import * as XLSX from 'xlsx';
import type { GenerateExcelInput } from '@chatagent/contracts';
import { DOCUMENT_LIMITS } from './limits';
import { assertSafeArchive } from './zip-guard';

export interface ParsedSheet {
  name: string;
  rows: number;
  columns: number;
  preview: Record<string, unknown>[];
}

export interface ParseExcelOptions {
  /**
   * Treat the buffer as delimited text (CSV) instead of a workbook archive.
   *
   * SheetJS sniffs a codepage for buffered text and does not pick UTF-8, so a
   * Chinese CSV read as a buffer comes back as mojibake. Delimited uploads are
   * decoded here first: UTF-8 (BOM tolerated), then GBK — what Chinese Windows
   * Excel writes by default.
   */
  delimited?: boolean;
}

/** Decodes a delimited text buffer: UTF-8 first, then a GBK fallback. */
export function decodeDelimitedText(buffer: Buffer): string {
  const hasBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = hasBom ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder('gbk').decode(body);
    } catch {
      return body.toString('utf8');
    }
  }
}

export function parseExcelBuffer(buffer: Buffer, options: ParseExcelOptions = {}): ParsedSheet[] {
  if (!options.delimited) assertSafeArchive(buffer);
  const workbook = options.delimited
    ? XLSX.read(decodeDelimitedText(buffer), { type: 'string', cellDates: false })
    : XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheets: ParsedSheet[] = [];

  for (const sheetName of workbook.SheetNames.slice(0, DOCUMENT_LIMITS.maxSheets)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      // A workbook can declare far more rows than it needs; the cap keeps the
      // parse bounded while the reported row count stays truthful.
      blankrows: false,
      range: undefined,
    });
    const allRows = rows.filter((row) => row.some((cell) => cell !== '' && cell != null));
    const dataRows = allRows.slice(0, DOCUMENT_LIMITS.maxRowsPerSheet);
    const columns = dataRows.reduce((max, row) => Math.max(max, row.length), 0);
    const [header = [], ...body] = dataRows;

    const preview = body.slice(0, DOCUMENT_LIMITS.maxPreviewRows).map((row) => {
      const record: Record<string, unknown> = {};
      header.forEach((key, index) => {
        const value = row[index];
        record[String(key || `col_${index + 1}`)] = value ?? '';
      });
      return record;
    });

    sheets.push({
      name: sheetName,
      // The full count is reported even when only a prefix was materialised.
      rows: allRows.length,
      columns,
      preview,
    });
  }

  return sheets;
}

export function createExcelBuffer(input: GenerateExcelInput): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const sheetInput of input.sheets) {
    const matrix: unknown[][] = [sheetInput.header, ...sheetInput.rows];
    const sheet = XLSX.utils.aoa_to_sheet(matrix);
    XLSX.utils.book_append_sheet(workbook, sheet, sheetInput.name.slice(0, 31) || 'Sheet1');
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
