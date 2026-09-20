import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {AuditStore} from '../src/server/store';
import type {AuditState} from '../src/shared/types';
import {
  basePage,
  crossIframeMove,
  duplicateComponent,
  nodeDelete,
  siblingInsert,
} from '../src/client/demo';

function issueRefs(nodes: Array<{ref: {frameId: string; uid: string}; attrs: Record<string, string>}>) {
  return Object.fromEntries(
    nodes
      .filter((n) => n.attrs['data-issue'])
      .map((n) => [n.attrs['data-issue'], n.ref]),
  ) as Record<string, {frameId: string; uid: string}>;
}

async function snapshotNodes(app: ReturnType<typeof createApp>, state: AuditState) {
  const sid = state.snapshots.at(-1)!.id;
  const response = await request(app).get(`/api/audits/alpha/snapshots/${sid}/nodes`).expect(200);
  return {sid, refs: issueRefs(response.body.nodes)};
}

const makeApp = () => createApp({store: new AuditStore()});

describe('node identity workflow', () => {
  it('auto-migrates an ignored finding after sibling insertion', async () => {
    const app = makeApp();
    await request(app).post('/api/audits/alpha/snapshots').send({root: basePage()}).expect(201);
    let state = (await request(app).get('/api/audits/alpha/state')).body as AuditState;
    const {sid, refs} = await snapshotNodes(app, state);

    await request(app)
      .post('/api/audits/alpha/findings')
      .send({
        snapshotId: sid,
        ref: refs['link-non-descriptive'],
        rule: 'link-non-descriptive',
        severity: 'serious',
        message: 'ignored for now',
      })
      .expect(201);

    const reconcile = await request(app)
      .post('/api/audits/alpha/reconcile')
      .send({root: siblingInsert(basePage())})
      .expect(200);
    expect(reconcile.body.stats.scoredEdges).toBeLessThanOrEqual(reconcile.body.stats.edgeBound);

    state = reconcile.body.state as AuditState;
    const finding = state.findings.find((f) => f.rule === 'link-non-descriptive')!;
    expect(finding.status).toBe('carried');
    expect(state.pendingMappings).toHaveLength(0);
    // The anchor is the SAME flagged element, at a shifted child-index path.
    const next = await snapshotNodes(app, state);
    expect(finding.anchor.uid).toBe(next.refs['link-non-descriptive'].uid);
    expect(finding.anchor.uid).not.toBe(refs['link-non-descriptive'].uid);
  });

  it('does not auto-migrate across duplicate components and honors a manual confirm', async () => {
    const app = makeApp();
    await request(app).post('/api/audits/alpha/snapshots').send({root: basePage()}).expect(201);
    let state = (await request(app).get('/api/audits/alpha/state')).body as AuditState;
    const first = await snapshotNodes(app, state);

    // Anchor the finding on the SECOND card ("Plan Pro"): after a new card is
    // inserted before it, its index shifts and it has a near-twin neighbour.
    const heading = (
      await request(app)
        .get(`/api/audits/alpha/snapshots/${first.sid}/nodes`)
    ).body.nodes.find((n: {text: string}) => n.text === 'Plan Pro');
    await request(app)
      .post('/api/audits/alpha/findings')
      .send({
        snapshotId: first.sid,
        ref: heading.ref,
        rule: 'heading-order',
        severity: 'moderate',
        message: 'ignored card heading',
      })
      .expect(201);

    const reconcile = await request(app)
      .post('/api/audits/alpha/reconcile')
      .send({root: duplicateComponent(basePage())})
      .expect(200);
    state = reconcile.body.state as AuditState;
    const finding = state.findings.find((f) => f.rule === 'heading-order')!;
    expect(finding.status).toBe('pending');
    expect(state.pendingMappings).toHaveLength(1);
    const pending = state.pendingMappings[0];
    expect(pending.candidates.length).toBeGreaterThanOrEqual(1);
    expect(['pending_ambiguous', 'pending_low_confidence', 'pending_candidate_truncated']).toContain(
      pending.status,
    );

    // User explicitly picks "Plan Pro" in the new snapshot.
    const next = await snapshotNodes(app, state);
    const nextNodes = (
      await request(app).get(`/api/audits/alpha/snapshots/${next.sid}/nodes`)
    ).body.nodes;
    const target = nextNodes.find((n: {text: string}) => n.text === 'Plan Pro');
    const decided = await request(app)
      .post('/api/audits/alpha/decide')
      .send({findingId: finding.id, targetRef: target.ref, snapshotId: next.sid})
      .expect(200);
    const after = decided.body.state as AuditState;
    expect(after.findings.find((f) => f.id === finding.id)!.status).toBe('ignored');
    const mappings = (await request(app).get('/api/audits/alpha/mappings')).body.mappings;
    const confirmed = mappings.find(
      (m: {decision: string; newNode: {label: string}}) =>
        m.decision === 'confirmed' && m.newNode.label.includes('Plan Pro'),
    );
    expect(confirmed).toBeTruthy();
  });

  it('keeps a deleted-node finding pending, then honors explicit reject', async () => {
    const app = makeApp();
    await request(app).post('/api/audits/alpha/snapshots').send({root: basePage()}).expect(201);
    let state = (await request(app).get('/api/audits/alpha/state')).body as AuditState;
    const {sid, refs} = await snapshotNodes(app, state);
    await request(app)
      .post('/api/audits/alpha/findings')
      .send({
        snapshotId: sid,
        ref: refs['focus-order'],
        rule: 'focus-order',
        severity: 'critical',
        message: 'ignored button',
      })
      .expect(201);

    const reconcile = await request(app)
      .post('/api/audits/alpha/reconcile')
      .send({root: nodeDelete(basePage())})
      .expect(200);
    state = reconcile.body.state as AuditState;
    const finding = state.findings.find((f) => f.rule === 'focus-order')!;
    // Never silently dropped.
    expect(['pending']).toContain(finding.status);

    const sid2 = state.snapshots.at(-1)!.id;
    const rejected = await request(app)
      .post('/api/audits/alpha/decide')
      .send({findingId: finding.id, targetRef: null, snapshotId: sid2})
      .expect(200);
    expect((rejected.body.state as AuditState).findings.find((f) => f.id === finding.id)!.status).toBe(
      'dropped',
    );
  });

  it('carries findings across iframe boundaries and retains mappings after pruning', async () => {
    const app = makeApp();
    await request(app).post('/api/audits/alpha/snapshots').send({root: basePage()}).expect(201);
    let state = (await request(app).get('/api/audits/alpha/state')).body as AuditState;
    const sid = state.snapshots[0].id;
    const nodes = (await request(app).get(`/api/audits/alpha/snapshots/${sid}/nodes`)).body.nodes;
    const acceptAll = nodes.find(
      (n: {frameId: string; text: string}) => n.frameId !== 'top' && n.text === 'Accept all',
    );
    await request(app)
      .post('/api/audits/alpha/findings')
      .send({
        snapshotId: sid,
        ref: acceptAll.ref,
        rule: 'low-contrast',
        severity: 'serious',
        message: 'ignored inside frame',
      })
      .expect(201);

    const reconcile = await request(app)
      .post('/api/audits/alpha/reconcile')
      .send({root: crossIframeMove(basePage())})
      .expect(200);
    state = reconcile.body.state as AuditState;
    const finding = state.findings.find((f) => f.rule === 'low-contrast')!;
    expect(finding.status).toBe('carried');
    expect(finding.anchor.frameId).not.toBe('top');

    const mappingsBefore = (await request(app).get('/api/audits/alpha/mappings')).body.mappings.length;
    const prune = await request(app).post('/api/audits/alpha/prune').send({keep: 1}).expect(200);
    expect(prune.body.pruned).toBeGreaterThanOrEqual(1);
    // Audit trail survives cleanup.
    expect(prune.body.retainedMappings).toBe(mappingsBefore);
    const mappingsAfter = (await request(app).get('/api/audits/alpha/mappings')).body.mappings;
    expect(mappingsAfter).toHaveLength(mappingsBefore);
    // Pruned snapshot trees are gone and their node endpoint reports GONE.
    const prunedSid = state.snapshots[0].id;
    await request(app).get(`/api/audits/alpha/snapshots/${prunedSid}/nodes`).expect(410);
    // But the mapping still carries the denormalized old/new node views.
    const autoMap = mappingsAfter.find(
      (m: {decision: string; newNode: {text: string}}) =>
        m.decision === 'auto' && m.newNode.text === 'Accept all',
    );
    expect(autoMap.oldNode.label).toContain('Accept all');
  });

  it('still serves the legacy content API with optimistic revision checks', async () => {
    const app = makeApp();
    const before = await request(app).get('/api/audits/alpha').expect(200);
    await request(app)
      .put('/api/audits/alpha')
      .send({content: 'updated', revision: before.body.revision})
      .expect(200);
    await request(app)
      .put('/api/audits/alpha')
      .send({content: 'stale', revision: before.body.revision})
      .expect(409);
  });
});
