/**
 * Zip-level guard for Office documents.
 *
 * A 20 MiB upload cap does not bound what an archive expands to: a few hundred
 * kilobytes of deflate data can inflate into gigabytes and take the process down
 * before any parser-level limit applies. The central directory is therefore
 * inspected *before* the buffer is handed to a Word/Excel parser.
 */

import { inflateRawSync } from 'node:zlib';

export interface ZipGuardLimits {
  /** Maximum number of entries in the archive. */
  maxEntries: number;
  /** Maximum total uncompressed size of all entries (bytes). */
  maxTotalUncompressed: number;
  /** Maximum uncompressed size of a single entry (bytes). */
  maxEntryUncompressed: number;
  /** Maximum compression ratio (uncompressed / compressed) per entry. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipGuardLimits = {
  maxEntries: 2_000,
  maxTotalUncompressed: 200 * 1024 * 1024,
  maxEntryUncompressed: 64 * 1024 * 1024,
  maxRatio: 200,
};

export class DocumentLimitError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'DocumentLimitError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

interface ZipEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header, used to find the real payload. */
  localHeaderOffset: number;
}

const ZIP64_SENTINEL = 0xffffffff;

/** Reads the central directory; returns undefined when the buffer is not a zip. */
function readCentralDirectory(buffer: Buffer, limits: ZipGuardLimits): ZipEntry[] | undefined {
  if (buffer.length < EOCD_MIN_SIZE) return undefined;
  if (buffer.readUInt32LE(0) !== 0x04034b50) return undefined; // local file header

  const searchStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  let eocd = -1;
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return undefined;

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset >= buffer.length) {
    throw new DocumentLimitError('archive directory is out of bounds', 'zip_directory');
  }
  // 0xffff means "the real count lives in the ZIP64 record": do not reject on a
  // sentinel, the entry loop below is bounded by the buffer anyway.
  if (entryCount !== 0xffff && entryCount > limits.maxEntries) {
    throw new DocumentLimitError(
      `archive contains ${entryCount} entries (limit ${limits.maxEntries})`,
      'zip_entry_count',
    );
  }
  if (entryCount === 0xffff) {
    // Walk the directory until the signature stops matching, bounded by the buffer.
    const limit = Math.min(limits.maxEntries, 65_535);
    let scanned = 0;
    let probe = directoryOffset;
    while (scanned < limit && probe + 46 <= buffer.length && buffer.readUInt32LE(probe) === CENTRAL_SIGNATURE) {
      scanned += 1;
      const nameLength = buffer.readUInt16LE(probe + 28);
      const extraLength = buffer.readUInt16LE(probe + 30);
      const commentLength = buffer.readUInt16LE(probe + 32);
      probe += 46 + nameLength + extraLength + commentLength;
    }
    if (scanned >= limits.maxEntries) {
      throw new DocumentLimitError(
        `archive contains at least ${limits.maxEntries} entries (limit ${limits.maxEntries})`,
        'zip_entry_count',
      );
    }
    return readEntries(buffer, directoryOffset, scanned);
  }

  return readEntries(buffer, directoryOffset, entryCount);
}

/** Reads `count` central-directory records starting at `directoryOffset`. */
function readEntries(buffer: Buffer, directoryOffset: number, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length) {
      throw new DocumentLimitError('archive directory is truncated', 'zip_directory');
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new DocumentLimitError('archive directory is malformed', 'zip_directory');
    }
    entries.push({
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localHeaderOffset: buffer.readUInt32LE(cursor + 42),
    });
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Measures what an entry really expands to. The central directory is attacker
 * controlled, so its declared sizes are only used as a hint: the payload is
 * inflated with a hard output ceiling and the real byte count is what counts.
 */
function measureEntry(
  buffer: Buffer,
  entry: ZipEntry,
  limits: ZipGuardLimits,
): { uncompressed: number; compressed: number } {
  const local = entry.localHeaderOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new DocumentLimitError('archive entry header is out of bounds', 'zip_directory');
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  if (dataStart > buffer.length) {
    throw new DocumentLimitError('archive entry header is out of bounds', 'zip_directory');
  }
  const available = buffer.length - dataStart;

  if (entry.method === 0) {
    // Stored: the payload cannot exceed the file itself, so the upload cap
    // already bounds it.
    const size = Math.min(entry.compressedSize, available);
    if (size > limits.maxEntryUncompressed) {
      throw new DocumentLimitError(
        `archive entry expands to ${size} bytes (limit ${limits.maxEntryUncompressed})`,
        'zip_entry_size',
      );
    }
    return { uncompressed: size, compressed: size };
  }
  if (entry.method !== 8) {
    throw new DocumentLimitError(
      `archive entry uses unsupported compression method ${entry.method}`,
      'zip_entry_method',
    );
  }

  try {
    // `info: true` returns the inflated buffer plus the engine, whose
    // bytesWritten is the number of *input* bytes really consumed. The typings
    // do not model that overload, hence the cast.
    const options = {
      // One byte over the limit is enough to detect a violation without holding
      // an unbounded buffer.
      maxOutputLength: limits.maxEntryUncompressed + 1,
      info: true,
    } as unknown as Parameters<typeof inflateRawSync>[1];
    const result = inflateRawSync(buffer.subarray(dataStart), options) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const uncompressed = result.buffer.length;
    const compressed = result.engine.bytesWritten > 0 ? result.engine.bytesWritten : 1;
    if (uncompressed > limits.maxEntryUncompressed) {
      throw new DocumentLimitError(
        `archive entry expands to ${uncompressed} bytes (limit ${limits.maxEntryUncompressed})`,
        'zip_entry_size',
      );
    }
    return { uncompressed, compressed };
  } catch (error) {
    if (error instanceof DocumentLimitError) throw error;
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DocumentLimitError(
        `archive entry expands beyond ${limits.maxEntryUncompressed} bytes`,
        'zip_entry_size',
      );
    }
    throw new DocumentLimitError('archive entry could not be inflated', 'zip_entry_invalid');
  }
}

/**
 * Throws {@link DocumentLimitError} when the archive looks like a decompression
 * bomb. Non-zip buffers pass through untouched (the parsers handle them).
 *
 * Sizes are MEASURED by inflating each entry with a hard ceiling; the values in
 * the central directory are never trusted, because a lying directory is exactly
 * how a bomb slips past a header-only check.
 */
export function assertSafeArchive(
  buffer: Buffer,
  limits: ZipGuardLimits = DEFAULT_ZIP_LIMITS,
): void {
  const entries = readCentralDirectory(buffer, limits);
  if (!entries) return;

  let totalUncompressed = 0;
  for (const entry of entries) {
    const measured = measureEntry(buffer, entry, limits);
    if (measured.compressed > 0) {
      const ratio = measured.uncompressed / measured.compressed;
      if (ratio > limits.maxRatio) {
        throw new DocumentLimitError(
          `archive entry compression ratio ${Math.round(ratio)}:1 exceeds ${limits.maxRatio}:1`,
          'zip_ratio',
        );
      }
    }
    totalUncompressed += measured.uncompressed;
    if (totalUncompressed > limits.maxTotalUncompressed) {
      throw new DocumentLimitError(
        `archive expands to more than ${limits.maxTotalUncompressed} bytes`,
        'zip_total_size',
      );
    }
  }
}
