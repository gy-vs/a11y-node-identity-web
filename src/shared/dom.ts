// DOM flattening and stable identity extraction.
//
// Identity is deliberately built from four independent signal families:
//   1. stable attributes  (id / data-testid / aria-label / name)
//   2. structural fingerprint (tag, stable attrs, normalized text, subtree shape)
//   3. accessible name + tag bucket (survives sibling reorder)
//   4. neighborhood anchor (nearest keyed ancestor, then previous stable sibling)
// plus the iframe frame path so identical components in different frames
// never silently collide.

import {digest, shortHash} from './hash';
import type {
  FlatFrame, FlatNode, FlatSnapshot, Identity, SFrame, SNode, SnapshotInput, StableKey,
} from './types';

const KEY_ATTRS = ['id', 'data-testid', 'aria-label', 'name'] as const;

// Attribute values that look auto-generated / positional and are therefore unstable.
const DENY_ID = /^(anon|anonymous|uid|auto|radix|ember\d+|react-?portal|:\s*r\d+)/i;
const CLASS_NOISE = /^(active|open|closed|selected|focus|focused|hover|visible|hidden|expanded|collapsed|enter|enter-active|leave|done|loading|is-[a-z]+)$/i;

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function stableAttrs(attrs: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attrs) return out;
  for (const key of Object.keys(attrs).sort()) {
    const lower = key.toLowerCase();
    if (lower === 'class') continue; // classes handled separately, filtered
    if (lower.startsWith('data-') && lower !== 'data-testid') continue;
    if (/^aria-(posinset|setsize|level|index|expanded|hidden|selected|pressed|checked)$/.test(lower)) continue;
    if (lower === 'style' || lower === 'tabindex') continue;
    const value = normalizeText(attrs[key]);
    if (value) out[lower] = value;
  }
  return out;
}

/** Stable (non-positional) class tokens, sorted and de-noised. */
export function stableClasses(attrs: Record<string, string> | undefined): string[] {
  if (!attrs?.class) return [];
  return attrs.class.split(/\s+/)
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => !CLASS_NOISE.test(value))
    .sort();
}

function extractKeys(tag: string, attrs: Record<string, string> | undefined): StableKey[] {
  const keys: StableKey[] = [];
  if (!attrs) return keys;
  for (const kind of KEY_ATTRS) {
    const raw = attrs[kind];
    if (raw === undefined) continue;
    const value = normalizeText(raw);
    if (!value || value.length > 120) continue;
    if (kind === 'id' && (/^\d/.test(value) || DENY_ID.test(value))) continue;
    if (kind === 'name' && !/^(input|select|textarea|button|fieldset|form)$/.test(tag)) continue;
    if (kind === 'aria-label' && value.length < 2) continue;
    keys.push({kind, value});
  }
  return keys;
}

function isText(node: SNode): boolean {
  return node.tag === '#text';
}

/** Normalized descendant text (used both for name and text fingerprint). */
export function descendantText(node: SNode): string {
  if (isText(node)) return normalizeText(node.text ?? '');
  const parts: string[] = [];
  for (const child of node.children ?? []) {
    const t = descendantText(child);
    if (t) parts.push(t);
  }
  return normalizeText(parts.join(' '));
}

/**
 * Accessible name per a deliberately conservative subset of the ARIA
 * algorithm: an element has a name only when the platform/role exposes one
 * (native controls, headings, links, img alt, buttons) or aria-label is
 * present. Generic containers (div/article/section/span/li...) do NOT get a
 * name synthesized from all descendant text — that text stays part of the
 * shape fingerprint. This prevents twins with different body copy from
 * looking "globally uniquely named".
 */
function accessibleName(node: SNode): string {
  const aria = normalizeText(node.attrs?.['aria-label'] ?? '');
  if (aria) return aria.slice(0, 120);
  const tag = node.tag;
  const namedTags = new Set([
    'a', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'input', 'select', 'textarea', 'summary', 'option', 'th', 'label',
  ]);
  if (!namedTags.has(tag)) return '';
  if (tag === 'img' || tag === 'area') {
    const alt = normalizeText(node.attrs?.alt ?? '');
    if (alt) return alt.slice(0, 120);
  }
  if (tag === 'input') {
    if (node.attrs?.type === 'submit' || node.attrs?.type === 'button') {
      const v = normalizeText(node.attrs.value ?? '');
      if (v) return v.slice(0, 120);
    }
    return normalizeText(node.attrs?.placeholder ?? node.attrs?.title ?? '').slice(0, 120);
  }
  return descendantText(node).slice(0, 120);
}

/** Subtree shape descriptor: ordered, text-normalized, stable-attr only. */
function shapeDescriptor(node: SNode): unknown {
  if (isText(node)) {
    const text = normalizeText(node.text ?? '');
    return text ? ['t', text] : null;
  }
  const childDescriptors: unknown[] = [];
  for (const child of node.children ?? []) {
    const descriptor = shapeDescriptor(child);
    if (descriptor !== null) childDescriptors.push(descriptor);
  }
  return [node.tag, stableAttrs(node.attrs), stableClasses(node.attrs), childDescriptors];
}

/** Role/ARIA-only descriptor: stable under pure text edits. */
function roleDescriptor(node: SNode): unknown {
  const attrs = stableAttrs(node.attrs);
  const roleParts: Record<string, string> = {};
  for (const key of ['role', 'type', 'href', 'src']) {
    if (attrs[key]) roleParts[key] = attrs[key];
  }
  if (attrs['aria-label']) roleParts['aria-label'] = attrs['aria-label'];
  return [node.tag, roleParts, stableClasses(node.attrs)];
}

function makeAnchor(
  keys: StableKey[],
  parentIdentity: Identity | null,
  priorSiblingKeys: StableKey[],
): string {
  if (keys.length) return `self:${keys[0].kind}=${keys[0].value}`;
  if (parentIdentity?.keys.length) {
    const k = parentIdentity.keys[0];
    return `anc:${k.kind}=${k.value}`;
  }
  if (priorSiblingKeys.length) {
    const k = priorSiblingKeys[priorSiblingKeys.length - 1];
    return `sib:${k.kind}=${k.value}`;
  }
  if (parentIdentity) return `anc:${parentIdentity.tag}#${parentIdentity.shape.slice(0, 6)}`;
  return 'root';
}

type Ctx = {
  nodes: FlatNode[];
  byNid: Map<string, FlatNode>;
  frameOf: Map<string, string[]>;
  frameOwner: Map<string, string>;
  frameMap: Map<string, SFrame>;
  counter: number;
};

function walk(
  node: SNode,
  path: number[],
  depth: number,
  parent: string | null,
  framePath: string[],
  parentIdentity: Identity | null,
  priorSiblingKeys: StableKey[],
  ctx: Ctx,
): FlatNode | null {
  if (isText(node)) return null;
  const tag = node.tag.toLowerCase();
  const keys = extractKeys(tag, node.attrs);
  const name = accessibleName(node);
  const shape = digest([shapeDescriptor(node)]);
  const roleDigest = digest([roleDescriptor(node)]);
  const keyDigest = digest(keys.map(k => [k.kind, k.value.toLowerCase()]));
  const anchor = makeAnchor(keys, parentIdentity, priorSiblingKeys);
  const nameSig = name ? digest([tag, name.toLowerCase(), ...stableClasses(node.attrs)]) : '';

  const elementChildren = (node.children ?? []).filter(child => !isText(child));
  const childTagCounts: Record<string, number> = {};
  for (const child of elementChildren) {
    const childTag = child.tag.toLowerCase();
    childTagCounts[childTag] = (childTagCounts[childTag] ?? 0) + 1;
  }

  ctx.counter += 1;
  const nid = `n${ctx.counter.toString(36)}`;
  const identity: Identity = {
    nid, keys,
    keyDigest: keys.length ? keyDigest : '',
    shape,
    structureSig: digest([tag, Object.entries(childTagCounts).sort()]),
    roleDigest, tag, name, nameSig, anchor, framePath,
    childTagCounts,
    childCount: elementChildren.length,
    path,
  };
  const flat: FlatNode = {nid, node, depth, parent, identity};
  ctx.nodes.push(flat);
  ctx.byNid.set(nid, flat);
  ctx.frameOf.set(nid, framePath);

  let index = 0;
  const seenKeys: StableKey[] = [];
  for (const child of node.children ?? []) {
    if (isText(child)) continue;
    walk(child, [...path, index], depth + 1, nid, framePath, identity, seenKeys, ctx);
    seenKeys.push(...extractKeys(child.tag, child.attrs));
    index += 1;
  }
  if (node.frame) {
    const frame = ctx.frameMap.get(node.frame);
    if (frame) flattenFrame(frame, [...framePath, node.frame], nid, ctx);
  }
  return flat;
}

function flattenFrame(frame: SFrame, framePath: string[], ownerNid: string | null, ctx: Ctx): void {
  if (framePath.length) ctx.frameOwner.set(framePath.join('/'), ownerNid ?? '');
  walk(frame.root, [], 0, null, framePath, null, [], ctx);
}

export function flattenSnapshot(input: SnapshotInput, snapshotId: string): FlatSnapshot {
  const frameMap = new Map<string, SFrame>();
  for (const frame of input.frames ?? []) frameMap.set(frame.id, frame);
  const ctx: Ctx = {
    nodes: [], byNid: new Map(), frameOf: new Map(), frameOwner: new Map(),
    frameMap, counter: 0,
  };
  flattenFrame({id: '', root: input.root, src: input.url, title: 'top'}, [], null, ctx);

  // group flattened nodes by frame path, in traversal order
  const groups = new Map<string, FlatNode[]>();
  for (const flat of ctx.nodes) {
    const key = flat.identity.framePath.join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(flat);
  }
  const frames: FlatFrame[] = [];
  for (const [key, nodes] of groups) {
    const framePath = key ? key.split('/') : [];
    const id = framePath.length ? framePath[framePath.length - 1] : '';
    const source = id ? frameMap.get(id) : undefined;
    frames.push({
      id,
      src: id ? source?.src : input.url,
      title: id ? source?.title : 'top',
      root: source?.root ?? input.root,
      framePath,
      nodes,
    });
  }
  return {
    snapshotId,
    url: input.url,
    capturedAt: input.capturedAt,
    nodes: groups.get('') ?? [],
    frames,
    byNid: ctx.byNid,
    frameOf: ctx.frameOf,
    frameOwner: ctx.frameOwner,
  };
}

/** Resolve a child-index path inside one frame of a flat snapshot (legacy references). */
export function resolvePath(snapshot: FlatSnapshot, path: number[], framePath: string[] = []): FlatNode | null {
  const key = framePath.join('/');
  const list = key ? (snapshot.frames.find(f => f.framePath.join('/') === key)?.nodes ?? []) : snapshot.nodes;
  for (const node of list) {
    if (eqPath(node.identity.path, path)) return node;
  }
  return null;
}

export function eqPath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function nidLabel(identity: Identity): string {
  if (identity.keys.length) {
    const k = identity.keys[0];
    return `${identity.tag}[${k.kind}="${k.value}"]`;
  }
  if (identity.name) return `${identity.tag} “${identity.name.slice(0, 40)}”`;
  return `${identity.tag}#${shortHash(identity.shape)}`;
}
