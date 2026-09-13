import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import mammoth from 'mammoth';
import type { GenerateWordInput } from '@chatagent/contracts';
import { assertSafeArchive } from './zip-guard';

export async function extractWordText(buffer: Buffer): Promise<string> {
  assertSafeArchive(buffer);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function createWordBuffer(input: GenerateWordInput): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      text: input.title,
      heading: HeadingLevel.TITLE,
    }),
  ];

  for (const paragraph of input.paragraphs) {
    children.push(new Paragraph({ children: [new TextRun(paragraph)] }));
  }

  if (input.table) {
    const header = input.table.header;
    const rows = input.table.rows;
    const width = Math.max(...rows.map((row) => row.length), header.length);
    const tableRows: TableRow[] = [];

    tableRows.push(
      new TableRow({
        children: header.map((cell) => tableCell(cell, true)),
      }),
    );

    for (const row of rows) {
      const cells: TableCell[] = [];
      for (let i = 0; i < width; i += 1) {
        cells.push(tableCell(row[i] ?? ''));
      }
      tableRows.push(new TableRow({ children: cells }));
    }

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: tableRows,
      }),
    );
  }

  const document = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(document);
}

function tableCell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
  });
}
