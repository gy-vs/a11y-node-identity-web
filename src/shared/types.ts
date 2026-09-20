// Wire and storage model for serialized DOM snapshots.
// A snapshot is a frame forest; each frame contains a node tree, and an
// <iframe> node may reference a child frame by its local id.

export type SNode = {
  tag: string;                 // lowercased element tag, or '#text'
  attrs?: Record<string, string>;
  text?: string;               // direct text for #text nodes
  children?: SNode[];
  frame?: string;              // id of child SFrame attached to this iframe node
};

export type SFrame = {
  id: string;                  // locally unique frame id, e.g. 'f0'
  src?: string;
  title?: string;
  root: SNode;                 // iframe content document root
};

export type SnapshotInput = {
  url: string;
  capturedAt: string;
  root: SNode;
  frames?: SFrame[];
};

/** Strong, user-authored stable attribute that survives re-renders. */
export type StableKey = {
  kind: 'id' | 'data-testid' | 'aria-label' | 'name';
  value: string;
};

/**
 * Stable identity for one element.
 *
 *  - keys       : stable attribute keys (the strongest signal)
 *  - shape      : structural fingerprint of the subtree (tag/attrs/text/depth)
 *  - roleDigest : fingerprint of element role + ARIA + tag (ignores text)
 *  - name       : accessible name (normalized descendant text / aria-label)
 *  - nameSig    : bucket signature for same-name nodes (tag + name + class)
 *  - anchor     : nearest persistent ancestor or stable neighbor hint
 *  - framePath  : chain of frame ids from the top document
 *  - path       : child-index path, kept ONLY for diagnostics (never identity)
 */
export type Identity = {
  nid: string;
  keys: StableKey[];
  keyDigest: string;
  shape: string;
  /** text-free structural signature: tag + immediate child tag multiset.
   *  Repeated instances of one component share this despite text edits,
   *  which is exactly what flags twin ambiguity. */
  structureSig: string;
  roleDigest: string;
  tag: string;
  name: string;
  nameSig: string;
  anchor: string;
  framePath: string[];
  /** immediate element-child tag multiset + count — cheap local structure signal */
  childTagCounts: Record<string, number>;
  childCount: number;
  path: number[];
};

export type FlatNode = {
  nid: string;
  node: SNode;
  depth: number;
  parent: string | null;
  identity: Identity;
};

export type FlatFrame = SFrame & {framePath: string[]; nodes: FlatNode[]};

export type FlatSnapshot = {
  snapshotId: string;
  url: string;
  capturedAt: string;
  nodes: FlatNode[];            // top-frame nodes
  frames: FlatFrame[];
  byNid: Map<string, FlatNode>;
  frameOf: Map<string, string[]>; // nid -> framePath
  /** nid of a node in the PARENT document that owns this frame ('' for top). */
  frameOwner: Map<string, string>; // framePath.join('/') -> owner nid
};

export type ReviewStatus = 'open' | 'ignored' | 'fixed';

/** A review finding. target uses stable identity, never a child-index path. */
export type Finding = {
  id: string;
  rule: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
  status: ReviewStatus;
  target: string;               // nid in the snapshot where it was created
  /** identity captured at creation, used to explain provenance */
  targetIdentity: Identity;
  createdAt: string;
};

export type StoredSnapshot = FlatSnapshot & {revision: number };
