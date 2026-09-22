/**
 * Granted work roots (product decision 9C, 2026-09-21).
 *
 * The owner chose C: an administrator may pre-authorize extra directories. The default
 * stays deny - this pins that the grant widens exactly one door and nothing else.
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertInsideWorkRoot } from './sandbox';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-grant-'));
  dirs.push(dir);
  return dir;
}

describe('granted work roots', () => {
  it('allows the granted directory and still refuses everything else', async () => {
    const base = await scratch();
    const work = join(base, 'work');
    const granted = join(base, 'shared');
    const privateDir = join(base, 'private');
    await mkdir(work, { recursive: true });
    await mkdir(granted, { recursive: true });
    await mkdir(privateDir, { recursive: true });

    // Without a grant the same path is refused, so the test proves the grant did it.
    await expect(assertInsideWorkRoot(work, granted)).rejects.toThrow();
    await expect(assertInsideWorkRoot(work, granted, [granted])).resolves.toBeTruthy();
    await expect(assertInsideWorkRoot(work, privateDir, [granted])).rejects.toThrow();
    // Escaping the granted root by going up is still refused.
    await expect(assertInsideWorkRoot(work, join(granted, '..', 'private'), [granted])).rejects.toThrow();
  });

  it('does not treat a name prefix as a grant', async () => {
    const base = await scratch();
    const work = join(base, 'work');
    const granted = join(base, 'shared');
    const lookalike = join(base, 'shared-evil');
    await mkdir(work, { recursive: true });
    await mkdir(granted, { recursive: true });
    await mkdir(lookalike, { recursive: true });

    await expect(assertInsideWorkRoot(work, lookalike, [granted])).rejects.toThrow();
  });

  it('ignores a blank grant instead of widening to the process directory', async () => {
    const base = await scratch();
    const work = join(base, 'work');
    const outside = join(base, 'elsewhere');
    await mkdir(work, { recursive: true });
    await mkdir(outside, { recursive: true });

    await expect(assertInsideWorkRoot(work, outside, ['', '   '])).rejects.toThrow();
  });

  it('resolves a granted symlink before trusting it', async () => {
    const base = await scratch();
    const work = join(base, 'work');
    const real = join(base, 'real');
    const link = join(base, 'link');
    await mkdir(work, { recursive: true });
    await mkdir(real, { recursive: true });
    try {
      await symlink(real, link, 'dir');
    } catch {
      return; // creating symlinks can require privileges on Windows: skip, do not fail
    }
    // Granting the link grants the directory it points at - and nothing beside it.
    await expect(assertInsideWorkRoot(work, real, [link])).resolves.toBeTruthy();
    await expect(assertInsideWorkRoot(work, work, [link])).resolves.toBeTruthy();
  });
});
