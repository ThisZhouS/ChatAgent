import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, ownerHeaders, poll } from './test-helpers';

/**
 * HTTP-level security coverage for the document upload route.
 *
 * The document package tests cover *parsing* a buffer; nothing covered the
 * route's own controls (who may upload, what may be uploaded, how often, and
 * what happens to an oversized upload or a decompression bomb). That route is
 * the only place a file enters the server, so the controls are asserted here.
 */
let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

const MEMBERS = [
  { id: 'u_alice', displayName: 'Alice', token: 'alice-token' },
  { id: 'u_bob', displayName: 'Bob', token: 'bob-token' },
];

async function boot(options: Parameters<typeof createTestApp>[0] = { members: MEMBERS }) {
  const test = await createTestApp(options);
  active.push(test.app);
  return test;
}

function multipart(
  fileName: string,
  content: Buffer,
  type = 'text/csv',
): { headers: Record<string, string>; body: Buffer } {
  const boundary = `----chatagenttest${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${type}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
  };
}

/** Minimal deflate bomb: a zip whose single entry inflates far past its size. */
function zipBomb(entryName = 'word/document.xml'): Buffer {
  const { deflateRawSync } = require('node:zlib') as typeof import('node:zlib');
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x41);
  const compressed = deflateRawSync(payload, { level: 9 });
  const name = Buffer.from(entryName, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localPart = Buffer.concat([local, name, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

describe('document upload route controls', () => {
  it('refuses an anonymous upload in production mode and stores nothing', async () => {
    const test = await boot({ auth: { mode: 'production' }, members: MEMBERS });

    const upload = multipart('budget.csv', Buffer.from('项目,预算\n差旅,12000\n', 'utf8'));
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: upload.headers,
      payload: upload.body,
    });

    expect(response.statusCode).toBe(401);
    // A refused parse must not leave a file behind for anyone to pick up.
    const login = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'alice-token' },
    });
    expect(login.statusCode).toBe(200);
    const files = await test.app.inject({
      method: 'GET',
      url: '/api/files',
      headers: { authorization: `Bearer ${login.json().token as string}` },
    });
    expect(files.statusCode).toBe(200);
    const listed = files.json() as { uploads: Array<{ name: string }> };
    expect(listed.uploads.some((item) => item.name === 'budget.csv')).toBe(false);
  });

  it('accepts a member upload and returns a bounded summary', async () => {
    const test = await boot();
    const upload = multipart('预算.csv', Buffer.from('项目,预算\n差旅,12000\n', 'utf8'));

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...upload.headers, authorization: 'Bearer alice-token' },
      payload: upload.body,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { file: { id: string }; summary: { kind: string; sheets?: unknown[] } };
    expect(body.summary.kind).toBe('csv');
    expect(body.summary.sheets).toHaveLength(1);
    expect(body.file.id).toBeTruthy();

    const files = await test.app.inject({
      method: 'GET',
      url: '/api/files',
      headers: { authorization: 'Bearer alice-token' },
    });
    expect(files.statusCode).toBe(200);
    const listed = files.json() as { uploads: Array<{ id: string }> };
    expect(listed.uploads.some((item) => item.id === body.file.id)).toBe(true);
  });

  it('rejects an unsupported file type and records the denial', async () => {
    const test = await boot();
    const upload = multipart('payload.exe', Buffer.from('MZ binary', 'utf8'), 'application/octet-stream');

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...upload.headers, authorization: 'Bearer alice-token' },
      payload: upload.body,
    });

    expect(response.statusCode).toBe(415);
    // Reading the audit trail needs the org admin (owner) principal, not the
    // uploader, so the denial entry is read as the owner.
    const rows = await poll(
      async () => {
        const audit = await test.app.inject({
          method: 'GET',
          url: '/api/audit?limit=50',
          headers: ownerHeaders(),
        });
        return audit.json() as Array<{ action: string; outcome: string; detail?: string }>;
      },
      (entries) => entries.some((row) => row.action === 'upload.rejected'),
    );
    const entry = rows.find((row) => row.action === 'upload.rejected');
    expect(entry?.outcome).toBe('denied');
    expect(entry?.detail).toBe('payload.exe');
  });

  it('refuses a decompression bomb before storing it', async () => {
    const test = await boot();
    const upload = multipart(
      'bomb.docx',
      zipBomb(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...upload.headers, authorization: 'Bearer alice-token' },
      payload: upload.body,
    });

    expect([400, 413]).toContain(response.statusCode);

    const files = await test.app.inject({
      method: 'GET',
      url: '/api/files',
      headers: { authorization: 'Bearer alice-token' },
    });
    const listed = files.json() as { uploads: Array<{ name: string }> };
    expect(listed.uploads.some((item) => item.name === 'bomb.docx')).toBe(false);
  });

  it('rejects an oversized upload instead of truncating it', async () => {
    const test = await boot();
    // The multipart limit is 20 MiB; a truncated stream must never be parsed.
    const upload = multipart('huge.csv', Buffer.alloc(21 * 1024 * 1024, 0x41), 'text/csv');

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...upload.headers, authorization: 'Bearer alice-token' },
      payload: upload.body,
    });

    expect(response.statusCode).toBe(413);
  }, 30_000);

  it('rate-limits uploads per member', async () => {
    const test = await boot();
    let limited = 0;
    // The upload bucket is 30 per minute; the 31st request must be refused.
    for (let index = 0; index < 31; index += 1) {
      const upload = multipart('tiny.csv', Buffer.from('a,b\n1,2\n', 'utf8'));
      const response = await test.app.inject({
        method: 'POST',
        url: '/api/documents/parse',
        headers: { ...upload.headers, authorization: 'Bearer alice-token' },
        payload: upload.body,
      });
      if (response.statusCode === 429) {
        limited = index + 1;
        expect(response.headers['retry-after']).toBeTruthy();
        break;
      }
      expect(response.statusCode).toBe(200);
    }
    expect(limited, 'the upload rate limit eventually refuses the caller').toBeGreaterThan(0);
  }, 30_000);
});
