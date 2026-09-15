import { z } from 'zod';
import type { LocalAgentHost } from './host';

/**
 * Narrow command surface between the trusted UI and the local host.
 *
 * Deliberately not a shell: there is no command that starts an arbitrary
 * process, reads an arbitrary path or forwards arbitrary arguments. Every field
 * is validated, the caller must present the per-launch token, and the host
 * applies its own authorization on top.
 */
export const hostCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('list') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('cancel'), taskId: z.string().min(1).max(128) }),
  z.object({
    type: z.literal('submit'),
    taskId: z.string().min(1).max(128),
    goal: z.string().min(1).max(4000),
    kind: z.enum(['document', 'side_effect']),
    toolsets: z.array(z.string().min(1).max(64)).max(10).default(['document']),
    delegation: z
      .object({
        ownerId: z.string().min(1).max(128),
        agentId: z.string().min(1).max(128),
        deviceId: z.string().min(1).max(128),
        expiresAt: z.string().min(1),
        capabilities: z.array(z.string().min(1).max(64)).max(20).default([]),
      })
      .optional(),
    approval: z
      .object({
        id: z.string().min(1).max(128),
        approved: z.boolean(),
        expiresAt: z.string().min(1),
        actionDigest: z.string().min(1).max(128),
      })
      .optional(),
  }),
]);

export type HostCommand = z.input<typeof hostCommandSchema>;

export interface HostCommandContext {
  /** Token minted for this application launch; never written to disk. */
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
  switch (command.type) {
    case 'status':
      return { ok: true, result: await host.status() };
    case 'list':
      return { ok: true, result: await host.list() };
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
        delegation: command.delegation,
        approval: command.approval,
      });
      return { ok: true, result: record };
    }
    default:
      return { ok: false, error: 'unsupported_command' };
  }
}
