import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, type TestMemberSeed } from './test-helpers';

let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

const MEMBERS: TestMemberSeed[] = [
  { id: 'u_alice', displayName: 'Alice', token: 'alice-token' },
  { id: 'u_bob', displayName: 'Bob', token: 'bob-token' },
];

async function boot(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const test = await createTestApp({ members: MEMBERS, ...overrides });
  active.push(test.app);
  return test;
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? String(raw[0]) : String(raw ?? '');
  return value.split(';')[0] ?? '';
}

describe('session cookie is read-only', () => {
  it('rejects state-changing requests authenticated only by cookie', async () => {
    const { app } = await boot();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'alice-token' },
    });
    const cookie = cookieOf(login);
    expect(cookie.startsWith('chatagent_session=')).toBe(true);

    // Reading with the cookie (needed by EventSource) works.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);

    // Writing with only the cookie is refused: no bearer token, no CSRF surface.
    const write = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    expect(write.statusCode).toBe(401);

    const bearer = login.json().token as string;
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('security headers', () => {
  it('sets hardening headers on every response', async () => {
    const { app } = await boot();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });
});

describe('rate limiting', () => {
  it('throttles repeated failed logins', async () => {
    const { app } = await boot();

    let throttled = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { memberId: 'u_alice', token: 'wrong-token' },
      });
      if (response.statusCode === 429) throttled += 1;
    }

    expect(throttled).toBeGreaterThan(0);
  });

  it('keeps the correct credentials path open before the limit is hit', async () => {
    const { app } = await boot();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_bob', token: 'bob-token' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('uploads', () => {
  it('rejects unsupported file types and accepts documents', async () => {
    const { app } = await boot();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'alice-token' },
    });
    const auth = { authorization: `Bearer ${login.json().token}` };

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...auth, 'content-type': multipart('evil.exe').contentType },
      payload: multipart('evil.exe').payload,
    });
    expect(rejected.statusCode).toBe(415);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...auth, 'content-type': multipart('notes.txt').contentType },
      payload: multipart('notes.txt').payload,
    });
    expect(accepted.statusCode).toBe(200);
  });
});

describe('audit trail', () => {
  it('records login outcomes without secrets', async () => {
    const { app, dataDir } = await boot();

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'super-secret-token' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'alice-token' },
    });

    // The audit log is appended asynchronously; give the queue a tick.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');

    expect(raw).toContain('"action":"auth.login"');
    expect(raw).toContain('"outcome":"failed"');
    expect(raw).toContain('"outcome":"ok"');
    expect(raw).not.toContain('alice-token');
    expect(raw).not.toContain('super-secret-token');
  });
});

describe('session revocation', () => {
  it('revokes every session of the caller', async () => {
    const { app } = await boot();
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'alice-token' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'alice-token' },
    });
    const tokenA = first.json().token as string;
    const tokenB = second.json().token as string;

    const revoke = await app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revoked).toBeGreaterThanOrEqual(1);

    for (const token of [tokenA, tokenB]) {
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      // Development mode falls back to the owner principal for unknown tokens,
      // so assert the identity is no longer the session member.
      expect(me.json().id).not.toBe('u_alice');
    }
  });
});

function multipart(filename: string): { payload: string; contentType: string } {
  const boundary = '----chatagentsecurityboundary';
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    'payload',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}
