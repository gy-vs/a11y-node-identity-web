// Capture a live DOM tree into the RawNode shape understood by the shared
// identity builder. Same-origin iframes are captured recursively; cross-origin
// frames are recorded as owner nodes without content (unresolvable by design).

import type {RawFrame, RawNode} from '../shared/types';

// Attributes retained on the snapshot (the server still recomputes every
// fingerprint from this set).
const CAPTURED_ATTRS = [
  'id',
  'name',
  'for',
  'class',
  'role',
  'href',
  'src',
  'type',
  'value',
  'placeholder',
  'title',
  'alt',
  'rel',
  'target',
  'hreflang',
  'disabled',
  'required',
  'checked',
  'data-testid',
  'data-test-id',
  'data-qa',
  'data-node-id',
  'data-issue',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-owns',
  'aria-controls',
  'aria-live',
  'aria-expanded',
  'aria-checked',
  'aria-selected',
  'aria-hidden',
  'aria-current',
  'aria-required',
] as const;

function captureAttrs(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of CAPTURED_ATTRS) {
    const value = element.getAttribute?.(name);
    if (value !== null) attrs[name] = value;
  }
  return attrs;
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** Own text only (direct text nodes), matching how fingerprints use text. */
function ownText(element: Element): string {
  let out = '';
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3 /* Node.TEXT_NODE */) out += child.textContent ?? '';
  }
  return out;
}

function captureFrame(doc: Document, name?: string): RawFrame {
  return {
    ...(name ? {name} : {}),
    root: captureNode(doc.documentElement, doc),
  };
}

export function captureNode(element: Element, ownerDoc: Document = document): RawNode {
  const tag = element.tagName.toLowerCase();
  const node: RawNode = {tag, attrs: captureAttrs(element)};
  const text = ownText(element).trim();
  if (text) node.text = text;

  const children: RawNode[] = [];
  for (const child of Array.from(element.children)) {
    if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
    children.push(captureNode(child, ownerDoc));
  }
  if (children.length) node.children = children;

  if (tag === 'iframe' || tag === 'frame') {
    const frameElement = element as HTMLFrameElement;
    try {
      const doc = frameElement.contentDocument;
      if (doc && doc.documentElement) {
        node.frame = captureFrame(doc, frameElement.contentWindow?.name || undefined);
      }
    } catch {
      // Cross-origin: content is inaccessible and intentionally omitted.
    }
  }
  return node;
}

export function captureDocument(doc: Document = document): RawNode {
  return captureNode(doc.documentElement, doc);
}

/** Convenience for the demo: capture a specific element subtree. */
export function captureElement(element: Element): RawNode {
  return captureNode(element, element.ownerDocument);
}
