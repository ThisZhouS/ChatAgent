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

export function parseExcelBuffer(buffer: Buffer): ParsedSheet[] {
  assertSafeArchive(buffer);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
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
