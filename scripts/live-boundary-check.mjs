#!/usr/bin/env node
/** Live boundary check against a running ChatAgent server.
 * Read-only, or a refusal that must store nothing.
 * Usage: node scripts/live-boundary-check.mjs [--server URL]
 * Exit: 0 = as documented, 1 = a boundary differed, 2 = server unreachable. All three paths have been exercised: 0 against a live server (7/7), 1 against a wrong
 * base path such as --server http://127.0.0.1:8787/api (7 FAIL lines), 2 against a dead port.
 * The event-stream probe is deliberately absent (it left a socket open and made the exit code
 * untrustworthy: round 44 in docs/iteration-2026-09-16-gate7a1-hardening.md). */
async function main() {
const at = process.argv.indexOf('--server');
const server = ((at === -1 ? process.env.CHATAGENT_SERVER_URL : process.argv[at + 1]) || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : '')); }
async function req(path, init) {
  const response = await fetch(server + path, init);
  let body = null;
  try { body = await response.json(); } catch (e) { body = null; }
  return { status: response.status, body: body };
}
let health;
try { health = await req('/health'); } catch (e) {
  console.log('[live-boundaries] ' + server + ' unreachable (' + e.message + ') -- nothing verified');
  return 2; // process.exitCode alone does not stop execution: the checks below would run
  // against an undefined health and crash with exit 1 instead of the documented 2.
}
const authMode = (health.body && health.body.authMode) || 'unknown';
check('health answers ok', health.status === 200 && Boolean(health.body && health.body.ok), 'status=' + health.status + ' authMode=' + authMode);
const anon = await req('/api/agent/status');
check(authMode === 'production' ? 'production refuses a credential-less request' : 'development serves a credential-less loopback request',
  authMode === 'production' ? anon.status === 401 : anon.status === 200, 'status=' + anon.status);
const bogus = await req('/api/agent/status', { headers: { authorization: 'Bearer 0123456789abcdef0123456789abcdef' } });
check('an unrecognised credential is refused', bogus.status === 401, 'status=' + bogus.status);
const intake = anon.body && anon.body.intake;
check('intake status carries the retry budget',
  Boolean(intake) && typeof intake.maxAttempts === 'number' && typeof intake.failed === 'number' && typeof intake.stalled === 'number',
  intake ? JSON.stringify(intake) : 'no intake block');
const approvals = await req('/api/approvals');
const approvalList = Array.isArray(approvals.body) ? approvals.body : ((approvals.body && approvals.body.approvals) || []);
check('approvals expose a digest and their status',
  approvals.status === 200 && approvalList.every(function (a) { return typeof a.digest === 'string' && 'status' in a; }),
  approvalList.length + ' approval(s)');
const conversations = await req('/api/conversations');
const list = Array.isArray(conversations.body) ? conversations.body : ((conversations.body && conversations.body.conversations) || []);
const foreign = list.find(function (c) { return (c.participantIds || []).indexOf('dev-owner') === -1; });
if (foreign && foreign.id) {
  const sent = await req('/api/conversations/' + foreign.id + '/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'boundary self-check (must not be stored)', clientMsgId: 'live-check-' + Date.now() }),
  });
  check('a send by a non-participant is refused', sent.status === 403 && Boolean(sent.body && sent.body.detail === 'not_a_participant'),
    'status=' + sent.status + ' detail=' + ((sent.body && sent.body.detail) || ''));
} else { check('a send by a non-participant is refused', false, 'no conversation without the caller to probe'); }
const form = new FormData();
form.append('file', new Blob(['plain text pretending to be a Word file']), 'probe.docx');
const upload = await req('/api/documents/parse', { method: 'POST', body: form });
check('bytes that do not match the extension are refused',
  upload.status === 415 && Boolean(upload.body && upload.body.detail), 'status=' + upload.status + ' detail=' + ((upload.body && upload.body.detail) || ''));
const failed = results.filter(function (ok) { return !ok; }).length;
console.log('');
console.log('[live-boundaries] ' + (results.length - failed) + '/' + results.length + ' boundaries behaved as documented');
if (failed > 0) { console.log('a FAIL means this instance disagrees with the docs -- investigate before trusting either'); }
else { console.log('runtime behaviour only: this is not Gate 7A.3 (real Hermes runtime + model credentials)'); }
// exitCode, not exit(): calling process.exit() while undici keep-alive handles are
// closing trips the libuv UV_HANDLE_CLOSING assertion on this platform (Node 24.11 / Windows).
// Observed twice: exit 127 after every check had already passed.
return failed > 0 ? 1 : 0;
}

// exitCode, not exit(): calling process.exit() while undici keep-alive handles close trips the
// libuv UV_HANDLE_CLOSING assertion on this platform (round 45).
process.exitCode = await main();
