import type { TaskRecord } from '@chatagent/contracts';
import type { TaskStore } from './types';

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  async get(id: string): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(id);
    return task ? { ...task, artifacts: [...task.artifacts] } : undefined;
  }

  async list(): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => ({ ...task, artifacts: [...task.artifacts] }));
  }

  async save(task: TaskRecord): Promise<void> {
    this.tasks.set(task.id, { ...task, artifacts: [...task.artifacts] });
  }
}
