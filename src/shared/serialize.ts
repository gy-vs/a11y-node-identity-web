// JSON-safe conversion for flat snapshots and match plans.
// Snapshots may cross the client/server boundary; Maps are rebuilt
// explicitly so nothing depends on insertion-order iteration.

import type {FlatSnapshot, StoredSnapshot} from './types';

export type SnapshotWire = {
  snapshotId: string;
  url: string;
  capturedAt: string;
  revision?: number;
  nodes: FlatSnapshot['nodes'];
  frames: FlatSnapshot['frames'];
};

export function serializeSnapshot(snapshot: FlatSnapshot): SnapshotWire {
  return {
    snapshotId: snapshot.snapshotId,
    url: snapshot.url,
    capturedAt: snapshot.capturedAt,
    nodes: snapshot.nodes,
    frames: snapshot.frames,
  };
}

export function deserializeSnapshot(wire: SnapshotWire): StoredSnapshot {
  const byNid = new Map<string, FlatSnapshot['byNid'] extends Map<string, infer V> ? V : never>();
  const frameOf = new Map<string, string[]>();
  for (const frame of wire.frames) {
    for (const node of frame.nodes) {
      byNid.set(node.nid, node);
      frameOf.set(node.nid, frame.framePath);
    }
  }
  const frameOwner = new Map<string, string>();
  // owner of a frame path = the element in the PARENT document whose node.frame points at it
  for (const node of byNid.values()) {
    if (node.node.frame) {
      const fp = node.identity.framePath;
      frameOwner.set([...fp, node.node.frame].join('/'), node.nid);
    }
  }
  const top = wire.frames.find(f => f.framePath.length === 0);
  return {
    snapshotId: wire.snapshotId,
    url: wire.url,
    capturedAt: wire.capturedAt,
    revision: wire.revision ?? 1,
    nodes: top?.nodes ?? wire.nodes,
    frames: wire.frames,
    byNid: byNid as FlatSnapshot['byNid'],
    frameOf,
    frameOwner,
  };
}
