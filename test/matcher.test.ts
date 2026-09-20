import {describe, expect, it} from 'vitest';
import {buildSnapshot} from '../src/shared/identity';
import {CANDIDATE_CAP, reconcile, textSimilarity} from '../src/shared/matcher';
import type {RawNode, Snapshot, SnapNode} from '../src/shared/types';
import {
  basePage,
  crossIframeMove,
  duplicateComponent,
  nodeDelete,
  nodeMove,
  siblingInsert,
  textChange,
} from '../src/client/demo';

function snap(seq: number, root: RawNode): Snapshot {
  return buildSnapshot('t', seq, root, `snap_t_${seq}`, new Date(seq * 1000).toISOString());
}

function findNode(snapshot: Snapshot, predicate: (n: SnapNode) => boolean): SnapNode {
  const hit = snapshot.nodes.find(predicate);
  if (!hit) throw new Error('node not found');
  return hit;
}

function byIssue(snapshot: Snapshot, issue: string): SnapNode {
  return findNode(snapshot, (n) => n.attrs['data-issue'] === issue);
}

function matchOf(result: ReturnType<typeof reconcile>, oldNode: SnapNode) {
  return result.matches.find(
    (m) => m.oldRef.uid === oldNode.uid && m.oldRef.frameId === oldNode.frameId,
  )!;
}

describe('text similarity', () => {
  it('is 1 for equal text and high for reworded text', () => {
    expect(textSimilarity('Alpha report', 'Alpha report')).toBe(1);
    expect(textSimilarity('Alpha report', 'Alpha quarterly report (renamed)')).toBeGreaterThan(0.4);
    expect(textSimilarity('Alpha report', 'Beta report')).toBeLessThan(0.6);
  });
});

describe('snapshot identity', () => {
  it('never keys on child-index paths and keeps paths display-only', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, siblingInsert(basePage()));
    const oldLink = byIssue(s1, 'link-non-descriptive');
    const newLink = byIssue(s2, 'link-non-descriptive');
    // The whole point: index path shifted (3rd -> 4th nav anchor).
    expect(oldLink.path).not.toEqual(newLink.path);
    // Stable id of the parent nav survives, and fingerprints are comparable.
    expect(oldLink.fingerprint.stableKeys).toEqual(newLink.fingerprint.stableKeys);
  });

  it('assigns content-derived frame ids independent of document order', () => {
    const s = snap(1, basePage());
    expect(s.frames.map((f) => f.id)).toEqual([
      'top',
      'top/name_settings-frame',
    ]);
  });
});

describe('reconcile scenarios', () => {
  it('1. sibling insertion: follows the node across the shifted index (AUTO)', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, siblingInsert(basePage()));
    const result = reconcile(s1, s2);
    const flagged = byIssue(s1, 'link-non-descriptive');
    const match = matchOf(result, flagged);
    expect(match.status).toBe('auto');
    expect(match.newRef?.uid).toBe(byIssue(s2, 'link-non-descriptive').uid);
    expect(match.confidence).toBeGreaterThanOrEqual(0.66);
  });

  it('2. node move: relocating a uniquely identifiable node is AUTO via neighborhood', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, nodeMove(basePage()));
    const result = reconcile(s1, s2);
    const match = matchOf(result, byIssue(s1, 'link-non-descriptive'));
    expect(match.status).toBe('auto');
    expect(match.newRef?.uid).toBe(byIssue(s2, 'link-non-descriptive').uid);
  });

  it('3. text change: reworded text still matches with a margin over twins', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, textChange(basePage()));
    const result = reconcile(s1, s2);
    const match = matchOf(result, byIssue(s1, 'list-structure'));
    expect(match.status).toBe('auto');
    expect(match.newRef?.uid).toBe(byIssue(s2, 'list-structure').uid);
    expect(match.reasons.some((r) => r.startsWith('text~') || r.startsWith('name~'))).toBe(true);
  });

  it('4. duplicate components: an exact twin forces a one-to-many pending', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, duplicateComponent(basePage()));
    const result = reconcile(s1, s2);
    // The "Plan Pro" card now has an indistinguishable identical twin:
    // nothing intrinsic can tell them apart, so it cannot auto-migrate.
    const proHeading = findNode(s1, (n) => n.tag === 'h3' && n.text === 'Plan Pro');
    const proCard = s1.nodes.find((n) => n.uid === proHeading.parentUid)!;
    const match = matchOf(result, proCard);
    expect(['pending_ambiguous', 'pending_low_confidence']).toContain(match.status);
    expect(match.newRef).toBeNull();
    expect(match.candidates.length).toBeGreaterThanOrEqual(2);
    // Two identical "Plan Pro" headings exist in the new snapshot.
    const twinHeads = s2.nodes.filter((n) => n.tag === 'h3' && n.text === 'Plan Pro');
    expect(twinHeads.length).toBe(2);
  });

  it('5. node deletion: removed anchor is deleted or forced pending, never carried', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, nodeDelete(basePage()));
    const result = reconcile(s1, s2);
    const match = matchOf(result, byIssue(s1, 'focus-order'));
    expect(['deleted', 'pending_low_confidence', 'pending_ambiguous']).toContain(match.status);
    expect(match.newRef).toBeNull();
  });

  it('6. cross-iframe: follows a node moving inside an embedded frame', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, crossIframeMove(basePage()));
    const result = reconcile(s1, s2);
    const frameId = s1.frames[1].id;
    expect(result.frameAlignment[frameId]).toBe(frameId);
    const innerButton = findNode(
      s1,
      (n) => n.frameId !== 'top' && n.tag === 'button' && n.text === 'Accept all',
    );
    const match = matchOf(result, innerButton);
    expect(match.status).toBe('auto');
    const target = s2.nodes.find((n) => n.uid === match.newRef!.uid)!;
    expect(target.frameId).not.toBe('top');
    expect(target.text).toBe('Accept all');
  });

  it('matches are one-to-one: no two old nodes claim the same new node as auto', () => {
    const s1 = snap(1, basePage());
    const s2 = snap(2, duplicateComponent(basePage()));
    const result = reconcile(s1, s2);
    const claimed = result.matches
      .filter((m) => m.status === 'auto')
      .map((m) => `${m.newRef!.frameId}/${m.newRef!.uid}`);
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe('frame boundaries', () => {
  it('unresolved nested frames become pending, never deletions', () => {
    // New tree: iframe owner loses its stable name -> content-derived frame id
    // changes and the owner is a plain element without content.
    const changed: RawNode = JSON.parse(JSON.stringify(basePage()));
    const iframeNode = (function walk(n: RawNode): RawNode | null {
      if (n.tag === 'iframe') return n;
      for (const child of n.children ?? []) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    })(changed)!;
    iframeNode.attrs = {...(iframeNode.attrs ?? {}), class: 'empty-slot'};
    delete iframeNode.attrs.name;
    delete iframeNode.frame;

    const s1 = snap(1, basePage());
    const s2 = snap(2, changed);
    const result = reconcile(s1, s2);
    const inner = result.matches.filter((m) => m.oldRef.frameId !== 'top');
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every((m) => m.status === 'pending_frame_unresolved')).toBe(true);
  });
});

describe('complexity bound', () => {
  it('scored edges stay within CANDIDATE_CAP * N on a large shuffled DOM', () => {
    // 3000 nearly-twin rows in a list, then a batch insertion at the front.
    const row = (i: number): RawNode => ({
      tag: 'li',
      attrs: {class: 'row', 'data-testid': `row-${i}`},
      children: [
        {tag: 'span', text: `Item ${i}`},
        {tag: 'button', text: 'Open'},
      ],
    });
    const tree: RawNode = {
      tag: 'html',
      children: [
        {
          tag: 'body',
          children: [
            {
              tag: 'ul',
              attrs: {id: 'biglist'},
              children: Array.from({length: 3000}, (_, i) => row(i)),
            },
          ],
        },
      ],
    };
    const inserted: RawNode = JSON.parse(JSON.stringify(tree));
    const list = inserted.children![0].children![0];
    list.children!.unshift(
      ...Array.from({length: 50}, (_, i) => ({
        tag: 'li',
        attrs: {class: 'row', 'data-testid': `new-${i}`},
        children: [
          {tag: 'span', text: `New item ${i}`},
          {tag: 'button', text: 'Open'},
        ],
      })),
    );

    const s1 = snap(1, tree);
    const s2 = snap(2, inserted);
    const result = reconcile(s1, s2);
    expect(result.stats.scoredEdges).toBeLessThanOrEqual(
      CANDIDATE_CAP * s1.nodes.length,
    );
    // The reported bound is strictly per-old-node.
    expect(result.stats.edgeBound).toBe(CANDIDATE_CAP * s1.nodes.length);
    // Runtime guard surfaced in stats.
    expect(result.stats.scoredEdges).toBeLessThan(s1.nodes.length * s2.nodes.length);
  });

  it('a no-stable-id homogeneous list with a front insert cannot mass auto-match', () => {
    // Identical rows, no testids: duplicates must not all claim the same
    // shifted targets automatically.
    const make = (count: number): RawNode => ({
      tag: 'ul',
      children: Array.from({length: count}, () => ({
        tag: 'li',
        attrs: {class: 'row'},
        text: 'same label',
      })),
    });
    const s1 = snap(1, make(20));
    const bigger = make(21);
    const s2 = snap(2, bigger);
    const result = reconcile(s1, s2);
    const autos = result.matches.filter((m) => m.status === 'auto');
    expect(autos.length).toBeLessThan(20);
    expect(result.stats.scoredEdges).toBeLessThanOrEqual(CANDIDATE_CAP * s1.nodes.length);
  });
});
