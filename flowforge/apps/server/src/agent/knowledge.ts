/**
 * The agent's knowledge base: documents split into passages, searched with BM25.
 * Works offline, needs no embeddings API, and handles any script (Hindi, Tamil, Arabic...).
 */

export interface Passage {
  documentId: string;
  title: string;
  text: string;
}

export interface SearchHit extends Passage {
  score: number;
}

const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can do does for from have how i in is it me my of on or our ' +
    'please tell that the their there this to us was we what when where which who why will with ' +
    'you your hai ka ki ke ko se me mein kya aap hum ' +
    'की का के को से में है हैं और क्या आप हम यह वह'
  ).split(' '),
);

/** Letters with their combining marks (Devanagari vowel signs are marks) and digits. */
export const tokenize = (text: string): string[] =>
  (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  ).filter((t) => !STOP_WORDS.has(t));

/** Split a document into passages of about `size` characters, on paragraph and sentence breaks. */
export function splitDocument(
  documentId: string,
  title: string,
  content: string,
  size = 700,
): Passage[] {
  const pieces: string[] = [];
  for (const paragraph of content.split(/\n\s*\n/)) {
    const text = paragraph.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length <= size) {
      pieces.push(text);
      continue;
    }
    // Long paragraph: break at sentence ends (also । for Hindi).
    let current = '';
    for (const sentence of text.split(/(?<=[.!?।])\s+/)) {
      if (current && current.length + sentence.length + 1 > size) {
        pieces.push(current);
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence;
      while (current.length > size * 1.5) {
        pieces.push(current.slice(0, size));
        current = current.slice(size);
      }
    }
    if (current) pieces.push(current);
  }
  // Merge small neighbours so short FAQ lines keep their context.
  const passages: Passage[] = [];
  let buffer = '';
  for (const piece of pieces) {
    if (buffer && buffer.length + piece.length + 1 > size) {
      passages.push({ documentId, title, text: buffer });
      buffer = '';
    }
    buffer = buffer ? `${buffer}\n${piece}` : piece;
  }
  if (buffer) passages.push({ documentId, title, text: buffer });
  return passages;
}

export class KnowledgeIndex {
  private readonly docs: Array<{ passage: Passage; terms: Map<string, number>; length: number }>;
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(passages: Passage[]) {
    this.docs = passages.map((passage) => {
      const tokens = tokenize(`${passage.title} ${passage.text}`);
      const terms = new Map<string, number>();
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of terms.keys())
        this.documentFrequency.set(t, (this.documentFrequency.get(t) ?? 0) + 1);
      return { passage, terms, length: tokens.length };
    });
    this.averageLength = this.docs.reduce((sum, d) => sum + d.length, 0) / (this.docs.length || 1);
  }

  get size() {
    return this.docs.length;
  }

  search(query: string, limit = 3): SearchHit[] {
    const k1 = 1.2;
    const b = 0.75;
    const n = this.docs.length;
    const terms = [...new Set(tokenize(query))];
    const hits: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        // Plain term, or a prefix match for inflections ("appointments" → "appointment").
        let tf = doc.terms.get(term) ?? 0;
        let df = this.documentFrequency.get(term) ?? 0;
        if (!tf && term.length >= 5) {
          for (const [t, count] of doc.terms) {
            if (t.length >= 4 && (t.startsWith(term.slice(0, -1)) || term.startsWith(t))) {
              tf += count * 0.7;
              df = Math.max(df, this.documentFrequency.get(t) ?? 0);
            }
          }
        }
        if (!tf) continue;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score +=
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.averageLength)));
      }
      if (score > 0) hits.push({ ...doc.passage, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
