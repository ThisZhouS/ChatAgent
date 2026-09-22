/**
 * Personal ids (question 8, answer B): a searchable, unique handle per member.
 *
 * The design note asked for four things and this file covers each of them, including the parts
 * that only matter when something goes wrong: the name rules (format and reserved words), the
 * uniqueness inside one organization, the rename cooldown, the retention window that keeps a
 * just-given-up name out of somebody else's hands, and the lazy assignment that gives members
 * created before handles existed a usable name instead of a migration step somebody could skip.
 *
 * Both windows are configuration, so the tests exercise the rules without waiting thirty days.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MemberView } from '@chatagent/contracts';
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
  // An id that cannot become a handle as-is: it starts with a digit and carries an invalid
  // character, so the derived name has to be repaired rather than copied.
  { id: '7carol!x', displayName: 'Carol', token: 'carol-token' },
];

async function boot(handles: { changeCooldownDays?: number; retentionDays?: number } = {}) {
  const test = await createTestApp({ members: MEMBERS, handles });
  active.push(test.app);
  return test;
}

async function login(app: FastifyInstance, memberId: string, token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { memberId, token },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().token as string;
}

function auth(token: string): Record<string, string> {
  return { authorization: 'Bearer ' + token };
}

async function me(app: FastifyInstance, token: string): Promise<MemberView> {
  const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as MemberView;
}

async function setHandle(app: FastifyInstance, token: string, handle: string) {
  return app.inject({
    method: 'PATCH',
    url: '/api/auth/handle',
    headers: auth(token),
    payload: { handle },
  });
}

async function directory(app: FastifyInstance, token: string): Promise<MemberView[]> {
  return (
    await app.inject({ method: 'GET', url: '/api/members', headers: auth(token) })
  ).json() as MemberView[];
}

function handlesOf(list: MemberView[]): string[] {
  return list.map((member) => member.handle ?? '').filter((handle) => handle !== '');
}

describe('personal handles', () => {
  it('gives every member a derived handle on the first read, including an id that is not usable as one', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');

    const profile = await me(app, alice);
    expect(profile.handle).toBe('u_alice');

    // The directory is what a colleague searches, so it has to be complete - the other members
    // never logged in and still have handles.
    const org = await directory(app, alice);
    const carol = org.find((member) => member.id === '7carol!x');
    expect(carol?.handle, 'a digit-leading id has to be repaired, not copied').toBeTruthy();
    expect(carol?.handle).toMatch(/^[a-z][a-z0-9._-]{2,23}$/);
    // Handles are unique inside the organization.
    expect(new Set(handlesOf(org)).size).toBe(handlesOf(org).length);

    // The assignment is idempotent: reading again does not rename anybody.
    const again = await directory(app, alice);
    expect(again.map((member) => member.handle).sort()).toEqual(
      org.map((member) => member.handle).sort(),
    );
  });

  it('lets a member set their own handle, and shows it to everybody in the organization', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    await me(app, alice);

    const updated = await setHandle(app, alice, 'Alice.Wang-1');
    expect(updated.statusCode, updated.body).toBe(200);
    // Normalised, never stored as typed: two spellings of one name must not both exist.
    expect((updated.json() as MemberView).handle).toBe('alice.wang-1');

    expect((await me(app, alice)).handle).toBe('alice.wang-1');
    const seenByBob = (await directory(app, bob)).find((member) => member.id === 'u_alice');
    expect(seenByBob?.handle).toBe('alice.wang-1');
  });

  it('refuses a malformed or reserved handle without touching the stored one', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    await me(app, alice);

    // Case is normalised rather than refused (see the test above), so the malformed set is
    // about shape: too short, illegal characters, a leading digit or dash, and too long.
    for (const handle of ['ab', 'has space', '1start', '-leading', 'a'.repeat(25)]) {
      const refused = await setHandle(app, alice, handle);
      expect(refused.statusCode, handle + ' -> ' + refused.body).toBe(400);
    }
    // Reserved words are refused rather than suffixed: "admin" must never resolve to a person.
    // ('ai' is on the reserved list too, but it is only two characters, so the length rule
    // already refuses it - the reserved list is the belt to that braces.)
    for (const reserved of ['admin', 'owner', 'system', 'everyone']) {
      const refused = await setHandle(app, alice, reserved);
      expect(refused.statusCode, reserved + ' -> ' + refused.body).toBe(400);
      expect(refused.json().detail, reserved + ' body=' + refused.body).toBe('handle_reserved');
    }
    expect((await me(app, alice)).handle, 'nothing was stored by the refused attempts').toBe(
      'u_alice',
    );
  });

  it('refuses a handle another member already holds, including in another spelling', async () => {
    // No cooldown here: the point of this case is uniqueness, so a rename must not be blocked by
    // the other rule (which has its own test).
    const { app } = await boot({ changeCooldownDays: 0 });
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    await me(app, bob);
    await setHandle(app, bob, 'bobby');

    const taken = await setHandle(app, alice, 'bobby');
    expect(taken.statusCode, taken.body).toBe(409);
    expect(taken.json().detail).toBe('handle_taken');

    expect((await setHandle(app, bob, 'bobby-2')).statusCode).toBe(200);
    const stillTaken = await setHandle(app, alice, 'Bobby-2');
    expect(stillTaken.statusCode, stillTaken.body).toBe(409);
    expect((await me(app, alice)).handle).toBe('u_alice');
  });

  it('enforces the rename cooldown, and allows the rename once the window has passed', async () => {
    const { app } = await boot({ changeCooldownDays: 30 });
    const alice = await login(app, 'u_alice', 'alice-token');
    await me(app, alice);

    expect((await setHandle(app, alice, 'alice-one')).statusCode).toBe(200);
    const tooSoon = await setHandle(app, alice, 'alice-two');
    expect(tooSoon.statusCode, tooSoon.body).toBe(429);
    expect(tooSoon.json().detail).toBe('handle_change_cooldown');
    // The refused rename did not change anything, and the name it wanted is still free.
    expect((await me(app, alice)).handle).toBe('alice-one');

    // A deployment that turns the cooldown off (0) allows it; the rule is configuration, not a
    // hard-coded constant, which is also what makes it testable.
    const open = await boot({ changeCooldownDays: 0 });
    const aliceOpen = await login(open.app, 'u_alice', 'alice-token');
    await me(open.app, aliceOpen);
    expect((await setHandle(open.app, aliceOpen, 'alice-one')).statusCode).toBe(200);
    expect((await setHandle(open.app, aliceOpen, 'alice-two')).statusCode).toBe(200);
    expect((await me(open.app, aliceOpen)).handle).toBe('alice-two');
  });

  it('keeps a given-up handle reserved for its previous owner during the retention window', async () => {
    const { app } = await boot({ changeCooldownDays: 0, retentionDays: 90 });
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    await me(app, alice);
    await setHandle(app, alice, 'alice-old');
    expect((await setHandle(app, alice, 'alice-new')).statusCode).toBe(200);

    // Somebody else cannot pick up the name people already associate with Alice...
    const stolen = await setHandle(app, bob, 'alice-old');
    expect(stolen.statusCode, stolen.body).toBe(409);
    expect(stolen.json().detail).toBe('handle_retired');
    // ...but Alice can take her own name back.
    expect((await setHandle(app, alice, 'alice-old')).statusCode).toBe(200);
    expect((await me(app, alice)).handle).toBe('alice-old');

    // With a zero-day retention the reservation is gone immediately, so the window is what
    // protects the name rather than a permanent block.
    const open = await boot({ changeCooldownDays: 0, retentionDays: 0 });
    const aliceOpen = await login(open.app, 'u_alice', 'alice-token');
    const bobOpen = await login(open.app, 'u_bob', 'bob-token');
    await me(open.app, aliceOpen);
    await setHandle(open.app, aliceOpen, 'alice-old');
    await setHandle(open.app, aliceOpen, 'alice-new');
    expect((await setHandle(open.app, bobOpen, 'alice-old')).statusCode).toBe(200);
  });
});
