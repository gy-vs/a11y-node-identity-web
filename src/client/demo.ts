// Programmatically built demo page rendered inside a sandbox iframe, plus six
// mutation scenarios used to exercise the matcher end to end.

import type {RawNode} from '../shared/types';

// Inner iframe document (same-origin srcdoc): a settings panel with issues.
const innerDoc: RawNode = {
  tag: 'html',
  children: [
    {
      tag: 'body',
      attrs: {class: 'settings'},
      children: [
        {
          tag: 'section',
          attrs: {'aria-label': 'Cookie preferences', 'data-issue': 'region-name'},
          children: [
            {tag: 'h2', text: 'Cookie settings'},
            {
              tag: 'label',
              children: [
                {tag: 'input', attrs: {type: 'checkbox', name: 'tracking', 'data-issue': 'label-missing'}},
              ],
            },
            {
              tag: 'button',
              attrs: {class: 'btn-ghost', 'data-issue': 'low-contrast'},
              text: 'Accept all',
            },
          ],
        },
      ],
    },
  ],
};

function iframe(name: string): RawNode {
  return {
    tag: 'iframe',
    attrs: {
      title: 'Embedded settings',
      name,
      srcdoc: '<!doctype html><title>settings</title>',
    },
    frame: {name, root: innerDoc},
  };
}

export function basePage(): RawNode {
  return {
    tag: 'html',
    attrs: {lang: 'en'},
    children: [
      {
        tag: 'body',
        children: [
          {
            tag: 'header',
            children: [
              {tag: 'a', attrs: {href: '/', class: 'logo'}, text: 'Acme'},
              {
                tag: 'nav',
                attrs: {id: 'mainnav', 'aria-label': 'Primary'},
                children: [
                  {tag: 'a', attrs: {href: '/home'}, text: 'Home'},
                  {tag: 'a', attrs: {href: '/pricing'}, text: 'Pricing'},
                  {tag: 'a', attrs: {href: '/docs', 'data-issue': 'link-non-descriptive'}, text: 'Click here'},
                ],
              },
            ],
          },
          {
            tag: 'main',
            attrs: {id: 'content'},
            children: [
              {
                tag: 'ul',
                attrs: {class: 'results', 'data-testid': 'results-list'},
                children: [
                  {tag: 'li', attrs: {'data-issue': 'list-structure'}, text: 'Alpha report'},
                  {tag: 'li', text: 'Beta report'},
                  {tag: 'li', text: 'Gamma report'},
                ],
              },
              {
                tag: 'div',
                attrs: {class: 'cards'},
                children: [
                  {
                    tag: 'article',
                    attrs: {class: 'card'},
                    children: [{tag: 'h3', text: 'Plan Starter'}, {tag: 'p', text: '$9 / month'}],
                  },
                  {
                    tag: 'article',
                    attrs: {class: 'card'},
                    children: [{tag: 'h3', text: 'Plan Pro'}, {tag: 'p', text: '$29 / month'}],
                  },
                  {
                    tag: 'article',
                    attrs: {class: 'card'},
                    children: [{tag: 'h3', text: 'Plan Enterprise'}, {tag: 'p', text: 'Custom'}],
                  },
                ],
              },
              {
                tag: 'button',
                attrs: {class: 'btn-primary', 'data-issue': 'focus-order'},
                text: 'Download audit',
              },
              iframe('settings-frame'),
            ],
          },
          {
            tag: 'footer',
            children: [
              {tag: 'a', attrs: {href: '/legal', 'data-issue': 'contrast'}, text: 'Legal'},
            ],
          },
        ],
      },
    ],
  };
}

export type Transform = (root: RawNode) => RawNode;

/** Structural clone (frame content is immutable demo data; shared by ref). */
function clone(node: RawNode): RawNode {
  return {
    tag: node.tag,
    ...(node.attrs ? {attrs: {...node.attrs}} : {}),
    ...(node.text !== undefined ? {text: node.text} : {}),
    ...(node.frame ? {frame: node.frame} : {}),
    ...(node.children ? {children: node.children.map(clone)} : {}),
  };
}

function find(
  node: RawNode,
  predicate: (n: RawNode) => boolean,
  path: number[] = [],
): {node: RawNode; parent: RawNode | null; path: number[]} | null {
  if (predicate(node)) return {node, parent: null, path};
  for (let i = 0; i < (node.children ?? []).length; i++) {
    const hit = find(node.children![i], predicate, [...path, i]);
    if (hit) return hit.parent ? hit : {...hit, parent: node};
  }
  return null;
}

/** 1. Sibling insertion: a new nav link is inserted BEFORE the flagged one. */
export const siblingInsert: Transform = (root) => {
  const next = clone(root);
  const nav = find(next, (n) => n.attrs?.id === 'mainnav')!.node;
  nav.children!.splice(2, 0, {tag: 'a', attrs: {href: '/blog'}, text: 'Blog'});
  return next;
};

/** 2. Node move: the flagged "Click here" link moves from nav into footer. */
export const nodeMove: Transform = (root) => {
  const next = clone(root);
  const nav = find(next, (n) => n.attrs?.id === 'mainnav')!.node;
  const index = nav.children!.findIndex((c) => c.attrs?.['data-issue'] === 'link-non-descriptive');
  const [moved] = nav.children!.splice(index, 1);
  const footer = find(next, (n) => n.tag === 'footer')!.node;
  footer.children!.push(moved);
  return next;
};

/** 3. Text change: the flagged list item text is reworded. */
export const textChange: Transform = (root) => {
  const next = clone(root);
  const item = find(next, (n) => n.attrs?.['data-issue'] === 'list-structure')!.node;
  item.text = 'Alpha quarterly report (renamed)';
  return next;
};

/** 4. Duplicate components: an EXACT twin of an existing card is inserted. */
export const duplicateComponent: Transform = (root) => {
  const next = clone(root);
  const cards = find(next, (n) => n.attrs?.class === 'cards')!.node;
  const pro = cards.children!.find((c) => c.children?.some((h) => h.text === 'Plan Pro'))!;
  // Identical twin (same heading, same price, same classes) inserted right
  // after the original: no intrinsic signal can tell them apart.
  cards.children!.splice(2, 0, clone(pro));
  return next;
};

/** 5. Node deletion: the flagged button is removed entirely. */
export const nodeDelete: Transform = (root) => {
  const next = clone(root);
  const main = find(next, (n) => n.attrs?.id === 'content')!.node;
  const index = main.children!.findIndex(
    (c) => c.attrs?.['data-issue'] === 'focus-order',
  );
  main.children!.splice(index, 1);
  return next;
};

/** 6. Cross-iframe: the flagged button inside the embedded frame moves. */
export const crossIframeMove: Transform = (root) => {
  const next = clone(root);
  const owner = find(next, (n) => n.tag === 'iframe')!.node;
  const framed = clone(owner.frame!.root);
  const section = find(framed, (n) => n.attrs?.['aria-label'] === 'Cookie preferences')!.node;
  const btnIndex = section.children!.findIndex((c) => c.tag === 'button');
  const [button] = section.children!.splice(btnIndex, 1);
  section.children!.unshift(button);
  owner.frame = {...owner.frame!, root: framed};
  return next;
};

export const SCENARIOS: Array<{id: string; label: string; transform: Transform}> = [
  {id: 'sibling-insert', label: '兄弟插入', transform: siblingInsert},
  {id: 'node-move', label: '节点移动', transform: nodeMove},
  {id: 'text-change', label: '文本变化', transform: textChange},
  {id: 'duplicate', label: '重复组件', transform: duplicateComponent},
  {id: 'delete', label: '节点删除', transform: nodeDelete},
  {id: 'cross-iframe', label: '跨 iframe 移动', transform: crossIframeMove},
];

/**
 * Mount an html-rooted RawNode tree into an EXISTING document: distribute
 * <head>/<body> children into the document's real head/body so that
 * doc.documentElement (the scanner's root) is the populated one. A plain
 * appendChild(document.createElement('html')) would render nothing to the
 * scanner because the document already owns an (empty) <html>.
 */
export function mountDocument(doc: Document, tree: RawNode): void {
  doc.head?.replaceChildren();
  doc.body?.replaceChildren();
  for (const child of tree.children ?? []) {
    if (child.tag === 'head' && doc.head) {
      for (const grand of child.children ?? []) doc.head.appendChild(renderToDom(grand, doc));
      if (child.text) doc.head.appendChild(doc.createTextNode(child.text));
    } else if (child.tag === 'body' && doc.body) {
      for (const attr of Object.entries(child.attrs ?? {})) doc.body.setAttribute(attr[0], attr[1]);
      if (child.text) doc.body.appendChild(doc.createTextNode(child.text));
      // renderToDom also schedules nested-frame content mounting.
      for (const grand of child.children ?? []) doc.body.appendChild(renderToDom(grand, doc));
    } else {
      doc.body?.appendChild(renderToDom(child, doc));
    }
  }
}

/** Render a RawNode tree (regular element root) into a real DOM element. */
export function renderToDom(node: RawNode, doc: Document): Element {
  const element = doc.createElement(node.tag);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (key === 'srcdoc') continue; // preview iframe content comes from `frame`
    element.setAttribute(key, value);
  }
  if (node.text) element.appendChild(doc.createTextNode(node.text));
  for (const child of node.children ?? []) element.appendChild(renderToDom(child, doc));
  if (node.frame && (node.tag === 'iframe' || node.tag === 'frame')) {
    const frameElement = element as HTMLIFrameElement;
    // Defer until the owner element is attached (contentDocument exists).
    const mount = (win: Window | null) => {
      try {
        const frameDoc = frameElement.contentDocument;
        if (!frameDoc) return;
        if (node.frame!.root.tag === 'html') mountDocument(frameDoc, node.frame!.root);
        else frameDoc.replaceChildren(renderToDom(node.frame!.root, frameDoc));
      } catch {
        /* sandboxed in preview; ignore */
      }
      void win;
    };
    const win = element.ownerDocument.defaultView;
    const raf = win?.requestAnimationFrame
      ? (cb: FrameRequestCallback) => win!.requestAnimationFrame(cb)
      : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number;
    raf(() => raf(() => mount(win)));
  }
  return element;
}
