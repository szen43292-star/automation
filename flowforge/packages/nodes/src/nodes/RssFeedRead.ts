import {
  NodeApiError,
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem } from '../shared/helpers';
import { findAll, parseXml, type XmlElement } from '../shared/xml';

/** An element as JSON: text, its attributes, or its children (repeated names become arrays). */
function toValue(element: XmlElement): unknown {
  if (!element.children.length) {
    const text = element.text.trim();
    if (text || !Object.keys(element.attributes).length) return text;
    return { ...element.attributes };
  }
  const out: IDataObject = { ...element.attributes };
  for (const child of element.children) {
    const value = toValue(child) as IDataObject[keyof IDataObject];
    const existing = out[child.name];
    if (existing === undefined) out[child.name] = value;
    else if (Array.isArray(existing)) existing.push(value as never);
    else out[child.name] = [existing, value] as IDataObject[keyof IDataObject];
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === 'object') {
    const object = value as IDataObject;
    return text(object.href ?? object.name ?? object['#text']);
  }
  return undefined;
}

/** One feed entry (RSS <item> or Atom <entry>) with the usual fields filled in. */
export function feedItem(element: XmlElement): IDataObject {
  const raw = toValue(element) as IDataObject;
  const item: IDataObject = typeof raw === 'object' && raw ? { ...raw } : {};
  const links = element.children.filter((c) => c.name === 'link');
  const alternate =
    links.find((l) => !l.attributes.rel || l.attributes.rel === 'alternate') ?? links[0];
  if (alternate) item.link = alternate.attributes.href ?? alternate.text.trim();
  const content = text(item['content:encoded'] ?? item.content ?? item.description ?? item.summary);
  if (content) {
    item.content = content;
    item.contentSnippet = stripHtml(content);
  }
  const date = text(item.pubDate ?? item.published ?? item.updated ?? item['dc:date']);
  if (date) {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) item.isoDate = parsed.toISOString();
  }
  item.title = text(item.title) ?? '';
  const guid = text(item.guid ?? item.id);
  if (guid) item.guid = guid;
  const creator = text(item['dc:creator'] ?? item.author);
  if (creator) item.creator = creator;
  return item;
}

export function parseFeed(xml: string): IDataObject[] {
  const root = parseXml(xml);
  const items = findAll(root, 'item');
  return (items.length ? items : findAll(root, 'entry')).map(feedItem);
}

export const RssFeedRead: INodeType = {
  description: {
    name: 'flowforge.rssFeedRead',
    displayName: 'RSS Read',
    icon: 'rss',
    iconColor: '#f26522',
    group: ['data'],
    version: 1,
    description: 'Read the entries of an RSS or Atom feed, one item each',
    subtitle: '={{ $parameter.url }}',
    defaults: { name: 'RSS Read' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['rss', 'atom', 'feed', 'news', 'xml', 'podcast'],
    properties: [
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://example.com/feed.xml',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Max Items',
            name: 'maxItems',
            type: 'number',
            default: 0,
            description: 'Return at most this many entries (0 = all)',
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const url = String(this.getNodeParameter('url', i) ?? '').trim();
        if (!/^https?:\/\//i.test(url))
          throw new NodeOperationError(this.getNode(), 'The URL must start with http(s)://', {
            itemIndex: i,
          });
        const { maxItems } = this.getNodeParameter<IDataObject>('options', i, {});
        const response = await this.helpers.httpRequest({
          url,
          method: 'GET',
          responseType: 'text',
          headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, */*' },
          timeout: 60_000,
        });
        if (response.statusCode >= 400)
          throw new NodeApiError(this.getNode(), undefined, {
            httpCode: response.statusCode,
            responseBody: String(response.body).slice(0, 500),
            itemIndex: i,
          });
        let entries = parseFeed(String(response.body ?? ''));
        if (!entries.length && !/<(rss|feed|rdf:RDF)\b/i.test(String(response.body)))
          throw new NodeOperationError(
            this.getNode(),
            'The URL did not return an RSS or Atom feed',
            {
              itemIndex: i,
            },
          );
        if (Number(maxItems) > 0) entries = entries.slice(0, Number(maxItems));
        for (const entry of entries) output.push({ json: entry, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          output.push(errorItem(this, error, i, items[i]));
          continue;
        }
        throw error;
      }
    }
    return [output];
  },
};
