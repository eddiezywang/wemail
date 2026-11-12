/**
 * Email chunking logic for the semantic index.
 *
 * Splits an email's body text into overlapping chunks suitable for
 * embedding and lexical indexing. Each chunk preserves context from
 * the surrounding text and carries a stable chunk_id derived from
 * the email id and chunk index.
 */

export interface ChunkInput {
  emailId: string;
  bodyText: string;
  subject?: string;
}

export interface Chunk {
  chunkId: string;
  emailId: string;
  /** The chunk text ready for embedding / lexical indexing. */
  text: string;
}

/** Target chunk size in characters. */
const CHUNK_SIZE = 800;

/** Overlap between consecutive chunks in characters. */
const CHUNK_OVERLAP = 200;

/** Minimum chunk size — shorter tails are folded into the previous chunk. */
const MIN_CHUNK_TAIL = 100;

/**
 * Split an email into chunks for indexing.
 *
 * Strategy:
 *  1. Prepend subject (if present) to give every chunk topic context.
 *  2. Split body text into character-based windows with overlap.
 *  3. Fold any trailing tail shorter than MIN_CHUNK_TAIL into the
 *     previous chunk so we don't produce degenerate single-sentence
 *     chunks.
 *  4. Assign stable chunk ids: `${emailId}::chunk-${i}`.
 */
export function chunkEmail(input: ChunkInput): Chunk[] {
  const { emailId, bodyText, subject } = input;

  const prefix = subject ? `Subject: ${subject}\n\n` : "";
  const fullText = prefix + (bodyText || "");

  if (!fullText.trim()) return [];

  // If the text fits in one chunk, return it whole.
  if (fullText.length <= CHUNK_SIZE) {
    return [{ chunkId: `${emailId}::chunk-0`, emailId, text: fullText }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  let idx = 0;

  while (start < fullText.length) {
    let end = Math.min(start + CHUNK_SIZE, fullText.length);
    const isLast = end >= fullText.length;

    // If this is the last chunk and it's too short, fold it into
    // the previous one.
    if (isLast && chunks.length > 0 && end - start < MIN_CHUNK_TAIL) {
      const prev = chunks[chunks.length - 1]!;
      prev.text = prev.text + fullText.slice(start);
      break;
    }

    chunks.push({
      chunkId: `${emailId}::chunk-${idx}`,
      emailId,
      text: fullText.slice(start, end),
    });

    start += CHUNK_SIZE - CHUNK_OVERLAP;
    idx++;
  }

  return chunks;
}

/**
 * Extract lexical terms from text for keyword-based fallback search.
 * Normalizes to lowercase, strips punctuation, deduplicates.
 */
export function extractLexicalTerms(text: string): string[] {
  const terms = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return [...new Set(terms)];
}
