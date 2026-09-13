import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createExcelBuffer, parseExcelBuffer } from './excel';
import { createWordBuffer, extractWordText } from './word';
import * as zlib from 'node:zlib';
import { detectDocumentKind, parseDocumentBuffer } from './document-service';
import { DOCUMENT_LIMITS } from './limits';
import { assertSafeArchive, DEFAULT_ZIP_LIMITS, DocumentLimitError } from './zip-guard';

describe('document service', () => {
  it('creates and parses a Word document', async () => {
    const buffer = await createWordBuffer({
      title: '测试文档',
      paragraphs: ['第一段', '第二段'],
    });
    const text = await extractWordText(buffer);
    expect(text).toContain('测试文档');
    expect(text).toContain('第一段');
  });

  it('creates and parses an Excel workbook', () => {
    const buffer = createExcelBuffer({
      fileName: 'test.xlsx',
      sheets: [
        {
          name: 'Sheet1',
          header: ['名称', '值'],
          rows: [
            ['状态', '完成'],
            ['数量', 3],
          ],
        },
      ],
    });
    const sheets = parseExcelBuffer(buffer);
    expect(sheets[0]?.name).toBe('Sheet1');
    expect(sheets[0]?.rows).toBe(3);
  });

  it('detects document kinds from file names', () => {
    expect(detectDocumentKind('a.docx')).toBe('word');
    expect(detectDocumentKind('a.xlsx')).toBe('excel');
    expect(detectDocumentKind('a.csv')).toBe('csv');
    expect(detectDocumentKind('a.pdf')).toBe('unknown');
  });
});

describe('parsed output is bounded', () => {
  it('truncates an oversized text document instead of returning everything', async () => {
    const huge = 'x'.repeat(DOCUMENT_LIMITS.maxTextChars + 5_000);
    const summary = await parseDocumentBuffer(Buffer.from(huge, 'utf8'), 'huge.txt');
    expect(summary.textPreview.length).toBeLessThanOrEqual(4_000);
    expect(summary.paragraphs?.length ?? 0).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxParagraphs);
  });

  it('caps workbook sheets while still reporting the real row count', () => {
    const workbook = XLSX.utils.book_new();
    const rows: unknown[][] = [['名称', '值']];
    for (let index = 0; index < DOCUMENT_LIMITS.maxRowsPerSheet + 50; index += 1) {
      rows.push([`row-${index}`, index]);
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Data');
    for (let index = 0; index < DOCUMENT_LIMITS.maxSheets + 5; index += 1) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['a'], [1]]), `S${index}`);
    }
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const sheets = parseExcelBuffer(buffer);
    expect(sheets.length).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxSheets);
    const data = sheets.find((sheet) => sheet.name === 'Data');
    expect(data?.rows).toBe(DOCUMENT_LIMITS.maxRowsPerSheet + 50 + 1);
    expect(data?.preview.length).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxPreviewRows);
  });
});

describe('zip bomb guard', () => {
  /** Builds a minimal ZIP with one or more deflated entries. */
  function buildZip(name: string, payload: Buffer): Buffer {
    return buildZipEntries([{ name, payload }]);
  }

  function buildZipEntries(entries: Array<{ name: string; payload: Buffer }>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const deflated = zlib.deflateRawSync(entry.payload);
      const nameBuffer = Buffer.from(entry.name, 'utf8');
      const crc = crc32(entry.payload);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(deflated.length, 18);
      local.writeUInt32LE(entry.payload.length, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      const localPart = Buffer.concat([local, nameBuffer, deflated]);
      locals.push(localPart);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(deflated.length, 20);
      central.writeUInt32LE(entry.payload.length, 24);
      central.writeUInt16LE(nameBuffer.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(Buffer.concat([central, nameBuffer]));
      offset += localPart.length;
    }
    const localPart = Buffer.concat(locals);
    const centralPart = Buffer.concat(centrals);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
  }

  let table: number[] | undefined;
  function crc32(buffer: Buffer): number {
    if (!table) {
      table = [];
      for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  it('rejects an archive whose entry expands beyond the limit', () => {
    // 8 MiB of zeros deflates to a few kilobytes: a classic bomb shape.
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0);
    const archive = buildZip('bomb.txt', bomb);
    expect(archive.length).toBeLessThan(64 * 1024);
    expect(() => assertSafeArchive(archive, { ...DEFAULT_ZIP_LIMITS, maxEntryUncompressed: 1024 })).toThrow(
      DocumentLimitError,
    );
  });

  it('rejects an archive with an extreme compression ratio', () => {
    const archive = buildZip('ratio.txt', Buffer.alloc(4 * 1024 * 1024, 0));
    expect(() => assertSafeArchive(archive, { ...DEFAULT_ZIP_LIMITS, maxRatio: 5 })).toThrow(
      /compression ratio/,
    );
  });

  it('rejects an archive with too many entries and accepts a normal document', () => {
    const many = buildZipEntries([
      { name: 'a.txt', payload: Buffer.from('a') },
      { name: 'b.txt', payload: Buffer.from('b') },
    ]);
    expect(() => assertSafeArchive(many, { ...DEFAULT_ZIP_LIMITS, maxEntries: 1 })).toThrow(
      /entries/,
    );
    expect(() => assertSafeArchive(buildZip('ok.txt', Buffer.from('hello')))).not.toThrow();
  });

  it('passes non-zip buffers through', () => {
    expect(() => assertSafeArchive(Buffer.from('plain text, not an archive'))).not.toThrow();
  });

  it('refuses to parse a bomb through the document service', async () => {
    const archive = buildZip('word/document.xml', Buffer.alloc(70 * 1024 * 1024, 0));
    await expect(parseDocumentBuffer(archive, 'bomb.docx')).rejects.toThrow(DocumentLimitError);
  });
});

describe('zip guard does not trust the central directory', () => {
  function buildLyingZip(payload: Buffer, method = 8): Buffer {
    // A real 8 MiB payload, but the central directory claims 1 KiB. A
    // header-only guard accepts this; a measuring guard must not.
    const deflated = zlib.deflateRawSync(payload);
    const name = Buffer.from('word/document.xml', 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // CRC is not verified by the guard
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localPart = Buffer.concat([local, name, deflated]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(1024, 24); // the lie: the real size is payload.length
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const centralPart = Buffer.concat([central, name]);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
  }

  it('rejects a bomb whose central directory understates the real size', () => {
    const archive = buildLyingZip(Buffer.alloc(8 * 1024 * 1024, 0));
    expect(archive.length).toBeLessThan(64 * 1024);
    expect(() => assertSafeArchive(archive)).toThrow(DocumentLimitError);
    expect(() => assertSafeArchive(archive)).toThrow(/compression ratio|expands/);
  });

  it('still accepts an honest document', async () => {
    const honest = await createWordBuffer({ title: '正常', paragraphs: ['内容'] });
    expect(() => assertSafeArchive(honest)).not.toThrow();
  });

  it('rejects an entry with an unsupported compression method', () => {
    const archive = buildLyingZip(Buffer.from('tiny'), 12);
    expect(() => assertSafeArchive(archive)).toThrow(/unsupported compression method/);
  });
});
