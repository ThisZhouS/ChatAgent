/**
 * Continuous authorization refresh (Gate 7A.2) — the server half.
 *
 * The on-device host holds grants in memory and asks this endpoint whether they
 * are still valid. What matters here:
 *  - the answer is per-member: another member's approval id answers `unknown`,
 *    which never leaks whether the id exists;
 *  - a kind this service keeps no ledger for is *not* answered at all, and the
 *    response says so, so the host stops asking instead of treating "no ledger"
 *    as "revoked";
 *  - nothing from the approval payload is echoed back.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, devHeaders } from './test-helpers';

let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

function approvalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    organizationId: 'org_local',
    requesterId: 'u_alice',
    action: { tool: 'send_message', target: 'self', chatType: 'direct', kind: 'message', text: '机密内容' },
    digest: 'a'.repeat(64),
    status: 'approved',
    createdAt: '2026-09-16T00:00:00.000Z',
    decidedAt: '2026-09-16T00:01:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function bootWithApprovals(records: Record<string, unknown>[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatagent-authz-'));
  await writeFile(join(dataDir, 'approvals.json'), JSON.stringify(records), 'utf8');
  const test = await createTestApp({ dataDir });
  active.push(test.app);
  return test;
}

describe('continuous authorization verification', () => {
  it('refuses anonymous callers in production mode', async () => {
    const test = await createTestApp({ auth: { mode: 'production' } });
    active.push(test.app);
    const denied = await test.app.inject({
      method: 'POST',
      url: '/api/agent-authorizations/verify',
      payload: { grants: [{ id: 'approval-1', kind: 'approval' }] },
    });
    expect(denied.statusCode).toBe(401);
  });

  it('answers active / revoked / expired / unknown and skips kinds it does not keep', async () => {
    const { app } = await bootWithApprovals([
      approvalRecord(),
      approvalRecord({ id: 'approval-pending', status: 'pending', decidedAt: undefined }),
      approvalRecord({ id: 'approval-expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    const answer = await app.inject({
      method: 'POST',
      url: '/api/agent-authorizations/verify',
      headers: devHeaders('u_alice'),
      payload: {
        deviceId: 'desktop-1',
        grants: [
          { id: 'approval-1', kind: 'approval' },
          { id: 'approval-pending', kind: 'approval' },
          { id: 'approval-expired', kind: 'approval' },
          { id: 'approval-missing', kind: 'approval' },
          // A kind this service has no ledger for: not answered, and reported as
          // unsupported instead of being called revoked.
          { id: 'delegation-1', kind: 'delegation' },
        ],
      },
    });
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as {
      supportedKinds: string[];
      results: { id: string; kind: string; status: string; expiresAt?: string }[];
    };
    expect(body.supportedKinds).toEqual(['approval']);
    expect(body.results.map((item) => [item.id, item.status])).toEqual([
      ['approval-1', 'active'],
      ['approval-pending', 'revoked'],
      ['approval-expired', 'expired'],
      ['approval-missing', 'unknown'],
    ]);
    expect(body.results.every((item) => item.kind === 'approval')).toBe(true);
    // The payload never travels back to the device on this path.
    expect(JSON.stringify(body)).not.toContain('机密内容');
  });

  it('does not confirm another member\'s approval', async () => {
    const { app } = await bootWithApprovals([approvalRecord()]);
    const answer = await app.inject({
      method: 'POST',
      url: '/api/agent-authorizations/verify',
      headers: devHeaders('u_bob'),
      payload: { grants: [{ id: 'approval-1', kind: 'approval' }] },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      supportedKinds: ['approval'],
      results: [{ id: 'approval-1', kind: 'approval', status: 'unknown' }],
    });
  });

  it('rejects a malformed or oversized question instead of guessing', async () => {
    const { app } = await bootWithApprovals([]);
    const notAList = await app.inject({
      method: 'POST',
      url: '/api/agent-authorizations/verify',
      headers: devHeaders('u_alice'),
      payload: { grants: 'all of them' },
    });
    expect(notAList.statusCode).toBe(400);
    const badKind = await app.inject({
      method: 'POST',
      url: '/api/agent-authorizations/verify',
      headers: devHeaders('u_alice'),
      payload: { grants: [{ id: 'x', kind: 'terminal' }] },
    });
    expect(badKind.statusCode).toBe(400);
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/agent-authorizations/verify',
      headers: devHeaders('u_alice'),
      payload: { grants: Array.from({ length: 201 }, (_, index) => ({ id: `a-${index}`, kind: 'approval' })) },
    });
    expect(tooMany.statusCode).toBe(400);
  });
});
