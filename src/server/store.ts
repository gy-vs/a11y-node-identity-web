// In-memory review store: audits, DOM snapshots, findings, match plans,
// and explicit node mappings.
//
// Audit mapping records live in their own append-only table. Deleting old
// snapshots (cleanup) does NOT delete confirmed mappings: the mapping table
// is the audit trail, and earlier generations of a mapping also serve as
// identity aliases when matching across multiple re-captures.

import type {
  Finding, FlatSnapshot, Identity, ReviewStatus, SnapshotInput, StoredSnapshot,
} from '../shared/types';
import {flattenSnapshot} from '../shared/dom';
import {serializeSnapshot} from '../shared/serialize';
import {
  matchSnapshots, type AliasHint, type Candidate, type MatchPlan, type NodeDescriptor,
} from '../shared/matcher';
import {describe} from '../shared/matcher';

export type AuditRow = {
  id: string; name: string; revision: number; content: string; updatedAt: string;
};

export type SnapshotRecord = {
  id: string;
  auditId: string;
  revision: number;
  capturedAt: string;
  url: string;
  data: ReturnType<typeof serializeSnapshot>;
  flat: StoredSnapshot;
};

export type ExplicitMapping = {
  id: string;
  auditId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  oldNid: string;
  newNid: string;
  oldDescriptor: NodeDescriptor;
  newDescriptor: NodeDescriptor;
  /** which candidate was chosen, when one existed */
  chosenCandidate?: Candidate | null;
  resolution: 'confirmed' | 'deleted_accepted' | 'ignored_unmapped';
  confirmedBy: string;
  confirmedAt: string;
  /** true when the old snapshot has since been cleaned up */
  sourceSnapshotPruned: boolean;
};

export type FindingRecord = Finding & {auditId: string; snapshotId: string};

export type Review = {
  auditId: string;
  snapshots: SnapshotRecord[];      // newest last
  findings: FindingRecord[];
  mappings: ExplicitMapping[];      // append-only audit trail
  /** snapshot id whose pending state currently applies */
  latestPlan?: MatchPlan & {generatedAt: string};
  /** findings auto-migrated by the latest /match run (per run, not history) */
  lastAutoMigrations?: Array<{findingId: string; oldNid: string; newNid: string; confidence: number}>;
};

export class ReviewStore {
  rows = new Map<string, AuditRow>();
  reviews = new Map<string, Review>();

  constructor() {
    const seed: AuditRow[] = [
      {id: 'alpha', name: 'Primary review findings', revision: 3, content: 'review findings: alpha\nstate: active', updatedAt: new Date(0).toISOString()},
      {id: 'beta', name: 'Secondary review findings', revision: 5, content: 'review findings: beta\nstate: review', updatedAt: new Date(1000).toISOString()},
    ];
    for (const row of seed) {
      this.rows.set(row.id, row);
      this.reviews.set(row.id, {auditId: row.id, snapshots: [], findings: [], mappings: []});
    }
  }

  review(auditId: string): Review | undefined {
    return this.reviews.get(auditId);
  }

  /** review-specific endpoints lazily create an empty review workspace */
  ensureReview(auditId: string): Review {
    let review = this.reviews.get(auditId);
    if (!review) {
      review = {auditId, snapshots: [], findings: [], mappings: []};
      this.reviews.set(auditId, review);
      if (!this.rows.has(auditId)) {
        this.rows.set(auditId, {
          id: auditId, name: `Review ${auditId}`, revision: 1, content: '',
          updatedAt: new Date(0).toISOString(),
        });
      }
    }
    return review;
  }

  requireReview(auditId: string): Review {
    return this.ensureReview(auditId);
  }

  addSnapshot(auditId: string, input: SnapshotInput): SnapshotRecord {
    const review = this.requireReview(auditId);
    const revision = review.snapshots.length + 1;
    const id = `${auditId}-snap-${revision}`;
    const flat: StoredSnapshot = Object.assign(
      flattenSnapshot(input, id), {revision});
    const record: SnapshotRecord = {
      id, auditId, revision,
      capturedAt: input.capturedAt,
      url: input.url,
      data: serializeSnapshot(flat),
      flat,
    };
    review.snapshots.push(record);
    return record;
  }

  addFindings(auditId: string, snapshotId: string, seeds: Array<{
    target: string; rule: string; message: string;
    severity: 'low' | 'medium' | 'high'; status?: ReviewStatus;
  }>): FindingRecord[] {
    const review = this.requireReview(auditId);
    const snapshot = this.requireSnapshot(auditId, snapshotId);
    const created: FindingRecord[] = [];
    for (const seed of seeds) {
      const flat = snapshot.flat.byNid.get(seed.target);
      if (!flat) throw Object.assign(new Error('unknown_target'), {status: 400});
      const record: FindingRecord = {
        id: `${auditId}-f-${review.findings.length + created.length + 1}`,
        auditId, snapshotId,
        rule: seed.rule,
        message: seed.message,
        severity: seed.severity,
        status: seed.status ?? 'open',
        target: seed.target,
        targetIdentity: flat.identity,
        createdAt: seed.status === 'ignored' ? '2026-09-10T10:00:00.000Z' : '2026-09-09T10:00:00.000Z',
      };
      review.findings.push(record);
      created.push(record);
    }
    return created;
  }

  setFindingStatus(auditId: string, findingId: string, status: ReviewStatus): FindingRecord {
    const review = this.requireReview(auditId);
    const finding = review.findings.find(f => f.id === findingId && f.auditId === auditId);
    if (!finding) throw Object.assign(new Error('finding_not_found'), {status: 404});
    finding.status = status;
    return finding;
  }

  requireSnapshot(auditId: string, snapshotId: string): SnapshotRecord {
    const review = this.requireReview(auditId);
    const snapshot = review.snapshots.find(s => s.id === snapshotId && s.auditId === auditId);
    if (!snapshot) throw Object.assign(new Error('snapshot_not_found'), {status: 404});
    return snapshot;
  }

  /**
   * Build the confirmed mapping chains. A chain starts at a mapping whose
   * source snapshot is the matching source and follows later hops by linking
   * one hop's destination descriptor to the next hop's source descriptor.
   * Returns chains keyed by the ORIGIN node descriptor (generation-independent
   * identity), because nids are reassigned on every flatten.
   */
  buildAliasChains(review: Review, fromSnapshotId: string): AliasHint[][] {
    const revOf = (snapshotId: string) =>
      review.snapshots.find(s => s.id === snapshotId)?.revision ?? Number.MAX_SAFE_INTEGER;
    const ordered = review.mappings
      .filter(m => m.resolution === 'confirmed' && m.newNid)
      .sort((a, b) => revOf(a.fromSnapshotId) - revOf(b.fromSnapshotId) || a.id.localeCompare(b.id));

    const chains: AliasHint[][] = [];
    for (const startMap of ordered.filter(m => m.fromSnapshotId === fromSnapshotId)) {
      let current = startMap.newDescriptor;
      let depth = 1;
      const hints: AliasHint[] = [
        {oldDescriptor: startMap.oldDescriptor, newDescriptor: current, depth},
      ];
      for (let guard = 0; guard < ordered.length; guard++) {
        const next = ordered.find(m =>
          m.fromSnapshotId !== fromSnapshotId && descriptorsLink(current, m.oldDescriptor));
        if (!next) break;
        current = next.newDescriptor;
        depth += 1;
        hints.push({oldDescriptor: startMap.oldDescriptor, newDescriptor: current, depth});
      }
      chains.push(hints);
    }
    return chains;
  }

  /**
   * Resolve confirmed alias hints to the nids of the actual old snapshot
   * being matched. A node in oldSnapshot joins a chain when its descriptor
   * matches the chain's endpoint that lives in (or before) that snapshot.
   */
  aliasesForMatching(review: Review, oldSnapshotId: string): Map<string, AliasHint[]> {
    const oldSnap = review.snapshots.find(s => s.id === oldSnapshotId);
    if (!oldSnap) return new Map();
    const result = new Map<string, AliasHint[]>();

    // chains may start at this snapshot, or at an earlier one whose endpoint
    // has already advanced into this snapshot.
    const chainStarts = new Set(review.mappings
      .filter(m => m.resolution === 'confirmed')
      .map(m => m.fromSnapshotId));
    void chainStarts;

    for (const mapping of review.mappings.filter(m => m.resolution === 'confirmed' && m.newNid)) {
      // Does this mapping's NEW endpoint describe a node present in oldSnapshot?
      // That happens when toSnapshotId === oldSnapshotId (the node arrived here),
      // or when the node is auto-resident (same descriptor, earlier confirmed).
      if (mapping.toSnapshotId === oldSnapshotId) {
        const flat = oldSnap.flat.byNid.get(mapping.newNid);
        if (flat) {
          // continue the chain forward from this node
          const chains = this.buildAliasChains(review, mapping.fromSnapshotId);
          const chain = chains.find(c => c.some(h =>
            descriptorsLink(h.newDescriptor, describe(flat.identity)))) ??
            [{oldDescriptor: mapping.oldDescriptor, newDescriptor: mapping.newDescriptor, depth: 1}];
          result.set(flat.nid, chain);
        }
      }
    }
    // chains originating directly at this snapshot
    for (const chain of this.buildAliasChains(review, oldSnapshotId)) {
      const origin = chain[0].oldDescriptor;
      for (const flat of oldSnap.flat.byNid.values()) {
        if (descriptorsLink(origin, describe(flat.identity))) {
          if (!result.has(flat.nid)) result.set(flat.nid, chain);
        }
      }
    }
    return result;
  }


  planMatch(auditId: string, oldSnapshotId: string, newSnapshotId: string, now: string) {
    const review = this.requireReview(auditId);
    const oldSnap = this.requireSnapshot(auditId, oldSnapshotId);
    const newSnap = this.requireSnapshot(auditId, newSnapshotId);
    const aliases = this.aliasesForMatching(review, oldSnapshotId);
    const plan = matchSnapshots({
      oldSnapshot: oldSnap.flat as FlatSnapshot,
      newSnapshot: newSnap.flat as FlatSnapshot,
      aliases,
    });
    const stored = Object.assign(plan, {generatedAt: now});
    review.latestPlan = stored;
    return {plan: stored, review, oldSnap, newSnap};
  }

  /**
   * Apply a confirmed explicit mapping. Records the audit entry and rewrites
   * all findings currently on the old node to the new target.
   */
  confirmMapping(input: {
    auditId: string;
    fromSnapshotId: string;
    toSnapshotId: string;
    oldNid: string;
    newNid: string | null; // null = user confirms the node is deleted
    resolution: ExplicitMapping['resolution'];
    confirmedBy: string;
    now: string;
    chosenCandidate?: Candidate | null;
  }): ExplicitMapping {
    const review = this.requireReview(input.auditId);
    const oldSnap = this.requireSnapshot(input.auditId, input.fromSnapshotId);
    const newSnap = this.requireSnapshot(input.auditId, input.toSnapshotId);
    const oldNode = oldSnap.flat.byNid.get(input.oldNid);
    if (!oldNode) throw Object.assign(new Error('old_node_missing'), {status: 400});
    const newNode = input.newNid ? newSnap.flat.byNid.get(input.newNid) : null;
    if (input.newNid && !newNode) throw Object.assign(new Error('new_node_missing'), {status: 400});

    // one-to-one: a new node may be the explicit target of only one old node
    if (newNode) {
      const conflict = review.mappings.find(m =>
        m.toSnapshotId === input.toSnapshotId &&
        m.newNid === input.newNid &&
        m.resolution === 'confirmed');
      if (conflict) {
        throw Object.assign(new Error('one_to_one_conflict'), {status: 409, conflicting: conflict.id});
      }
    }

    const mapping: ExplicitMapping = {
      id: `${input.auditId}-map-${review.mappings.length + 1}`,
      auditId: input.auditId,
      fromSnapshotId: input.fromSnapshotId,
      toSnapshotId: input.toSnapshotId,
      oldNid: input.oldNid,
      newNid: input.newNid ?? '',
      oldDescriptor: describe(oldNode.identity),
      newDescriptor: newNode ? describe(newNode.identity) : emptyDescriptor(oldNode.identity),
      chosenCandidate: input.chosenCandidate ?? null,
      resolution: input.resolution,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.now,
      sourceSnapshotPruned: false,
    };
    review.mappings.push(mapping);

    for (const finding of review.findings) {
      const targetsOld = this.findingCurrentTarget(review, finding) === input.oldNid &&
        (finding.snapshotId === input.fromSnapshotId ||
          review.mappings.some(m => m.toSnapshotId === input.fromSnapshotId));
      if (!targetsOld) continue;
      if (newNode) {
        finding.target = input.newNid!;
        finding.snapshotId = input.toSnapshotId;
        finding.targetIdentity = newNode.identity;
      } else if (input.resolution === 'deleted_accepted') {
        finding.status = 'fixed';
      }
    }
    return mapping;
  }

  /** Where does a finding currently point, following the mapping chain? */
  findingCurrentTarget(review: Review, finding: FindingRecord): string {
    let nid = finding.target;
    let snapshotId = finding.snapshotId;
    for (const m of review.mappings) {
      if (m.fromSnapshotId === snapshotId && m.oldNid === nid && m.resolution === 'confirmed' && m.newNid) {
        nid = m.newNid;
        snapshotId = m.toSnapshotId;
      }
    }
    return nid;
  }

  findingCurrentSnapshot(review: Review, finding: FindingRecord): string {
    let snapshotId = finding.snapshotId;
    let nid = finding.target;
    for (const m of review.mappings) {
      if (m.fromSnapshotId === snapshotId && m.oldNid === nid && m.resolution === 'confirmed' && m.newNid) {
        nid = m.newNid;
        snapshotId = m.toSnapshotId;
      }
    }
    return snapshotId;
  }

  /**
   * Delete old snapshots, keeping the latest one. Confirmed mappings are
   * retained as audit records and flagged when their source was pruned.
   */
  cleanup(auditId: string, keepLatest = 1): {deleted: string[]; retainedMappings: number} {
    const review = this.requireReview(auditId);
    const keepIds = new Set(review.snapshots.slice(-keepLatest).map(s => s.id));
    const deleted: string[] = [];
    const kept: SnapshotRecord[] = [];
    for (const snapshot of review.snapshots) {
      if (keepIds.has(snapshot.id)) { kept.push(snapshot); continue; }
      deleted.push(snapshot.id);
    }
    review.snapshots.splice(0, review.snapshots.length, ...kept);
    for (const mapping of review.mappings) {
      if (deleted.includes(mapping.fromSnapshotId)) mapping.sourceSnapshotPruned = true;
    }
    return {deleted, retainedMappings: review.mappings.length};
  }
}

function emptyDescriptor(identity: Identity): NodeDescriptor {
  const d = describe(identity);
  return {...d, tag: '', name: '', keys: [], shape: '', roleDigest: '', nameSig: ''};
}

/** Whether two descriptors (from adjacent generations) name the same node. */
function descriptorsLink(a: NodeDescriptor, b: NodeDescriptor): boolean {
  const keySig = (d: NodeDescriptor) =>
    d.keys.map(k => `${k.kind}=${k.value}`).sort().join('|');
  const aKeys = keySig(a);
  const bKeys = keySig(b);
  if (aKeys || bKeys) return aKeys === bKeys && aKeys !== '';
  if (a.shape && b.shape && a.shape === b.shape) return true;
  if (a.nameSig && b.nameSig && a.nameSig === b.nameSig && a.tag === b.tag) return true;
  return false;
}
