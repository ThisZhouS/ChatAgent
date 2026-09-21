/**
 * File boundary: what a declared upload actually is.
 *
 * The extension allow-list alone is a naming convention, not a check - a caller can rename
 * anything to `.docx`. The parser then runs on bytes nobody verified, and the stored file is
 * served back later under a name that implies a format. This module compares the declared
 * extension with the file's own signature and refuses the mismatch.
 *
 * It is deliberately a pure function over the first bytes so it can be tested without a
 * server and reused by any entry point that accepts a file (.strict, fail closed: an unknown
 * extension is not "probably fine").
 */

/** How many bytes are needed for the longest signature we look at. */
export const SIGNATURE_BYTES = 16;

export type FileFamily = 'zip' | 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'ole' | 'text';

export interface SignatureVerdict {
  ok: boolean;
  family?: FileFamily;
  /** Machine-readable reason, e.g. `extension_content_mismatch`. */
  reason?: string;
}

/**
 * Which family each allowed extension belongs to. Office files are ZIP containers (OOXML) or
 * OLE compound documents (the legacy .doc/.xls), and the two are not interchangeable: a
 * renamed .xls is not a .docx.
 */
const EXTENSION_FAMILIES: Record<string, FileFamily> = {
  docx: 'zip',
  xlsx: 'zip',
  pptx: 'zip',
  zip: 'zip',
  doc: 'ole',
  xls: 'ole',
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  csv: 'text',
  txt: 'text',
  md: 'text',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** The family a byte prefix belongs to, or undefined when it is not a known binary format. */
export function detectFamily(bytes: Uint8Array): FileFamily | undefined {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  // An empty ZIP (only the end-of-central-directory record) is still a ZIP container.
  if (startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  // OLE compound document header (legacy .doc/.xls/.ppt).
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  return undefined;
}

/**
 * Text files have no signature, so the check is the negative one: the bytes must be valid
 * UTF-8 and must not contain NUL. A ".txt" full of binary is a renamed binary.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.some((byte) => byte === 0x00)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function extensionOf(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return undefined;
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Verifies that the bytes match what the extension claims. `allowedExtensions` is passed in so
 * the server keeps one list, and an extension outside it is refused here too rather than
 * silently accepted because some other layer allowed it.
 */
export function verifyFileSignature(
  fileName: string,
  bytes: Uint8Array,
  allowedExtensions: readonly string[],
): SignatureVerdict {
  const extension = extensionOf(fileName);
  if (!extension || !allowedExtensions.includes(extension)) {
    return { ok: false, reason: 'unsupported_extension' };
  }
  const expected = EXTENSION_FAMILIES[extension];
  if (!expected) return { ok: false, reason: 'unsupported_extension' };
  if (bytes.length === 0) return { ok: false, reason: 'empty_file' };

  const head = bytes.subarray(0, Math.min(SIGNATURE_BYTES, bytes.length));
  if (expected === 'text') {
    // Only the head is available here; the caller passes what it read. Binary content is
    // caught immediately because it either starts with a known signature or contains NUL.
    if (detectFamily(head)) {
      return { ok: false, family: detectFamily(head), reason: 'extension_content_mismatch' };
    }
    return looksLikeText(bytes) ? { ok: true, family: 'text' } : { ok: false, reason: 'not_text' };
  }

  const family = detectFamily(head);
  if (!family) return { ok: false, reason: 'unrecognised_signature' };
  if (family !== expected) {
    return { ok: false, family, reason: 'extension_content_mismatch' };
  }
  return { ok: true, family };
}
