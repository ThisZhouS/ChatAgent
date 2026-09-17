#!/usr/bin/env node
/**
 * Provisions (or reuses) the local member used by scripts/ui-e2e.mjs.
 *
 * Why this exists: the client E2E needs to log in, and a committed default token
 * (it used to be 'alice-dev-token') is a live credential in the repository. Instead
 * this script mints a dedicated member — 'e2e_local', never one of the real dev
 * accounts — and keeps its token in Temp/e2e-member.json, which is gitignored.
 *
 * Usage:
 *   node scripts/ensure-e2e-member.mjs [--server http://localhost:8787]
 *
 * Prints the member id (never the token) and exits 0 when the credentials are
 * usable, 2 when the server is not reachable, 3 when this caller may not mint a
 * member (production auth mode without owner credentials).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const serverUrl = String(
  argValue('--server', process.env.CHATAGENT_SERVER_URL ?? 'http://localhost:8787'),
).replace(/\/+$/, '');
const memberId = argValue('--member', process.env.SMOKE_MEMBER ?? 'e2e_local');
const credentialsPath = join(root, 'Temp', 'e2e-member.json');

function readLocal() {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    if (parsed && typeof parsed.memberId === 'string' && typeof parsed.token === 'string') return parsed;
  } catch {
    // no local credentials yet
  }
  return undefined;
}

async function login(id, token) {
  try {
    const response = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: id, token }),
    });
    return response.ok;
  } catch {
    return undefined; // server unreachable
  }
}

async function mint() {
  const token = randomBytes(24).toString('hex');
  const response = await fetch(`${serverUrl}/api/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: memberId, displayName: 'E2E Client', roles: ['member'], token }),
  });
  if (response.status === 401 || response.status === 403) return { denied: response.status };
  if (!response.ok) return { error: `http_${response.status}` };
  const body = await response.json().catch(() => ({}));
  return { token: typeof body.token === 'string' ? body.token : token };
}

const local = readLocal();
if (local && local.memberId === memberId) {
  const usable = await login(local.memberId, local.token);
  if (usable === undefined) {
    console.error(`server not reachable at ${serverUrl} (start it first: node scripts/restart-server.mjs)`);
    process.exit(2);
  }
  if (usable) {
    console.log(`reusing local E2E member ${local.memberId} (token in Temp/e2e-member.json)`);
    process.exit(0);
  }
  console.log(`stored E2E credentials for ${local.memberId} no longer work; minting a fresh token`);
}

const minted = await mint();
if (minted.denied) {
  console.error(
    `this server refuses member creation for the caller (http ${minted.denied}).`,
    'In production auth mode pass owner credentials instead:',
    '  SMOKE_MEMBER=<owner> SMOKE_TOKEN=<token> node scripts/ui-e2e.mjs',
  );
  process.exit(3);
}
if (minted.error) {
  console.error(`could not mint an E2E member: ${minted.error} (is the server running at ${serverUrl}?)`);
  process.exit(2);
}
mkdirSync(dirname(credentialsPath), { recursive: true });
writeFileSync(
  credentialsPath,
  `${JSON.stringify({ memberId, token: minted.token, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
console.log(`provisioned local E2E member ${memberId}; token stored in Temp/e2e-member.json (gitignored)`);
