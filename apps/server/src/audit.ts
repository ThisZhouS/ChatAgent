import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type AuditOutcome = 'ok' | 'denied' | 'failed';

export interface AuditEvent {
  action: string;
  outcome: AuditOutcome;
  actorId?: string;
  organizationId?: string;
  target?: string;
  detail?: string;
  ip?: string;
}

const MAX_DETAIL = 200;

/**
 * Append-only audit trail (JSONL). Secrets are never written: callers pass
 * identifiers and short reasons only, and every field is truncated.
 */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(private readonly filePath: string) {}

  record(event: AuditEvent): void {
    // Auditing must never break a request path.
    this.queue = this.queue
      .then(() => this.append(event))
      .catch(() => undefined);
  }

  /** Awaits queued writes; used by tests and graceful shutdown. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async append(event: AuditEvent): Promise<void> {
    if (!this.ready) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.ready = true;
    }
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action: truncate(event.action, 64),
      outcome: event.outcome,
      actorId: event.actorId ? truncate(event.actorId, 64) : undefined,
      organizationId: event.organizationId ? truncate(event.organizationId, 64) : undefined,
      target: event.target ? truncate(event.target, 128) : undefined,
      detail: event.detail ? truncate(event.detail, MAX_DETAIL) : undefined,
      ip: event.ip ? truncate(event.ip, 64) : undefined,
    });
    await appendFile(this.filePath, `${line}\n`, 'utf8');
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
