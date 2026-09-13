import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MemberView } from '@chatagent/contracts';
import { createTestApp, devHeaders, type TestMemberSeed } from './test-helpers';

let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

const MEMBERS: TestMemberSeed[] = [
  { id: 'u_alice', displayName: 'Alice', token: 'alice-token' },
];

async function boot(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const test = await createTestApp({ members: MEMBERS, ...overrides });
  active.push(test.app);
  return test;
}

describe('member administration', () => {
  it('rejects non-admin members', async () => {
    const { app } = await boot();

    const list = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: devHeaders('u_alice'),
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: devHeaders('u_alice'),
      payload: { id: 'u_mallory', displayName: 'Mallory' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('provisions a member and returns the token exactly once', async () => {
    const { app, dataDir } = await boot();

    // No dev header: the development caller is the configured org owner.
    const created = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: 'u_bob', displayName: 'Bob', roles: ['member'] },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { member: MemberView; token: string };
    expect(body.member.id).toBe('u_bob');
    expect(body.token).toHaveLength(64);

    // The list never exposes material.
    const list = (
      await app.inject({ method: 'GET', url: '/api/members' })
    ).json() as MemberView[];
    expect(list.map((member) => member.id)).toContain('u_bob');
    expect(JSON.stringify(list)).not.toContain(body.token);

    // The directory file stores only a hash.
    const raw = await readFile(join(dataDir, 'members.json'), 'utf8');
    expect(raw).not.toContain(body.token);
    expect(raw).toContain('tokenHash');

    // The issued token logs the member in.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_bob', token: body.token },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().member.displayName).toBe('Bob');
  });

  it('rotates a token and invalidates the previous one', async () => {
    const { app } = await boot();
    const created = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: 'u_carol', displayName: 'Carol' },
    });
    const first = created.json().token as string;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { memberId: 'u_carol', token: first },
        })
      ).statusCode,
    ).toBe(200);

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/members/u_carol/token',
    });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json().token as string;
    expect(second).not.toBe(first);

    const oldToken = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_carol', token: first },
    });
    expect(oldToken.statusCode).toBe(401);

    const newToken = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_carol', token: second },
    });
    expect(newToken.statusCode).toBe(200);
  });

  it('updates roles and keeps the organization boundary', async () => {
    const { app } = await boot();
    await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: 'u_dave', displayName: 'Dave' },
    });

    const promoted = await app.inject({
      method: 'PATCH',
      url: '/api/members/u_dave',
      payload: { roles: ['admin'], displayName: 'Dave (admin)' },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().roles).toEqual(['admin']);
    expect(promoted.json().displayName).toBe('Dave (admin)');

    const foreign = await app.inject({
      method: 'PATCH',
      url: '/api/members/u_eve',
      payload: { displayName: 'Eve' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('stops an admin from promoting to owner or taking over the owner', async () => {
    const { app } = await boot();

    // Owner creates an admin and a second admin account we can act as.
    const created = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: 'u_admin', displayName: 'Admin', roles: ['admin'] },
    });
    const adminToken = created.json().token as string;
    const adminAuth = { authorization: `Bearer ${adminToken}` };

    const promoteSelf = await app.inject({
      method: 'PATCH',
      url: '/api/members/u_admin',
      headers: adminAuth,
      payload: { roles: ['owner'] },
    });
    expect(promoteSelf.statusCode).toBe(403);

    const createOwner = await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: adminAuth,
      payload: { id: 'u_owner2', displayName: 'Owner 2', roles: ['owner'] },
    });
    expect(createOwner.statusCode).toBe(403);

    const rotateOwner = await app.inject({
      method: 'POST',
      url: '/api/members/dev-owner/token',
      headers: adminAuth,
    });
    expect(rotateOwner.statusCode).toBe(403);

    // An admin may still manage a plain member.
    const plain = await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: adminAuth,
      payload: { id: 'u_plain', displayName: 'Plain' },
    });
    expect(plain.statusCode).toBe(201);
  });

  it('shows the audit trail to admins only', async () => {
    const { app } = await boot();

    // Generate one denied action so the trail is non-empty.
    await app.inject({
      method: 'GET',
      url: '/api/tasks/does-not-exist',
      headers: devHeaders('u_alice'),
    });

    const asMember = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: devHeaders('u_alice'),
    });
    expect(asMember.statusCode).toBe(403);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const asOwner = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(asOwner.statusCode).toBe(200);
    const entries = asOwner.json() as Array<{ action?: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.action === 'access.not_found')).toBe(true);
    // No secret material is ever written to the trail.
    expect(JSON.stringify(entries)).not.toContain('alice-token');
  });

  it('rejects malformed member payloads', async () => {
    const { app } = await boot();
    const response = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: '', displayName: 'x', roles: ['superuser'] },
    });
    expect(response.statusCode).toBe(400);
  });
});
