// Serialize a live DOM subtree (including same-origin iframes) into the
// SnapshotInput wire shape. Nodes are identified by STABLE ATTRIBUTES, never
// by a child-index path; the serialized structure is only the raw material
// from which the server computes fingerprints.

import type {SNode, SFrame, SnapshotInput} from '../shared/types';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function serializeAttrs(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    // drop rendering-only / auto-generated noise that identity ignores too
    const name = attr.name.toLowerCase();
    if (name === 'style') continue;
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

function serializeNode(node: Node): SNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text ? {tag: '#text', text} : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  if (SKIP_TAGS.has(element.tagName)) return null;

  const children: SNode[] = [];
  for (const child of Array.from(element.childNodes)) {
    const serialized = serializeNode(child);
    if (serialized) children.push(serialized);
  }
  const out: SNode = {
    tag: element.tagName.toLowerCase(),
    attrs: serializeAttrs(element),
  };
  if (children.length) out.children = children;

  // recurse into same-origin iframes
  if (element.tagName === 'IFRAME') {
    try {
      const doc = (element as HTMLIFrameElement).contentDocument;
      if (doc && doc.body) {
        const frameId = `frame-${Math.abs(hashString(element.getAttribute('src') ?? '')).toString(36)}`;
        frames.push({id: frameId, src: (element as HTMLIFrameElement).src, title: element.getAttribute('title') ?? '', root: serializeNode(doc.body) ?? {tag: 'body'}});
        out.frame = frameId;
      }
    } catch {
      // cross-origin iframe: identity stays on the <iframe> element itself
    }
  }
  return out;
}

const frames: SFrame[] = [];

function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) { h = (h * 31 + value.charCodeAt(i)) | 0; }
  return h;
}

export function captureSnapshot(root: Element, url: string, capturedAt: string): SnapshotInput {
  frames.length = 0;
  const serialized = serializeNode(root) ?? {tag: 'div'};
  const input: SnapshotInput = {url, capturedAt, root: serialized};
  if (frames.length) input.frames = [...frames];
  return input;
}
