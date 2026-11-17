import { PDFParse } from "pdf-parse";

/**
 * Generic, bounded PDF text extraction (P2.6 — split out of the former
 * `invoice/PdfTextExtractor.ts`).
 *
 * The open tree keeps this mechanism because the agent attachment store
 * (and any generic consumer) uses it for PDF→text shaping. The invoice
 * issue-date heuristic (`extractInvoiceIssueDate`) and the invoice PDF
 * metadata extractor moved to the edition overlay with the allowance
 * module, which carries its own copy of the extraction mechanics.
 */

export const DEFAULT_PDF_TEXT_MAX_PAGES = 10;
export const DEFAULT_PDF_TEXT_MAX_CHARACTERS = 100_000;

export type PdfTextExtractionLimitReason =
  | "pdf-page-limit-exceeded"
  | "pdf-text-character-limit-exceeded";

export interface PdfTextExtractionOptions {
  maxPages?: number;
  maxCharacters?: number;
}

export class PdfTextExtractionLimitError extends Error {
  constructor(readonly reasonCode: PdfTextExtractionLimitReason) {
    super(reasonCode);
    this.name = "PdfTextExtractionLimitError";
  }
}

/**
 * Bounds application-controlled PDF work to a page prefix and refuses text
 * larger than the configured consumer budget. pdf-parse materializes the
 * selected pages' text before returning, so the character limit bounds what
 * this application consumes rather than arbitrary parser-internal allocation.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: PdfTextExtractionOptions = {},
): Promise<string> {
  const maxPages = positiveIntegerLimit(
    options.maxPages ?? DEFAULT_PDF_TEXT_MAX_PAGES,
    "maxPages",
  );
  const maxCharacters = positiveIntegerLimit(
    options.maxCharacters ?? DEFAULT_PDF_TEXT_MAX_CHARACTERS,
    "maxCharacters",
  );
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText({ first: maxPages });
    if (result.total > maxPages) {
      throw new PdfTextExtractionLimitError("pdf-page-limit-exceeded");
    }
    if (result.text.length > maxCharacters) {
      throw new PdfTextExtractionLimitError(
        "pdf-text-character-limit-exceeded",
      );
    }
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function positiveIntegerLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid-pdf-text-limit:${name}`);
  }
  return value;
}
