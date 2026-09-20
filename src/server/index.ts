import express from 'express';
import {fileURLToPath} from 'node:url';
import {store as defaultStore} from './store';
import type {AuditStore as Store} from './store';
import type {NodeRef, RawNode} from '../shared/types';

export function createApp(deps: {store?: Store} = {}) {
  const store = deps.store ?? defaultStore;
  const app = express();
  app.use(express.json({limit: '6mb'}));

  // ---- Legacy workbench endpoints (unchanged contract) --------------------
  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'accessibility-review', count: store.listAudits().length}),
  );
  app.get('/api/audits', (_req, res) =>
    res.json(
      store.listAudits().map(({content, ...row}) => row),
    ),
  );
  app.get('/api/audits/:id', (req, res) => {
    const row = store.getAudit(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/audits/:id', (req, res) => {
    const outcome = store.putContent(
      req.params.id,
      String(req.body.content ?? ''),
      Number(req.body.revision),
    );
    if (outcome === 'missing') return res.status(404).json({error: 'not_found'});
    if (outcome === 'conflict')
      return res.status(409).json({error: 'revision_conflict', current: store.getAudit(req.params.id)});
    res.json(outcome);
  });
  app.post('/api/audits/:id/analyze', async (req, res) => {
    const row = store.getAudit(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({
      id: row.id,
      revision: row.revision,
      lines: String(req.body.content ?? row.content).split(/\r?\n/).length,
      diagnostics: [],
    });
  });

  // ---- Node identity workbench -------------------------------------------
  app.get('/api/audits/:id/state', (req, res) => {
    if (!store.getAudit(req.params.id)) return res.status(404).json({error: 'not_found'});
    res.json(store.state(req.params.id));
  });

  app.post('/api/audits/:id/snapshots', (req, res) => {
    if (!store.getAudit(req.params.id)) return res.status(404).json({error: 'not_found'});
    const root = req.body?.root as RawNode | undefined;
    if (!root || typeof root.tag !== 'string')
      return res.status(400).json({error: 'root_required'});
    const snapshot = store.addSnapshot(req.params.id, root);
    res.status(201).json({
      snapshot: {id: snapshot.id, seq: snapshot.seq, nodeCount: snapshot.nodes.length},
      state: store.state(req.params.id),
    });
  });

  app.get('/api/audits/:id/snapshots/:sid/nodes', (req, res) => {
    const snapshot = store.getSnapshot(req.params.id, req.params.sid);
    if (!snapshot) return res.status(404).json({error: 'not_found'});
    if (snapshot.pruned) return res.status(410).json({error: 'snapshot_pruned'});
    res.json({
      id: snapshot.id,
      nodes: snapshot.nodes.map((n) => ({
        ref: {frameId: n.frameId, uid: n.uid},
        uid: n.uid,
        frameId: n.frameId,
        parentUid: n.parentUid,
        childUids: n.childUids,
        tag: n.tag,
        attrs: n.attrs,
        text: n.text,
        path: n.path,
      })),
      frames: snapshot.frames,
      roots: snapshot.roots,
    });
  });

  app.post('/api/audits/:id/findings', (req, res) => {
    const {snapshotId, ref, rule, severity, message} = req.body ?? {};
    if (!snapshotId || !ref || !rule)
      return res.status(400).json({error: 'snapshotId_ref_rule_required'});
    try {
      const finding = store.addFinding(req.params.id, snapshotId, ref as NodeRef, {
        rule: String(rule),
        severity: ['critical', 'serious', 'moderate', 'minor'].includes(severity)
          ? severity
          : 'moderate',
        message: String(message ?? ''),
      });
      res.status(201).json({finding, state: store.state(req.params.id)});
    } catch (error) {
      res.status(404).json({error: (error as Error).message});
    }
  });

  /** Capture a new DOM revision and reconcile all findings against it. */
  app.post('/api/audits/:id/reconcile', (req, res) => {
    if (!store.getAudit(req.params.id)) return res.status(404).json({error: 'not_found'});
    const root = req.body?.root as RawNode | undefined;
    if (!root || typeof root.tag !== 'string')
      return res.status(400).json({error: 'root_required'});
    const outcome = store.reconcile(req.params.id, root);
    if (outcome.error) return res.status(409).json({error: outcome.error});
    res.json({
      snapshot: {id: outcome.snapshot.id, seq: outcome.snapshot.seq, nodeCount: outcome.snapshot.nodes.length},
      matches: outcome.result.matches,
      stats: outcome.result.stats,
      frameAlignment: outcome.result.frameAlignment,
      state: store.state(req.params.id, outcome.result.stats),
    });
  });

  /** Explicit mapping decision: confirm a candidate, or reject (deleted). */
  app.post('/api/audits/:id/decide', (req, res) => {
    const {findingId, targetRef, snapshotId} = req.body ?? {};
    if (!findingId || !snapshotId)
      return res.status(400).json({error: 'findingId_snapshotId_required'});
    const outcome = store.decide(
      req.params.id,
      String(findingId),
      (targetRef as NodeRef | null) ?? null,
      String(snapshotId),
    );
    if (outcome.error) return res.status(404).json({error: outcome.error});
    res.json({finding: outcome.finding, state: store.state(req.params.id)});
  });

  /** Delete snapshot trees, retaining the mapping audit trail. */
  app.post('/api/audits/:id/prune', (req, res) => {
    if (!store.getAudit(req.params.id)) return res.status(404).json({error: 'not_found'});
    const keep = Math.max(1, Number(req.body?.keep ?? 1));
    const outcome = store.pruneSnapshots(req.params.id, keep);
    res.json({...outcome, state: store.state(req.params.id)});
  });

  /** Durable mapping audit log (survives snapshot pruning). */
  app.get('/api/audits/:id/mappings', (req, res) => {
    if (!store.getAudit(req.params.id)) return res.status(404).json({error: 'not_found'});
    res.json({mappings: store.listMappings(req.params.id)});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
