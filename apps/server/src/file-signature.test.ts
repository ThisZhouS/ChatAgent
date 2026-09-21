/**
 * What a file actually is, versus what its name claims.
 *
 * The extension allow-list is a naming convention; these tests are about the bytes. A renamed
 * file must not reach the parser, and must not be stored under a name that implies a format it
 * does not have.
 */
import { describe, expect, it } from 'vitest';
import { detectFamily, extensionOf, looksLikeText, verifyFileSignature } from './file-signature';

const ALLOWED = ['docx', 'doc', 'xlsx', 'csv', 'txt', 'md', 'pdf', 'png', 'jpg', 'gif', 'webp', 'zip'];

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3', 'binary');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from('GIF89a...', 'binary');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const WAVE = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);

describe('file signatures', () => {
  it('accepts a file whose bytes match its extension', () => {
    expect(verifyFileSignature('report.docx', ZIP, ALLOWED).ok).toBe(true);
    expect(verifyFileSignature('legacy.doc', OLE, ALLOWED).ok).toBe(true);
    expect(verifyFileSignature('brief.pdf', PDF, ALLOWED).ok).toBe(true);
    expect(verifyFileSignature('photo.png', PNG, ALLOWED).ok).toBe(true);
    expect(verifyFileSignature('photo.jpg', JPEG, ALLOWED).ok).toBe(true);
    expect(verifyFileSignature('anim.gif', GIF, ALLOWED).ok).toBe(true);
    expect(verifyFileSignature('pic.webp', WEBP, ALLOWED).ok).toBe(true);
  });

  it('refuses a renamed file instead of trusting the name', () => {
    const renamed = verifyFileSignature('report.docx', PDF, ALLOWED);
    expect(renamed.ok).toBe(false);
    expect(renamed.reason).toBe('extension_content_mismatch');
    expect(renamed.family).toBe('pdf');

    // The OOXML containers are not interchangeable either: an .xls is OLE, not ZIP.
    expect(verifyFileSignature('book.xlsx', OLE, ALLOWED).reason).toBe('extension_content_mismatch');
    expect(verifyFileSignature('photo.png', ZIP, ALLOWED).reason).toBe('extension_content_mismatch');
  });

  it('refuses names outside the allow-list, unknown formats and empty files', () => {
    expect(verifyFileSignature('payload.exe', ZIP, ALLOWED).reason).toBe('unsupported_extension');
    expect(verifyFileSignature('noextension', ZIP, ALLOWED).reason).toBe('unsupported_extension');
    expect(verifyFileSignature('trailing.', ZIP, ALLOWED).reason).toBe('unsupported_extension');
    expect(verifyFileSignature('report.docx', Buffer.alloc(0), ALLOWED).reason).toBe('empty_file');
    // RIFF, but not a WEBP: an unknown container is not accepted as "close enough".
    expect(verifyFileSignature('sound.webp', WAVE, ALLOWED).reason).toBe('unrecognised_signature');
  });

  it('treats text as text: readable UTF-8 in, binary out', () => {
    expect(verifyFileSignature('notes.txt', Buffer.from('项目 预算\n差旅 12000\n', 'utf8'), ALLOWED).ok).toBe(
      true,
    );
    expect(verifyFileSignature('data.csv', Buffer.from('a,b\n1,2\n', 'utf8'), ALLOWED).ok).toBe(true);
    // The same bytes renamed to .csv are still a PNG.
    expect(verifyFileSignature('data.csv', PNG, ALLOWED).reason).toBe('extension_content_mismatch');
    // NUL bytes make it binary, whatever the name says.
    expect(verifyFileSignature('notes.txt', Buffer.from([0x41, 0x00, 0x42]), ALLOWED).reason).toBe(
      'not_text',
    );
    // Invalid UTF-8 is not text either.
    expect(verifyFileSignature('notes.md', Buffer.from([0xff, 0xfe, 0x41]), ALLOWED).reason).toBe(
      'not_text',
    );
  });

  it('exposes the small pieces the checks are built from', () => {
    expect(detectFamily(PDF)).toBe('pdf');
    expect(detectFamily(Buffer.from('hello', 'utf8'))).toBeUndefined();
    expect(looksLikeText(Buffer.from('hello', 'utf8'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x68, 0x00]))).toBe(false);
    expect(extensionOf('Report.DOCX')).toBe('docx');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('noextension')).toBeUndefined();
  });
});
