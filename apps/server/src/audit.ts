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

  constructor(
    private readonly filePath: string,
    /**
     * Organization stamped on lines whose event does not name one.
     *
     * The trail is a single file per instance while `organizationId` is a hard boundary
     * everywhere else, so an unstamped line cannot be attributed at read time and would
     * either leak to every admin or be visible to none. Stamping the deployment's
     * organization keeps the read filter meaningful. It is only a fallback: a reader
     * resolves the organization from the ACTOR's membership record first, which is
     * authoritative even for a line that was stamped here.
     */
    private readonly defaultOrganizationId?: string,
  ) {}

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
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action: truncate(event.action, 64),
      outcome: event.outcome,
      actorId: event.actorId ? truncate(event.actorId, 64) : undefined,
      organizationId: event.organizationId
        ? truncate(event.organizationId, 64)
        : this.defaultOrganizationId,
      target: event.target ? truncate(event.target, 128) : undefined,
      detail: event.detail ? truncate(event.detail, MAX_DETAIL) : undefined,
      ip: event.ip ? truncate(event.ip, 64) : undefined,
    });
    // The earlier version cached a "the data directory exists" flag after its
    // first write. When the *first* append raced the directory creation (mkdir and
    // appendFile are separate awaits), that flag was set even though no line ever
    // landed, and every later audit line failed silently — an audit trail that
    // starts empty for the whole process lifetime. Ensuring the directory on every
    // append costs one mkdir (a no-op once it exists) and makes the first record,
    // and any record after the file was cleaned up, land for real.
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${line}\n`, 'utf8');
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
