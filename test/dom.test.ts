// @vitest-environment node
import {describe, expect, it, beforeEach} from 'vitest';
import {JSDOM} from 'jsdom';
import {mountDocument} from '../src/client/demo';
import {captureDocument} from '../src/client/scanner';
import {basePage, crossIframeMove, siblingInsert} from '../src/client/demo';
import {buildSnapshot} from '../src/shared/identity';
import {reconcile} from '../src/shared/matcher';
import type {RawNode} from '../src/shared/types';

function roundTrip(tree: RawNode): RawNode {
  const dom = new JSDOM('<!doctype html><meta charset="utf-8">', {pretendToBeVisual: true});
  const doc = dom.window.document;
  // Synchronous rAF on the top window (renderToDom schedules nested-frame
  // mounts through the owner document's defaultView).
  let rafQueue: FrameRequestCallback[] = [];
  const installRaf = (win: Window & typeof globalThis) => {
    (win as unknown as {requestAnimationFrame: (cb: FrameRequestCallback) => number}).requestAnimationFrame =
      (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      };
  };
  installRaf(dom.window as unknown as Window & typeof globalThis);
  mountDocument(doc, tree);
  // Nested iframes create their own windows during mount; install and flush
  // in waves until the frame subtree is populated.
  for (let wave = 0; wave < 4; wave++) {
    const frames = dom.window.document.querySelectorAll('iframe, frame');
    frames.forEach((frame) => {
      const contentWindow = (frame as HTMLIFrameElement).contentWindow as
        | (Window & typeof globalThis)
        | null;
      if (contentWindow) installRaf(contentWindow);
    });
    const queue = rafQueue;
    rafQueue = [];
    for (const cb of queue) cb(0);
  }
  return captureDocument(doc);
}

describe('live DOM capture round trip', () => {
  it('captures the populated documentElement (not an empty <html>)', () => {
    const captured = roundTrip(basePage());
    expect(captured.tag).toBe('html');
    const body = captured.children?.find((c) => c.tag === 'body');
    expect(body?.children?.length).toBeGreaterThan(0);
    const allTags: string[] = [];
    const walk = (n: RawNode) => {
      allTags.push(n.tag);
      for (const c of n.children ?? []) walk(c);
    };
    walk(captured);
    expect(allTags).toContain('main');
    expect(allTags).toContain('iframe');
  });

  it('captures same-origin iframe content recursively', () => {
    const captured = roundTrip(basePage());
    let frame: RawNode | undefined;
    const walk = (n: RawNode) => {
      if (n.tag === 'iframe') frame = n;
      for (const c of n.children ?? []) walk(c);
    };
    walk(captured);
    expect(frame?.frame?.root).toBeTruthy();
    let found = false;
    const walkFrame = (n: RawNode) => {
      if (n.text === 'Accept all') found = true;
      for (const c of n.children ?? []) walkFrame(c);
    };
    walkFrame(frame!.frame!.root);
    expect(found).toBe(true);
  });

  describe('reconcile over real scanned DOM', () => {
    beforeEach(() => {
      // jsdom iframe contentDocument access needs this window context.
    });

    it('survives sibling insertion after scanning the live preview', () => {
      const s1 = buildSnapshot('d', 1, roundTrip(basePage()), 'd1');
      const s2 = buildSnapshot('d', 2, roundTrip(siblingInsert(basePage())), 'd2');
      const flagged = s1.nodes.find((n) => n.attrs['data-issue'] === 'link-non-descriptive')!;
      const result = reconcile(s1, s2);
      const match = result.matches.find(
        (m) => m.oldRef.uid === flagged.uid && m.oldRef.frameId === flagged.frameId,
      )!;
      expect(match.status).toBe('auto');
    });

    it('follows a node moving inside the scanned embedded frame', () => {
      const s1 = buildSnapshot('d', 1, roundTrip(basePage()), 'd1');
      const s2 = buildSnapshot('d', 2, roundTrip(crossIframeMove(basePage())), 'd2');
      const inner = s1.nodes.find(
        (n) => n.frameId !== 'top' && n.tag === 'button' && n.text === 'Accept all',
      )!;
      const result = reconcile(s1, s2);
      const match = result.matches.find(
        (m) => m.oldRef.uid === inner.uid && m.oldRef.frameId === inner.frameId,
      )!;
      expect(match.status).toBe('auto');
      expect(match.newRef?.frameId).not.toBe('top');
    });
  });
});
