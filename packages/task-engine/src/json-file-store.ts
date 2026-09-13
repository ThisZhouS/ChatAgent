import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskRecord } from '@chatagent/contracts';
import { DEFAULT_ORGANIZATION_ID, LEGACY_OWNER_ID } from '@chatagent/contracts';
import type { TaskStore } from './types';

export interface JsonFileTaskStoreOptions {
  /** Applied to legacy records that predate the ownership fields. */
  legacyOrganizationId?: string;
  legacyRequesterId?: string;
}

export class JsonFileTaskStore implements TaskStore {
  private readonly cache = new Map<string, TaskRecord>();
  private readonly legacyOrganizationId: string;
  private readonly legacyRequesterId: string;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    options: JsonFileTaskStoreOptions = {},
  ) {
    this.legacyOrganizationId = options.legacyOrganizationId ?? DEFAULT_ORGANIZATION_ID;
    this.legacyRequesterId = options.legacyRequesterId ?? LEGACY_OWNER_ID;
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    await this.load();
    const task = this.cache.get(id);
    return task ? clone(task) : undefined;
  }

  async list(): Promise<TaskRecord[]> {
    await this.load();
    return [...this.cache.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async save(task: TaskRecord): Promise<void> {
    await this.load();
    this.cache.set(task.id, clone(task));
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as TaskRecord[];
      for (const task of parsed) {
        this.cache.set(task.id, migrateTask(task, this.legacyOrganizationId, this.legacyRequesterId));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const data = JSON.stringify([...this.cache.values()], null, 2);
    await writeFile(this.filePath, data, 'utf8');
  }
}

/**
 * Legacy JSON compatibility: records written before Gate 1/2 have no
 * organization/requester. They are attributed to the configured legacy owner
 * so authorization stays fail-closed for everyone else.
 */
function migrateTask(
  task: TaskRecord,
  legacyOrganizationId: string,
  legacyRequesterId: string,
): TaskRecord {
  return {
    ...task,
    organizationId: task.organizationId ?? legacyOrganizationId,
    requesterId: task.requesterId ?? legacyRequesterId,
    artifacts: (task.artifacts ?? []).map((artifact) => ({
      ...artifact,
      organizationId: artifact.organizationId ?? task.organizationId ?? legacyOrganizationId,
      ownerId: artifact.ownerId ?? task.requesterId ?? legacyRequesterId,
      taskId: artifact.taskId ?? task.id,
    })),
  };
}

function clone(task: TaskRecord): TaskRecord {
  return { ...task, artifacts: [...task.artifacts], input: task.input ? { ...task.input } : undefined };
}
