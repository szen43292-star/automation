/** A small, forgiving XML reader: enough for RSS and Atom feeds (no DTDs, no namespaces API). */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const TOKEN =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Parses a document into a tree; returns a synthetic root whose children are the top elements. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#root', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  for (const match of source.matchAll(TOKEN)) {
    const current = stack[stack.length - 1]!;
    const [, cdata, closing, opening, attrs, selfClosing, text] = match;
    if (cdata !== undefined) current.text += cdata;
    else if (text !== undefined) current.text += decodeEntities(text);
    else if (opening) {
      const element: XmlElement = { name: opening, attributes: {}, children: [], text: '' };
      for (const [, key, double, single, bare] of (attrs ?? '').matchAll(ATTRIBUTE)) {
        element.attributes[key!] = decodeEntities(double ?? single ?? bare ?? '');
      }
      current.children.push(element);
      if (!selfClosing) stack.push(element);
    } else if (closing) {
      // Close up to the matching element (tolerates unclosed tags in sloppy feeds).
      const index = stack.map((e) => e.name).lastIndexOf(closing);
      if (index > 0) stack.length = index;
    }
  }
  return root;
}

export function findAll(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlElement) => {
    for (const child of node.children) {
      if (child.name === name) found.push(child);
      else visit(child);
    }
  };
  visit(element);
  return found;
}
