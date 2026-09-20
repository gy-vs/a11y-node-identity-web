// Bounded old/new node comparison for the pending-confirmation UI.
// Text diff is a word/char-level LCS with a cap so huge text nodes stay cheap.

import {textSimilarity} from './matcher';
import type {NodeView} from './types';

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const TEXT_TOKEN_CAP = 120;

function tokenize(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]+/gu) ?? [];
  if (/[一-鿿]/.test(text)) return Array.from(text);
  if (words.length > TEXT_TOKEN_CAP) return sliceCap(words);
  return words;
}

function sliceCap(tokens: string[]): string[] {
  // Keep head + tail with a marker; diff is display-only.
  const head = tokens.slice(0, TEXT_TOKEN_CAP / 2);
  const tail = tokens.slice(-TEXT_TOKEN_CAP / 2);
  return [...head, ' … ', ...tail];
}

export function diffText(oldText: string, newText: string): DiffLine[] {
  if (oldText === newText) return oldText ? [{kind: 'same', text: oldText}] : [];
  const a = tokenize(oldText);
  const b = tokenize(newText);
  // LCS table: O(TEXT_TOKEN_CAP^2) worst case, constant-bound.
  const dp: number[][] = Array.from({length: a.length + 1}, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  const push = (kind: DiffLine['kind'], token: string) => {
    const last = lines[lines.length - 1];
    if (last && last.kind === kind) last.text += token;
    else lines.push({kind, text: token});
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('removed', a[i]);
      i++;
    } else {
      push('added', b[j]);
      j++;
    }
  }
  while (i < a.length) push('removed', a[i++]);
  while (j < b.length) push('added', b[j++]);
  return lines.map((line) => ({...line, text: line.text.trim()})).filter((line) => line.text);
}

export interface AttributeChange {
  name: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface NodeDiff {
  tagChanged: boolean;
  attributes: AttributeChange[];
  textLines: DiffLine[];
  textSimilarity: number;
  structural: {
    oldChildCount: number;
    newChildCount: number;
    oldSubtreeSize: number;
    newSubtreeSize: number;
    structChanged: boolean;
  };
}

export function diffNodes(oldNode: NodeView | null, newNode: NodeView | null): NodeDiff {
  const attributes: AttributeChange[] = [];
  const names = new Set([
    ...Object.keys(oldNode?.attrs ?? {}),
    ...Object.keys(newNode?.attrs ?? {}),
  ]);
  for (const name of [...names].sort()) {
    const ov = oldNode?.attrs[name] ?? null;
    const nv = newNode?.attrs[name] ?? null;
    if (ov !== nv) attributes.push({name, oldValue: ov, newValue: nv});
  }
  const oldText = oldNode?.text ?? '';
  const newText = newNode?.text ?? '';
  return {
    tagChanged: !!oldNode && !!newNode && oldNode.tag !== newNode.tag,
    attributes,
    textLines: diffText(oldText, newText),
    textSimilarity: textSimilarity(oldText, newText),
    structural: {
      oldChildCount: oldNode?.childCount ?? 0,
      newChildCount: newNode?.childCount ?? 0,
      oldSubtreeSize: oldNode?.subtreeSize ?? 0,
      newSubtreeSize: newNode?.subtreeSize ?? 0,
      structChanged: (oldNode?.structHash ?? '') !== (newNode?.structHash ?? ''),
    },
  };
}
