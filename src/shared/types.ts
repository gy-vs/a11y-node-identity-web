// Shared data model for cross-snapshot node identity.
// Node identity is NEVER a child-index path: paths are display-only.

export type FrameId = string;

/** A node as captured from a live DOM (client) or constructed in tests. */
export interface RawNode {
  tag: string;
  attrs?: Record<string, string>;
  /** Direct (own) text content; normalization happens in the builder. */
  text?: string;
  children?: RawNode[];
  /** Present when this node is an <iframe> with same-origin accessible content. */
  frame?: RawFrame;
}

export interface RawFrame {
  /** window.name, when available. */
  name?: string;
  root: RawNode;
}

/** Pointer to a node inside a stored snapshot. */
export interface NodeRef {
  frameId: FrameId;
  uid: string;
}

export interface Fingerprint {
  /** Stable identity keys, e.g. "id:mainnav", sorted and de-duplicated. */
  stableKeys: string[];
  role: string | null;
  /** Accessible-name proxy (aria-label / labelledby / label[for] / own text). */
  name: string;
  /** Normalized, truncated own text. */
  text: string;
  /** Cheap signature of non-stable attributes (class, href, type, aria-* ...). */
  attrSig: string;
  /** Hash of the node's own (non-structural) properties. */
  localSig: string;
}

export interface SnapNode {
  uid: string;
  frameId: FrameId;
  tag: string;
  /** All captured attributes (stable attributes are a documented subset). */
  attrs: Record<string, string>;
  text: string;
  /** Child-index path INSIDE THE FRAME. Display/debug only, never identity. */
  path: number[];
  depth: number;
  childCount: number;
  /** Number of nodes in the whole subtree (including this node). */
  subtreeSize: number;
  parentUid: string | null;
  childUids: string[];
  prevSiblingUids: string[];
  nextSiblingUids: string[];
  fingerprint: Fingerprint;
  /** Merkle hash over localSig + children's structHash. */
  structHash: string;
  /** Sorted multiset of immediate-child tag/role pairs. */
  childSig: string;
}

export interface FrameInfo {
  id: FrameId;
  parentFrameId: FrameId | null;
  /** UID of the <iframe> element owning this frame, in the parent frame. */
  ownerUid: string | null;
  name?: string;
  rootUid: string;
  depth: number;
}

export interface Snapshot {
  id: string;
  auditId: string;
  seq: number;
  createdAt: string;
  frames: FrameInfo[];
  nodes: SnapNode[];
  /** frameId -> root uid */
  roots: Record<string, string>;
}

/** Lightweight, denormalized node description safe to retain after cleanup. */
export interface NodeView {
  ref: NodeRef;
  label: string;
  pathText: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
  role: string | null;
  name: string;
  childCount: number;
  subtreeSize: number;
  structHash: string;
}

export type MatchStatusCode =
  | 'auto'
  | 'pending_ambiguous'
  | 'pending_low_confidence'
  | 'pending_candidate_truncated'
  | 'pending_frame_unresolved'
  | 'deleted';

export interface ScoredCandidate {
  ref: NodeRef;
  score: number;
  margin: number;
  reasons: string[];
}

export interface NodeMatch {
  oldRef: NodeRef;
  status: MatchStatusCode;
  newRef: NodeRef | null;
  confidence: number;
  reasons: string[];
  candidates: ScoredCandidate[];
  /** True when the candidate space was cut off by the per-node bound. */
  candidatesTruncated: boolean;
}

export interface ReconcileStats {
  oldNodeCount: number;
  newNodeCount: number;
  scoredEdges: number;
  candidateBuckets: number;
  durationMs: number;
  /** scoredEdges <= CANDIDATE_CAP * max(old,new) — the linear upper bound. */
  edgeBound: number;
}

export interface ReconcileResult {
  matches: NodeMatch[];
  stats: ReconcileStats;
  /** old frameId -> new frameId, for resolved frames. */
  frameAlignment: Record<string, string>;
}

export type FindingStatus =
  | 'open'
  | 'ignored'
  | 'carried' // review result auto-migrated across snapshots
  | 'pending' // waits for an explicit node mapping decision
  | 'dropped'; // node believed deleted; user marked the finding closed

export type IssueSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

/** A review finding (e.g. an ignored issue). Anchored to an explicit mapping. */
export interface Finding {
  id: string;
  auditId: string;
  rule: string;
  severity: IssueSeverity;
  message: string;
  status: FindingStatus;
  /** Snapshot in which the finding was authored. */
  snapshotId: string;
  anchor: NodeRef;
  /** Denormalized descriptor retained even after snapshots are pruned. */
  anchorView: NodeView;
  /** Mapping row that currently anchors the finding (null only when pending). */
  mappingId: string | null;
  updatedAt: string;
}

export type MappingDecision = 'auto' | 'confirmed' | 'rejected';

/**
 * Explicit, auditable correspondence between two node versions.
 * Mapping rows are NEVER pruned: they are the audit trail that survives
 * snapshot cleanup. NodeView payloads are denormalized on purpose.
 */
export interface MappingRow {
  id: string;
  auditId: string;
  oldSnapshotId: string;
  newSnapshotId: string;
  oldNode: NodeView;
  newNode: NodeView | null; // null = explicit "deleted / no counterpart"
  confidence: number;
  decision: MappingDecision;
  reasons: string[];
  decidedBy: string;
  decidedAt: string;
}

export interface AuditState {
  audit: {id: string; name: string; revision: number; updatedAt: string};
  snapshots: Array<{
    id: string;
    seq: number;
    createdAt: string;
    nodeCount: number;
    frameCount: number;
    pruned: boolean;
  }>;
  findings: Finding[];
  pendingMappings: Array<{
    mappingDraftId: string;
    findingId: string;
    oldNode: NodeView;
    currentNode: NodeView | null;
    candidates: Array<NodeView & {score: number; reasons: string[]}>;
    status: MatchStatusCode;
    confidence: number;
  }>;
  stats?: ReconcileStats;
}
