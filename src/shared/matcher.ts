// Deterministic, bounded-complexity node matcher between two snapshots.
//
// Why not pairwise comparison:
//   Nodes are first partitioned into O(N) hash buckets by identity signals
//   (stable keys, role, name signature, anchor, shape). An old node only
//   scores against the UNION of its buckets, each source capped. Total
//   scoring work is O(N + M + C), C = comparisons, with a hard per-old-node
//   candidate cap and a global comparison cap. The algorithm never iterates
//   the Cartesian product old x new.
//
// Determinism:
//   Ties break by (confidence desc, nid asc). Every collection of nodes is
//   explicitly sorted before it influences the result. No Date/Math.random.
//
// Safety:
//   A migration is auto-applied only when the match is unique, mutually the
//   best choice for both sides, confident (>= AUTO_CONFIDENCE) and the margin
//   to the runner-up is sufficient. Everything else — low score,
//   one-to-many / many-to-one, ties, missing nodes, cross-frame moves
//   without a key — becomes a pending confirmation item.

import {fnv1a32} from './hash';
import type {FlatNode, FlatSnapshot, Identity} from './types';
import {textSimilarity} from './text';

export const AUTO_CONFIDENCE = 0.9;
export const CANDIDATE_FLOOR = 0.3;
export const MIN_MARGIN = 0.05;
const MAX_CANDIDATES_PER_SOURCE = 8;
const MAX_CANDIDATES_TOTAL = 24;
const MAX_COMPARISONS = 250_000;
const SAME_TAG_FALLBACK_CAP = 6;

/** Confirmed mapping carried over from an earlier snapshot generation. */
export type AliasHint = {
  oldDescriptor: NodeDescriptor;
  newDescriptor: NodeDescriptor;
  depth: number;
};

/** Portable identity summary stored on findings and audit mapping records. */
export type NodeDescriptor = {
  tag: string;
  name: string;
  keys: {kind: string; value: string}[];
  shape: string;
  structureSig?: string;
  roleDigest: string;
  nameSig: string;
  anchor: string;
  framePath: string[];
  path: number[];
};

export function describe(identity: Identity): NodeDescriptor {
  return {
    tag: identity.tag,
    name: identity.name,
    keys: identity.keys.map(k => ({kind: k.kind, value: k.value})),
    shape: identity.shape,
    structureSig: identity.structureSig,
    roleDigest: identity.roleDigest,
    nameSig: identity.nameSig,
    anchor: identity.anchor,
    framePath: identity.framePath,
    path: identity.path,
  };
}

export type PendingReason =
  | 'no_match'
  | 'low_confidence'
  | 'ambiguous'
  | 'contested'
  | 'cross_frame'
  | 'candidate_cap'
  | 'deleted';

export type MatchSignal =
  | 'stable_key'
  | 'unique_name'
  | 'shape_fingerprint'
  | 'anchor_neighborhood'
  | 'role'
  | 'name_text'
  | 'child_structure'
  | 'alias_chain'
  | 'same_path';

export type Candidate = {
  newNid: string;
  confidence: number;
  signals: {signal: MatchSignal; weight: number}[];
  shapeSimilarity: number;
  nameSimilarity: number;
  crossFrame: boolean;
  samePath: boolean;
};

export type Match = {
  oldNid: string;
  newNid: string;
  confidence: number;
  signals: Candidate['signals'];
  auto: boolean;
  reason: string;
};

export type Pending = {
  oldNid: string;
  reason: PendingReason;
  detail: string;
  candidates: Candidate[];
};

export type MatchStats = {
  oldCount: number;
  newCount: number;
  comparisons: number;
  candidateCapHits: number;
  auto: number;
  pending: number;
  /** deterministic cost proxy, NOT wall-clock (keeps plans reproducible) */
  budgetUsed: number;
};

export type MatchPlan = {
  oldSnapshotId: string;
  newSnapshotId: string;
  matches: Match[];
  pending: Pending[];
  byOld: Map<string, Match>;
  stats: MatchStats;
};

type Bucket = Map<string, FlatNode[]>;

class NewIndex {
  byKey = new Map<string, FlatNode[]>();
  byRole = new Map<string, FlatNode[]>();
  byNameSig = new Map<string, FlatNode[]>();
  byAnchor = new Map<string, FlatNode[]>();
  byShape = new Map<string, FlatNode[]>();
  byStructure = new Map<string, FlatNode[]>();
  byTag = new Map<string, FlatNode[]>();
  // frame-agnostic global variants (cross-frame reach only)
  globalByKey = new Map<string, FlatNode[]>();
  globalByShape = new Map<string, FlatNode[]>();
  globalByStructure = new Map<string, FlatNode[]>();
  all: FlatNode[] = [];
  nameUniverse = new Map<string, number>();
  nameUniverseOld = new Map<string, number>();

  constructor(newSnapshot: FlatSnapshot, oldSnapshot?: FlatSnapshot) {
    this.bucketize(newSnapshot, this.byKey, n => n.identity.keys.length ? n.identity.keyDigest : null);
    this.bucketize(newSnapshot, this.byRole, n => n.identity.roleDigest);
    this.bucketize(newSnapshot, this.byNameSig, n => n.identity.nameSig || null);
    this.bucketize(newSnapshot, this.byAnchor, n => n.identity.anchor);
    this.bucketize(newSnapshot, this.byShape, n => n.identity.shape);
    this.bucketize(newSnapshot, this.byStructure, n => n.identity.structureSig);
    this.bucketize(newSnapshot, this.byTag, n => `${n.identity.tag}`);
    this.bucketizePlain(newSnapshot, this.globalByKey, n => n.identity.keys.length ? n.identity.keyDigest : null);
    this.bucketizePlain(newSnapshot, this.globalByShape, n => n.identity.shape);
    this.bucketizePlain(newSnapshot, this.globalByStructure, n => n.identity.structureSig);
    for (const node of newSnapshot.byNid.values()) {
      this.all.push(node);
      if (node.identity.name) {
        const k = nameKey(node.identity.tag, node.identity.name);
        this.nameUniverse.set(k, (this.nameUniverse.get(k) ?? 0) + 1);
      }
    }
    this.all.sort((a, b) => a.nid.localeCompare(b.nid));
    if (oldSnapshot) {
      for (const node of oldSnapshot.byNid.values()) {
        if (!node.identity.name) continue;
        const k = nameKey(node.identity.tag, node.identity.name);
        this.nameUniverseOld.set(k, (this.nameUniverseOld.get(k) ?? 0) + 1);
      }
    }
  }

  private bucketize(snapshot: FlatSnapshot, bucket: Bucket, keyOf: (n: FlatNode) => string | null) {
    for (const node of snapshot.byNid.values()) {
      const key = keyOf(node);
      if (!key) continue;
      const composite = `${node.identity.framePath.join('/')} ${key}`;
      const list = bucket.get(composite);
      if (list) list.push(node);
      else bucket.set(composite, [node]);
    }
    for (const list of bucket.values()) list.sort((a, b) => a.nid.localeCompare(b.nid));
  }

  private lookup(bucket: Bucket, framePath: string[], key: string, cap: number): FlatNode[] {
    const list = bucket.get(`${framePath.join('/')} ${key}`);
    return list ? list.slice(0, cap) : [];
  }

  private bucketizePlain(snapshot: FlatSnapshot, bucket: Bucket, keyOf: (n: FlatNode) => string | null) {
    for (const node of snapshot.byNid.values()) {
      const key = keyOf(node);
      if (!key) continue;
      const list = bucket.get(key);
      if (list) list.push(node);
      else bucket.set(key, [node]);
    }
    for (const list of bucket.values()) list.sort((a, b) => a.nid.localeCompare(b.nid));
  }

  private lookupGlobal(bucket: Bucket, key: string, cap: number): FlatNode[] {
    const list = bucket.get(key);
    return list ? list.slice(0, cap) : [];
  }

  /**
   * Bounded, deterministically ordered candidate set.
   * Sources are consulted strongest-first and short-circuit as soon as a
   * uniquely identifying bucket (stable key or exact shape, length 1) is
   * found. Cross-frame candidates are reachable only via stable keys or
   * user-confirmed aliases; structure/name buckets stay inside the frame.
   */
  candidates(old: FlatNode, aliasDescriptors: NodeDescriptor[] | undefined): {
    candidates: FlatNode[]; capped: boolean;
  } {
    const id = old.identity;
    const picked = new Map<string, FlatNode>();
    let capped = false;

    const add = (nodes: FlatNode[], sourceCap: number): boolean => {
      let taken = 0;
      for (const node of nodes) {
        if (picked.has(node.nid)) continue;
        if (taken >= sourceCap) { capped = true; return true; }
        if (picked.size >= MAX_CANDIDATES_TOTAL) { capped = true; return true; }
        picked.set(node.nid, node);
        taken += 1;
      }
      return false;
    };
    const size = () => picked.size;

    // strongest: stable keys (same frame, then the cross-frame key bucket)
    if (id.keys.length) {
      const keyHits = this.lookup(this.byKey, id.framePath, id.keyDigest, MAX_CANDIDATES_PER_SOURCE);
      add(keyHits, MAX_CANDIDATES_PER_SOURCE);
      if (keyHits.length === 1) {
        add(this.lookupGlobal(this.globalByKey, id.keyDigest, 4), 4); // frame move detection
        return done(picked, capped);
      }
      if (size() === 0) add(this.lookupGlobal(this.globalByKey, id.keyDigest, 4), 4);
      if (size() > 0) return done(picked, capped);
    }

    // exact structural fingerprint: in this tree shape includes normalized
    // text and stable attrs, so a length-1 hit is decisive evidence
    const shapeHits = this.lookup(this.byShape, id.framePath, id.shape, MAX_CANDIDATES_PER_SOURCE);
    if (shapeHits.length === 1) {
      add(shapeHits, MAX_CANDIDATES_PER_SOURCE);
      return done(picked, capped);
    }
    if (shapeHits.length > 1) add(shapeHits, 6);

    // secondary identity signals, each source tightly capped
    if (id.nameSig) {
      add(this.lookup(this.byNameSig, id.framePath, id.nameSig, 5), 5);
    }
    add(this.lookup(this.byRole, id.framePath, id.roleDigest, 4), 4);
    if (id.anchor && id.anchor !== 'root') {
      add(this.lookup(this.byAnchor, id.framePath, id.anchor, 4), 4);
    }

    // confirmed mappings from older generations extend identity across time.
    // The latest descriptor in each chain is the best predictor of where the
    // node is now; its role/structure buckets are consulted even when text
    // edits changed its shape, so a confirmed chain survives content churn.
    if (aliasDescriptors?.length) {
      const latest = aliasDescriptors[aliasDescriptors.length - 1];
      if (latest.keys.length) add(this.lookupGlobal(this.globalByKey, aliasKeyDigest(latest), 4), 4);
      if (latest.shape) add(this.lookupGlobal(this.globalByShape, latest.shape, 4), 4);
      if (latest.roleDigest) add(this.lookup(this.byRole, latest.framePath, latest.roleDigest, 6), 6);
      const latestStruct = structureSigOf(latest);
      if (latestStruct) add(this.lookup(this.byStructure, latest.framePath, latestStruct, 6), 6);
      if (latest.nameSig) add(this.lookup(this.byNameSig, latest.framePath, latest.nameSig, 4), 4);
    }

    // last-resort within the SAME frame, small hard cap. Deleted nodes get
    // few weak candidates and resolve as deleted/no_match.
    if (picked.size === 0) {
      add(this.lookup(this.byTag, id.framePath, id.tag, SAME_TAG_FALLBACK_CAP), SAME_TAG_FALLBACK_CAP);
    }

    // bounded CROSS-FRAME structural fallback (only after in-frame options
    // are exhausted). These candidates are capped below the auto threshold
    // by score() and always surface as a cross_frame confirmation prompt.
    if (picked.size === 0) {
      add(this.lookupGlobal(this.globalByStructure, id.structureSig, 4), 4);
    }
    if (picked.size === 0 && id.shape) {
      add(this.lookupGlobal(this.globalByShape, id.shape, 4), 4);
    }

    return done(picked, capped);
  }

  /** unique accessible name on BOTH sides: safe auto-migration signal */
  isUniqueNameBothSides(tag: string, name: string): boolean {
    const k = nameKey(tag, name);
    return (this.nameUniverse.get(k) ?? 0) === 1 && (this.nameUniverseOld.get(k) ?? 0) === 1;
  }

  /** exact shape appears at most once inside the candidate's frame */
  isShapeUniqueInFrame(node: FlatNode): boolean {
    const list = this.byShape.get(`${node.identity.framePath.join('/')} ${node.identity.shape}`);
    return !list || list.length === 1;
  }

  /** text-free structural signature is unique inside the candidate's frame.
   *  Repeated components (cards/rows) collide here and stay ambiguous. */
  isStructureUniqueInFrame(node: FlatNode): boolean {
    const list = this.byStructure.get(`${node.identity.framePath.join('/')} ${node.identity.structureSig}`);
    return !list || list.length === 1;
  }
}

function nameKey(tag: string, name: string): string {
  return `${tag} ${name.toLowerCase()}`;
}

function done(picked: Map<string, FlatNode>, capped: boolean) {
  return {
    candidates: [...picked.values()].sort((a, b) => a.nid.localeCompare(b.nid)),
    capped,
  };
}

function aliasKeyDigest(descriptor: NodeDescriptor): string {
  return fnv1a32(JSON.stringify(descriptor.keys.map(k => [k.kind, k.value.toLowerCase()])));
}

function structureSigOf(descriptor: NodeDescriptor): string {
  if (descriptor.structureSig) return descriptor.structureSig;
  // descriptors persisted before structureSig existed: cannot reconstruct
  // the child multiset here, so fall back to the role digest bucket.
  return descriptor.roleDigest;
}

function multisetSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let inter = 0; let union = 0;
  for (const key of keys) {
    inter += Math.min(a[key] ?? 0, b[key] ?? 0);
    union += Math.max(a[key] ?? 0, b[key] ?? 0);
  }
  return union ? inter / union : 0;
}

type Scored = Candidate & {node: FlatNode; uniqueName: boolean; exactKey: boolean};

function score(old: FlatNode, node: FlatNode, index: NewIndex, aliasDepth: number,
  aliasDescriptors: NodeDescriptor[] | undefined): Scored | null {
  const oi = old.identity;
  const ni = node.identity;
  const signals: Candidate['signals'] = [];
  const crossFrame = oi.framePath.join('/') !== ni.framePath.join('/');
  const samePath = pathEq(oi.path, ni.path);

  let sum = 0;
  let total = 0;
  const addSignal = (signal: MatchSignal, weight: number, value: number) => {
    signals.push({signal, weight: round4(weight * value)});
    sum += weight * value;
    total += weight;
  };

  // 1. stable attributes (strongest). Conflicting keys => hard reject.
  let exactKey = false;
  if (oi.keys.length || ni.keys.length) {
    exactKey = oi.keys.length > 0 && ni.keys.length > 0 && oi.keyDigest === ni.keyDigest;
    if (!exactKey) {
      return {
        node, newNid: node.nid, confidence: 0.1,
        signals: [], shapeSimilarity: 0, nameSimilarity: 0,
        crossFrame, samePath, uniqueName: false, exactKey: false,
      };
    }
    addSignal('stable_key', 0.42, 1);
  }

  // 2. structure fingerprint (shape includes tag + stable attrs + text)
  const childSim = multisetSimilarity(oi.childTagCounts, ni.childTagCounts);
  const exactShape = oi.shape === ni.shape;
  const shapeSim = exactShape ? 1 : Math.max(
    oi.roleDigest === ni.roleDigest ? 0.55 : 0,
    childSim * 0.8,
  );
  addSignal('shape_fingerprint', 0.34, shapeSim);

  // 3. role/aria
  addSignal('role', 0.08, oi.roleDigest === ni.roleDigest ? 1 : 0);

  // 4. accessible name / text (tolerates text edits)
  let nameSim = 0;
  if (oi.name || ni.name) nameSim = oi.name === ni.name ? 1 : textSimilarity(oi.name, ni.name);
  addSignal('name_text', 0.1, nameSim);

  // 5. child structure multiset
  addSignal('child_structure', 0.04, childSim);

  // 6. neighborhood anchor
  const anchorMatch = oi.anchor === ni.anchor && oi.anchor !== 'root';
  addSignal('anchor_neighborhood', 0.16, anchorMatch ? 1 : 0);

  // 7. same legacy path — tiny tie-breaker only, never identity
  addSignal('same_path', 0.02, samePath ? 1 : 0);

  // 8. user-confirmed cross-generation alias: a human already attested that
  // this logical identity survives across generations. Strong signal.
  let aliasHit = 0;
  if (aliasDepth > 0 && aliasDescriptors?.length) {
    const latest = aliasDescriptors[aliasDescriptors.length - 1];
    if (latest.keys.length) {
      aliasHit = ni.keys.length && ni.keyDigest === oi.keyDigest ? 1 : 0.4;
    } else if (latest.shape === ni.shape) {
      aliasHit = 1;
    } else if (latest.roleDigest === ni.roleDigest &&
      structureSigOf(latest) === ni.structureSig) {
      aliasHit = 0.9; // same role/component kind after a text edit
    } else if (latest.roleDigest === ni.roleDigest) {
      aliasHit = 0.6;
    }
    addSignal('alias_chain', 0.3, aliasHit * (1 / (1 + Math.min(aliasDepth, 3) * 0.15)));
  }

  let confidence = total > 0 ? sum / total : 0;

  // boosts -----------------------------------------------------------------
  // exact shape is unique in-frame, its text-free structural signature is
  // also unique (so this is not a repeated component), and the neighborhood
  // corroborates it: safe to auto-migrate even without a stable attribute.
  const shapeUnique = exactShape &&
    index.isShapeUniqueInFrame(node) &&
    index.isStructureUniqueInFrame(node) &&
    anchorMatch;
  const uniqueName = !!oi.name && !!ni.name && oi.tag === ni.tag && nameSim >= 0.85 &&
    index.isUniqueNameBothSides(oi.tag, oi.name);
  if (uniqueName) {
    addSignal('unique_name', 0, 1); // marker; confidence boost below
    confidence = Math.max(confidence, exactKey ? 0.97 : 0.93);
  }
  if (shapeUnique && anchorMatch) confidence = Math.max(confidence, 0.92);
  if (exactKey && !crossFrame) confidence = Math.max(confidence, 0.93);
  if (exactKey && crossFrame) confidence = Math.min(Math.max(confidence, 0.9), 0.97);
  if (crossFrame && !exactKey) confidence = Math.min(confidence, 0.55);

  if (confidence < CANDIDATE_FLOOR) return null;

  return {
    node,
    newNid: node.nid,
    confidence: round4(Math.min(0.99, confidence)),
    signals: signals.filter(s => s.weight > 0).sort((a, b) => b.weight - a.weight),
    shapeSimilarity: round4(shapeSim),
    nameSimilarity: round4(nameSim),
    crossFrame,
    samePath,
    uniqueName,
    exactKey,
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function pathEq(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export type MatchInput = {
  oldSnapshot: FlatSnapshot;
  newSnapshot: FlatSnapshot;
  aliases?: Map<string, AliasHint[]>;
};

export function matchSnapshots(input: MatchInput): MatchPlan {
  const {oldSnapshot, newSnapshot} = input;
  const index = new NewIndex(newSnapshot, oldSnapshot);

  const oldNodes = [...oldSnapshot.byNid.values()].sort((a, b) => a.nid.localeCompare(b.nid));

  // ---- bounded scoring phase ---------------------------------------------
  const scoredByOld = new Map<string, Scored[]>();
  const cappedOlds = new Set<string>();
  let comparisons = 0;
  let capHits = 0;

  for (const old of oldNodes) {
    const aliases = input.aliases?.get(old.nid);
    const aliasDescriptors = aliases?.map(a => a.newDescriptor);
    const deepest = aliases?.reduce((mx, a) => Math.max(mx, a.depth), 0) ?? 0;
    const gathered = index.candidates(old, aliasDescriptors);
    if (gathered.capped) { capHits += 1; cappedOlds.add(old.nid); }

    const scored: Scored[] = [];
    for (const candidate of gathered.candidates) {
      if (comparisons >= MAX_COMPARISONS) { cappedOlds.add(old.nid); break; }
      comparisons += 1;
      const result = score(old, candidate, index, deepest, aliasDescriptors);
      if (result && result.confidence >= CANDIDATE_FLOOR) scored.push(result);
    }
    scored.sort((a, b) =>
      b.confidence - a.confidence ||
      a.node.nid.localeCompare(b.node.nid));
    scoredByOld.set(old.nid, scored);
  }

  // ---- one-to-one assignment phase ----------------------------------------
  // O(C) reverse-choice index: for every NEW nid, which OLD node scores it
  // highest (deterministic nid tiebreak). Built once — no old*old scan.
  const reverseBest = new Map<string, {oldNid: string; confidence: number}>();
  for (const old of oldNodes) {
    const best = scoredByOld.get(old.nid)![0];
    if (!best) continue;
    const current = reverseBest.get(best.newNid);
    if (!current || best.confidence > current.confidence ||
      (best.confidence === current.confidence && old.nid.localeCompare(current.oldNid) < 0)) {
      reverseBest.set(best.newNid, {oldNid: old.nid, confidence: best.confidence});
    }
  }

  const assigned = new Map<string, Scored>();
  const takenBy = new Map<string, string>();

  // confident, margined, same-frame (or keyed cross-frame) tentative matches
  const tentative = new Map<string, Scored>();
  for (const old of oldNodes) {
    const list = scoredByOld.get(old.nid)!;
    const best = list[0];
    if (!best || best.confidence < AUTO_CONFIDENCE) continue;
    if (best.confidence - (list[1]?.confidence ?? 0) < MIN_MARGIN) continue;
    if (best.crossFrame && !best.exactKey) continue;
    tentative.set(old.nid, best);
  }

  // mutual-best-first lock-in
  for (const [oldNid, best] of tentative) {
    const rev = reverseBest.get(best.newNid);
    if (rev && rev.oldNid === oldNid && rev.confidence >= best.confidence - 0.0001) {
      assigned.set(oldNid, best);
      takenBy.set(best.newNid, oldNid);
    }
  }

  // remaining: deterministic greedy (confidence desc, old nid asc); never
  // steal a taken target, and refuse contested reverse choices
  const rest = [...tentative.entries()]
    .filter(([oldNid]) => !assigned.has(oldNid))
    .sort((a, b) => b[1].confidence - a[1].confidence || a[0].localeCompare(b[0]));
  for (const [oldNid, best] of rest) {
    if (takenBy.has(best.newNid)) continue;
    const rev = reverseBest.get(best.newNid);
    if (rev && rev.oldNid !== oldNid && rev.confidence >= best.confidence - 0.0001) continue;
    assigned.set(oldNid, best);
    takenBy.set(best.newNid, oldNid);
  }

  const matches: Match[] = [];
  const pending: Pending[] = [];
  for (const old of oldNodes) {
    const chosen = assigned.get(old.nid);
    if (chosen) {
      matches.push({
        oldNid: old.nid,
        newNid: chosen.newNid,
        confidence: chosen.confidence,
        signals: chosen.signals,
        auto: true,
        reason: explainAuto(chosen),
      });
      continue;
    }
    pending.push(classify(old, scoredByOld.get(old.nid)!, takenBy,
      cappedOlds.has(old.nid), comparisons >= MAX_COMPARISONS));
  }

  const end = 0;
  void end;
  return {
    oldSnapshotId: oldSnapshot.snapshotId,
    newSnapshotId: newSnapshot.snapshotId,
    matches,
    pending,
    byOld: new Map(matches.map(m => [m.oldNid, m])),
    stats: {
      oldCount: oldNodes.length,
      newCount: newSnapshot.byNid.size,
      comparisons,
      candidateCapHits: capHits,
      auto: matches.length,
      pending: pending.length,
      budgetUsed: comparisons * 10 + capHits,
    },
  };
}

function explainAuto(scored: Scored): string {
  if (scored.signals.some(s => s.signal === 'stable_key')) {
    return scored.crossFrame
      ? 'stable key unique across the iframe boundary'
      : 'unique stable attribute match';
  }
  if (scored.uniqueName) return 'globally unique accessible name with matching structure';
  if (scored.samePath && scored.confidence >= 0.95) return 'stable structure at the same position';
  return 'high-confidence structural fingerprint match';
}

function classify(
  old: FlatNode,
  list: Scored[],
  takenBy: Map<string, string>,
  wasCapped: boolean,
  globalCapReached: boolean,
): Pending {
  const toCandidate = (s: Scored): Candidate => ({
    newNid: s.newNid,
    confidence: s.confidence,
    signals: s.signals,
    shapeSimilarity: s.shapeSimilarity,
    nameSimilarity: s.nameSimilarity,
    crossFrame: s.crossFrame,
    samePath: s.samePath,
  });

  if (list.length === 0) {
    return {
      oldNid: old.nid,
      reason: 'deleted',
      detail: 'no surviving element shares identity signals; node appears deleted',
      candidates: [],
    };
  }

  const best = list[0];
  const runner = list[1];
  const candidates = list.slice(0, 5).map(toCandidate);

  if (wasCapped || globalCapReached) {
    return {
      oldNid: old.nid, reason: 'candidate_cap',
      detail: 'candidate search hit the bounded cap; manual confirmation required',
      candidates,
    };
  }
  if (best.crossFrame && !best.exactKey) {
    return {
      oldNid: old.nid, reason: 'cross_frame',
      detail: 'candidate lies across an iframe boundary without a decisive stable key',
      candidates,
    };
  }
  if (takenBy.has(best.newNid)) {
    return {
      oldNid: old.nid, reason: 'contested',
      detail: `best candidate ${best.newNid} was already claimed by another reviewed node`,
      candidates,
    };
  }
  if (runner && best.confidence - runner.confidence < MIN_MARGIN) {
    return {
      oldNid: old.nid, reason: 'ambiguous',
      detail: `top candidates tie within margin ${MIN_MARGIN}: ${best.confidence} vs ${runner.confidence}`,
      candidates,
    };
  }
  if (best.confidence < AUTO_CONFIDENCE) {
    return {
      oldNid: old.nid,
      reason: best.confidence < 0.55 ? 'no_match' : 'low_confidence',
      detail: best.confidence < 0.55
        ? `best similarity only ${best.confidence}; node likely deleted`
        : `confidence ${best.confidence} below auto-migration threshold ${AUTO_CONFIDENCE}`,
      candidates,
    };
  }
  return {
    oldNid: old.nid, reason: 'ambiguous',
    detail: 'undecidable under the one-to-one constraint',
    candidates,
  };
}

export function isFrameBoundary(a: Identity, b: Identity): boolean {
  return a.framePath.join('/') !== b.framePath.join('/');
}
