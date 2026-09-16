'use strict';
/**
 * Continuous receipt sync (Gate 7A.2 remainder).
 *
 * The organization server keeps a *copy* of what happened on this device; the
 * device stays authoritative. The page used to do this opportunistically while
 * the settings screen was open, which meant local work silently never reached
 * the workbench when nobody looked at that screen.
 *
 * This module is deliberately free of Electron imports: it receives the host,
 * a cookie provider and a fetch implementation, so it can be exercised without
 * a GUI. Guarantees:
 *  - offline first: receipts are queued on disk and retried with backoff;
 *  - at-most-once per version: a receipt is only re-sent when the task changed;
 *  - honest status: pending/lastSuccessAt/lastError are reported to the UI;
 *  - no credentials on disk: cookies are read from the live session per request.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** Bounded queue: a device that is offline for days must not grow without limit. */
const MAX_PENDING = 200;

/**
 * Reads the queue state.
 *
 * A missing file is normal (first run). A file that exists but cannot be parsed
 * is NOT: it may still hold receipts that were never delivered, so it is renamed
 * aside (never deleted) and the reason is surfaced through `status().lastError`
 * instead of silently starting with an empty queue.
 */
function readState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      return { synced: {}, pending: {}, lastError: `state_unreadable: ${error.code || error.message}` };
    }
    return { synced: {}, pending: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        synced: parsed.synced && typeof parsed.synced === 'object' ? parsed.synced : {},
        pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
        lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : undefined,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : undefined,
      };
    }
    throw new Error('state is not an object');
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    let kept = '';
    try {
      kept = `${statePath}.corrupt-${Date.now()}`;
      fs.renameSync(statePath, kept);
      console.error(`[chatagent] receipt queue was unreadable (${reason}); kept as ${kept}`);
    } catch {
      // best effort: the error below is still reported
    }
    return {
      synced: {},
      pending: {},
      lastError: `state_corrupt: ${reason}${kept ? ` (kept as ${path.basename(kept)})` : ''}`,
    };
  }
}

/** Write → flush → rename, the same commit discipline the task store uses. */
function writeState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, statePath);
  } catch (error) {
    // The queue is an optimization, never the source of truth: report and go on.
    console.error('[chatagent] could not persist receipt queue:', error && error.message);
  }
}

/** One host record -> one receipt. Never invents fields the server would reject. */
function toReceipt(record, fallbackNow) {
  if (!record || typeof record.taskId !== 'string' || !record.taskId) return undefined;
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
        .filter((artifact) => artifact && typeof artifact.name === 'string' && artifact.name)
        .slice(0, 50)
        .map((artifact) => ({
          name: artifact.name,
          sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : '',
          bytes: typeof artifact.bytes === 'number' ? artifact.bytes : undefined,
        }))
    : [];
  const ownerId =
    record.delegation && typeof record.delegation.ownerId === 'string' && record.delegation.ownerId
      ? record.delegation.ownerId
      : undefined;
  return {
    deviceId: String(record.deviceId || 'unknown-device').slice(0, 128),
    agentId: String(record.agentId || 'hermes').slice(0, 128),
    taskId: record.taskId.slice(0, 128),
    goal: String(record.goal || '(无目标)').slice(0, 2000),
    kind: String(record.kind || 'document').slice(0, 64),
    state: record.state,
    executor: record.executor === 'hermes' ? 'hermes' : 'fake',
    error: typeof record.error === 'string' ? record.error.slice(0, 500) : undefined,
    summary: typeof record.summary === 'string' ? record.summary.slice(0, 500) : undefined,
    artifacts,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : fallbackNow,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : fallbackNow,
    // Present only when the host verified a delegation for this task: it is what
    // lets the server refuse a device that mirrors another account's work.
    ownerId,
  };
}

function createReceiptSync(options) {
  const {
    host,
    serverUrl,
    statePath,
    cookieProvider,
    fetchImpl = globalThis.fetch,
    intervalMs = DEFAULT_INTERVAL_MS,
    logger = console,
    now = () => Date.now(),
  } = options;

  let state = readState(statePath);
  let timer;
  let inFlight = null;
  let stopped = false;
  let backoffMs = intervalMs;

  /** Collects changed records into the pending queue. */
  function collect() {
    return host
      .list()
      .then((records) => {
        const nowIso = new Date(now()).toISOString();
        for (const record of records) {
          const receipt = toReceipt(record, nowIso);
          if (!receipt) continue;
          if (state.synced[receipt.taskId] === receipt.updatedAt) continue;
          state.pending[receipt.taskId] = receipt;
        }
        // Growth guard: the host prunes finished records (retention), so the
        // dedupe map must forget them too or it grows for the lifetime of the
        // install. Only entries the host no longer knows about are dropped, and
        // only after a *successful* list (a failed list must not wipe memory).
        const knownIds = new Set(records.map((record) => record && record.taskId).filter(Boolean));
        for (const taskId of Object.keys(state.synced)) {
          if (!knownIds.has(taskId)) delete state.synced[taskId];
        }
        const pendingIds = Object.keys(state.pending);
        if (pendingIds.length > MAX_PENDING) {
          // Oldest first: keep the most recent work in the mirror.
          pendingIds
            .sort((a, b) => Date.parse(state.pending[a].updatedAt) - Date.parse(state.pending[b].updatedAt))
            .slice(0, pendingIds.length - MAX_PENDING)
            .forEach((taskId) => delete state.pending[taskId]);
        }
        return Object.values(state.pending);
      })
      .catch((error) => {
        state.lastError = `host_list_failed: ${error && error.message ? error.message : String(error)}`;
        return [];
      });
  }

  async function push(receipts) {
    const cookies = await cookieProvider();
    const headers = { 'content-type': 'application/json' };
    if (cookies) headers.cookie = cookies;
    const response = await fetchImpl(`${serverUrl}/api/local-tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ receipts }),
    });
    return response;
  }

  async function flush() {
    if (stopped) return { sent: 0, skipped: true };
    const pending = await collect();
    if (pending.length === 0) {
      // A state-file problem is a real report (it may mean undelivered receipts
      // were lost), so it survives until a successful sync replaces it.
      if (!String(state.lastError || '').startsWith('state_')) state.lastError = undefined;
      writeState(statePath, state);
      return { sent: 0 };
    }
    try {
      const response = await push(pending);
      if (!response.ok) {
        // 401 means "not signed in yet": keep the queue, retry quietly later.
        state.lastError = `http_${response.status}`;
        writeState(statePath, state);
        return { sent: 0, status: response.status };
      }
      const syncedAt = new Date(now()).toISOString();
      for (const receipt of pending) {
        state.synced[receipt.taskId] = receipt.updatedAt;
        delete state.pending[receipt.taskId];
      }
      state.lastSuccessAt = syncedAt;
      state.lastError = undefined;
      writeState(statePath, state);
      logger.info && logger.info(`[chatagent] synced ${pending.length} local task receipt(s)`);
      return { sent: pending.length };
    } catch (error) {
      state.lastError = `network: ${error && error.message ? error.message : String(error)}`;
      writeState(statePath, state);
      return { sent: 0, error: state.lastError };
    }
  }

  function schedule() {
    if (stopped) return;
    const delay = state.lastError ? Math.min(backoffMs, MAX_BACKOFF_MS) : intervalMs;
    backoffMs = state.lastError ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : intervalMs;
    timer = setTimeout(() => {
      void kick('timer');
    }, delay);
    timer.unref && timer.unref();
  }

  /** Runs one sync cycle; concurrent callers share the same run. */
  function kick(reason = 'manual') {
    if (stopped) return Promise.resolve({ sent: 0, skipped: true });
    if (inFlight) return inFlight;
    inFlight = flush()
      .catch((error) => {
        state.lastError = String(error && error.message ? error.message : error);
        return { sent: 0, error: state.lastError };
      })
      .finally(() => {
        inFlight = null;
        if (timer) clearTimeout(timer);
        schedule();
      });
    if (reason !== 'timer') logger.info && logger.info(`[chatagent] receipt sync (${reason})`);
    return inFlight;
  }

  return {
    start() {
      stopped = false;
      schedule();
      return kick('start');
    },
    kick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    status() {
      return {
        pending: Object.keys(state.pending).length,
        synced: Object.keys(state.synced).length,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
      };
    },
  };
}

module.exports = { createReceiptSync, toReceipt, MAX_PENDING, readState, writeState };
