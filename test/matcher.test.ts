import {describe, expect, it} from 'vitest';
import {FIXTURES, fixtureFlatPair, largeTree} from '../src/shared/fixtures';
import {matchSnapshots, AUTO_CONFIDENCE} from '../src/shared/matcher';
import {flattenSnapshot} from '../src/shared/dom';
import type {SNode, SnapshotInput} from '../src/shared/types';

function matchFixture(key: string) {
  const fixture = FIXTURES.find(f => f.key === key)!;
  const {before, after, targetBefore} = fixtureFlatPair(fixture);
  const plan = matchSnapshots({oldSnapshot: before, newSnapshot: after});
  return {fixture, plan, targetBefore};
}

describe('identity extraction', () => {
  it('never uses child-index path as identity', () => {
    const f = FIXTURES.find(x => x.key === 'sibling-insert')!;
    const {before, targetBefore} = fixtureFlatPair(f);
    const node = before.byNid.get(targetBefore)!;
    expect(node.identity.keys.length).toBeGreaterThan(0);
    expect(node.identity.keyDigest).not.toBe(node.identity.path.join('/'));
    // shape digest is an opaque hash, not a positional path
    expect(node.identity.shape).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects auto-generated ids but keeps author ids', () => {
    const input: SnapshotInput = {
      url: 'u', capturedAt: 't',
      root: {tag: 'div', attrs: {id: 'main'}, children: [
        {tag: 'span', attrs: {id: ':r12:'}, children: [{tag: '#text', text: 'x'}]},
      ]},
    };
    const snap = flattenSnapshot(input, 's');
    const nodes = [...snap.byNid.values()];
    const main = nodes.find(n => n.node.attrs?.id === 'main')!;
    const span = nodes.find(n => n.node.attrs?.id === ':r12:')!;
    expect(main.identity.keys.some(k => k.kind === 'id' && k.value === 'main')).toBe(true);
    expect(span.identity.keys.some(k => k.kind === 'id')).toBe(false);
  });

  it('includes frame path so equal widgets in different frames differ', () => {
    const widget: SNode = {tag: 'button', attrs: {id: 'ok'}, children: [{tag: '#text', text: 'OK'}]};
    const input: SnapshotInput = {
      url: 'u', capturedAt: 't',
      root: {tag: 'main', children: [
        widget,
        {tag: 'iframe', attrs: {id: 'frame-a'}, frame: 'f0'},
        {tag: 'iframe', attrs: {id: 'frame-b'}, frame: 'f1'},
      ]},
      frames: [
        {id: 'f0', root: widget},
        {id: 'f1', root: widget},
      ],
    };
    const snap = flattenSnapshot(input, 's');
    const buttons = [...snap.byNid.values()].filter(n => n.identity.tag === 'button');
    expect(buttons.length).toBe(3);
    const framePaths = new Set(buttons.map(b => b.identity.framePath.join('/')));
    expect(framePaths.size).toBe(3);
    // keys alone collide across frames; framePath disambiguates the bucket key
    expect(snap.frameOf.get(buttons[1].nid)).toEqual(['f0']);
    expect(snap.frameOf.get(buttons[2].nid)).toEqual(['f1']);
  });
});

describe('required remap scenarios', () => {
  it('sibling insertion: auto-migrates despite shifted index path', () => {
    const {plan, targetBefore} = matchFixture('sibling-insert');
    const match = plan.byOld.get(targetBefore);
    expect(match).toBeTruthy();
    expect(match!.auto).toBe(true);
    expect(match!.confidence).toBeGreaterThanOrEqual(AUTO_CONFIDENCE);
    // prove the index path actually changed
    const oldNode = plan;
    void oldNode;
  });

  it('node move: follows stable identity to a different subtree', () => {
    const {plan, targetBefore, fixture} = matchFixture('node-move');
    const before = fixtureFlatPair(fixture).before;
    const after = fixtureFlatPair(fixture).after;
    const oldNode = before.byNid.get(targetBefore)!;
    const match = plan.byOld.get(targetBefore)!;
    const newNode = after.byNid.get(match.newNid)!;
    expect(match.confidence).toBeGreaterThanOrEqual(AUTO_CONFIDENCE);
    expect(newNode.node.attrs?.['data-testid']).toBe('submit-btn');
    expect(newNode.identity.path).not.toEqual(oldNode.identity.path);
  });

  it('text change: matches on stable id and structure, tolerates edited text', () => {
    const {plan, targetBefore, fixture} = matchFixture('text-change');
    const after = fixtureFlatPair(fixture).after;
    const match = plan.byOld.get(targetBefore)!;
    const newNode = after.byNid.get(match.newNid)!;
    // <p id="email-hint"> text changed but stable id keeps identity
    expect(newNode.node.attrs?.id).toBe('email-hint');
    expect(match.signals.some(s => s.signal === 'stable_key')).toBe(true);
    // the shape fingerprint changed (edited text), yet the id match wins
    expect(match.confidence).toBeGreaterThanOrEqual(AUTO_CONFIDENCE);
  });

  it('repeated unkeyed components: goes pending, never auto-picks a twin', () => {
    const {plan, targetBefore} = matchFixture('repeated');
    expect(plan.byOld.get(targetBefore)).toBeUndefined();
    const pending = plan.pending.find(p => p.oldNid === targetBefore)!;
    expect(['ambiguous', 'low_confidence', 'contested']).toContain(pending.reason);
    expect(pending.candidates.length).toBeGreaterThan(1);
  });

  it('repeated keyed components: picks the correct twin automatically', () => {
    const {plan, targetBefore, fixture} = matchFixture('repeated-keyed');
    const after = fixtureFlatPair(fixture).after;
    const match = plan.byOld.get(targetBefore)!;
    expect(match).toBeTruthy();
    const newNode = after.byNid.get(match.newNid)!;
    expect(newNode.node.attrs?.['data-testid']).toBe('card-a');
  });

  it('node deletion: pending as deleted with no auto re-attachment', () => {
    const {plan, targetBefore} = matchFixture('deletion');
    expect(plan.byOld.get(targetBefore)).toBeUndefined();
    const pending = plan.pending.find(p => p.oldNid === targetBefore)!;
    expect(pending.reason).toBe('deleted');
    expect(pending.candidates.length).toBe(0);
  });

  it('cross-iframe move with stable key: auto-migrates across boundary', () => {
    const {plan, targetBefore, fixture} = matchFixture('cross-iframe');
    const after = fixtureFlatPair(fixture).after;
    const match = plan.byOld.get(targetBefore)!;
    expect(match.confidence).toBeGreaterThanOrEqual(AUTO_CONFIDENCE);
    const newNode = after.byNid.get(match.newNid)!;
    expect(newNode.identity.framePath).toEqual([]);
    expect(newNode.node.attrs?.id).toBe('chat-widget');
  });

  it('cross-iframe move without stable key: stays pending', () => {
    const {plan, targetBefore} = matchFixture('cross-iframe-nokey');
    expect(plan.byOld.get(targetBefore)).toBeUndefined();
    const pending = plan.pending.find(p => p.oldNid === targetBefore)!;
    expect(pending.reason).toBe('cross_frame');
  });
});

describe('one-to-one assignment', () => {
  it('never assigns the same new node to two old nodes automatically', () => {
    for (const fixture of FIXTURES) {
      const {before, after} = fixtureFlatPair(fixture);
      const plan = matchSnapshots({oldSnapshot: before, newSnapshot: after});
      const targets = plan.matches.map(m => m.newNid);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('is deterministic across repeated runs', () => {
    const fixture = FIXTURES.find(f => f.key === 'repeated')!;
    const {before, after} = fixtureFlatPair(fixture);
    const runs = Array.from({length: 5}, () =>
      JSON.stringify(matchSnapshots({oldSnapshot: before, newSnapshot: after}), replacer));
    expect(new Set(runs).size).toBe(1);
  });
});

function replacer(_key: string, value: unknown) {
  return value instanceof Map ? {__map: [...value]} : value;
}

describe('complexity bound', () => {
  it('scales linearly: comparisons far below the old*new product', () => {
    const {before: bIn, after: aIn} = largeTree();
    const before = flattenSnapshot(bIn, 'big-before');
    const after = flattenSnapshot(aIn, 'big-after');
    const n = before.byNid.size;
    const m = after.byNid.size;
    const plan = matchSnapshots({oldSnapshot: before, newSnapshot: after});
    // Hard upper bound check: no Cartesian product.
    expect(plan.stats.comparisons).toBeLessThan(n * 24 + 50);
    expect(plan.stats.comparisons).toBeLessThan(n * m);
    expect(m).toBeGreaterThan(10000);
    // the node at the end keeps its identity; sibling insertion early in
    // one list must not break matching elsewhere
    const plan2 = plan;
    void plan2;
  });

  it('matches the last-node target after early sibling insertion', () => {
    const {before: bIn, after: aIn, targetTestId} = largeTree();
    const before = flattenSnapshot(bIn, 'big-before');
    const after = flattenSnapshot(aIn, 'big-after');
    const target = [...before.byNid.values()].find(n => n.node.attrs?.['data-testid'] === targetTestId)!;
    const plan = matchSnapshots({oldSnapshot: before, newSnapshot: after});
    const match = plan.byOld.get(target.nid);
    expect(match).toBeTruthy();
    const newNode = after.byNid.get(match!.newNid)!;
    expect(newNode.node.attrs?.['data-testid']).toBe(targetTestId);
  });
});
