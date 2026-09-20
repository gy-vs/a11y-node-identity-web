// In-memory authoritative store for audits, snapshots, findings and the
// durable mapping audit trail.
//
// Guarantees implemented here:
//  - review results anchor to MAPPING ROWS, never to child-index paths;
//  - reconcile uses the bounded matcher and refuses to auto-migrate anything
//    low-confidence / one-to-many (those become pending drafts);
//  - confirmed/rejected mappings are explicit user decisions;
//  - pruning snapshots keeps every mapping row + denormalized NodeView, so the
//    audit trail survives snapshot cleanup.

import {reconcile} from '../shared/matcher';
import {viewOf} from '../shared/identity';
import type {
  AuditState,
  Finding,
  MappingRow,
  MatchStatusCode,
  NodeRef,
  NodeView,
  RawNode,
  Snapshot,
} from '../shared/types';
import {buildSnapshot} from '../shared/identity';

export interface AuditRow {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  content: string; // legacy text payload (kept for the original workbench)
}

interface StoredSnapshot extends Snapshot {
  pruned: boolean;
}

let counter = 0;
const uid = (prefix: string) =>
  `${prefix}_${(++counter).toString(36)}${Date.now().toString(36).slice(-4)}`;

interface PendingDraft {
  /** Node the finding was originally authored on (never changes). */
  originView: NodeView;
  /** Best-guess reference in the LATEST snapshot (unconfirmed, may be null). */
  currentRef: NodeRef | null;
  currentView: NodeView | null;
  status: MatchStatusCode;
  confidence: number;
  candidates: Array<NodeView & {score: number; reasons: string[]}>;
  match: unknown;
}

export class AuditStore {
  readonly audits = new Map<string, AuditRow>();
  readonly snapshots = new Map<string, StoredSnapshot[]>(); // auditId -> snapshots
  readonly findings = new Map<string, Finding[]>();
  readonly mappings = new Map<string, MappingRow[]>();

  constructor() {
    this.audits.set('alpha', {
      id: 'alpha',
      name: 'Primary review findings',
      revision: 3,
      content: 'review findings: alpha\nstate: active',
      updatedAt: new Date(0).toISOString(),
    });
    this.audits.set('beta', {
      id: 'beta',
      name: 'Secondary review findings',
      revision: 5,
      content: 'review findings: beta\nstate: review',
      updatedAt: new Date(1000).toISOString(),
    });
  }

  getAudit(id: string): AuditRow | undefined {
    return this.audits.get(id);
  }

  listAudits(): AuditRow[] {
    return [...this.audits.values()];
  }

  putContent(id: string, content: string, revision: number): AuditRow | 'conflict' | 'missing' {
    const row = this.audits.get(id);
    if (!row) return 'missing';
    if (revision !== row.revision) return 'conflict';
    row.content = content;
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    return row;
  }

  snapList(auditId: string): StoredSnapshot[] {
    return this.snapshots.get(auditId) ?? [];
  }

  getSnapshot(auditId: string, snapshotId: string): StoredSnapshot | undefined {
    return this.snapList(auditId).find((s) => s.id === snapshotId);
  }

  bump(auditId: string): void {
    const row = this.audits.get(auditId)!;
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
  }

  /** Ingest a freshly captured DOM tree as a new snapshot. */
  addSnapshot(auditId: string, root: RawNode): Snapshot {
    const list = this.snapList(auditId);
    const seq = list.length ? list[list.length - 1].seq + 1 : 1;
    const snapshot = buildSnapshot(auditId, seq, root);
    list.push({...snapshot, pruned: false});
    this.snapshots.set(auditId, list);
    this.bump(auditId);
    return snapshot;
  }

  addFinding(
    auditId: string,
    snapshotId: string,
    ref: NodeRef,
    input: {rule: string; severity: Finding['severity']; message: string},
  ): Finding {
    const snapshot = this.getSnapshot(auditId, snapshotId);
    if (!snapshot) throw new Error('snapshot_not_found');
    const node = snapshot.nodes.find((n) => n.uid === ref.uid && n.frameId === ref.frameId);
    if (!node) throw new Error('node_not_found');

    // An authored finding is anchored to an explicit identity mapping from
    // the snapshot onto itself (a self-confirmation row).
    const self: MappingRow = {
      id: uid('map'),
      auditId,
      oldSnapshotId: snapshotId,
      newSnapshotId: snapshotId,
      oldNode: viewOf(node),
      newNode: viewOf(node),
      confidence: 1,
      decision: 'confirmed',
      reasons: ['authored'],
      decidedBy: 'reviewer',
      decidedAt: new Date().toISOString(),
    };
    const finding: Finding = {
      id: uid('find'),
      auditId,
      rule: input.rule,
      severity: input.severity,
      message: input.message,
      status: 'ignored',
      snapshotId,
      anchor: ref,
      anchorView: viewOf(node),
      mappingId: self.id,
      updatedAt: new Date().toISOString(),
    };
    this.mappings.set(auditId, [...(this.mappings.get(auditId) ?? []), self]);
    this.findings.set(auditId, [...(this.findings.get(auditId) ?? []), finding]);
    this.bump(auditId);
    return finding;
  }

  listFindings(auditId: string): Finding[] {
    return this.findings.get(auditId) ?? [];
  }

  listMappings(auditId: string): MappingRow[] {
    return this.mappings.get(auditId) ?? [];
  }

  /**
   * Reconcile the latest snapshot against a new raw tree:
   * build the new snapshot, walk findings via the matcher, auto-carry on
   * unique high-confidence edges, otherwise open a pending draft.
   * Returns the new snapshot plus updated rows.
   */
  reconcile(auditId: string, root: RawNode) {
    const oldList = this.snapList(auditId);
    const oldSnap = oldList[oldList.length - 1];
    if (!oldList.length) return {error: 'no_baseline' as const};
    const seq = oldSnap.seq + 1;
    const newSnap = {...buildSnapshot(auditId, seq, root), pruned: false};
    oldList.push(newSnap);

    const result = reconcile(oldSnap, newSnap);
    const oldByRef = new Map(
      oldSnap.nodes.map((n) => [`${n.frameId}/${n.uid}`, n]),
    );
    const newByRef = new Map(
      newSnap.nodes.map((n) => [`${n.frameId}/${n.uid}`, n]),
    );

    const findings = this.listFindings(auditId);
    const mappings = this.listMappings(auditId);
    // Every live finding participates: newly authored ones (snapshotId may be
    // any earlier snapshot, never yet migrated), pending ones chasing a node
    // across revisions, and ones anchored at the immediately previous
    // snapshot. Dropped findings are terminal and stay out.
    const active = findings.filter(
      (f) => f.status !== 'dropped' && (f.status === 'pending' || f.snapshotId === oldSnap.id),
    );

    for (const finding of active) {
      // Pending findings carry an (unconfirmed) currentRef into the previous
      // snapshot so they can keep chasing a node across revisions. If the last
      // guess was "deleted" (currentRef null), the finding stays pending with
      // no candidates to chase this round.
      const draft = (finding as Finding & {draft?: PendingDraft}).draft;
      if (finding.status === 'pending' && draft && draft.currentRef === null) {
        finding.snapshotId = newSnap.id;
        finding.updatedAt = new Date().toISOString();
        continue;
      }
      const oldRef = finding.status === 'pending' && draft ? draft.currentRef! : finding.anchor;
      const match = result.matches.find(
        (m) => m.oldRef.uid === oldRef.uid && m.oldRef.frameId === oldRef.frameId,
      );
      if (!match) continue;
      const oldNode = oldByRef.get(`${match.oldRef.frameId}/${match.oldRef.uid}`)!;
      const oldView = viewOf(oldNode);

      if (match.status === 'auto' && match.newRef) {
        const newNode = newByRef.get(`${match.newRef.frameId}/${match.newRef.uid}`)!;
        const row: MappingRow = {
          id: uid('map'),
          auditId,
          oldSnapshotId: oldSnap.id,
          newSnapshotId: newSnap.id,
          oldNode: oldView,
          newNode: viewOf(newNode),
          confidence: match.confidence,
          decision: 'auto',
          reasons: match.reasons,
          decidedBy: 'matcher',
          decidedAt: new Date().toISOString(),
        };
        mappings.push(row);
        finding.snapshotId = newSnap.id;
        finding.anchor = {...match.newRef};
        finding.anchorView = viewOf(newNode);
        finding.status = 'carried';
        finding.updatedAt = new Date().toISOString();
        delete (finding as Partial<{draft: PendingDraft}>).draft;
      } else {
        // deleted, ambiguous, low confidence, truncated space or unresolved
        // frame: NEVER auto-migrate. Open/refresh the pending draft.
        const topCandidate = match.candidates[0];
        finding.status = 'pending';
        finding.mappingId = null;
        finding.snapshotId = newSnap.id;
        finding.updatedAt = new Date().toISOString();
        (finding as Finding & {draft?: PendingDraft}).draft = {
          originView: draft?.originView ?? finding.anchorView,
          currentRef: topCandidate ? {...topCandidate.ref} : null,
          currentView: topCandidate
            ? viewOf(newByRef.get(`${topCandidate.ref.frameId}/${topCandidate.ref.uid}`)!)
            : null,
          status: match.status,
          confidence: match.confidence,
          candidates: match.candidates.map((c) => ({
            ...viewOf(newByRef.get(`${c.ref.frameId}/${c.ref.uid}`)!),
            score: c.score,
            reasons: c.reasons,
          })),
          match,
        };
      }
    }

    this.mappings.set(auditId, mappings);
    this.findings.set(auditId, findings);
    this.lastStats.set(auditId, result.stats);
    this.bump(auditId);
    return {
      snapshot: newSnap,
      result,
      findings: active,
    };
  }

  /**
   * Explicit user decision on a pending finding.
   *  - targetRef present  => CONFIRMED mapping, finding carries to the node;
   *  - targetRef null     => REJECTED ("node deleted"), finding dropped.
   */
  decide(
    auditId: string,
    findingId: string,
    targetRef: NodeRef | null,
    snapshotId: string,
    actor = 'reviewer',
  ): {finding?: Finding; error?: string} {
    const finding = this.listFindings(auditId).find((f) => f.id === findingId);
    if (!finding) return {error: 'finding_not_found'};
    const draft = (finding as Finding & {draft?: PendingDraft}).draft;
    if (!draft) return {error: 'not_pending'};

    let newView: NodeView | null = null;
    if (targetRef) {
      const snapshot = this.getSnapshot(auditId, snapshotId);
      if (!snapshot) return {error: 'snapshot_not_found'};
      const node = snapshot.nodes.find(
        (n) => n.uid === targetRef.uid && n.frameId === targetRef.frameId,
      );
      if (!node) return {error: 'node_not_found'};
      newView = viewOf(node);
    }

    const row: MappingRow = {
      id: uid('map'),
      auditId,
      oldSnapshotId: finding.snapshotId,
      newSnapshotId: snapshotId,
      oldNode: draft.originView,
      newNode: newView,
      confidence: targetRef ? 1 : 0,
      decision: targetRef ? 'confirmed' : 'rejected',
      reasons: [targetRef ? 'manual-confirm' : 'manual-delete'],
      decidedBy: actor,
      decidedAt: new Date().toISOString(),
    };
    this.mappings.set(auditId, [...this.listMappings(auditId), row]);

    if (targetRef && newView) {
      finding.snapshotId = snapshotId;
      finding.anchor = {...targetRef};
      finding.anchorView = newView;
      finding.status = 'ignored';
    } else {
      finding.status = 'dropped';
    }
    finding.mappingId = row.id;
    finding.updatedAt = new Date().toISOString();
    delete (finding as Partial<{draft: PendingDraft}>).draft;
    this.bump(auditId);
    return {finding};
  }

  /**
   * Delete captured snapshot trees (keeping the newest), but RETAIN all
   * mapping rows: they carry denormalized NodeViews and form the audit
   * record of confirmed node identity across revisions.
   */
  pruneSnapshots(auditId: string, keep = 1): {pruned: number; retainedMappings: number} {
    const list = this.snapList(auditId);
    const keepIds = new Set(list.slice(-keep).map((s) => s.id));
    let pruned = 0;
    for (const snapshot of list) {
      if (!keepIds.has(snapshot.id) && !snapshot.pruned) {
        snapshot.pruned = true;
        snapshot.nodes = [];
        snapshot.frames = [];
        snapshot.roots = {};
        pruned++;
      }
    }
    // Findings can't stay anchored to a pruned snapshot unless already carried;
    // their anchorView + mapping rows keep the identity trail regardless.
    this.bump(auditId);
    return {pruned, retainedMappings: this.listMappings(auditId).length};
  }

  lastStats = new Map<string, AuditState['stats']>();

  state(auditId: string, stats?: AuditState['stats']): AuditState {
    const row = this.audits.get(auditId)!;
    const pendingMappings = this.listFindings(auditId)
      .filter((f) => f.status === 'pending')
      .map((f) => {
        const draft = (f as Finding & {draft?: PendingDraft}).draft!;
        return {
          mappingDraftId: f.id,
          findingId: f.id,
          oldNode: draft.originView,
          currentNode: draft.currentView,
          candidates: draft.candidates,
          status: draft.status,
          confidence: draft.confidence,
        };
      });
    const strip = (f: Finding): Finding => {
      const {draft: _draft, ...clean} = f as Finding & {draft?: PendingDraft};
      void _draft;
      return clean;
    };
    return {
      audit: {id: row.id, name: row.name, revision: row.revision, updatedAt: row.updatedAt},
      snapshots: this.snapList(auditId).map((s) => ({
        id: s.id,
        seq: s.seq,
        createdAt: s.createdAt,
        nodeCount: s.nodes.length,
        frameCount: s.frames.length,
        pruned: s.pruned,
      })),
      findings: this.listFindings(auditId).map(strip),
      pendingMappings,
      ...(stats ?? this.lastStats.get(auditId)
        ? {stats: stats ?? this.lastStats.get(auditId)}
        : {}),
    };
  }
}

export const store = new AuditStore();
