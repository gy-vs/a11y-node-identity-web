import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {FIXTURES, fixtureFlatPair} from '../src/shared/fixtures';
import {flattenSnapshot} from '../src/shared/dom';

// The server owns a single in-memory store; each scenario uses a distinct
// audit id derived from its fixture key so runs never collide.
function auditId(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').slice(0, 12);
}

async function upload(app: ReturnType<typeof createApp>, audit: string, side: 'before' | 'after', key: string) {
  const fixture = FIXTURES.find(f => f.key === key)!;
  const input = side === 'before' ? fixture.before : fixture.after;
  const res = await request(app).post(`/api/reviews/${audit}/snapshots`).send(input).expect(201);
  return res.body.id as string;
}

async function seedFinding(app: ReturnType<typeof createApp>, key: string, audit: string, snapshotId: string) {
  const fixture = FIXTURES.find(f => f.key === key)!;
  const {targetBefore} = fixtureFlatPair(fixture);
  const res = await request(app).post(`/api/reviews/${audit}/findings`).send({
    snapshotId,
    findings: [{
      target: targetBefore,
      rule: fixture.finding.rule,
      message: fixture.finding.message,
      severity: fixture.finding.severity,
      status: 'ignored', // the "marked ignore" action from the bug report
    }],
  }).expect(201);
  return {findingId: res.body[0].id, targetBefore};
}

describe('review remap API', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.key}: ${fixture.expect === 'auto' ? 'auto-migrates' : 'enters pending'}`, async () => {
      const app = createApp();
      const audit = auditId(fixture.key);
      const oldSnap = await upload(app, audit, 'before', fixture.key);
      const newSnap = await upload(app, audit, 'after', fixture.key);
      const {findingId} = await seedFinding(app, fixture.key, audit, oldSnap);

      const res = await request(app)
        .post(`/api/reviews/${audit}/match`)
        .send({oldSnapshotId: oldSnap, newSnapshotId: newSnap})
        .expect(200);
      const state = res.body.state;

      if (fixture.expect === 'auto') {
        expect(state.autoMigrated.map((m: {findingId: string}) => m.findingId)).toContain(findingId);
        expect(state.pending.map((p: {findings: Array<{id: string}>}) =>
          p.findings.some(f => f.id === findingId)).some(Boolean)).toBe(false);
        // the ignored status must survive the automatic migration
        const migrated = state.findings.find((f: {id: string}) => f.id === findingId);
        expect(migrated.status).toBe('ignored');
        expect(migrated.currentSnapshotId).toBe(newSnap);
      } else {
        const entry = state.pending.find((p: {findings: Array<{id: string}>}) =>
          p.findings.some(f => f.id === findingId));
        expect(entry).toBeTruthy();
        // still attached to the OLD snapshot — nothing was auto-migrated
        const stalled = state.findings.find((f: {id: string}) => f.id === findingId);
        expect(stalled.currentSnapshotId).toBe(oldSnap);
      }
    });
  }

  it('shows a field-level diff for each pending candidate', async () => {
    const app = createApp();
    const audit = 'diffcase';
    const oldSnap = await upload(app, audit, 'before', 'repeated');
    const newSnap = await upload(app, audit, 'after', 'repeated');
    await seedFinding(app, 'repeated', audit, oldSnap);
    const res = await request(app)
      .post(`/api/reviews/${audit}/match`).send({oldSnapshotId: oldSnap, newSnapshotId: newSnap});
    const entry = res.body.state.pending[0];
    expect(entry.candidates.length).toBeGreaterThan(1);
    expect(entry.candidates[0].diff).toBeTruthy();
    expect(entry.candidates[0].newLabel).toMatch(/article/);
  });

  it('persists an explicit user-confirmed mapping and migrates the finding', async () => {
    const app = createApp();
    const audit = 'confirmcase';
    const key = 'repeated';
    const oldSnap = await upload(app, audit, 'before', key);
    const newSnap = await upload(app, audit, 'after', key);
    const {findingId} = await seedFinding(app, key, audit, oldSnap);
    const matched = await request(app)
      .post(`/api/reviews/${audit}/match`).send({oldSnapshotId: oldSnap, newSnapshotId: newSnap});
    const entry = matched.body.state.pending.find((p: {findings: Array<{id: string}>}) =>
      p.findings.some(f => f.id === findingId));
    const chosen = entry.candidates[0];

    await request(app).post(`/api/reviews/${audit}/mappings`).send({
      fromSnapshotId: oldSnap,
      toSnapshotId: newSnap,
      oldNid: entry.oldNid,
      newNid: chosen.newNid,
      resolution: 'confirmed',
      chosenCandidate: {confidence: chosen.confidence},
    }).expect(201);

    const state = await request(app).get(`/api/reviews/${audit}/state`).expect(200);
    const finding = state.body.findings.find((f: {id: string}) => f.id === findingId);
    expect(finding.currentTarget).toBe(chosen.newNid);
    expect(finding.currentSnapshotId).toBe(newSnap);
    expect(state.body.pending ?? state.body.pending).toEqual([]);
  });

  it('enforces one-to-one: the same new node cannot be mapped twice', async () => {
    const app = createApp();
    const audit = 'onetoone';
    const key = 'repeated';
    const fixture = FIXTURES.find(f => f.key === key)!;
    const oldSnap = await upload(app, audit, 'before', key);
    const newSnap = await upload(app, audit, 'after', key);
    const oldFlat = flattenSnapshot(fixture.before, oldSnap);
    const newFlat = flattenSnapshot(fixture.after, newSnap);
    const oldArticles = [...oldFlat.byNid.values()].filter(n => n.identity.tag === 'article');
    const newArticles = [...newFlat.byNid.values()].filter(n => n.identity.tag === 'article');
    expect(oldArticles.length).toBe(2);
    expect(newArticles.length).toBe(3);

    // seed one finding on each old twin
    await request(app).post(`/api/reviews/${audit}/findings`).send({
      snapshotId: oldSnap,
      findings: oldArticles.map((node, i) => ({
        target: node.nid, rule: `rule-${i}`, message: `m${i}`, severity: 'low' as const,
      })),
    }).expect(201);

    // first old twin -> second new twin: accepted
    await request(app).post(`/api/reviews/${audit}/mappings`).send({
      fromSnapshotId: oldSnap, toSnapshotId: newSnap,
      oldNid: oldArticles[0].nid, newNid: newArticles[1].nid, resolution: 'confirmed',
    }).expect(201);

    // second old twin -> SAME new twin: rejected (one-to-many)
    const conflict = await request(app).post(`/api/reviews/${audit}/mappings`).send({
      fromSnapshotId: oldSnap, toSnapshotId: newSnap,
      oldNid: oldArticles[1].nid, newNid: newArticles[1].nid, resolution: 'confirmed',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('one_to_one_conflict');
    expect(conflict.body.conflicting).toBeTruthy();
  });

  it('carries an explicit mapping across a third generation as an identity alias', async () => {
    const app = createApp();
    const audit = 'aliascase';
    const key = 'repeated';
    const fixture = FIXTURES.find(f => f.key === key)!;
    const s1 = await upload(app, audit, 'before', key);
    const s2 = await upload(app, audit, 'after', key);
    const {findingId, targetBefore} = await seedFinding(app, key, audit, s1);

    // generation 1 -> 2 is ambiguous (twins); reviewer resolves it explicitly
    const m1 = await request(app)
      .post(`/api/reviews/${audit}/match`).send({oldSnapshotId: s1, newSnapshotId: s2});
    const entry = m1.body.state.pending.find((p: {findings: Array<{id: string}>}) =>
      p.findings.some(f => f.id === findingId));
    const chosen = entry.candidates[0];
    await request(app).post(`/api/reviews/${audit}/mappings`).send({
      fromSnapshotId: s1, toSnapshotId: s2, oldNid: entry.oldNid,
      newNid: chosen.newNid, resolution: 'confirmed',
    }).expect(201);

    // generation 3: edit text on the surviving twin so its shape changes;
    // build it from the "after" tree by mutating the chosen node's text.
    const s2flat = flattenSnapshot(fixture.after, s2);
    const chosenNode = s2flat.byNid.get(chosen.newNid)!;
    const para = (chosenNode.node.children ?? []).find(c => c.tag === 'p');
    if (para?.children?.[0] && para.children[0].tag === '#text') {
      para.children[0].text = 'Noise cancelling, 30h battery — UPDATED COPY.';
    }
    const gen3: typeof fixture.after = {
      ...fixture.after,
      capturedAt: '2026-09-03T08:00:00.000Z',
    };
    const s3 = (await request(app).post(`/api/reviews/${audit}/snapshots`).send(gen3).expect(201)).body.id;

    // matching s2 -> s3 should follow the confirmed alias chain and auto-migrate
    const m2 = await request(app)
      .post(`/api/reviews/${audit}/match`).send({oldSnapshotId: s2, newSnapshotId: s3}).expect(200);
    const migrated = m2.body.state.autoMigrated.find((x: {findingId: string}) => x.findingId === findingId);
    expect(migrated).toBeTruthy();
    expect(migrated.oldNid).toBe(chosen.newNid);

    const state = m2.body.state;
    const finalFinding = state.findings.find((f: {id: string}) => f.id === findingId);
    expect(finalFinding.status).toBe('ignored'); // status preserved across generations
    expect(finalFinding.currentSnapshotId).toBe(s3);
    void targetBefore;
  });

  it('retains confirmed mapping audit records after old snapshots are pruned', async () => {    const app = createApp();
    const audit = 'auditcase';
    const oldSnap = await upload(app, audit, 'before', 'sibling-insert');
    const newSnap = await upload(app, audit, 'after', 'sibling-insert');
    const {targetBefore} = await seedFinding(app, 'sibling-insert', audit, oldSnap);
    await request(app).post(`/api/reviews/${audit}/match`).send({
      oldSnapshotId: oldSnap, newSnapshotId: newSnap,
    });
    // also record an explicit mapping for the auto-matched node (audit entry)
    const matchRes = await request(app).get(`/api/reviews/${audit}/state`);
    const auto = matchRes.body.autoMigrated[0];
    await request(app).post(`/api/reviews/${audit}/mappings`).send({
      fromSnapshotId: oldSnap, toSnapshotId: newSnap,
      oldNid: targetBefore, newNid: auto.newNid, resolution: 'confirmed',
    }).expect(201);

    const cleanup = await request(app).post(`/api/reviews/${audit}/cleanup`).send({keepLatest: 1});
    expect(cleanup.body.deleted).toContain(oldSnap);
    expect(cleanup.body.retainedMappings).toBeGreaterThanOrEqual(1);

    const mappings = await request(app).get(`/api/reviews/${audit}/mappings`).expect(200);
    const record = mappings.body.mappings[0];
    expect(record).toBeTruthy();
    expect(record.fromSnapshotId).toBe(oldSnap);
    expect(record.sourceSnapshotPruned).toBe(true);
    expect(record.oldDescriptor).toBeTruthy();
    expect(record.confirmedAt).toBeTruthy();
  });
});
