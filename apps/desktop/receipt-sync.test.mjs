import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The desktop shell is plain CommonJS (it runs inside Electron), so the module
// under test is loaded through createRequire rather than rewritten as ESM.
const require = createRequire(import.meta.url);
const { createReceiptSync, toReceipt, MAX_PENDING, readState } = require('./receipt-sync.cjs');

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'chatagent-receipt-sync-'));
  dirs.push(dir);
  return dir;
}

function hostRecord(taskId, updatedAt, extra = {}) {
  return {
    taskId,
    deviceId: 'desktop-1',
    agentId: 'hermes',
    goal: '整理周报',
    kind: 'document',
    state: 'succeeded',
    updatedAt,
    artifacts: [],
    ...extra,
  };
}

function fakeHost(records) {
  return { list: vi.fn(async () => records) };
}

function okResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status };
}

describe('receipt mapping', () => {
  it('never invents fields and only carries a verified delegation owner', () => {
    const receipt = toReceipt(hostRecord('t1', '2026-09-16T00:00:00.000Z'), '2026-09-16T00:00:00.000Z');
    expect(receipt).toMatchObject({ taskId: 't1', deviceId: 'desktop-1', ownerId: undefined });
    const owned = toReceipt(
      hostRecord('t2', '2026-09-16T00:00:00.000Z', { delegation: { ownerId: 'member-alice' } }),
      '2026-09-16T00:00:00.000Z',
    );
    expect(owned.ownerId).toBe('member-alice');
    // A delegation without an owner must not become an empty-string claim.
    const empty = toReceipt(
      hostRecord('t3', '2026-09-16T00:00:00.000Z', { delegation: { ownerId: '' } }),
      '2026-09-16T00:00:00.000Z',
    );
    expect(empty.ownerId).toBeUndefined();
  });

  it('skips records without an id and bounds the payload it sends', () => {
    expect(toReceipt({ goal: 'no id' }, '2026-09-16T00:00:00.000Z')).toBeUndefined();
    expect(toReceipt(null, '2026-09-16T00:00:00.000Z')).toBeUndefined();
    const many = toReceipt(
      hostRecord('t4', '2026-09-16T00:00:00.000Z', {
        goal: 'x'.repeat(5000),
        artifacts: Array.from({ length: 80 }, (_, index) => ({ name: `f${index}.docx`, sha256: 'a', bytes: 1 })),
      }),
      '2026-09-16T00:00:00.000Z',
    );
    expect(many.goal.length).toBe(2000);
    expect(many.artifacts).toHaveLength(50);
  });
});

describe('queue state file', () => {
  it('keeps an unreadable queue aside and reports it instead of starting silently', async () => {
    const dir = scratch();
    const statePath = join(dir, 'receipts-sync.json');
    writeFileSync(statePath, '{ not json', 'utf8');

    const sync = createReceiptSync({
      // Nothing new to send: the report must not be wiped by the empty branch.
      host: fakeHost([]),
      serverUrl: 'http://127.0.0.1:1',
      statePath,
      cookieProvider: async () => '',
      fetchImpl: async () => okResponse(200),
      intervalMs: 60_000,
      logger: { info() {}, error() {} },
    });
    await sync.kick('test');

    const status = sync.status();
    expect(status.lastError).toMatch(/^state_corrupt:/);
    expect(status.lastError).toMatch(/\.corrupt-\d+/);
    const kept = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(kept, 'the unreadable queue is kept aside, not deleted').toHaveLength(1);
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe('{ not json');

    // A successful sync that actually delivered something clears the report.
    const sync2 = createReceiptSync({
      host: fakeHost([hostRecord('t1', '2026-09-16T00:00:00.000Z')]),
      serverUrl: 'http://127.0.0.1:1',
      statePath: join(dir, 'other.json'),
      cookieProvider: async () => '',
      fetchImpl: async () => okResponse(200),
      intervalMs: 60_000,
      logger: { info() {}, error() {} },
    });
    await sync2.kick('test');
    expect(sync2.status().lastError).toBeUndefined();
    sync2.stop();
    sync.stop();
  });

  it('survives a state file that cannot be written at all', async () => {
    const dir = scratch();
    // A directory where the state file should be: every write fails.
    const statePath = join(dir, 'receipts-sync.json');
    const sync = createReceiptSync({
      host: fakeHost([hostRecord('t1', '2026-09-16T00:00:00.000Z')]),
      serverUrl: 'http://127.0.0.1:1',
      statePath,
      cookieProvider: async () => '',
      fetchImpl: async () => okResponse(200),
      intervalMs: 60_000,
      logger: { info() {}, error() {} },
    });
    require('node:fs').mkdirSync(statePath, { recursive: true });
    const result = await sync.kick('test');
    // Reporting still works; the module never throws out of a sync cycle.
    expect(result.sent).toBe(1);
    sync.stop();
  });

  it('re-sends only what changed and forgets records the host dropped', async () => {
    const dir = scratch();
    const statePath = join(dir, 'receipts-sync.json');
    let records = [hostRecord('t1', '2026-09-16T00:00:00.000Z'), hostRecord('t2', '2026-09-16T00:00:00.000Z')];
    const host = { list: vi.fn(async () => records) };
    const fetchImpl = vi.fn(async () => okResponse(200));
    const sync = createReceiptSync({
      host,
      serverUrl: 'http://127.0.0.1:1',
      statePath,
      cookieProvider: async () => '',
      fetchImpl,
      intervalMs: 60_000,
      logger: { info() {}, error() {} },
    });

    await sync.kick('test');
    expect(sync.status().synced).toBe(2);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.receipts.map((item) => item.taskId).sort()).toEqual(['t1', 't2']);

    // Nothing changed: no second upload.
    await sync.kick('test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // One task changes: only that one is uploaded again.
    records = [hostRecord('t1', '2026-09-16T01:00:00.000Z'), records[1]];
    await sync.kick('test');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).receipts.map((item) => item.taskId)).toEqual(['t1']);

    // Retention removes t2 from the device: the dedupe entry goes with it, so the
    // state file does not grow for the lifetime of the install.
    records = [records[0]];
    await sync.kick('test');
    expect(sync.status().synced).toBe(1);
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(Object.keys(onDisk.synced)).toEqual(['t1']);
    sync.stop();
  });

  it('keeps a failed upload queued and bounds the queue by newest work', async () => {
    const dir = scratch();
    const statePath = join(dir, 'receipts-sync.json');
    const records = Array.from({ length: MAX_PENDING + 40 }, (_, index) =>
      hostRecord(`t${String(index).padStart(3, '0')}`, new Date(Date.UTC(2026, 8, 16, 0, index)).toISOString()),
    );
    const sync = createReceiptSync({
      host: fakeHost(records),
      serverUrl: 'http://127.0.0.1:1',
      statePath,
      cookieProvider: async () => 'session=abc',
      fetchImpl: async () => ({ ok: false, status: 401 }),
      intervalMs: 60_000,
      logger: { info() {}, error() {} },
    });
    const result = await sync.kick('test');
    expect(result.sent).toBe(0);
    expect(sync.status().pending).toBe(MAX_PENDING);
    expect(sync.status().lastError).toBe('http_401');
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(Object.keys(onDisk.pending)).toHaveLength(MAX_PENDING);
    // The newest work is what survives the cap.
    expect(onDisk.pending[records[records.length - 1].taskId]).toBeTruthy();
    expect(onDisk.pending[records[0].taskId]).toBeUndefined();
    sync.stop();
  });

  it('reports a read error rather than pretending the queue is empty', () => {
    const dir = scratch();
    const missing = readState(join(dir, 'nope.json'));
    expect(missing.lastError).toBeUndefined();
    expect(missing.pending).toEqual({});
  });
});
