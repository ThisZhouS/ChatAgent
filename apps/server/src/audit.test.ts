/**
 * The audit trail is the operator-facing record of refusals and side effects
 * (docs/acceptance-guide.md tells people to read `audit.jsonl` next to the data
 * directory), so its two "the line never landed" failure modes are tested
 * directly, not only through the HTTP suites.
 *
 * Found while chasing a flaky suite: a read that raced the first write threw
 * ENOENT. The test was fixed to poll, but the race has a product side too — the
 * writer cached "the directory exists" after its first attempt, so a first append
 * that lost the race left the whole process without an audit trail, silently.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from './audit';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-audit-'));
  dirs.push(dir);
  return dir;
}

function lines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('audit log durability', () => {
  it('writes the first record even when the data directory does not exist yet', async () => {
    const root = await tempRoot();
    // One level deeper than the temp root: the writer itself must create it.
    const filePath = join(root, 'data', 'audit.jsonl');
    const audit = new AuditLog(filePath);
    audit.record({ action: 'auth.login', outcome: 'ok', actorId: 'u_alice' });
    await audit.flush();

    const entries = lines(await readFile(filePath, 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'auth.login', outcome: 'ok', actorId: 'u_alice' });
    // The log writes the fields it knows and copies nothing else: an event object carrying
    // an extra property (a caller forwarding a parsed request body, say) must not have that
    // property land in the trail. That is the property checkable HERE. AuditLog does not
    // detect secrets - it simply refuses to copy a field it has no name for - so this
    // assertion fails the moment the writer starts spreading the caller's object verbatim,
    // which is the regression worth pinning.
    //
    // (An earlier version of this test asserted the trail omits a literal no call in this
    // file ever passes - it could not fail for ANY AuditLog implementation. Keeping tokens
    // out of the trail at all is the call sites' job, and that IS guarded end to end by
    // security-hardening.test.ts, which posts a real token to the real login route.)
    audit.record({
      action: 'auth.login',
      outcome: 'failed',
      actorId: 'u_bob',
      detail: 'bad_token',
      token: 'super-secret-token',
    } as never);
    await audit.flush();
    const raw = await readFile(filePath, 'utf8');
    // The field it was given is written; the field it has no name for is not.
    expect(raw).toContain('bad_token');
    expect(raw).not.toContain('super-secret-token');
  });

  it('truncates every field, so one long value cannot dominate the trail', async () => {
    const root = await tempRoot();
    const filePath = join(root, 'audit.jsonl');
    const audit = new AuditLog(filePath);
    // The class documents "every field is truncated"; without it a caller passing a long
    // blob would write it whole, and the trail stops being something a person can read.
    audit.record({ action: 'a'.repeat(500), outcome: 'ok', detail: 'd'.repeat(500) });
    await audit.flush();
    const [entry] = lines(await readFile(filePath, 'utf8'));
    expect((entry.action as string).length).toBeLessThanOrEqual(65);
    expect((entry.detail as string).length).toBeLessThanOrEqual(201);
  });

  it('keeps recording after the file (and its directory) disappears mid-process', async () => {
    const root = await tempRoot();
    const dataDir = join(root, 'data');
    const filePath = join(dataDir, 'audit.jsonl');
    const audit = new AuditLog(filePath);
    audit.record({ action: 'auth.login', outcome: 'ok', actorId: 'u_alice' });
    await audit.flush();

    // An operator or a cleanup script removed the trail while the server runs: the
    // next line must still be readable where the guide says it lives, instead of
    // being dropped because a cached "ready" flag said otherwise.
    await rm(dataDir, { recursive: true, force: true });
    audit.record({ action: 'auth.logout', outcome: 'ok', actorId: 'u_alice' });
    await audit.flush();

    const entries = lines(await readFile(filePath, 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'auth.logout' });
  });

  it('does not break the request path when the sink cannot be written', async () => {
    const root = await tempRoot();
    // A directory in the audit file's place: every append fails with EISDIR.
    const blocked = join(root, 'audit-dir');
    await mkdir(blocked, { recursive: true });
    const audit = new AuditLog(blocked);
    // record() must never throw or reject into the caller.
    expect(() => audit.record({ action: 'auth.login', outcome: 'failed' })).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
    // And the failure is visible to whoever looks: the path is not a file.
    expect((await stat(blocked)).isDirectory()).toBe(true);
  });

  it('appends in order, so a reader can reconstruct what happened', async () => {
    const root = await tempRoot();
    const filePath = join(root, 'audit.jsonl');
    await appendFile(filePath, '', 'utf8');
    const audit = new AuditLog(filePath);
    audit.record({ action: 'first', outcome: 'ok' });
    audit.record({ action: 'second', outcome: 'ok' });
    audit.record({ action: 'third', outcome: 'denied' });
    await audit.flush();
    expect(lines(await readFile(filePath, 'utf8')).map((entry) => entry.action)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
