// Deterministic demo + test fixtures for every required remap scenario:
// sibling insert, node move, text change, repeated components, deletion,
// and cross-iframe boundary. Plus a synthetic large-DOM generator used to
// prove the complexity bound.

import {flattenSnapshot} from './dom';
import type {FlatSnapshot, SNode, SnapshotInput} from './types';

type El = SNode;
function el(tag: string, attrs: Record<string, string>, children: SNode[] = []): El {
  return {tag, attrs, children};
}
function txt(value: string): SNode {
  return {tag: '#text', text: value};
}
function linkRow(id: string, label: string): El {
  return el('li', {'data-testid': `row-${id}`}, [
    el('a', {href: `/item/${id}`}, [txt(label)]),
    el('button', {class: 'ghost', 'aria-label': `Ignore ${label}`}, [txt('Ignore')]),
  ]);
}
function card(id: string, title: string, body: string): El {
  return el('article', {'data-testid': `card-${id}`, class: 'card'}, [
    el('h3', {}, [txt(title)]),
    el('p', {}, [txt(body)]),
  ]);
}

const at = (iso: string) => new Date(iso).toISOString();

export type TargetHint = {testId?: string; id?: string; tag?: string; attr?: Record<string, string>; inFrame?: boolean};

export type Fixture = {
  key: string;
  title: string;
  description: string;
  before: SnapshotInput;
  after: SnapshotInput;
  findingTarget: TargetHint;
  finding: {rule: string; message: string; severity: 'low' | 'medium' | 'high'};
  /** what the matcher is expected to do with the finding target */
  expect: 'auto' | 'pending';
};

// 1. sibling insertion -----------------------------------------------------
// The reviewed <li> keeps stable attributes; an extra unkeyed <li> is
// inserted before it, so its child-index path changes.
function siblingInsert(): Fixture {
  const before: SnapshotInput = {
    url: 'https://shop.example.test/review',
    capturedAt: at('2026-09-01T08:00:00Z'),
    root: el('main', {id: 'content'}, [
      el('h1', {}, [txt('Checkout review')]),
      el('ul', {id: 'line-items'}, [
        linkRow('shipping', 'Shipping address'),
        linkRow('payment', 'Payment method'),
        linkRow('confirm', 'Confirm order'),
      ]),
    ]),
  };
  const after: SnapshotInput = {
    url: 'https://shop.example.test/review',
    capturedAt: at('2026-09-02T08:00:00Z'),
    root: el('main', {id: 'content'}, [
      el('div', {class: 'promo-banner'}, [txt('New: one-click checkout')]),
      el('h1', {}, [txt('Checkout review')]),
      el('ul', {id: 'line-items'}, [
        el('li', {class: 'banner-row'}, [txt('SAVE 10% TODAY')]),
        linkRow('shipping', 'Shipping address'),
        linkRow('payment', 'Payment method'),
        linkRow('confirm', 'Confirm order'),
      ]),
    ]),
  };
  return {
    key: 'sibling-insert',
    title: 'Sibling insertion',
    description: 'A banner row is inserted before the reviewed list item; its index path shifts by one.',
    before, after,
    findingTarget: {testId: 'row-payment'},
    finding: {rule: 'label', message: 'Button has ambiguous accessible name', severity: 'medium'},
    expect: 'auto',
  };
}

// 2. node move -------------------------------------------------------------
// The reviewed node relocates into a different subtree; stable identity
// follows it, the child-index path does not.
function nodeMove(): Fixture {
  const before: SnapshotInput = {
    url: 'https://shop.example.test/editor',
    capturedAt: at('2026-09-01T08:00:00Z'),
    root: el('div', {class: 'layout'}, [
      el('header', {}, [el('nav', {id: 'primary-nav'}, [
        el('a', {href: '/', 'data-testid': 'nav-home'}, [txt('Home')]),
        el('a', {href: '/tools', 'data-testid': 'nav-tools'}, [txt('Tools')]),
      ])]),
      el('main', {id: 'main'}, [
        el('section', {id: 'toolbar'}, [
          el('button', {'data-testid': 'submit-btn'}, [txt('Submit for review')]),
        ]),
      ]),
    ]),
  };
  const after: SnapshotInput = {
    url: 'https://shop.example.test/editor',
    capturedAt: at('2026-09-02T08:00:00Z'),
    root: el('div', {class: 'layout'}, [
      el('header', {}, [el('nav', {id: 'primary-nav'}, [
        el('a', {href: '/', 'data-testid': 'nav-home'}, [txt('Home')]),
        el('a', {href: '/tools', 'data-testid': 'nav-tools'}, [txt('Tools')]),
        el('button', {'data-testid': 'submit-btn', class: 'moved'}, [txt('Submit for review')]),
      ])]),
      el('main', {id: 'main'}, [el('section', {id: 'toolbar'})]),
    ]),
  };
  return {
    key: 'node-move',
    title: 'Node moved',
    description: 'The submit button is relocated from the toolbar section into the top nav.',
    before, after,
    findingTarget: {testId: 'submit-btn'},
    finding: {rule: 'target-size', message: 'Touch target smaller than 24px', severity: 'low'},
    expect: 'auto',
  };
}

// 3. text change -----------------------------------------------------------
// The reviewed hint keeps its id; its text is edited.
function textChange(): Fixture {
  const before: SnapshotInput = {
    url: 'https://shop.example.test/form',
    capturedAt: at('2026-09-01T08:00:00Z'),
    root: el('form', {id: 'signup'}, [
      el('label', {for: 'email'}, [txt('Email address')]),
      el('input', {id: 'email', type: 'email', 'aria-describedby': 'email-hint'}),
      el('p', {id: 'email-hint'}, [txt('We never share your email with anyone.')]),
      el('button', {'data-testid': 'signup-submit'}, [txt('Create your account')]),
    ]),
  };
  const after: SnapshotInput = {
    url: 'https://shop.example.test/form',
    capturedAt: at('2026-09-02T08:00:00Z'),
    root: el('form', {id: 'signup'}, [
      el('label', {for: 'email'}, [txt('Work email address')]),
      el('input', {id: 'email', type: 'email', 'aria-describedby': 'email-hint'}),
      el('p', {id: 'email-hint'}, [txt('We will never share your email address with anyone else.')]),
      el('button', {'data-testid': 'signup-submit'}, [txt('Create account')]),
    ]),
  };
  return {
    key: 'text-change',
    title: 'Text changed',
    description: 'Hint text and button label are edited; attributes and structure remain.',
    before, after,
    findingTarget: {id: 'email-hint'},
    finding: {rule: 'contrast', message: 'Hint text contrast below 4.5:1', severity: 'high'},
    expect: 'auto',
  };
}

// 4. repeated components ---------------------------------------------------
// Genuine unkeyed twins: two byte-identical cards before; after a distinct
// promo card is inserted and both twins survive. The reviewed target (the
// first twin) cannot be told apart from its clone and must stay pending.
function repeated(): Fixture {
  const card2 = (title: string, body: string): El =>
    el('article', {class: 'card'}, [el('h3', {}, [txt(title)]), el('p', {}, [txt(body)])]);
  const before: SnapshotInput = {
    url: 'https://shop.example.test/feed',
    capturedAt: at('2026-09-01T08:00:00Z'),
    root: el('section', {id: 'feed'}, [
      el('h2', {}, [txt('Recommendations')]),
      el('div', {class: 'grid'}, [
        card2('Wireless headphones', 'Noise cancelling, 30h battery.'),
        card2('Wireless headphones', 'Noise cancelling, 30h battery.'),
      ]),
    ]),
  };
  const after: SnapshotInput = {
    url: 'https://shop.example.test/feed',
    capturedAt: at('2026-09-02T08:00:00Z'),
    root: el('section', {id: 'feed'}, [
      el('h2', {}, [txt('Recommendations')]),
      el('div', {class: 'grid'}, [
        card2('Wireless headphones', 'Limited time offer.'),
        card2('Wireless headphones', 'Noise cancelling, 30h battery.'),
        card2('Wireless headphones', 'Noise cancelling, 30h battery.'),
      ]),
    ]),
  };
  return {
    key: 'repeated',
    title: 'Repeated components (unkeyed twins)',
    description: 'Identical cards without stable ids: the reviewed twin cannot be distinguished from its clone.',
    before, after,
    findingTarget: {tag: 'article', attr: {class: 'card'}},
    finding: {rule: 'heading-order', message: 'Card heading hierarchy unclear', severity: 'medium'},
    expect: 'pending',
  };
}

// 4b. repeated components WITH keys -> deterministic auto migration.
export function repeatedKeyed(): Fixture {
  const base = repeated();
  const keyed = (node: SNode, id: string): SNode =>
    node.tag === 'article'
      ? {...node, attrs: {...node.attrs, 'data-testid': id}, children: node.children}
      : node;
  const addKeys = (root: SNode, ids: string[]): SNode => {
    let i = 0;
    const walkNode = (n: SNode): SNode => {
      if (n.tag === 'article') { const k = keyed(n, ids[i++]); return {...k, children: (n.children ?? []).map(walkNode)}; }
      return {...n, children: (n.children ?? []).map(walkNode)};
    };
    return walkNode(root);
  };
  return {
    ...base,
    key: 'repeated-keyed',
    title: 'Repeated components (keyed)',
    description: 'Same list but each card carries a data-testid: the right twin is selected automatically.',
    before: {...base.before, root: addKeys(base.before.root, ['card-a', 'card-b'])},
    after: {...base.after, root: addKeys(base.after.root, ['card-new', 'card-a', 'card-b'])},
    findingTarget: {testId: 'card-a'},
    expect: 'auto',
  };
}

// 5. deletion --------------------------------------------------------------
// The reviewed node disappears. The finding must surface as deleted rather
// than re-attaching to a surviving neighbor.
function deletion(): Fixture {
  const row = (testid: string, label: string): El => el('div', {class: 'row'}, [
    el('label', {}, [txt(label)]),
    el('input', {'data-testid': testid, type: 'checkbox'}),
  ]);
  const before: SnapshotInput = {
    url: 'https://shop.example.test/settings',
    capturedAt: at('2026-09-01T08:00:00Z'),
    root: el('main', {id: 'settings'}, [
      el('h1', {}, [txt('Settings')]),
      row('weekly-toggle', 'Email me weekly'),
      row('mention-toggle', 'Email me when mentioned'),
      row('marketing-toggle', 'Marketing emails'),
    ]),
  };
  const after: SnapshotInput = {
    url: 'https://shop.example.test/settings',
    capturedAt: at('2026-09-02T08:00:00Z'),
    root: el('main', {id: 'settings'}, [
      el('h1', {}, [txt('Settings')]),
      row('weekly-toggle', 'Email me weekly'),
      row('mention-toggle', 'Email me when mentioned'),
    ]),
  };
  return {
    key: 'deletion',
    title: 'Node deleted',
    description: 'The marketing toggle row is removed; the finding must not jump to a surviving checkbox.',
    before, after,
    findingTarget: {testId: 'marketing-toggle'},
    finding: {rule: 'label', message: 'Checkbox label not programmatically associated', severity: 'high'},
    expect: 'pending',
  };
}

// 6. cross-iframe boundary -------------------------------------------------
// Reviewed dialog has a stable id and moves out of its iframe into the top
// document: auto-migratable across the frame boundary.
function chatWidget(withKey: boolean): El {
  const attrs: Record<string, string> = withKey
    ? {id: 'chat-widget', role: 'dialog', 'aria-label': 'Support chat'}
    : {role: 'dialog'};
  return el('div', attrs, [
    el('button', {class: 'chat-open'}, [txt('Open chat')]),
    el('p', {class: 'chat-note'}, [txt('We typically reply in a few minutes.')]),
  ]);
}
function crossIframe(withKey: boolean): Fixture {
  const before: SnapshotInput = {
    url: 'https://shop.example.test/contact',
    capturedAt: at('2026-09-01T08:00:00Z'),
    root: el('main', {id: 'page'}, [
      el('h1', {}, [txt('Contact us')]),
      {tag: 'iframe', attrs: {src: 'https://cdn.example.test/chat/v1.html', title: 'Support chat', 'data-testid': 'chat-frame'}, frame: 'f0'},
    ]),
    frames: [
      {id: 'f0', src: 'https://cdn.example.test/chat/v1.html', title: 'Support chat', root: chatWidget(withKey)},
    ],
  };
  const after: SnapshotInput = {
    url: 'https://shop.example.test/contact',
    capturedAt: at('2026-09-02T08:00:00Z'),
    root: el('main', {id: 'page'}, [
      el('h1', {}, [txt('Contact us')]),
      el('section', {class: 'chat-host'}, [chatWidget(withKey)]),
    ]),
  };
  return {
    key: withKey ? 'cross-iframe' : 'cross-iframe-nokey',
    title: withKey ? 'Cross-iframe move (keyed)' : 'Cross-iframe move (no stable key)',
    description: withKey
      ? 'The chat dialog moves out of its iframe into the top document; frame path changes but id survives.'
      : 'Same move without a stable id: cross-frame structural matches must wait for explicit confirmation.',
    before, after,
    findingTarget: {tag: 'div', attr: {role: 'dialog'}, inFrame: true},
    finding: {rule: 'aria', message: 'Dialog focus is not trapped', severity: 'medium'},
    expect: withKey ? 'auto' : 'pending',
  };
}

export const FIXTURES: Fixture[] = [
  siblingInsert(),
  nodeMove(),
  textChange(),
  repeated(),
  repeatedKeyed(),
  deletion(),
  crossIframe(true),
  crossIframe(false),
];

export function findInInput(input: SnapshotInput, pred: (node: SNode) => boolean, frames = true): SNode | null {
  const search = (node: SNode): SNode | null => {
    if (pred(node)) return node;
    for (const child of node.children ?? []) {
      const found = search(child);
      if (found) return found;
    }
    return null;
  };
  const rootHit = search(input.root);
  if (rootHit) return rootHit;
  if (frames) {
    for (const frame of input.frames ?? []) {
      const hit = search(frame.root);
      if (hit) return hit;
    }
  }
  return null;
}

function matchesHint(node: SNode, hint: TargetHint): boolean {
  if (hint.testId && node.attrs?.['data-testid'] !== hint.testId) return false;
  if (hint.id && node.attrs?.id !== hint.id) return false;
  if (hint.tag && node.tag !== hint.tag) return false;
  if (hint.attr) {
    for (const [k, v] of Object.entries(hint.attr)) {
      if ((node.attrs?.[k] ?? '') !== v) return false;
    }
  }
  return true;
}

/** Flatten both fixture sides and locate the reviewed element's nid in the old snapshot. */
export function fixtureFlatPair(fixture: Fixture): {
  before: FlatSnapshot; after: FlatSnapshot; targetBefore: string; targetNode: SNode;
} {
  const before = flattenSnapshot(fixture.before, 'snap-before');
  const after = flattenSnapshot(fixture.after, 'snap-after');

  const targetNode = findInInput(fixture.before, n => matchesHint(n, fixture.findingTarget), !!fixture.findingTarget.inFrame);
  const flat = targetNode ? [...before.byNid.values()].find(n => n.node === targetNode) : undefined;
  if (!targetNode || !flat) throw new Error(`fixture ${fixture.key}: finding target not located`);
  return {before, after, targetBefore: flat.nid, targetNode};
}

// large DOM generator for complexity tests --------------------------------

export function largeTree(opts?: {lists?: number; perList?: number}): {
  before: SnapshotInput; after: SnapshotInput; targetTestId: string; movedTestId: string;
} {
  const lists = opts?.lists ?? 300;
  const per = opts?.perList ?? 60; // ~18k+ element nodes
  const mk = (insertList: number): SnapshotInput => ({
    url: 'https://large.example.test/',
    capturedAt: at('2026-09-01T08:00:00Z'),
    root: el('main', {id: 'big'}, Array.from({length: lists}, (_, li) =>
      el('section', {id: `sec-${li}`}, [
        el('ul', {'data-testid': `list-${li}`}, Array.from({length: per + (li === insertList ? 1 : 0)}, (_, i) => {
          if (li === insertList && i === 0) return el('li', {class: 'injected'}, [txt('injected')]);
          const realIndex = li === insertList ? i - 1 : i;
          return el('li', {}, [
            el('a', {href: `/l/${li}/${realIndex}`, 'data-testid': `l-${li}-${realIndex}`}, [
              txt(`Item ${li} ${realIndex}`),
            ]),
          ]);
        })),
      ]))),
  });
  return {
    before: mk(-1),
    after: mk(7),
    targetTestId: `l-${lists - 1}-${per - 1}`,
    movedTestId: `l-7-${per - 1}`,
  };
}
