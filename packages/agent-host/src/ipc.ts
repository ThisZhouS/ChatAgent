import { z } from 'zod';
import type { LocalAgentHost } from './host';

/**
 * Narrow command surface between the trusted UI and the local host.
 *
 * Deliberately not a shell: there is no command that starts an arbitrary
 * process, reads an arbitrary path or forwards arbitrary arguments. Every field
 * is validated and the host applies its own authorization on top.
 *
 * Notably absent: any command that *grants* a delegation or an approval. Those
 * are minted by the Electron main process from verified organization-server
 * responses or an explicit local consent dialog (`host.authorizationRegistry`),
 * never by the page — otherwise "renderer-supplied approval" would be back.
 */
export const hostCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }).strict(),
  z
    .object({
      type: z.literal('list'),
      /** Newest-first cap for the UI; the store itself is bounded by retention. */
      limit: z.number().int().min(1).max(500).default(200),
    })
    .strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('cancel'), taskId: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal('retry'), taskId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      type: z.literal('submit'),
      taskId: z.string().min(1).max(128),
      goal: z.string().min(1).max(4000),
      kind: z.enum(['document', 'side_effect']),
      toolsets: z.array(z.string().min(1).max(64)).max(10).default(['document']),
      /** References to grants the host already holds; never a caller-built object. */
      delegationId: z.string().min(1).max(128).optional(),
      approvalId: z.string().min(1).max(128).optional(),
    })
    // Strict: an unexpected field (`delegation`, `approval`, …) is a rejected
    // command instead of being silently dropped, so a caller that still believes
    // it can declare its own authorization gets an explicit error.
    .strict(),
]);

export type HostCommand = z.input<typeof hostCommandSchema>;

export interface HostCommandContext {
  /**
   * Token minted for this application launch; never written to disk. Kept as a
   * second gate in front of the sender validation done by the main process.
   */
  token: string;
}

export type HostCommandResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; detail?: string };

/** Handles one UI→host command. Returns a result object; never throws. */
export async function handleHostCommand(
  host: LocalAgentHost,
  rawCommand: HostCommand,
  context: HostCommandContext,
  presentedToken: string | undefined,
): Promise<HostCommandResult> {
  if (context.token === '' || presentedToken !== context.token) {
    return { ok: false, error: 'unauthorized', detail: 'device token missing or invalid' };
  }
  const parsed = hostCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_command', detail: parsed.error.issues[0]?.message ?? 'schema' };
  }
  const command = parsed.data;
  try {
    switch (command.type) {
      case 'status':
        return { ok: true, result: await host.status() };
      case 'list': {
        // H-06: one documented shape for both sides. The workbench reads
        // `result.tasks`; returning a bare array here is what made every local
        // task invisible in the UI.
        const all = await host.list();
        // Newest first, capped: an install that has run for months must not make
        // the settings page render hundreds of finished rows on every open. The
        // total is reported so the UI can say what is not shown.
        const newestFirst = [...all].sort(
          (a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? ''),
        );
        return {
          ok: true,
          result: { tasks: newestFirst.slice(0, command.limit), total: all.length },
        };
      }
      case 'pause':
        host.pause();
        return { ok: true, result: { paused: true } };
      case 'resume':
        host.resume();
        return { ok: true, result: { paused: false } };
      case 'stop':
        await host.stop('stopped_from_ui');
        return { ok: true, result: { running: false } };
      case 'cancel':
        return { ok: true, result: { cancelled: await host.cancel(command.taskId) } };
      case 'retry': {
        const record = await host.retry(command.taskId);
        return record
          ? { ok: true, result: record }
          : { ok: false, error: 'retry_refused', detail: 'task is not retryable' };
      }
      case 'submit': {
        const record = await host.submit({
          taskId: command.taskId,
          agentId: host.agentId,
          goal: command.goal,
          kind: command.kind,
          // The work directory is assigned by the host inside its own root; the UI
          // cannot point the executor at an arbitrary path.
          workDir: host.workRoot,
          toolsets: command.toolsets,
          delegationId: command.delegationId,
          approvalId: command.approvalId,
        });
        return { ok: true, result: record };
      }
      default:
        return { ok: false, error: 'unsupported_command' };
    }
  } catch (error) {
    // A store write failure (H-03), an idempotency conflict or any other host
    // error is reported as a failure; the UI must not show an optimistic success.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: detail.startsWith('idempotency_conflict') ? 'idempotency_conflict' : 'host_error',
      detail,
    };
  }
}
