#!/usr/bin/env node
/**
 * Provisions a member for production authentication.
 *
 * Usage:
 *   node scripts/add-member.mjs <id> <displayName> <token> [organizationId] [roles]
 *
 * Only the sha256 hash of the token is written to data/members.json.
 * Restart the server afterwards so the directory is reloaded.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const [, , id, displayName, token, organizationId = 'org_local', roles = 'member'] = process.argv;

if (!id || !displayName || !token) {
  console.error(
    'Usage: node scripts/add-member.mjs <id> <displayName> <token> [organizationId] [roles]',
  );
  process.exit(1);
}

const dataDir = resolve(process.env.CHATAGENT_DATA_DIR ?? './data');
const filePath = join(dataDir, 'members.json');
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

await mkdir(dirname(filePath), { recursive: true });

let members = [];
try {
  members = JSON.parse(await readFile(filePath, 'utf8'));
  if (!Array.isArray(members)) members = [];
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const now = new Date().toISOString();
const roleList = roles.split(',').map((role) => role.trim()).filter(Boolean);
const existing = members.find((member) => member.id === id);

if (existing) {
  existing.organizationId = organizationId;
  existing.displayName = displayName;
  existing.roles = roleList;
  existing.tokenHash = tokenHash;
  existing.updatedAt = now;
} else {
  members.push({
    id,
    organizationId,
    displayName,
    roles: roleList,
    agentIds: [],
    tokenHash,
    createdAt: now,
    updatedAt: now,
  });
}

await writeFile(filePath, JSON.stringify(members, null, 2), 'utf8');
console.log(`member ${id} written to ${filePath} (token stored as sha256 only)`);
console.log('restart the ChatAgent server to reload the member directory');
