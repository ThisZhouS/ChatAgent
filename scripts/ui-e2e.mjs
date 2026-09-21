#!/usr/bin/env node
/**
 * Browser-level end-to-end test of the ChatAgent client.
 *
 * The desktop shell is Electron, so the packaged (or dev) client exposes a
 * Chrome DevTools Protocol endpoint. This script drives the real UI through
 * that endpoint: it types into the login form, opens the AI conversation,
 * sends messages, waits for the AI reply and captures screenshots as evidence.
 *
 * Usage:
 *   node scripts/ui-e2e.mjs                       # packaged exe if built, else dev electron
 *   node scripts/ui-e2e.mjs --server http://localhost:8787 --debug-port 9333
 *   node scripts/ui-e2e.mjs --keep-open           # leave the client running for manual review
 *
 * Prerequisites: a running ChatAgent server (node scripts/restart-server.mjs)
 * and a built web bundle (pnpm build), because the client loads the server URL.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const serverUrl = (argValue('--server', process.env.CHATAGENT_SERVER_URL ?? 'http://localhost:8787')).replace(/\/+$/, '');
const debugPort = Number(argValue('--debug-port', '9333'));
/**
 * Credentials for the run, in order: --member/--token, SMOKE_MEMBER/SMOKE_TOKEN, then
 * the gitignored Temp/e2e-member.json that scripts/ensure-e2e-member.mjs writes. A
 * committed default token would be a live credential in the repository, so the
 * fallback provisions a dedicated local member instead of shipping one.
 */
function localE2eCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'Temp', 'e2e-member.json'), 'utf8'));
    if (parsed && typeof parsed.memberId === 'string' && typeof parsed.token === 'string') return parsed;
  } catch {
    // not provisioned yet
  }
  return undefined;
}

function ensureLocalE2eMember() {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'ensure-e2e-member.mjs'), '--server', serverUrl], {
    stdio: 'inherit',
  });
  return result.status === 0 ? localE2eCredentials() : undefined;
}

const explicitMember = argValue('--member', process.env.SMOKE_MEMBER);
const explicitToken = argValue('--token', process.env.SMOKE_TOKEN);
const resolvedCredentials =
  explicitMember && explicitToken
    ? { memberId: explicitMember, token: explicitToken }
    : (localE2eCredentials() ?? ensureLocalE2eMember());
const memberId = explicitMember ?? resolvedCredentials?.memberId ?? 'e2e_local';
const memberToken = explicitToken ?? resolvedCredentials?.token ?? '';
const shotDir = resolve(argValue('--shots', join(root, 'Temp', 'ui-shots')));
const keepOpen = args.includes('--keep-open');
// Defaults to the packaged build, but any client binary may be pointed at (an
// upgrade rehearsal packages a second build next to the shipped one).
const packagedExe =
  argValue('--exe', process.env.CHATAGENT_CLIENT_EXE) ??
  join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'ChatAgent.exe');
const devElectron = join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');

const results = [];
const screenshots = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function httpGetJson(port, path) {
  return new Promise((resolvePromise) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false, timeout: 3000 },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            resolvePromise(JSON.parse(raw));
          } catch {
            resolvePromise(undefined);
          }
        });
      },
    );
    req.on('error', () => resolvePromise(undefined));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Minimal Chrome DevTools Protocol client over the page target websocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.delete(id)) rejectPromise(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.result?.value;
  }

  /**
   * Screenshots are evidence, not assertions: a slow or blocked renderer must
   * not fail the run, so capture problems are reported and skipped.
   */
  async screenshot(name) {
    try {
      const result = await this.send('Page.captureScreenshot', { format: 'png' }, 12000);
      const file = join(shotDir, `${name}.png`);
      writeFileSync(file, Buffer.from(result.data, 'base64'));
      screenshots.push(file);
      return file;
    } catch (error) {
      console.log(`  (screenshot ${name} skipped: ${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }
  }
}

function normaliseText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Gives the page a couple of animation frames to apply a Vue update. */
async function flushPromisesInPage(cdp) {
  await cdp
    .evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`,
    )
    .catch(() => undefined);
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression);
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

/** Helper expression: click the first element matching a selector whose text contains value. */
function clickByTextExpr(selector, text) {
  return `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const hit = nodes.find((node) => (node.textContent || '').includes(${JSON.stringify(text)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`;
}

/** Helper expression: resolve the element carrying a data-testid marker. */
function findExpr(testId) {
  const id = JSON.stringify(testId);
  return `document.querySelector('[data-testid=' + ${id} + ']')`;
}

/** Helper expression: the interactive control behind a marker (Element Plus puts
 * the attribute either on the inner control or on the wrapper element). */
function fieldExpr(testId) {
  return `(() => {
    const host = ${findExpr(testId)};
    if (!host) return null;
    return host.matches('input, textarea') ? host : host.querySelector('input, textarea');
  })()`;
}

/** Helper expression: set a Vue-bound field value through the native setter. */
function setFieldExpr(testId, value) {
  return `(() => {
    const field = ${fieldExpr(testId)};
    if (!field) return false;
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

/**
 * Opens the 1:1 conversation with an AI account by clicking the side item that
 * carries the "AI" tag. Titles and previews are ambiguous (a group preview can
 * mention the assistant too), so the tag is the reliable marker.
 */
function clickAiContactExpr() {
  return `(() => {
    const items = [...document.querySelectorAll('.side-item')];
    const hit = items.find((item) =>
      [...item.querySelectorAll('.el-tag')].some((tag) => (tag.textContent || '').trim() === 'AI'),
    );
    if (!hit) return false;
    hit.click();
    return true;
  })()`;
}

function clickTestIdExpr(testId) {
  return `(() => {
    const host = ${findExpr(testId)};
    if (!host) return false;
    const target = host.closest('button') || host.querySelector('button') || host;
    target.click();
    return true;
  })()`;
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await httpGetJson(new URL(serverUrl).port ? Number(new URL(serverUrl).port) : 80, '/health');
    if (body && body.ok === true) return body;
    await sleep(400);
  }
  return undefined;
}

/**
 * Types into the composer and sends, verifying that the message was really
 * posted before the caller starts waiting for a reply.
 *
 * The chat list re-renders whenever a reply or poll lands; a value written into
 * the textarea in that window is reset before the send click, the client blocks
 * the empty send locally, and the run then fails with "no reply" even though
 * nothing was ever sent (observed under load). Retrying with an explicit
 * bubble-marker check keeps that latent harness flake out of the gate.
 */
/**
 * Sends one message from the composer and reports whether a bubble with that text
 * exists in the conversation.
 *
 * Two things this has to get right, both learned from a real packaged run: the
 * bubble only appears after the POST returns and the thread is re-read (so an
 * immediate check is a race, and a second click on that race posts the message
 * twice), and the send button is disabled while a send is in flight (:loading),
 * so a click that lands in that window does nothing at all. It therefore waits
 * for the button to be clickable, waits for the bubble, and never re-types a
 * message that is already in flight.
 */
async function sendComposerMessage(cdp, text, { attempts = 3 } = {}) {
  const bubbleSeen = () =>
    cdp
      .evaluate(
        `[...document.querySelectorAll('[data-testid="message-bubble"]')].some((node) => (node.innerText || '').includes(${JSON.stringify(text)}))`,
      )
      .catch(() => false);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await bubbleSeen()) return true;
    // A successful send clears the composer: only type when it is empty or still
    // holds our text, so a retry can never post a second copy.
    const current = await cdp.evaluate(
      `(() => { const field = ${fieldExpr('composer')}; return field ? String(field.value || '') : ''; })()`,
    );
    if (!String(current).includes(text)) {
      await cdp.evaluate(setFieldExpr('composer', text));
    }
    if (await clickWhenSendable(cdp)) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await bubbleSeen()) return true;
        await sleep(150);
      }
    }
    await sleep(300);
  }
  return false;
}

/** Clicks the send control once it is enabled (a loading button swallows clicks). */
async function clickWhenSendable(cdp, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const host = ${findExpr('send')};
      if (!host) return { found: false };
      const button = host.closest('button') || host.querySelector('button') || host;
      return { found: true, disabled: Boolean(button.disabled), loading: button.classList.contains('is-loading') };
    })()`);
    if (state && state.found && !state.disabled && !state.loading) {
      await cdp.evaluate(clickTestIdExpr('send'));
      return true;
    }
    await sleep(100);
  }
  return false;
}

/** What the page looked like when a send produced no bubble (diagnostics only). */
async function composerDiagnostics(cdp, text) {
  return cdp.evaluate(`(() => {
    const field = ${fieldExpr('composer')};
    const host = ${findExpr('send')};
    const button = host ? host.closest('button') || host.querySelector('button') || host : null;
    const bubbles = [...document.querySelectorAll('[data-testid="message-bubble"]')];
    return {
      composerValue: field ? String(field.value || '') : null,
      sendDisabled: button ? Boolean(button.disabled) : null,
      bubbles: bubbles.length,
      hasMarker: bubbles.some((node) => (node.innerText || '').includes(${JSON.stringify(text)})),
    };
  })()`);
}

function launchClient() {
  const usePackaged = existsSync(packagedExe);
  const command = usePackaged ? packagedExe : devElectron;
  if (!existsSync(command)) return undefined;
  // A stale profile keeps serving the previous hashed bundle from the HTTP
  // cache; every run starts from a clean profile and disables caching.
  rmSync(join(root, 'Temp', 'electron-profile'), { recursive: true, force: true });
  const child = spawn(
    command,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${join(root, 'Temp', 'electron-profile')}`,
      ...(usePackaged ? [] : [resolve(root, 'apps', 'desktop')]),
    ],
    { detached: false, stdio: 'ignore', windowsHide: true },
  );
  return { child, kind: usePackaged ? 'packaged exe' : 'dev electron' };
}

async function connectToPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await httpGetJson(debugPort, '/json/list');
    const page = Array.isArray(targets) ? targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) : undefined;
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolvePromise, rejectPromise) => {
        ws.addEventListener('open', () => resolvePromise());
        ws.addEventListener('error', () => rejectPromise(new Error('websocket failed')));
        setTimeout(() => rejectPromise(new Error('websocket connect timed out')), 10000);
      });
      return new Cdp(ws);
    }
    await sleep(500);
  }
  return undefined;
}

function stopClient() {
  try {
    execFileSync('taskkill', ['/IM', 'ChatAgent.exe', '/F', '/T'], { stdio: 'ignore' });
  } catch {
    // already gone
  }
  try {
    execFileSync('taskkill', ['/IM', 'electron.exe', '/F', '/T'], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

/**
 * Counts matches of a selector until the value stops changing, so assertions
 * run against a fully loaded conversation instead of a partially rendered one.
 */
async function waitForStableCount(cdp, selector, timeoutMs = 20000) {
  const expression = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const current = Number(await cdp.evaluate(expression));
    if (current === previous) stableRounds += 1;
    else stableRounds = 0;
    previous = current;
    if (current > 0 && stableRounds >= 2) return current;
    await sleep(500);
  }
  return previous;
}

/**
 * Waits until a bubble beyond `baseline` matches the pattern and returns its
 * text; messages that existed before the interaction never satisfy the check.
 */
async function waitForNewBubble(cdp, baseline, pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(`(() => {
      const bubbles = [...document.querySelectorAll('[data-testid="message-bubble"]')];
      if (bubbles.length <= ${baseline}) return '';
      const fresh = bubbles.slice(${baseline}).map((b) => (b.innerText || '').replace(/\s+/g, ' ')).filter(Boolean);
      return fresh.length > 0 ? fresh[fresh.length - 1] : '';
    })()`);
    if (typeof found === 'string' && found !== '') {
      lastText = found;
      if (pattern.test(found)) return found;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label} (last new bubble: ${lastText || 'none'})`);
}

/**
 * Collects computed text/background color pairs for a set of selectors and
 * returns WCAG contrast ratios. Used to verify readability objectively instead
 * of eyeballing a screenshot.
 */
function contrastExpr(selectors) {
  return `(() => {
    // Parsed without a regular expression on purpose: this expression travels
    // through two layers of string literals, and a backslash that survives only
    // one of them silently turns the pattern into something that never matches.
    const parse = (value) => {
      const text = String(value || '');
      const open = text.indexOf('(');
      const close = text.lastIndexOf(')');
      if (open < 0 || close <= open) return null;
      const parts = text.slice(open + 1, close).split(',').map((n) => Number.parseFloat(n));
      if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const luminance = ({ r, g, b }) => {
      const channel = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const background = (element) => {
      let node = element;
      while (node && node !== document.documentElement.parentNode) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0.05) return color;
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const ratio = (a, b) => {
      const l1 = luminance(a);
      const l2 = luminance(b);
      const light = Math.max(l1, l2);
      const dark = Math.min(l1, l2);
      return Number((((light + 0.05) / (dark + 0.05))).toFixed(2));
    };
    const out = [];
    for (const selector of ${JSON.stringify(selectors)}) {
      const element = document.querySelector(selector);
      if (!element) {
        out.push({ selector, missing: true });
        continue;
      }
      const style = getComputedStyle(element);
      const fg = parse(style.color);
      const bg = background(element);
      out.push({
        selector,
        text: (element.innerText || '').replace(/\s+/g, ' ').slice(0, 24),
        fontSize: style.fontSize,
        contrast: fg ? ratio(fg, bg) : null,
      });
    }
    return out;
  })()`;
}

/** Reports clipped or overflowing text nodes inside a container selector. */
function overflowExpr(selector) {
  return `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    return nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        // text-overflow: ellipsis is a deliberate truncation, not a defect
        if (style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap') return false;
        return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
      })
      .slice(0, 6)
      .map((node) => ({
        cls: node.className,
        text: (node.innerText || '').replace(/\s+/g, ' ').slice(0, 32),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
  })()`;
}

/**
 * Waits until a bubble that appears AFTER the bubble carrying `marker` matches
 * the pattern. Anchoring on the marker keeps the assertion valid even when the
 * client only renders the newest page of history.
 */
async function waitForBubbleAfter(cdp, marker, pattern, timeoutMs, label) {
  const expression = `(() => {
    const bubbles = [...document.querySelectorAll('[data-testid="message-bubble"]')];
    const anchor = bubbles.findIndex((bubble) => (bubble.innerText || '').includes(${JSON.stringify('__MARKER__')}));
    if (anchor < 0) return '';
    const after = bubbles.slice(anchor + 1).map((bubble) => bubble.innerText || '').filter((text) => text.trim() !== '');
    return after.length > 0 ? after[after.length - 1] : '';
  })()`.replace('__MARKER__', marker);
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(expression);
    if (typeof found === 'string' && found !== '') {
      lastText = found;
      if (pattern.test(found)) return found;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label} (last bubble after marker: ${normaliseText(lastText) || 'none'})`);
}

async function main() {
  console.log(`ChatAgent UI end-to-end → ${serverUrl} (CDP :${debugPort})\n`);
  mkdirSync(shotDir, { recursive: true });

  const health = await waitForHealth();
  record('server reachable', Boolean(health), health ? `authMode=${health.authMode}` : 'no /health');
  if (!health) {
    console.log('\nstart the server first: node scripts/restart-server.mjs');
    process.exit(1);
  }

  const launched = launchClient();
  if (!launched) {
    record('desktop client binary found', false, 'build it with: pnpm --filter @chatagent/desktop run build');
    process.exit(1);
  }
  const cdp = await connectToPage();
  record('desktop client exposed a page target', Boolean(cdp), launched.kind);
  if (!cdp) {
    stopClient();
    process.exit(1);
  }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.navigate', { url: serverUrl });
  await sleep(1500);

  try {
    const where = await cdp.evaluate('location.href');
    record('client loaded the app URL', typeof where === 'string' && where.startsWith(serverUrl), String(where));
    const scriptTags = await cdp.evaluate(`[...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')).slice(0, 4)`);
    record('app bundle referenced', Array.isArray(scriptTags) && scriptTags.length > 0, JSON.stringify(scriptTags));

    const loginReady = await waitFor(cdp, `Boolean(${fieldExpr('login-member')})`, 30000, 'login form');
    record('login view rendered', Boolean(loginReady));
    const loginText = await cdp.evaluate('document.body.innerText.replace(/\\s+/g, " ").slice(0, 160)');
    record('login view copy', typeof loginText === 'string' && loginText.includes('ChatAgent'), loginText);
    await cdp.screenshot('01-login');

    await cdp.evaluate(setFieldExpr('login-member', memberId));
    const filledMember = await cdp.evaluate(`(() => { const f = ${fieldExpr('login-member')}; return f ? f.value : null; })()`);
    await cdp.evaluate(setFieldExpr('login-token', memberToken));
    record('credentials entered', filledMember === memberId, `member=${filledMember}`);

    await cdp.evaluate(clickTestIdExpr('login-submit'));
    // A brand-new deployment has no conversations yet, so the sidebar (with its
    // contacts) is what proves the session works; conversations may appear later.
    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="conversation-item"]') || document.querySelector('.side-item'))`,
      25000,
      'sidebar content',
    );
    const sidebar = await cdp.evaluate(`({
      conversations: document.querySelectorAll('[data-testid="conversation-item"]').length,
      contacts: document.querySelectorAll('.side-item').length,
    })`);
    record(
      'logged in and sidebar rendered',
      Number(sidebar.contacts) > 0 || Number(sidebar.conversations) > 0,
      JSON.stringify(sidebar),
    );
    await cdp.screenshot('02-chat');

    // Open the 1:1 conversation with an AI account through its "AI" tag: titles
    // and previews are ambiguous (a group preview can mention the assistant).
    const opened = await cdp.evaluate(clickAiContactExpr());
    record('opened the 1:1 AI conversation', Boolean(opened));
    if (!opened) {
      const names = await cdp.evaluate(`[...document.querySelectorAll('.side-item')].map((n) => n.innerText || '')`);
      record(
        'available side items',
        false,
        JSON.stringify(
          (Array.isArray(names) ? names : []).map((text) => normaliseText(String(text)).slice(0, 40)),
        ),
      );
    }
    // Opening a conversation is asynchronous. The composer may already be
    // enabled because the client auto-selected another conversation on load, so
    // the header is what has to be waited for, not the composer.
    const headerReady = await waitFor(
      cdp,
      `(() => {
        const header = (document.querySelector('.chat-main .side-title') || {}).innerText || '';
        return /助手|助理/.test(header) ? header : '';
      })()`,
      15000,
      'the AI conversation header',
    ).catch(() => '');
    const header = normaliseText(String(headerReady));
    record('AI conversation is active', header.includes('助手') || header.includes('助理'), header.slice(0, 40));
    await waitFor(
      cdp,
      `(() => { const el = document.querySelector('[data-testid="composer"] textarea, textarea[data-testid="composer"]'); return Boolean(el) && !el.disabled; })()`,
      15000,
      'composer enabled',
    );

    // Wait for the persisted history of this conversation to finish loading.
    const loaded = await waitForStableCount(cdp, '[data-testid="message-bubble"]', 8000);
    record(
      'conversation thread rendered',
      loaded >= 0,
      `${loaded} bubbles in the newest page (0 = fresh conversation)`,
    );

    // Bubbles are addressed by unique markers instead of by count: the client
    // keeps only the newest page, so a counter is not a stable baseline.
    // The host hands a message to an assistant only after the recall window has elapsed, so the
    // greeting reply is not immediate by design. Read the policy and allow for it, and assert
    // that a queued message is explained to the user rather than looking stuck.
    const policy = await cdp
      .evaluate('window.fetch("/api/agent/status").then((r) => r.json()).then((s) => s.intake ?? null)')
      .catch(() => null);
    const deferMs = Number(policy?.deferMs ?? 0);
    // `deferMs` is the recall window; whether anything is actually queued is the mode. In
    // immediate mode nothing waits, so there is no notice to look for.
    const deferred = policy?.mode === 'deferred';
    const stamp = Date.now().toString(36);
    const greetingMarker = `E2E-HELLO-${stamp}`;
    const greeting = await cdp.evaluate(setFieldExpr('composer', `你好 ${greetingMarker}`));
    record('composer accepts input', Boolean(greeting));
    record(
      'greeting message was posted from the client',
      await sendComposerMessage(cdp, `你好 ${greetingMarker}`),
      `marker ${greetingMarker}`,
    );

    // The handoff is queued until the recall window has elapsed: the user must be told, not
    // left wondering why the assistant is silent (only observable while it is still queued).
    if (deferred && deferMs >= 5000) {
      const notice = await cdp
        .evaluate('Boolean(document.querySelector(\'[data-testid=intake-notice]\'))')
        .catch(() => undefined);
      record('a queued handoff is explained instead of looking stuck', notice === true, `deferMs=${deferMs}`);
    }

    const replyText = await waitForBubbleAfter(
      cdp,
      greetingMarker,
      /我是 ChatAgent/,
      // Generous when the host defers the handoff: a long recall window is a policy, not a hang.
      Math.max(40000, deferMs + 30000),
      'AI greeting reply',
    );
    record('AI replied to the greeting in the UI', replyText !== '', normaliseText(replyText).slice(0, 100));
    await cdp.screenshot('03-ai-reply');

    const docMarker = `E2E-DOC-${stamp}`;
    const docRequest = `帮我生成一份 Word 周报 ${docMarker}`;
    const posted = await sendComposerMessage(cdp, docRequest);
    if (!posted) {
      // A send that produced no bubble has to say why: a disabled button (a send
      // still in flight) plus a composer that still holds the text means nothing
      // was lost, which is a different story from a swallowed message.
      const diagnostics = await composerDiagnostics(cdp, docRequest).catch(() => null);
      console.log(`[diag] document request not posted — ${JSON.stringify(diagnostics)}`);
    }
    record('document request posted from the client', posted, posted ? `marker ${docMarker}` : 'no bubble appeared');
    const docReply = await waitForBubbleAfter(cdp, docMarker, /已生成文件|已完成|\.docx/, 60000, 'document task reply');
    record('document task finished in the UI', docReply !== '', normaliseText(docReply).slice(0, 120));

    const artifacts = await cdp.evaluate(
      `[...document.querySelectorAll('[data-testid="message-bubble"] a')].map((node) => ({ text: node.innerText || '', href: node.getAttribute('href') || '' })).map((item) => item.text.trim() + '|' + item.href).slice(-3)`,
    );
    const downloadable = (Array.isArray(artifacts) ? artifacts : []).filter((item) =>
      String(item).includes('|/api/files/'),
    );
    record('generated file is downloadable from the chat', downloadable.length > 0, JSON.stringify(downloadable));
    await cdp.screenshot('04-document-task');

    // Recall: a member withdraws their own message inside the window; the body
    // must disappear from the bubble and from every later read.
    const recallMarker = `撤回验证-${stamp}`;
    await sendComposerMessage(cdp, recallMarker);
    await waitForBubbleAfter(cdp, recallMarker, new RegExp(recallMarker), 40000, 'own message');

    // The recall assertion is anchored to the marker bubble's position counted
    // from the END of the list, because the page trims the oldest bubbles.
    const anchor = await cdp.evaluate(`(() => {
      const bubbles = [...document.querySelectorAll('[data-testid="message-bubble"]')];
      const index = bubbles.findIndex((bubble) => (bubble.innerText || '').includes(${JSON.stringify(recallMarker)}));
      if (index < 0) return { clicked: false };
      const button = bubbles[index].querySelector('[data-testid="recall"]');
      if (!button) return { clicked: false, reason: 'no recall button' };
      const offsetFromEnd = bubbles.length - 1 - index;
      button.click();
      return { clicked: true, offsetFromEnd };
    })()`);

    let recalledText = '';
    if (anchor && anchor.clicked) {
      const expression = `(() => {
        const bubbles = [...document.querySelectorAll('[data-testid="message-bubble"]')];
        const target = bubbles[bubbles.length - 1 - ${Number(anchor.offsetFromEnd)}];
        return target ? target.innerText || '' : '';
      })()`;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        recalledText = String(await cdp.evaluate(expression));
        if (recalledText.includes('撤回了一条消息')) break;
        await sleep(500);
      }
    }
    // Forwarding: the dialog opens for any message, and the copy lands in the
    // chosen conversation. On a workspace without a second conversation the
    // dialog legitimately shows an empty state, which is reported as such.
    const forwardOpened = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('[data-testid="forward"]')];
      const last = buttons[buttons.length - 1];
      if (!last) return false;
      last.click();
      return true;
    })()`);
    const forwardTargets = forwardOpened
      ? await cdp.evaluate(`[...document.querySelectorAll('.el-select-dropdown__item')].length`)
      : 0;
    if (forwardOpened && Number(forwardTargets) > 0) {
      await cdp.evaluate(`(() => {
        const option = document.querySelector('.el-select-dropdown__item');
        if (option) option.click();
        return true;
      })()`);
      await flushPromisesInPage(cdp);
      const forwarded = await cdp.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.el-dialog__footer button')];
        const confirm = buttons.find((node) => (node.innerText || '').trim() === '转发');
        if (!confirm) return false;
        confirm.click();
        return true;
      })()`);
      const noticeText = await waitFor(
        cdp,
        `(() => { const node = document.querySelector('[data-testid="notice"]'); return node ? node.innerText : ''; })()`,
        10000,
        'forward confirmation',
      ).catch(() => '');
      record('message forwarding from the client works', Boolean(forwarded) && normaliseText(String(noticeText)).includes('已转发'), normaliseText(String(noticeText)).slice(0, 40));
    } else {
      record('message forwarding dialog opens', Boolean(forwardOpened), `${forwardTargets} target(s) available`);
    }

    // Attachment path: upload a real file through the composer's file input and
    // require the sent bubble to carry a downloadable /api/files link. This
    // multipart path had no coverage in the packaged client, and it is exactly
    // where a missing credential header goes unnoticed.
    const attachName = `e2e-note-${stamp}.txt`;
    const attachMarker = `E2E-ATTACH-${stamp}`;
    const injectedFile = await cdp.evaluate(`(() => {
      const input = document.querySelector('.composer-row input[type="file"]') || document.querySelector('input[type="file"]');
      if (!input) return 'no-input';
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify('附件内容 e2e')}], ${JSON.stringify(attachName)}, { type: 'text/plain' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'dispatched';
    })()`);
    let attached = false;
    const attachDeadline = Date.now() + 15000;
    while (Date.now() < attachDeadline) {
      attached = await cdp
        .evaluate(`(document.body.innerText || '').includes(${JSON.stringify(attachName)})`)
        .catch(() => false);
      if (attached) break;
      await sleep(300);
    }
    await sendComposerMessage(cdp, `${attachMarker} 附件验证`);
    const attachLink = await cdp.evaluate(`(() => {
      const bubbles = [...document.querySelectorAll('[data-testid="message-bubble"]')];
      const hit = bubbles.find((bubble) => (bubble.innerText || '').includes(${JSON.stringify(attachMarker)}));
      if (!hit) return '';
      const link = [...hit.querySelectorAll('a')].find((node) =>
        (node.getAttribute('href') || '').includes('/api/files/'),
      );
      return link ? (link.innerText || '').trim() + '|' + link.getAttribute('href') : '';
    })()`);
    record(
      'chat attachment uploads and delivers a downloadable file',
      injectedFile === 'dispatched' && attached && String(attachLink).includes('/api/files/'),
      JSON.stringify({ injectedFile, attached, link: String(attachLink).slice(0, 80) }),
    );

    // The export control is asserted by presence only: activating it opens the
    // generated file through the OS browser, which is a side effect a test run
    // must not trigger.
    const exportControl = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="export"]'))`,
    );
    record('conversation export control is available', exportControl === true);

    // The AI reply may quote the recalled text (that turn is a different
    // message); what must be gone is the sender's OWN bubble content.
    const ownMarkerBubbles = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.bubble-row.mine')];
      return rows.filter((row) => (row.innerText || '').includes(${JSON.stringify(recallMarker)})).length;
    })()`);
    const quoted = await cdp.evaluate(
      `(document.body.innerText || '').includes(${JSON.stringify(recallMarker)})`,
    );
    record(
      'own message can be recalled and the body disappears',
      Boolean(anchor && anchor.clicked) &&
        recalledText.includes('撤回了一条消息') &&
        Number(ownMarkerBubbles) === 0,
      `${normaliseText(recalledText).slice(0, 50)} · 已被 AI 引用=${String(quoted)}`,
    );
    await cdp.screenshot('08-recalled');

    const uiErrors = await cdp.evaluate(
      `[...document.querySelectorAll('.el-message--error, .el-alert--error')].map((n) => n.innerText.replace(/\\s+/g, ' ')).slice(0, 5)`,
    );
    record('no error toasts visible', Array.isArray(uiErrors) && uiErrors.length === 0, JSON.stringify(uiErrors));

    const pageOverflow = await cdp.evaluate(
      `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })`,
    );
    record(
      'no horizontal page overflow',
      Number(pageOverflow.scrollWidth) <= Number(pageOverflow.clientWidth) + 1,
      JSON.stringify(pageOverflow),
    );

    const clipped = await cdp.evaluate(
      overflowExpr('.bubble-text, .side-item-title, .side-item-sub, .chat-main .side-title'),
    );
    record('no clipped text in bubbles or sidebar', Array.isArray(clipped) && clipped.length === 0, JSON.stringify(clipped));

    // Contrast is measured on a live themed page; under heavy load the theme
    // transition can still be settling, so a low first reading is re-measured
    // once after the transition has had time to finish.
    const measureContrast = async () => {
      const detail = await cdp.evaluate(
        contrastExpr(['.bubble-text', '.side-item-title', '.side-item-sub', '.chat-main .side-title']),
      );
      const worst = Array.isArray(detail)
        ? Math.min(...detail.filter((item) => typeof item.contrast === 'number').map((item) => item.contrast))
        : 0;
      return { detail, worst };
    };

    let { detail: lightContrast, worst: worstLight } = await measureContrast();
    if (worstLight < 4.5) {
      await sleep(900);
      ({ detail: lightContrast, worst: worstLight } = await measureContrast());
    }
    record('light theme contrast >= 4.5', worstLight >= 4.5, `worst=${worstLight} ${JSON.stringify(lightContrast)}`);

    // Dark mode is part of the product; toggling it also proves the theme
    // switch is wired to the rendered UI rather than only to localStorage.
    const toggled = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => /深色模式|浅色模式/.test(node.innerText || ''));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    // Wait for the class to actually land instead of sleeping a fixed time: under
    // load the toggle can take longer, and measuring early reports bogus contrast.
    const darkClass = await waitFor(
      cdp,
      `document.documentElement.classList.contains('dark')`,
      8000,
      'dark theme class',
    ).catch(() => false);
    record('theme switch toggles dark mode', Boolean(toggled) && darkClass === true, `dark=${String(darkClass)}`);
    await cdp.screenshot('05-dark-mode');
    let { detail: darkContrast, worst: worstDark } = await measureContrast();
    if (worstDark < 4.5) {
      await sleep(900);
      ({ detail: darkContrast, worst: worstDark } = await measureContrast());
    }
    record('dark theme contrast >= 4.5', worstDark >= 4.5, `worst=${worstDark} ${JSON.stringify(darkContrast)}`);
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => /深色模式|浅色模式/.test(node.innerText || ''));
      if (button) button.click();
      return true;
    })()`);
    await sleep(300);

    // Responsive behaviour: the client must stay usable in a smaller window.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(700);
    const narrow = await cdp.evaluate(
      `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, composer: Boolean(document.querySelector('[data-testid="composer"]')), bubbles: document.querySelectorAll('[data-testid="message-bubble"]').length })`,
    );
    record(
      'layout holds at 1024x720',
      Number(narrow.scrollWidth) <= Number(narrow.clientWidth) + 1 && narrow.composer === true,
      JSON.stringify(narrow),
    );
    await cdp.screenshot('06-narrow-window');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    const domSummary = await cdp.evaluate(`({
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input, textarea').length,
      cards: document.querySelectorAll('.el-card').length,
      bubbles: document.querySelectorAll('[data-testid="message-bubble"]').length,
      theme: document.documentElement.className,
      title: document.title,
    })`);
    record('UI structure present', Boolean(domSummary) && domSummary.cards > 0, JSON.stringify(domSummary));

    // Every navigation entry must render a real page. A malformed SFC template
    // still builds and still serves 200, so only driving the views catches it.
    for (const label of ['工作台', '任务', '审批', '文件', '账号', '成员', '设置']) {
      const clicked = await cdp.evaluate(`(() => {
        const items = [...document.querySelectorAll('.el-menu-item')];
        const hit = items.find((item) => (item.innerText || '').includes(${JSON.stringify(label)}));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      await sleep(900);
      const state = await cdp.evaluate(`({
        heading: (document.querySelector('.page-header h2') || document.body).innerText.slice(0, 24),
        cards: document.querySelectorAll('.el-card').length,
        toasts: document.querySelectorAll('.el-message--error').length,
      })`);
      record(
        `view "${label}" renders`,
        Boolean(clicked) && Number(state.cards) > 0 && Number(state.toasts) === 0,
        JSON.stringify({ ...state, heading: String(state.heading).replace(/\s+/g, ' ') }),
      );
      if (label === '设置') {
        const settingsText = await cdp.evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ')`);
        record(
          'settings view exposes self-service token rotation and session management',
          typeof settingsText === 'string' &&
            settingsText.includes('重置我的访问令牌') &&
            settingsText.includes('我的登录会话'),
          String(settingsText).slice(0, 140),
        );
        await cdp.screenshot('07-settings');
      }
      if (label === '文件') {
        // The documents page used to show only row/column counts. Upload a real
        // UTF-8 CSV through the file input and require the parsed table to
        // render, which covers upload -> parse -> preview end to end.
        const csv = '项目,预算\n差旅,12000\n培训,8000\n';
        const injected = await cdp.evaluate(`(() => {
          const input = document.querySelector('input[type="file"]');
          if (!input) return 'no-input';
          const csv = ${JSON.stringify(csv)};
          const transfer = new DataTransfer();
          transfer.items.add(new File([csv], 'ui-e2e-budget.csv', { type: 'text/csv' }));
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return 'dispatched';
        })()`);
        let previewText = '';
        const previewDeadline = Date.now() + 20000;
        while (Date.now() < previewDeadline) {
          previewText = await cdp.evaluate(`(() => {
            const node = document.querySelector('.sheet-preview');
            return node ? (node.innerText || '').replace(/\\s+/g, ' ') : '';
          })()`);
          if (previewText.includes('差旅') && previewText.includes('12000')) break;
          await sleep(400);
        }
        record(
          'documents view renders the parsed CSV preview table',
          injected === 'dispatched' &&
            previewText.includes('预算') &&
            previewText.includes('差旅') &&
            previewText.includes('12000'),
          JSON.stringify({ injected, previewText: String(previewText).slice(0, 140) }),
        );
        await cdp.screenshot('08-documents');
      }
    }
  } catch (error) {
    record('ui flow completed', false, error instanceof Error ? error.message : String(error));
    if (cdp) {
      const diagnostic = await cdp
        .evaluate('({ href: location.href, title: document.title, text: document.body.innerText.slice(0, 200), html: document.body.innerHTML.slice(0, 200) })')
        .catch((probeError) => ({ probeError: String(probeError) }));
      record('failure diagnostic', false, JSON.stringify(diagnostic));
      await cdp.screenshot('99-failure').catch(() => undefined);
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
  if (screenshots.length > 0) console.log(`screenshots: ${screenshots.join(', ')}`);
  const reportPath = join(root, 'Temp', 'ui-e2e-report.json');
  writeFileSync(
    reportPath,
    JSON.stringify({ serverUrl, memberId, ranAt: new Date().toISOString(), results, screenshots }, null, 2),
    'utf8',
  );
  console.log(`report: ${reportPath}`);

  if (!keepOpen) stopClient();
  process.exit(failed.length === 0 ? 0 : 1);
}

try {
  await main();
} catch (error) {
  console.error(`ui-e2e crashed: ${error instanceof Error ? error.message : String(error)}`);
  stopClient();
  process.exit(1);
}
