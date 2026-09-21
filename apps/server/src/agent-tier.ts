/**
 * Contact tiers: what an AI account may do with a message from a given person.
 *
 * The product rule (see Prompt/2026-09-17-product-decomposition.md) is that the owner
 * of an assistant decides, per contact, how much the assistant may do with that
 * person's messages:
 *
 *   owner   - the account owner (and org admins): full behaviour, subject to the
 *             existing approval gate for side effects. Not configurable - it is derived
 *             from the stored ownership, so nobody can grant themselves this tier.
 *   confirm - the default for everyone else: the assistant may plan and reply, but every
 *             side effect still needs an approval from the human.
 *   chat    - conversation only: the assistant may read documents and answer, but the
 *             tools that send, forward or produce files are not offered to it at all.
 *   ignore  - the message never reaches an assistant: no handoff, no task, audit only.
 *
 * Everything here is enforced in code. The tier is also stated in the prompt (as the
 * secondary defense), because a model that knows its boundary wastes fewer steps.
 */
import type { AgentAccount, AgentContactTier } from '@chatagent/contracts';

/** Tiers a human may set. `owner` is derived and cannot be assigned. */
export const ASSIGNABLE_CONTACT_TIERS: readonly AgentContactTier[] = ['confirm', 'chat', 'ignore'];

/** Tiers the resolver can return, including the derived owner tier. */
export type EffectiveContactTier = 'owner' | AgentContactTier;

export interface TierPolicy {
  /** False means the message is not handed to an assistant at all. */
  intake: boolean;
  /**
   * Tool names this tier may use. `undefined` means every registered tool (still
   * subject to the approval gate); a list is a hard allowlist - tools outside it are
   * neither advertised to the model nor executable.
   */
  allowedTools?: string[];
  /** True when every side effect must be confirmed by a human before it happens. */
  requiresApproval: boolean;
}

/**
 * Read-only tools a `chat`-tier contact may still use. Kept as an explicit list rather
 * than "everything without a side effect": a new tool is refused by default, which is
 * the safe direction for a capability decision.
 */
export const CHAT_TIER_TOOLS: readonly string[] = ['parse_document'];

const POLICIES: Record<EffectiveContactTier, TierPolicy> = {
  owner: { intake: true, requiresApproval: true },
  confirm: { intake: true, requiresApproval: true },
  chat: { intake: true, allowedTools: [...CHAT_TIER_TOOLS], requiresApproval: true },
  ignore: { intake: false, allowedTools: [], requiresApproval: true },
};

export function tierPolicy(tier: EffectiveContactTier): TierPolicy {
  return POLICIES[tier] ?? POLICIES.ignore;
}

/**
 * Resolves the tier for one sender. Explicit per-contact entries win; the account
 * default applies otherwise; unknown input falls back to `confirm` (the cautious
 * setting) rather than to a permissive one. Ownership is checked before the map, so a
 * contact cannot be given a lower tier than the owner actually has.
 */
export function resolveContactTier(
  account: Pick<AgentAccount, 'ownerId' | 'contactTiers' | 'defaultTier'>,
  senderId: string | undefined,
  options: { isOrgAdmin?: boolean } = {},
): EffectiveContactTier {
  if (options.isOrgAdmin) return 'owner';
  if (senderId && senderId === account.ownerId) return 'owner';
  if (senderId) {
    const explicit = account.contactTiers?.[senderId];
    if (explicit && ASSIGNABLE_CONTACT_TIERS.includes(explicit)) return explicit;
  }
  const fallback = account.defaultTier;
  return fallback && ASSIGNABLE_CONTACT_TIERS.includes(fallback) ? fallback : 'confirm';
}

/** One line the model is told about the tier it is running under. */
export function tierPromptRule(tier: EffectiveContactTier, senderName: string): string {
  switch (tier) {
    case 'owner':
      return `This request comes from the account owner (${senderName}); full behaviour is available, and outbound actions still need their recorded approval.`;
    case 'chat':
      return `This request comes from ${senderName}, who is at the CHAT tier: reply in conversation and read documents only. Tools that send, forward or write files are switched off for this run and cannot be used, emulated or worked around.`;
    case 'ignore':
      return `This request comes from ${senderName}, who is at the IGNORE tier: nothing should have reached you; stop and report that no action is allowed.`;
    default:
      return `This request comes from ${senderName}, who is at the CONFIRM tier: plan and reply, but every side effect needs the owner's approval before it happens.`;
  }
}

/** Tools this tier may use, intersected with what the runtime actually registered. */
export function allowedToolsForTier(
  tier: EffectiveContactTier,
  registered: string[],
): string[] | undefined {
  const policy = tierPolicy(tier);
  if (policy.allowedTools === undefined) return undefined;
  return registered.filter((name) => policy.allowedTools!.includes(name));
}
