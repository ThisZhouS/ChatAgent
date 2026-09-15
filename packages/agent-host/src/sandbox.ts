import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Filesystem guards for on-device agent work.
 *
 * Setting a working directory only picks a default location; it is not a
 * sandbox. These helpers make the boundary explicit and testable: the host
 * refuses any path that leaves the authorized work root, follows symlinks when
 * checking, and never overwrites a file whose content changed since it was read.
 */

export class WorkdirRefusedError extends Error {
  constructor(
    message: string,
    readonly candidate: string,
    readonly root: string,
  ) {
    super(message);
    this.name = 'WorkdirRefusedError';
  }
}

export class OverwriteRefusedError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
  ) {
    super(message);
    this.name = 'OverwriteRefusedError';
  }
}

/** True when `candidate` is inside `root` (after resolving both). */
export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  const withSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate.startsWith(withSep);
}

/**
 * Resolves a caller-supplied directory and refuses it unless it lives inside the
 * authorized work root. Symlinks are resolved first so a link cannot point out.
 */
export async function assertInsideWorkRoot(root: string, candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new WorkdirRefusedError('the working directory must be an absolute path', candidate, root);
  }
  const resolvedRoot = await safeRealpath(root);
  const resolved = await safeRealpath(candidate);
  if (!isInside(resolvedRoot, resolved)) {
    throw new WorkdirRefusedError('the working directory escapes the authorized work root', candidate, root);
  }
  return resolved;
}

/** realpath that falls back to the resolved path when the entry does not exist yet. */
async function safeRealpath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return resolve(target);
  }
}

/** Creates (or reuses) a task directory under the work root. */
export async function ensureTaskWorkDir(root: string, taskId: string): Promise<string> {
  const safeId = taskId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  if (safeId === '') throw new WorkdirRefusedError('task id is not usable as a directory', taskId, root);
  await mkdir(root, { recursive: true });
  const dir = join(root, safeId);
  await mkdir(dir, { recursive: true });
  return assertInsideWorkRoot(root, dir);
}

export function sha256Of(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function fileSha256(filePath: string): Promise<string | undefined> {
  try {
    return sha256Of(await readFile(filePath));
  } catch {
    return undefined;
  }
}

/**
 * Writes a file only when the on-disk content still matches the expected digest
 * (or the file does not exist). An employee editing the file in the meantime
 * must not be silently overwritten; the caller then produces a new version.
 */
export async function writeFileIfUnchanged(
  filePath: string,
  content: Buffer | string,
  expectedSha256?: string,
): Promise<{ written: boolean; sha256: string; versioned?: string }> {
  await mkdir(dirname(filePath), { recursive: true });
  const current = await fileSha256(filePath);
  const digest = sha256Of(content);
  if (current !== undefined && expectedSha256 !== undefined && current !== expectedSha256) {
    const versioned = withVersionSuffix(filePath);
    await writeFile(versioned, content);
    return { written: true, sha256: digest, versioned };
  }
  if (current !== undefined && expectedSha256 === undefined) {
    const versioned = withVersionSuffix(filePath);
    await writeFile(versioned, content);
    return { written: true, sha256: digest, versioned };
  }
  await writeFile(filePath, content);
  return { written: true, sha256: digest };
}

function withVersionSuffix(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filePath}.${stamp}.new`;
}

/** Collects the files inside a task directory as relative, hashed artifacts. */
export async function collectArtifacts(
  workDir: string,
  limit = 50,
): Promise<Array<{ relativePath: string; name: string; bytes: number; sha256: string }>> {
  const out: Array<{ relativePath: string; name: string; bytes: number; sha256: string }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        const buffer = await readFile(full);
        out.push({
          relativePath: relative(workDir, full).split(sep).join('/'),
          name: entry.name,
          bytes: info.size,
          sha256: sha256Of(buffer),
        });
      } catch {
        // A file that disappeared mid-scan is simply not an artifact.
      }
    }
  };
  await walk(workDir, 0);
  return out;
}
