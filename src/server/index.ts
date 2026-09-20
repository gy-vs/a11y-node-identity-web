import express from 'express';
import {fileURLToPath} from 'node:url';
import type {SnapshotInput} from '../shared/types';
import {ReviewStore, type FindingRecord, type SnapshotRecord} from './store';
import {diffNodes} from '../shared/text';
import {nidLabel} from '../shared/dom';
import type {Candidate, MatchPlan, NodeDescriptor} from '../shared/matcher';
import {describe} from '../shared/matcher';

const store = new ReviewStore();

type PendingView = {
  oldNid: string;
  oldDescriptor: NodeDescriptor;
  oldLabel: string;
  reason: string;
  detail: string;
  findings: FindingRecord[];
  candidates: Array<Candidate & {
    newLabel: string;
    newDescriptor: NodeDescriptor;
    framePath: string[];
    diff: ReturnType<typeof diffNodes>;
  }>;
};

type ReviewState = {
  auditId: string;
  snapshots: Array<{id: string; revision: number; url: string; capturedAt: string; nodeCount: number; frameCount: number}>;
  findings: Array<FindingRecord & {currentSnapshotId: string; currentTarget: string}>;
  plan: (MatchPlan & {generatedAt: string}) | null;
  pending: PendingView[];
  autoMigrated: Array<{findingId: string; oldNid: string; newNid: string; confidence: number}>;
};

function buildReviewState(auditId: string): ReviewState {
  const review = store.requireReview(auditId);
  const plan = review.latestPlan ?? null;
  const snapshots = review.snapshots.map(s => ({
    id: s.id, revision: s.revision, url: s.url, capturedAt: s.capturedAt,
    nodeCount: s.flat.byNid.size, frameCount: s.flat.frames.length,
  }));

  // findings relevant to the newest match: those alive on the old snapshot
  let relevant = new Set<string>();
  let oldSnap: SnapshotRecord | undefined;
  if (plan) {
    oldSnap = review.snapshots.find(s => s.id === plan.oldSnapshotId);
    const newSnap = review.snapshots.find(s => s.id === plan.newSnapshotId);
    if (oldSnap && newSnap) {
      for (const finding of review.findings) {
        if (store.findingCurrentSnapshot(review, finding) === oldSnap.id) relevant.add(finding.id);
      }
    }
  }

  const pending: PendingView[] = [];
  if (plan && oldSnap) {
    const newSnap = review.snapshots.find(s => s.id === plan.newSnapshotId)!;
    const pendingOlds = new Map(plan.pending.map(p => [p.oldNid, p]));
    // restrict UI queue to nodes that actually carry findings
    for (const item of plan.pending) {
      const findingsHere = review.findings.filter(f =>
        relevant.has(f.id) && store.findingCurrentTarget(review, f) === item.oldNid);
      if (findingsHere.length === 0) continue;
      const oldNode = oldSnap.flat.byNid.get(item.oldNid);
      if (!oldNode) continue;
      const entry = pendingOlds.get(item.oldNid)!;
      pending.push({
        oldNid: item.oldNid,
        oldDescriptor: describe(oldNode.identity),
        oldLabel: nidLabel(oldNode.identity),
        reason: entry.reason,
        detail: entry.detail,
        findings: findingsHere,
        candidates: item.candidates.map(candidate => {
          const newNode = newSnap.flat.byNid.get(candidate.newNid)!;
          return {
            ...candidate,
            newLabel: nidLabel(newNode.identity),
            newDescriptor: describe(newNode.identity),
            framePath: newNode.identity.framePath,
            diff: diffNodes(oldNode, newNode, candidate.shapeSimilarity, nidLabel),
          };
        }),
      });
    }
  }

  const autoMigrated: ReviewState['autoMigrated'] = review.lastAutoMigrations ?? [];

  return {
    auditId,
    snapshots,
    findings: review.findings.map(f => ({
      ...f,
      currentSnapshotId: store.findingCurrentSnapshot(review, f),
      currentTarget: store.findingCurrentTarget(review, f),
    })),
    plan,
    pending,
    autoMigrated,
  };
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '5mb'}));

  // ---- legacy text-audit API (kept intact) -------------------------------
  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'accessibility-review', count: store.rows.size}));
  app.get('/api/audits', (_req, res) =>
    res.json([...store.rows.values()].map(({content, ...row}) => row)));
  app.get('/api/audits/:id', (req, res) => {
    const row = store.rows.get(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/audits/:id', (req, res) => {
    const row = store.rows.get(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/audits/:id/analyze', async (req, res) => {
    const row = store.rows.get(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise(resolve => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({id: row.id, revision: row.revision, lines: String(req.body.content ?? row.content).split(/\r?\n/).length, diagnostics: []});
  });

  // ---- node-identity review API -----------------------------------------
  app.post('/api/reviews/:auditId/snapshots', (req, res) => {
    const input = req.body as SnapshotInput;
    if (!input?.root || !input.url) return res.status(400).json({error: 'snapshot_shape'});
    const record = store.addSnapshot(req.params.auditId, input);
    res.status(201).json({
      id: record.id, revision: record.revision,
      nodeCount: record.flat.byNid.size, frameCount: record.flat.frames.length,
    });
  });

  app.get('/api/reviews/:auditId/snapshots/:snapshotId', (req, res) => {
    try {
      const record = store.requireSnapshot(req.params.auditId, req.params.snapshotId);
      res.json({
        id: record.id, revision: record.revision, url: record.url, capturedAt: record.capturedAt,
        snapshot: record.data,
      });
    } catch (error) {
      res.status((error as {status?: number}).status ?? 500).json({error: (error as Error).message});
    }
  });

  app.post('/api/reviews/:auditId/findings', (req, res) => {
    try {
      const seeds = (req.body?.findings ?? []) as Array<{
        target: string; rule: string; message: string;
        severity: 'low' | 'medium' | 'high'; status?: 'open' | 'ignored' | 'fixed';
      }>;
      if (!Array.isArray(seeds) || seeds.some(s => !s.target || !s.rule)) {
        return res.status(400).json({error: 'findings_shape'});
      }
      const snapshotId = req.body.snapshotId as string;
      const created = store.addFindings(req.params.auditId, snapshotId, seeds);
      res.status(201).json(created);
    } catch (error) {
      res.status((error as {status?: number}).status ?? 500).json({error: (error as Error).message});
    }
  });

  app.patch('/api/reviews/:auditId/findings/:findingId', (req, res) => {
    try {
      const status = req.body?.status;
      if (!['open', 'ignored', 'fixed'].includes(status)) return res.status(400).json({error: 'bad_status'});
      res.json(store.setFindingStatus(req.params.auditId, req.params.findingId, status));
    } catch (error) {
      res.status((error as {status?: number}).status ?? 500).json({error: (error as Error).message});
    }
  });

  app.post('/api/reviews/:auditId/match', (req, res) => {
    try {
      const {oldSnapshotId, newSnapshotId} = req.body ?? {};
      if (!oldSnapshotId || !newSnapshotId) return res.status(400).json({error: 'match_shape'});
      const {plan} = store.planMatch(req.params.auditId, oldSnapshotId, newSnapshotId,
        new Date().toISOString());
      const review = store.requireReview(req.params.auditId);
      const newSnapRecord = store.requireSnapshot(req.params.auditId, newSnapshotId);
      // auto-migrate findings along confident one-to-one matches, recording
      // exactly which findings moved (shown to the reviewer)
      review.lastAutoMigrations = [];
      for (const finding of review.findings) {
        if (store.findingCurrentSnapshot(review, finding) !== oldSnapshotId) continue;
        const match = plan.byOld.get(store.findingCurrentTarget(review, finding));
        if (match) {
          finding.target = match.newNid;
          finding.snapshotId = newSnapshotId;
          const node = newSnapRecord.flat.byNid.get(match.newNid);
          if (node) finding.targetIdentity = node.identity;
          review.lastAutoMigrations.push({
            findingId: finding.id, oldNid: match.oldNid, newNid: match.newNid,
            confidence: match.confidence,
          });
        }
      }
      // state is built AFTER migration, so pending only lists stalled findings
      const state = buildReviewState(req.params.auditId);
      res.json({plan: stripPlan(plan), state});
    } catch (error) {
      res.status((error as {status?: number}).status ?? 500).json({error: (error as Error).message});
    }
  });

  app.get('/api/reviews/:auditId/state', (_req, res) => {
    try {
      res.json(buildReviewState(_req.params.auditId));
    } catch (error) {
      res.status((error as {status?: number}).status ?? 500).json({error: (error as Error).message});
    }
  });

  app.post('/api/reviews/:auditId/mappings', (req, res) => {
    try {
      const mapping = store.confirmMapping({
        auditId: req.params.auditId,
        fromSnapshotId: req.body.fromSnapshotId,
        toSnapshotId: req.body.toSnapshotId,
        oldNid: req.body.oldNid,
        newNid: req.body.newNid ?? null,
        resolution: req.body.resolution ?? (req.body.newNid ? 'confirmed' : 'deleted_accepted'),
        confirmedBy: req.body.confirmedBy ?? 'reviewer@example.test',
        now: new Date().toISOString(),
        chosenCandidate: req.body.chosenCandidate ?? null,
      });
      res.status(201).json(mapping);
    } catch (error) {
      const status = (error as {status?: number}).status ?? 500;
      res.status(status).json({error: (error as Error).message, conflicting: (error as {conflicting?: string}).conflicting});
    }
  });

  app.get('/api/reviews/:auditId/mappings', (_req, res) => {
    const review = store.review(_req.params.auditId);
    if (!review) return res.status(404).json({error: 'not_found'});
    // audit trail survives even when referenced snapshots have been pruned
    res.json({
      mappings: review.mappings,
      snapshotIds: new Set(review.snapshots.map(s => s.id)),
    });
  });

  app.post('/api/reviews/:auditId/cleanup', (req, res) => {
    try {
      const result = store.cleanup(req.params.auditId, Number(req.body?.keepLatest ?? 1));
      res.json(result);
    } catch (error) {
      res.status((error as {status?: number}).status ?? 500).json({error: (error as Error).message});
    }
  });

  app.post('/api/reviews/:auditId/reset', (_req, res) => {
    store.reviews.set(_req.params.auditId, {
      auditId: _req.params.auditId, snapshots: [], findings: [], mappings: [],
    });
    res.status(204).end();
  });

  return app;
}

function stripPlan(plan: MatchPlan) {
  return {
    oldSnapshotId: plan.oldSnapshotId,
    newSnapshotId: plan.newSnapshotId,
    generatedAt: (plan as MatchPlan & {generatedAt?: string}).generatedAt,
    stats: plan.stats,
    matches: plan.matches,
    pending: plan.pending,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
