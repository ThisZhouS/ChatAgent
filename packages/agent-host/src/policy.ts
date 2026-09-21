/**
 * Capability policy for the local agent host: which toolsets may ever run, and what the
 * model is told about the ones that are switched off.
 *
 * There is exactly one list. It used to live twice - once in `host.ts` (checked at submit
 * time) and once in `adapter.ts` (checked before spawning the executor) - and the two had
 * drifted: `browser`, `computer_use`, `cronjob`, `delegation`, `homeassistant` and
 * `spotify` were refused by the adapter but accepted by the host, so a side-effect task
 * with those toolsets failed late, as an executor error, instead of being refused at the
 * door with an explanation.
 *
 * Defence in depth stays: the host refuses at submit time, the adapter refuses again before
 * spawning, and the prompt states the boundary so the model does not burn its steps
 * fighting a wall. "Switched off" means off - emulating, hand-writing or routing around a
 * denial is a failure, not a workaround.
 */
import type { BlockReason, LocalTaskRecord } from './types';

/**
 * Capabilities that may never be granted to a local task, whatever the caller asks for.
 * `*` is included so a wildcard request cannot be used to sweep everything in.
 */
export const FORBIDDEN_TOOLSETS: ReadonlySet<string> = new Set([
  '*',
  'browser',
  'code_execution',
  'computer_use',
  'cronjob',
  'custom',
  'delegation',
  'homeassistant',
  'node',
  'python',
  'shell',
  'spotify',
  'terminal',
]);

/** The capability floor for a document task: read/write inside the task directory. */
export const DOCUMENT_TOOLSETS: ReadonlySet<string> = new Set(['document', 'document.read', 'file']);

/**
 * The toolset names that make a request refused, in the order they were given. Reported so
 * the refusal can name the offending entry instead of a generic "not granted".
 */
export function refusedToolsets(
  kind: LocalTaskRecord['kind'],
  toolsets: unknown,
): string[] {
  if (!Array.isArray(toolsets)) return ['(toolsets is not a list)'];
  const forbidden = toolsets.filter(
    (toolset) => typeof toolset === 'string' && FORBIDDEN_TOOLSETS.has(toolset),
  );
  if (forbidden.length > 0) return forbidden;
  if (kind !== 'document') return [];
  // Fail closed: an empty list is not "the default capability" (a planted empty-toolset row
  // used to run), and a blank entry is not a document toolset either.
  if (toolsets.length === 0) return ['(no toolset requested)'];
  const unknown = toolsets.filter(
    (toolset) => typeof toolset !== 'string' || toolset.trim() === '' || !DOCUMENT_TOOLSETS.has(toolset),
  );
  return unknown;
}

/**
 * Returns the block reason when the requested capabilities may not run for this kind, or
 * undefined when they may. Fail closed: an unknown toolset is not a document toolset.
 */
export function refuseCapabilities(
  kind: LocalTaskRecord['kind'],
  toolsets: string[],
): BlockReason | undefined {
  if (!Array.isArray(toolsets)) return 'capability_not_granted';
  return refusedToolsets(kind, toolsets).length > 0 ? 'capability_not_granted' : undefined;
}

export function isForbiddenToolset(name: string): boolean {
  return FORBIDDEN_TOOLSETS.has(name);
}

/**
 * The boundary text injected into a run, so the model knows what it does not have. It is
 * generated from the same list the checks use, which is what keeps the promise honest: a
 * tool cannot be refused by code while the prompt still advertises it.
 */
export function capabilityBrief(granted: string[] = []): string {
  const switchedOff = [...FORBIDDEN_TOOLSETS].filter((name) => name !== '*').sort();
  const available = granted.length > 0 ? granted.join(', ') : 'none';
  return [
    'Run boundaries (enforced by the host in code, not by this text):',
    `- Available toolsets for this run: ${available}.`,
    `- Switched off and not negotiable: ${switchedOff.join(', ')}.`,
    '- A switched-off capability does not exist for you: never emulate it, never write its output by hand, and never look for an equivalent route.',
    '- If a task needs a capability you do not have, stop and report which capability is missing.',
  ].join('\n');
}
