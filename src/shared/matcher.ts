// Deterministic, bounded cross-snapshot node matching.
//
// Identity signals (in scoring order):
//   1. stable attributes (id / data-testid / name / aria relationship ...)
//   2. structural fingerprint: tag, role, accessible name, own text,
//      attribute signature, child signature, Merkle struct hash, subtree size
//   3. neighborhood: matched parent + preceding siblings (relaxation)
//
// Complexity upper bound (also asserted at runtime via stats):
//   scoredEdges <= CANDIDATE_CAP * |old nodes|, i.e. O(N), never all-pairs.
// Memory: O(N) hash indexes per frame.
//
// Decisions are conservative: only unique, high-confidence, one-to-one edges
// auto-migrate review results. One-to-many / low confidence / truncated search
// spaces / unresolved frames all become PENDING and require an explicit user
// decision (matcher.ts never invents a mapping).

import type {
  NodeMatch,
  NodeRef,
  ReconcileResult,
  ScoredCandidate,
  SnapNode,
  Snapshot,
} from './types';

export const CANDIDATE_CAP = 12;
const AUTO_SCORE = 0.52;
const MARGIN = 0.1;
const DELETED_SCORE = 0.2;
const RELAX_ITERS = 3;

// Intrinsic weights (round 1).
const W_STABLE = 0.34;
const W_ROLE = 0.08;
const W_TAG = 0.07;
const W_NAME = 0.18;
const W_TEXT = 0.1;
const W_ATTR = 0.05;
const W_CHILD = 0.06;
const W_STRUCT = 0.08;
const W_STRUCT_NEAR = 0.03;
// Neighborhood weights (round 2), sum 0.18.
const W_PARENT = 0.1;
const W_PARENT_TAG = 0.03;
const W_SIBLING = 0.08;

// Tags whose accessible name is derived from own text (see identity.ts).
const NAME_FROM_TEXT_TAGS = new Set(['a', 'button', 'th', 'td', 'li']);

// When the best edge is anchored by a clearly-similar label and the runner-up
// is not similar at all, text is treated as a distinguishing anchor even if
// the raw score margin is small (used for the 1-vs-many decision).
const ANCHOR_SIM = 0.72;
const ANCHOR_GAP = 0.14;
const AUTO_STABLE = 0.5; // unique stable-key anchor auto-threshold (intrinsic only)

interface FrameIndex {
  byStable: Map<string, RankedEntry[]>;
  byText: Map<string, RankedEntry[]>;
  byCoarse: Map<string, RankedEntry[]>;
  all: SnapNode[];
}

/**
 * Magnitude band for subtree size: fine-grained at small sizes, logarithmic
 * at large ones. Keeps buckets near-constant size while a moved node still
 * lands in the same or adjacent band.
 */
function sizeBand(size: number): string {
  if (size <= 8) return String(size);
  if (size <= 32) return `b${Math.floor(size / 4)}`;
  if (size <= 256) return `c${Math.floor(size / 32)}`;
  return `d${Math.floor(Math.log2(size))}`;
}

function indexFrame(nodes: SnapNode[]): FrameIndex {
  const byStable = new Map<string, RankedEntry[]>();
  const byText = new Map<string, RankedEntry[]>();
  const byCoarse = new Map<string, RankedEntry[]>();
  for (const node of nodes) {
    const entry: RankedEntry = {node, rank: staticRankOf(node)};
    for (const key of node.fingerprint.stableKeys) push(byStable, key, entry);
    if (node.fingerprint.text) push(byText, node.fingerprint.text, entry);
    const bucket =
      node.depth <= 30 ? String(node.depth) : '31+';
    push(
      byCoarse,
      `${node.tag}|${node.fingerprint.role ?? '-'}|${node.childCount <= 6 ? node.childCount : '7+'}|d${bucket}|s${sizeBand(node.subtreeSize)}`,
      entry,
    );
  }
  return {byStable, byText, byCoarse, all: nodes};
}

function push<K>(map: Map<K, RankedEntry[]>, key: K, entry: RankedEntry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

/**
 * Text similarity blended from:
 *  - character-bigram Dice (catches edits),
 *  - token LCS ratio on the shorter token sequence (catches rewording where
 *    most of the short label survives inside a longer new label).
 * Token-aware, works for CJK strings.
 */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;

  const charDice = (x: string, y: string): number => {
    const grams = (s: string) => {
      if (s.length < 2) return [s];
      const out: string[] = [];
      for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
      return out;
    };
    const counts = new Map<string, number>();
    for (const g of grams(x)) counts.set(g, (counts.get(g) ?? 0) + 1);
    let shared = 0;
    for (const g of grams(y)) {
      const left = counts.get(g) ?? 0;
      if (left > 0) {
        shared++;
        counts.set(g, left - 1);
      }
    }
    return (2 * shared) / (x.length + y.length - 2 || 1);
  };
  const dice = charDice(al, bl);
  // Only pay the O(tokens^2) LCS price when the cheap Dice pass says the
  // strings are plausibly related (or very short).
  if (dice < 0.15 && Math.min(al.length, bl.length) > 12) return dice;
  const tokenLcs = (x: string, y: string): number => {
    const tok = (s: string) => {
      const words = s.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (/[一-鿿]/.test(s)) return Array.from(s.replace(/\s+/g, ''));
      return words;
    };
    const ta = tok(x);
    const tb = tok(y);
    if (ta.length === 0 || tb.length === 0) return 0;
    // Rolling LCS row: O(|ta|*|tb|), but inputs here are node labels (<=400
    // chars); matcher invokes this only on the bounded candidate set.
    let prev = new Array<number>(tb.length + 1).fill(0);
    let cur = new Array<number>(tb.length + 1).fill(0);
    for (const wa of ta) {
      for (let j = 1; j <= tb.length; j++) {
        cur[j] = wa === tb[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[tb.length] / Math.min(ta.length, tb.length);
  };

  return Math.min(1, 0.5 * dice + 0.5 * tokenLcs(al, bl));
}

interface Edge {
  oldN: SnapNode;
  newN: SnapNode;
  intrinsic: number;
  intrinsicReasons: string[];
  nameSim: number;
  textSim: number;
  total: number;
  reasons: string[];
}

function intrinsicScore(
  oldN: SnapNode,
  newN: SnapNode,
  sim: (a: string, b: string) => number,
): {
  score: number;
  reasons: string[];
  nameSim: number;
  textSim: number;
} {
  let score = 0;
  const reasons: string[] = [];
  const of = oldN.fingerprint;
  const nf = newN.fingerprint;

  const sharedStable = of.stableKeys.filter((key) => nf.stableKeys.includes(key));
  if (sharedStable.length) {
    score += W_STABLE;
    reasons.push('stable:' + sharedStable[0]);
  }
  if (of.role !== null && of.role === nf.role) {
    score += W_ROLE;
    reasons.push('role');
  }
  if (oldN.tag === newN.tag) {
    score += W_TAG;
    reasons.push('tag');
  }
  const nameSim = sim(of.name, nf.name);
  const textSim = sim(of.text, nf.text);
  // Avoid double counting: for label-bearing tags (a/button/li/...) the
  // accessible name IS the own text, so score only one combined signal.
  const nameDerivedFromText = NAME_FROM_TEXT_TAGS.has(oldN.tag) && of.name === of.text;
  const contentSim = nameDerivedFromText ? Math.max(nameSim, textSim) : Math.max(nameSim, textSim * 0.6 + nameSim * 0.4);
  if (contentSim > 0) {
    score += W_NAME * contentSim;
    if (contentSim >= 0.99) reasons.push('name=');
    else reasons.push(`name~${contentSim.toFixed(2)}`);
  }
  if (!nameDerivedFromText && textSim > 0) {
    score += W_TEXT * textSim;
    if (textSim >= 0.99) reasons.push('text=');
    else reasons.push(`text~${textSim.toFixed(2)}`);
  }
  if (of.attrSig === nf.attrSig) {
    score += W_ATTR;
    reasons.push('attrs');
  }
  if (oldN.childSig === newN.childSig) {
    score += W_CHILD;
    reasons.push('children');
  }
  if (oldN.structHash === newN.structHash) {
    score += W_STRUCT;
    reasons.push('struct=');
  } else {
    const max = Math.max(oldN.subtreeSize, newN.subtreeSize, 1);
    if (Math.abs(oldN.subtreeSize - newN.subtreeSize) / max <= 0.15) {
      score += W_STRUCT_NEAR;
      reasons.push('size~');
    }
  }
  return {score: Math.min(score, 1), reasons, nameSim, textSim};
}

/**
 * Numeric pre-order index of a node inside its frame (path components packed
 * as a fraction); gives a total order cheaper than path.localeCompare.
 */
function orderOf(node: SnapNode): number {
  let value = 0;
  let scale = 1;
  for (const part of node.path) {
    scale /= 32;
    value += part * scale;
  }
  return value;
}

interface Rank {
  attrHit: 0 | 1;
  sizeRel: number;
  depthDiff: number;
  order: number;
}

/** Static, old-node-independent components of the coarse ranking. */
interface StaticRank {
  attrSig: string;
  subtreeSize: number;
  depth: number;
  order: number;
}

function staticRankOf(node: SnapNode): StaticRank {
  return {
    attrSig: node.fingerprint.attrSig,
    subtreeSize: node.subtreeSize,
    depth: node.depth,
    order: orderOf(node),
  };
}

function rankAgainst(oldN: SnapNode, staticRank: StaticRank): Rank {
  const max = Math.max(oldN.subtreeSize, staticRank.subtreeSize, 1);
  return {
    attrHit: oldN.fingerprint.attrSig === staticRank.attrSig ? 0 : 1,
    sizeRel: Math.abs(oldN.subtreeSize - staticRank.subtreeSize) / max,
    depthDiff: Math.abs(oldN.depth - staticRank.depth),
    order: staticRank.order,
  };
}

function rankLess(a: Rank, b: Rank): boolean {
  return (
    a.attrHit - b.attrHit ||
    a.sizeRel - b.sizeRel ||
    a.depthDiff - b.depthDiff ||
    a.order - b.order
  ) < 0;
}

interface CandidateSet {
  nodes: SnapNode[];
  truncated: boolean;
}

type RankedEntry = {node: SnapNode; rank: StaticRank};

/**
 * Bounded top-k over precomputed static ranks. Single linear scan with a
 * fixed-size (<=k) buffer. A cheap numeric prefilter rejects entries before
 * constructing the full rank, so a homogeneous bucket costs one comparison
 * per entry. No splice, no full sort — O(N) per old node.
 */
function topKRanked(
  entries: RankedEntry[],
  k: number,
  rankOf: (rank: StaticRank) => Rank,
  prefilter?: (rank: StaticRank) => boolean,
): SnapNode[] {
  if (entries.length === 0) return [];
  const best: Array<{entry: RankedEntry; rank: Rank}> = [];
  for (const entry of entries) {
    if (prefilter && best.length === k && !prefilter(entry.rank)) continue;
    const rank = rankOf(entry.rank);
    if (best.length < k) {
      insertSorted(best, {entry, rank});
    } else if (rankLess(rank, best[best.length - 1].rank)) {
      best.pop();
      insertSorted(best, {entry, rank});
    }
  }
  return best.map((value) => value.entry.node);
}

function insertSorted(
  best: Array<{entry: RankedEntry; rank: Rank}>,
  value: {entry: RankedEntry; rank: Rank},
): void {
  let i = best.length;
  best.push(value);
  while (i > 0 && rankLess(value.rank, best[i - 1].rank)) {
    best[i] = best[i - 1];
    i--;
  }
  best[i] = value;
}

function candidatesFor(oldN: SnapNode, index: FrameIndex): CandidateSet {
  const rankOf = (staticRank: StaticRank) => rankAgainst(oldN, staticRank);
  const stableEntries = oldN.fingerprint.stableKeys.flatMap(
    (key) => index.byStable.get(key) ?? [],
  );
  const stable = dedupeEntries(stableEntries);
  if (stable.length) {
    return {
      nodes: topKRanked(stable, CANDIDATE_CAP, rankOf),
      truncated: stable.length > CANDIDATE_CAP,
    };
  }

  const picked: RankedEntry[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const add = (entries: RankedEntry[]) => {
    for (const entry of entries) {
      if (picked.length >= CANDIDATE_CAP) {
        truncated = true;
        return;
      }
      if (!seen.has(entry.node.uid)) {
        seen.add(entry.node.uid);
        picked.push(entry);
      }
    }
  };

  const textBucket = oldN.fingerprint.text
    ? index.byText.get(oldN.fingerprint.text)
    : undefined;
  if (textBucket) {
    if (textBucket.length > 8) {
      // Repeated identical text is itself a "twin" signal: sample, truncate.
      truncated = true;
      add(textBucket.slice(0, 6));
    } else {
      add(textBucket);
    }
  }

  const coarseBase = `${oldN.tag}|${oldN.fingerprint.role ?? '-'}|${oldN.childCount <= 6 ? oldN.childCount : '7+'}`;
  const exactBand = sizeBand(oldN.subtreeSize);
  // Exact depth+band first; on a miss, widen by one depth each way and the
  // neighboring size bands — a constant number of probes.
  const bandNeighbors = new Set<string>([exactBand]);
  const size = oldN.subtreeSize;
  for (const delta of [1, -1, 4, -4]) {
    if (size + delta > 0) bandNeighbors.add(sizeBand(size + delta));
  }
  const depthProbes = oldN.depth <= 30 ? [oldN.depth, oldN.depth - 1, oldN.depth + 1] : [30, 31];
  const coarseKeys = new Set<string>();
  for (const depth of depthProbes) {
    const dKey = depth <= 30 ? String(depth) : '31+';
    for (const band of bandNeighbors) {
      coarseKeys.add(`${coarseBase}|d${dKey}|s${band}`);
    }
  }
  let coarseTotal = 0;
  const coarseParts: RankedEntry[][] = [];
  for (const key of coarseKeys) {
    const part = index.byCoarse.get(key);
    if (part) {
      coarseTotal += part.length;
      coarseParts.push(part);
    }
  }
  if (coarseTotal) {
    const quota = CANDIDATE_CAP - picked.length;
    if (quota <= 0) {
      truncated = true;
    } else if (coarseTotal > CANDIDATE_CAP) {
      // Oversized homogeneous ("twin") bucket: there is no intrinsic signal
      // strong enough to scan N candidates per old node. Take a small,
      // deterministic proximity sample ONCE and mark the search space
      // truncated; only a stable anchor could override the resulting pending
      // state. Constant work per old node regardless of bucket size.
      truncated = true;
      const perPart = Math.max(1, Math.ceil(Math.min(quota, 4) / coarseParts.length));
      for (const part of coarseParts) {
        const sample = part.slice(0, perPart).map((entry) => ({
          node: entry.node,
          rank: staticRankOf(entry.node),
        }));
        add(sample);
        if (picked.length >= Math.min(quota, 4)) break;
      }
    } else {
      add(coarseParts.flat());
    }
  }

  return {nodes: picked.map((entry) => entry.node), truncated};
}

function dedupeEntries(entries: RankedEntry[]): RankedEntry[] {
  const seen = new Set<string>();
  const out: RankedEntry[] = [];
  for (const entry of entries) {
    if (!seen.has(entry.node.uid)) {
      seen.add(entry.node.uid);
      out.push(entry);
    }
  }
  return out;
}

function matchFrame(
  oldNodes: SnapNode[],
  newNodes: SnapNode[],
  stats: {scoredEdges: number; candidateBuckets: number},
): NodeMatch[] {
  const index = indexFrame(newNodes);
  stats.candidateBuckets += index.byCoarse.size + index.byStable.size + index.byText.size;
  const byUid = new Map(newNodes.map((n) => [n.uid, n]));
  const oldByUid = new Map(oldNodes.map((n) => [n.uid, n]));
  // Memoize label comparisons: homogeneous/twin components repeat identical
  // texts thousands of times.
  const simCache = new Map<string, number>();
  const sim = (a: string, b: string): number => {
    if (!a || !b) return 0;
    const key = a < b ? a + '' + b : b + '' + a;
    let value = simCache.get(key);
    if (value === undefined) {
      value = textSimilarity(a, b);
      simCache.set(key, value);
    }
    return value;
  };

  // Build the bounded edge set (per-old-node candidate slice).
  const edges = new Map<string, Edge[]>(); // oldUid -> edges
  const truncated = new Set<string>();
  const order: SnapNode[] = [];

  for (const oldN of oldNodes) {
    order.push(oldN);
    const set = candidatesFor(oldN, index);
    if (set.truncated) truncated.add(oldN.uid);
    const list: Edge[] = set.nodes.map((newN) => {
      const {score, reasons, nameSim, textSim} = intrinsicScore(oldN, newN, sim);
      return {
        oldN,
        newN,
        intrinsic: score,
        intrinsicReasons: reasons,
        nameSim,
        textSim,
        total: score,
        reasons,
      };
    });
    stats.scoredEdges += list.length;
    edges.set(oldN.uid, list);
  }

  // Relaxation: rescore neighborhood based on the current tentative
  // old -> new assignment; iterate until stable (max RELAX_ITERS rounds).
  let assignment = new Map<string, string>(); // oldUid -> newUid
  for (let iter = 0; iter < RELAX_ITERS; iter++) {
    for (const list of edges.values()) {
      for (const edge of list) {
        let bonus = 0;
        const reasons: string[] = [];
        // Parent: both roots of aligned frames, or parent pair assigned.
        if (!edge.oldN.parentUid && !edge.newN.parentUid) {
          bonus += W_PARENT;
          reasons.push('parent=root');
        } else if (edge.oldN.parentUid && edge.newN.parentUid) {
          const mappedParent = assignment.get(edge.oldN.parentUid);
          if (mappedParent && mappedParent === edge.newN.parentUid) {
            bonus += W_PARENT;
            reasons.push('parent=');
          } else {
            const op = byUid.get(edge.newN.parentUid);
            const oldParent = oldByUid.get(edge.oldN.parentUid);
            if (op && oldParent && op.tag === oldParent.tag) {
              bonus += W_PARENT_TAG;
              reasons.push('parent~tag');
            }
          }
        }
        // Preceding siblings (up to 3 stored each).
        let sibHits = 0;
        for (const sp of edge.oldN.prevSiblingUids) {
          const mapped = assignment.get(sp);
          if (mapped && edge.newN.prevSiblingUids.includes(mapped)) sibHits++;
        }
        if (sibHits > 0) {
          bonus += W_SIBLING * Math.min(1, sibHits / 2);
          reasons.push(`sib×${sibHits}`);
        }
        edge.total = Math.min(1, edge.intrinsic + bonus);
        edge.reasons = Array.from(new Set([...edge.intrinsicReasons, ...reasons]));
      }
    }
    const next = greedyAssignment(edges);
    if (sameMap(assignment, next)) break;
    assignment = next;
  }

  // Final adjudication: one-to-one, threshold + 1-vs-many margin.
  const ownedBy = new Map<string, string>(); // newUid -> oldUid that owns it
  for (const [oldUid, newUid] of assignment) ownedBy.set(newUid, oldUid);

  const matches: NodeMatch[] = [];
  for (const oldN of order) {
    const list = (edges.get(oldN.uid) ?? []).slice().sort(edgeCompare);
    const ref = (n: SnapNode): NodeRef => ({frameId: n.frameId, uid: n.uid});

    if (list.length === 0) {
      matches.push({
        oldRef: ref(oldN),
        status: 'deleted',
        newRef: null,
        confidence: 0,
        reasons: ['no-candidate'],
        candidates: [],
        candidatesTruncated: false,
      });
      continue;
    }

    const best = list[0];
    const second = list[1];
    const margin = second ? +(best.total - second.total).toFixed(4) : 1;
    // Text-anchor separation: a strong best label vs a dissimilar runner-up
    // distinguishes twins that otherwise score identically.
    const bestContent = Math.max(best.nameSim, best.textSim);
    const secondContent = second ? Math.max(second.nameSim, second.textSim) : 0;
    const textAnchored = bestContent >= ANCHOR_SIM && bestContent - secondContent >= ANCHOR_GAP;
    const candidates: ScoredCandidate[] = list.slice(0, 5).map((edge) => ({
      ref: ref(edge.newN),
      score: +edge.total.toFixed(4),
      margin: 0,
      reasons: edge.reasons,
    }));
    for (const candidate of candidates) candidate.margin = +(best.total - candidate.score).toFixed(4);

    const base = {
      oldRef: ref(oldN),
      confidence: best.total,
      candidates,
      candidatesTruncated: truncated.has(oldN.uid),
    };

    if (best.total < DELETED_SCORE) {
      matches.push({...base, status: 'deleted', newRef: null, reasons: ['best<deleted-cutoff']});
      continue;
    }

    const sharedStable = oldN.fingerprint.stableKeys.some((key) =>
      best.newN.fingerprint.stableKeys.includes(key),
    );
    const oneToOne = ownedBy.get(best.newN.uid) === oldN.uid;
    // A unique stable anchor needs less total mass: the explicit id is the
    // identity; neighborhood cannot help when the node moved.
    const strongEnough = best.total >= (sharedStable ? AUTO_STABLE : AUTO_SCORE);
    const separated = margin >= MARGIN || list.length === 1 || textAnchored;
    // A capped candidate space can only auto-migrate on a stable anchor;
    // otherwise the true counterpart could be outside the slice.
    const searchTrusted = !base.candidatesTruncated || sharedStable;

    if (oneToOne && strongEnough && separated && searchTrusted) {
      matches.push({
        ...base,
        status: 'auto',
        newRef: ref(best.newN),
        reasons: best.reasons,
      });
    } else {
      let status: NodeMatch['status'];
      if (!oneToOne) status = 'pending_ambiguous';
      else if (!separated) status = 'pending_ambiguous';
      else if (base.candidatesTruncated && !sharedStable) status = 'pending_candidate_truncated';
      else status = 'pending_low_confidence';
      matches.push({...base, status, newRef: null, reasons: best.reasons});
    }
  }
  return matches;
}

function edgeCompare(a: Edge, b: Edge): number {
  if (b.total !== a.total) return b.total - a.total;
  const orderDiff = orderOf(a.newN) - orderOf(b.newN);
  if (orderDiff !== 0) return orderDiff;
  return a.newN.uid < b.newN.uid ? -1 : 1;
}

function greedyAssignment(edges: Map<string, Edge[]>): Map<string, string> {
  const all: Edge[] = [];
  for (const list of edges.values()) all.push(...list);
  all.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    const oldOrder = orderOf(a.oldN) - orderOf(b.oldN);
    if (oldOrder !== 0) return oldOrder;
    return edgeCompare(a, b);
  });
  const takenNew = new Set<string>();
  const takenOld = new Set<string>();
  const map = new Map<string, string>();
  for (const edge of all) {
    if (takenOld.has(edge.oldN.uid) || takenNew.has(edge.newN.uid)) continue;
    takenOld.add(edge.oldN.uid);
    takenNew.add(edge.newN.uid);
    map.set(edge.oldN.uid, edge.newN.uid);
  }
  return map;
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Align frames across snapshots and match every old node.
 * Frames are processed owner-first: top -> nested. A nested frame resolves
 * when its <iframe> owner node matched (auto) to a new owner that also carries
 * a frame, or when its content-derived frame id exists unchanged.
 * Unresolved frames produce pending_frame_unresolved matches — never deletions.
 */
export function reconcile(oldSnap: Snapshot, newSnap: Snapshot): ReconcileResult {
  const started = Date.now();
  const oldByUid = new Map(oldSnap.nodes.map((n) => [n.uid, n]));
  const newByUid = new Map(newSnap.nodes.map((n) => [n.uid, n]));
  const oldByFrame = new Map<string, SnapNode[]>();
  const newByFrame = new Map<string, SnapNode[]>();
  for (const n of oldSnap.nodes) {
    const list = oldByFrame.get(n.frameId) ?? [];
    list.push(n);
    oldByFrame.set(n.frameId, list);
  }
  for (const n of newSnap.nodes) {
    const list = newByFrame.get(n.frameId) ?? [];
    list.push(n);
    newByFrame.set(n.frameId, list);
  }
  const stats = {scoredEdges: 0, candidateBuckets: 0};
  const matches: NodeMatch[] = [];
  const frameAlignment: Record<string, string> = {top: 'top'};

  const oldFrames = oldSnap.frames.slice().sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const newFrameByOwner = new Map(newSnap.frames.map((f) => [f.ownerUid, f]));
  const newFrameIds = new Set(newSnap.frames.map((f) => f.id));

  for (const oldFrame of oldFrames) {
    if (oldFrame.id === 'top') {
      frameAlignment.top = 'top';
    } else if (newFrameIds.has(oldFrame.id)) {
      frameAlignment[oldFrame.id] = oldFrame.id;
    } else {
      // Resolve via the owner node match computed in the parent frame.
      const ownerMatch = matches.find(
        (m) => m.oldRef.uid === oldFrame.ownerUid && m.status === 'auto',
      );
      const newOwner = ownerMatch?.newRef ? newByUid.get(ownerMatch.newRef.uid) : undefined;
      const candidate = newOwner ? newFrameByOwner.get(newOwner.uid) : undefined;
      if (ownerMatch?.newRef && candidate) {
        frameAlignment[oldFrame.id] = candidate.id;
      } else {
        // Unresolved: surface every node of this frame as pending, no guess.
        for (const node of oldByFrame.get(oldFrame.id) ?? []) {
          matches.push({
            oldRef: {frameId: node.frameId, uid: node.uid},
            status: 'pending_frame_unresolved',
            newRef: null,
            confidence: 0,
            reasons: ['frame-unresolved'],
            candidates: [],
            candidatesTruncated: false,
          });
        }
        continue;
      }
    }

    const newFrameId = frameAlignment[oldFrame.id];
    matches.push(...matchFrame(oldByFrame.get(oldFrame.id) ?? [], newByFrame.get(newFrameId) ?? [], stats));
  }

  // Nodes belonging to frames that vanished entirely are already pending above;
  // make sure ordering is deterministic (old snapshot DFS order).
  matches.sort((a, b) => {
    const ao = oldByUid.get(a.oldRef.uid);
    const bo = oldByUid.get(b.oldRef.uid);
    const key = (n?: SnapNode) =>
      n ? `${n.frameId}/${n.path.join('.')}` : a.oldRef.uid;
    return key(ao).localeCompare(key(bo), undefined, {numeric: true});
  });

  // Per-old-node cap CANDIDATE_CAP => at most that many scored edges per old
  // node: a strict linear bound independent of the new DOM size. Building the
  // indexes is O(new nodes), so total work is O(old + new).
  const edgeBound = CANDIDATE_CAP * Math.max(oldSnap.nodes.length, 1);
  return {
    matches,
    frameAlignment,
    stats: {
      oldNodeCount: oldSnap.nodes.length,
      newNodeCount: newSnap.nodes.length,
      scoredEdges: stats.scoredEdges,
      candidateBuckets: stats.candidateBuckets,
      durationMs: Date.now() - started,
      edgeBound,
    },
  };
}
