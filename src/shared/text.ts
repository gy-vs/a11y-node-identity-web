// Bounded text similarity and node-level diff descriptors.
// All work is capped so pathological long strings cannot blow up matching.

import {normalizeText, stableClasses as stableClassesExport} from './dom';
import type {FlatNode, Identity} from './types';

const MAX_TEXT_LEN = 240;
const MAX_EDIT_CELLS = 4096; // 64x64 cap

export function tokenSet(value: string): string[] {
  return normalizeText(value).toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Similarity in [0,1] between two strings.
 * Uses capped Levenshtein when both strings are short; otherwise a
 * bounded token-overlap (Jaccard) measure. Deterministic either way.
 */
export function textSimilarity(a: string, b: string): number {
  const left = a.slice(0, MAX_TEXT_LEN);
  const right = b.slice(0, MAX_TEXT_LEN);
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.length * right.length <= MAX_EDIT_CELLS) {
    return 1 - levenshtein(left, right) / Math.max(left.length, right.length);
  }
  return jaccard(tokenSet(left), tokenSet(right));
}

function levenshtein(a: string, b: string): number {
  const n = b.length;
  let prev = Array.from({length: n + 1}, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let inter = 0;
  const seen = new Set<string>();
  for (const token of a) {
    if (setB.has(token) && !seen.has(token)) { inter += 1; seen.add(token); }
  }
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

export type FieldDiff =
  | {field: 'tag'; old: string; new: string}
  | {field: 'stableAttribute'; name: string; old: string | null; new: string | null}
  | {field: 'class'; added: string[]; removed: string[]}
  | {field: 'text'; old: string; new: string; similarity: number}
  | {field: 'shape'; oldShape: string; newShape: string; similarity: number}
  | {field: 'frame'; oldPath: string[]; newPath: string[]}
  | {field: 'position'; oldPath: number[]; newPath: number[]; moved: true};

export type NodeDiff = {
  oldNid: string;
  newNid: string | null;
  oldLabel: string;
  newLabel: string;
  fields: FieldDiff[];
  shapeSimilarity: number;
};

function attrsOf(node: FlatNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.node.attrs ?? {})) {
    if (key === 'class') continue;
    if (key.startsWith('data-') && key !== 'data-testid') continue;
    if (key === 'style' || key === 'tabindex') continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** Descriptive diff between an old node and a candidate new node. */
export function diffNodes(
  old: FlatNode,
  candidate: FlatNode | null,
  shapeSimilarity: number,
  labelOf: (identity: Identity) => string,
): NodeDiff {
  const oi = old.identity;

  if (!candidate) {
    return {
      oldNid: old.nid, newNid: null,
      oldLabel: labelOf(oi), newLabel: '（节点已删除 / deleted, no candidate）',
      fields: [], shapeSimilarity: 0,
    };
  }
  const ni = candidate.identity;
  const fields: FieldDiff[] = [];

  if (oi.tag !== ni.tag) fields.push({field: 'tag', old: oi.tag, new: ni.tag});

  const oldAttrs = attrsOf(old);
  const newAttrs = attrsOf(candidate);
  for (const name of [...new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)])].sort()) {
    const a = oldAttrs[name] ?? null;
    const b = newAttrs[name] ?? null;
    if (a !== b) fields.push({field: 'stableAttribute', name, old: a, new: b});
  }

  const oldClasses = stableClassesExport(old.node.attrs);
  const newClasses = stableClassesExport(candidate.node.attrs);
  const removed = oldClasses.filter(c => !newClasses.includes(c));
  const added = newClasses.filter(c => !oldClasses.includes(c));
  if (added.length || removed.length) fields.push({field: 'class', added, removed});

  if (oi.name !== ni.name) {
    fields.push({field: 'text', old: oi.name, new: ni.name, similarity: textSimilarity(oi.name, ni.name)});
  }

  if (oi.shape !== ni.shape) {
    fields.push({field: 'shape', oldShape: oi.shape, newShape: ni.shape, similarity: shapeSimilarity});
  }

  const oldFp = oi.framePath.join('/');
  const newFp = ni.framePath.join('/');
  if (oldFp !== newFp) fields.push({field: 'frame', oldPath: oi.framePath, newPath: ni.framePath});

  if (!samePosition(oi.path, ni.path) || oldFp !== newFp) {
    fields.push({field: 'position', oldPath: oi.path, newPath: ni.path, moved: true});
  }

  return {
    oldNid: old.nid, newNid: candidate.nid,
    oldLabel: labelOf(oi), newLabel: labelOf(ni),
    fields, shapeSimilarity,
  };
}

function samePosition(a: number[], b: string[] | number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === (b as number[])[i]);
}
