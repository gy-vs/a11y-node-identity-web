// Node identity primitives:
//   1. stable attributes (explicit ids / names the app itself relies on)
//   2. structural fingerprint (role/name/text/attribute signature + Merkle hash)
//   3. neighborhood (parent / preceding siblings) — applied in matcher.ts
//
// Child-index paths are computed for display only and must never be used
// as identity.

import type {
  Fingerprint,
  FrameId,
  FrameInfo,
  NodeView,
  RawFrame,
  RawNode,
  Snapshot,
  SnapNode,
} from './types';

/** FNV-1a 32-bit, hex. Deterministic, dependency free, sufficient for buckets. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // 32-bit FNV prime multiply.
  }
  return h.toString(16).padStart(8, '0');
}

const WS = /\s+/g;
export function normalizeText(value: string): string {
  return value.replace(WS, ' ').trim().slice(0, 400);
}

/**
 * Attributes whose contract-level stability matches DOM identity semantics:
 * explicitly authored, unique-ish handles used by forms, tests and
 * accessibility APIs.
 */
export const STABLE_ATTRS = [
  'id',
  'data-testid',
  'data-test-id',
  'data-qa',
  'data-node-id',
  'name',
  'for',
  'aria-labelledby',
  'aria-describedby',
  'aria-owns',
  'aria-controls',
] as const;

// Unstable ids produced by CSS-in-JS / build tooling (css-*, :r12:).
const UNSTABLE_ID = /^(css|emotion|radix|headlessui|[a-z]?\d{5,})[-:]|^:r\d+:?$/i;

function stableKey(attr: string, raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 200) return null;
  if (attr === 'id' && UNSTABLE_ID.test(value)) return null;
  // Composite references ("a b") point at several nodes; skip for keying.
  if (
    (attr === 'aria-labelledby' || attr === 'aria-describedby' || attr === 'aria-owns') &&
    /\s/.test(value)
  ) {
    return null;
  }
  return `${attr}:${value}`;
}

/** Attributes folded into the (non-stable) attribute signature. */
const ATTR_SIG_KEYS = [
  'role',
  'class',
  'href',
  'src',
  'type',
  'value',
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'aria-live',
  'aria-expanded',
  'aria-checked',
  'aria-selected',
  'aria-hidden',
  'aria-current',
  'aria-required',
  'disabled',
  'required',
  'checked',
  'hreflang',
  'rel',
  'target',
  'data-issue',
];

function attrSignature(attrs: Record<string, string>, tag: string): string {
  const parts: string[] = [`tag:${tag}`];
  for (const key of ATTR_SIG_KEYS) {
    if (attrs[key] !== undefined) parts.push(`${key}=${normalizeText(attrs[key]).slice(0, 120)}`);
  }
  return fnv1a(parts.join('|'));
}

function roleOf(tag: string, attrs: Record<string, string>): string | null {
  if (attrs.role) return attrs.role;
  const implicit: Record<string, string> = {
    a: attrs.href !== undefined ? 'link' : '',
    button: 'button',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    img: 'image',
    svg: 'graphics-document',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    input:
      attrs.type === 'checkbox' ? 'checkbox' : attrs.type === 'radio' ? 'radio' : 'textbox',
    textarea: 'textbox',
    select: 'combobox',
    label: 'label',
    dialog: 'dialog',
    table: 'table',
    tr: 'row',
    th: 'columnheader',
    td: 'cell',
  };
  return implicit[tag] || null;
}

function accessibleName(tag: string, attrs: Record<string, string>, text: string): string {
  if (attrs['aria-label']) return normalizeText(attrs['aria-label']);
  if (tag === 'img' && attrs.alt) return normalizeText(attrs.alt);
  if ((tag === 'input' || tag === 'textarea') && attrs.placeholder)
    return normalizeText(attrs.placeholder);
  if (tag === 'a' || tag === 'button' || tag === 'th' || tag === 'td' || tag === 'li') return text;
  return '';
}

export function fingerprintOf(
  tag: string,
  attrs: Record<string, string>,
  text: string,
): Fingerprint {
  const stableKeys: string[] = [];
  for (const attr of STABLE_ATTRS) {
    if (attrs[attr] !== undefined) {
      const key = stableKey(attr, attrs[attr]);
      if (key) stableKeys.push(key);
    }
  }
  stableKeys.sort();
  const role = roleOf(tag, attrs);
  const name = accessibleName(tag, attrs, text);
  const attrSig = attrSignature(attrs, tag);
  const localSig = fnv1a(
    [tag, role ?? '', name.slice(0, 120), text.slice(0, 120), attrSig].join(''),
  );
  return {stableKeys, role, name, text, attrSig, localSig};
}

function childSignature(children: SnapNode[]): string {
  const pairs = children
    .map((node) => `${node.tag}:${node.fingerprint.role ?? '-'}`)
    .sort()
    .join(',');
  return fnv1a(pairs);
}

let SEQ = 0;
function nextUid(): string {
  SEQ = (SEQ + 1) % 0x7fffffff;
  return 'n' + SEQ.toString(36) + Math.random().toString(36).slice(2, 7);
}

interface BuiltFrame {
  info: FrameInfo;
  nodes: SnapNode[];
  nested: {owner: SnapNode; frame: RawFrame}[];
}

function buildFrame(
  frame: RawFrame,
  id: FrameId,
  parentFrameId: FrameId | null,
  depth: number,
): BuiltFrame {
  const nodes: SnapNode[] = [];
  const nested: {owner: SnapNode; frame: RawFrame}[] = [];

  const build = (
    raw: RawNode,
    parentUid: string | null,
    path: number[],
    level: number,
  ): SnapNode => {
    const uid = nextUid();
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.attrs ?? {})) attrs[key] = String(value);
    const text = normalizeText(raw.text ?? '');
    const fingerprint = fingerprintOf(raw.tag.toLowerCase(), attrs, text);
    const node: SnapNode = {
      uid,
      frameId: id,
      tag: raw.tag.toLowerCase(),
      attrs,
      text,
      path: [...path],
      depth: level,
      childCount: 0,
      subtreeSize: 1,
      parentUid,
      childUids: [],
      prevSiblingUids: [],
      nextSiblingUids: [],
      fingerprint,
      structHash: '',
      childSig: '',
    };
    nodes.push(node);
    if (raw.frame) nested.push({owner: node, frame: raw.frame});

    const children = (raw.children ?? []).map((child, index) =>
      build(child, uid, [...path, index + 1], level + 1),
    );
    node.childCount = children.length;
    node.childUids = children.map((child) => child.uid);
    for (let i = 0; i < children.length; i++) {
      children[i].prevSiblingUids = children.slice(Math.max(0, i - 3), i).map((c) => c.uid);
      children[i].nextSiblingUids = children.slice(i + 1, i + 4).map((c) => c.uid);
    }
    node.subtreeSize = 1 + children.reduce((sum, child) => sum + child.subtreeSize, 0);
    // Iframe CONTENT does not participate in the owner's Merkle hash; frames
    // are aligned separately across snapshots (see matcher.ts).
    node.childSig = childSignature(children);
    node.structHash = fnv1a(
      `${fingerprint.localSig}|${node.childSig}|${children
        .map((child) => child.structHash)
        .join(',')}`,
    );
    return node;
  };

  const rootNode = build(frame.root, null, [], 0);
  return {
    info: {
      id,
      parentFrameId,
      ownerUid: null, // filled in by the caller for nested frames
      ...(frame.name ? {name: frame.name} : {}),
      rootUid: rootNode.uid,
      depth,
    },
    nodes,
    nested,
  };
}

function frameHandle(owner: SnapNode, frame: RawFrame): string {
  // A stable key already encodes the authored handle (name=..., id=...); do
  // not append the window name again when it is the same value.
  const stable = owner.fingerprint.stableKeys[0]?.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  if (stable) return stable;
  const handle = owner.uid;
  const named = frame.name ? `/${normalizeText(frame.name).replace(/\W+/g, '_')}` : '';
  return `${handle}${named}`;
}

export function buildSnapshot(
  auditId: string,
  seq: number,
  root: RawNode,
  id?: string,
  createdAt?: string,
): Snapshot {
  const frames: FrameInfo[] = [];
  const allNodes: SnapNode[] = [];
  const roots: Record<string, string> = {};

  // BFS of frames, owner frames always built before their nested frames.
  let built = buildFrame({root}, 'top', null, 0);
  const queue: {ownerFrameId: FrameId; ownerUid: string; frame: RawFrame}[] = [];
  const enqueue = (ownerFrameId: FrameId, nested: BuiltFrame['nested']) => {
    for (const entry of nested) {
      queue.push({ownerFrameId, ownerUid: entry.owner.uid, frame: entry.frame});
    }
  };
  frames.push(built.info);
  allNodes.push(...built.nodes);
  roots.top = built.info.rootUid;
  enqueue('top', built.nested);

  while (queue.length) {
    const {ownerFrameId, ownerUid, frame} = queue.shift()!;
    const ownerFrame = frames.find((f) => f.id === ownerFrameId)!;
    const ownerNode = allNodes.find((n) => n.uid === ownerUid)!;
    const frameId = `${ownerFrameId}/${frameHandle(ownerNode, frame)}`;
    built = buildFrame(frame, frameId, ownerFrameId, ownerFrame.depth + 1);
    built.info.ownerUid = ownerUid;
    frames.push(built.info);
    allNodes.push(...built.nodes);
    roots[frameId] = built.info.rootUid;
    enqueue(frameId, built.nested);
  }

  return {
    id: id ?? `snap_${auditId}_${seq}`,
    auditId,
    seq,
    createdAt: createdAt ?? new Date().toISOString(),
    frames,
    nodes: allNodes,
    roots,
  };
}

export function labelOf(node: SnapNode): string {
  const fp = node.fingerprint;
  const basis = fp.name || fp.text;
  if (basis) return `<${node.tag}> ${basis.slice(0, 80)}`;
  if (fp.role) return `<${node.tag}> [role=${fp.role}]`;
  return `<${node.tag}>`;
}

export function pathTextOf(node: SnapNode): string {
  return node.path.length ? node.path.join('.') : 'root';
}

export function viewOf(node: SnapNode): NodeView {
  return {
    ref: {frameId: node.frameId, uid: node.uid},
    label: labelOf(node),
    pathText: pathTextOf(node),
    tag: node.tag,
    attrs: node.attrs,
    text: node.text,
    role: node.fingerprint.role,
    name: node.fingerprint.name,
    childCount: node.childCount,
    subtreeSize: node.subtreeSize,
    structHash: node.structHash,
  };
}
