import type { DocumentSummary } from '@chatagent/contracts';
import { parseExcelBuffer } from './excel';
import { DOCUMENT_LIMITS, truncateText } from './limits';
import { assertSafeArchive } from './zip-guard';
import { extractWordText } from './word';

export function detectDocumentKind(fileName: string): DocumentSummary['kind'] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.docx') || lower.endsWith('.doc')) return 'word';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'excel';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text';
  return 'unknown';
}

export async function parseDocumentBuffer(
  buffer: Buffer,
  fileName: string,
  fileId = fileName,
): Promise<DocumentSummary> {
  const kind = detectDocumentKind(fileName);

  // Office formats are zip archives: bound what they expand to before a parser
  // touches them (a 20 MiB upload can still be a decompression bomb).
  if (kind === 'word' || kind === 'excel') {
    assertSafeArchive(buffer);
  }

  if (kind === 'word') {
    const text = await extractWordText(buffer);
    return {
      fileId,
      fileName,
      kind,
      textPreview: text.slice(0, 4000),
      paragraphs: text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean),
    };
  }

  if (kind === 'excel' || kind === 'csv') {
    const sheets = parseExcelBuffer(buffer);
    const textPreview = sheets
      .map((sheet) => `[${sheet.name}] ${sheet.rows} rows x ${sheet.columns} columns`)
      .join('\n');
    return { fileId, fileName, kind, textPreview, sheets };
  }

  if (kind === 'text') {
    const text = buffer.toString('utf8');
    return {
      fileId,
      fileName,
      kind,
      textPreview: text.slice(0, 4000),
      paragraphs: text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean),
    };
  }

  return {
    fileId,
    fileName,
    kind,
    textPreview: `Unsupported file type: ${fileName}`,
  };
}
