/**
 * Resource caps for document parsing.
 *
 * Uploads are size-limited (20 MiB), but a small archive can still expand into a
 * huge document or a spreadsheet with millions of rows. Parsed output therefore
 * has to be bounded before it reaches the model context or the API response.
 */
export const DOCUMENT_LIMITS = {
  /** Longest extracted text kept for a Word/text document. */
  maxTextChars: 200_000,
  /** Paragraphs kept for a Word/text document. */
  maxParagraphs: 2_000,
  /** Sheets kept for a workbook. */
  maxSheets: 50,
  /** Rows read from one sheet (the row count is still reported in full). */
  maxRowsPerSheet: 20_000,
  /** Preview rows returned per sheet. */
  maxPreviewRows: 10,
} as const;

export function truncateText(text: string, limit = DOCUMENT_LIMITS.maxTextChars): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}
…（内容过长，已截断）`, truncated: true };
}
