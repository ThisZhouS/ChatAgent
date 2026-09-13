import type { Memory, ModelMessage } from './types';

export class ConversationMemory implements Memory {
  private messages: ModelMessage[] = [];

  constructor(initial?: ModelMessage[]) {
    if (initial) this.messages = [...initial];
  }

  append(message: ModelMessage): void {
    this.messages.push(message);
  }

  list(): ModelMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }
}
