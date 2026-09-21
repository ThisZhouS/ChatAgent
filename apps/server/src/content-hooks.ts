/**
 * Content hooks: summoning an assistant because of what a message says, not because somebody
 * typed "@".
 *
 * The product asks for keyword/regex hooks per conversation. A regular expression that runs on
 * every inbound message is also a denial-of-service surface (catastrophic backtracking), so the
 * rules are bounded on both ends:
 *
 *  - at set time: length cap, must compile, and the classic nested-quantifier shapes are
 *    refused outright (a full RE2 engine is not available here, so the dangerous shapes are
 *    rejected instead of being run hopefully);
 *  - at match time: a compiled cache, a bounded number of rules, and a wall-clock budget after
 *    which the remaining rules are skipped for that message. Skipping is the safe direction -
 *    a hook that does not fire leaves the room exactly as it was.
 */

/** Patterns longer than this are refused at set time. */
export const MAX_HOOK_PATTERN_LENGTH = 200;
/** Rules per conversation. */
export const MAX_HOOKS_PER_CONVERSATION = 20;
/** Only messages up to this length are scanned. */
export const MAX_HOOK_INPUT_LENGTH = 4000;
/** Wall-clock budget for one message; the remaining rules are skipped when it is spent. */
export const HOOK_BUDGET_MS = 25;

export interface HookValidation {
  ok: boolean;
  reason?: 'too_long' | 'invalid_regex' | 'unsafe_pattern';
}

/**
 * Rejects the shapes that make a regex explode on crafted input: a quantified group whose body
 * is itself quantified, e.g. `(a+)+` or `(a|aa)+`. It is a heuristic, which is why the match
 * phase also has a time budget.
 */
export function looksUnsafe(pattern: string): boolean {
  const nestedQuantifier = /\([^)]*[+*][^)]*\)\s*[+*{]/;
  const repeatedAlternation = /\([^)]*\|[^)]*\)\s*[+*]/;
  const hugeRepetition = /\{\s*\d{4,}/;
  return nestedQuantifier.test(pattern) || repeatedAlternation.test(pattern) || hugeRepetition.test(pattern);
}

export function validateHookPattern(pattern: string): HookValidation {
  const trimmed = pattern.trim();
  if (trimmed === '') return { ok: false, reason: 'invalid_regex' };
  if (trimmed.length > MAX_HOOK_PATTERN_LENGTH) return { ok: false, reason: 'too_long' };
  if (looksUnsafe(trimmed)) return { ok: false, reason: 'unsafe_pattern' };
  try {
    new RegExp(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_regex' };
  }
  return { ok: true };
}

/** Validates a whole list, returning the first problem so the caller can name it. */
export function validateHookList(
  patterns: string[],
): { ok: true; hooks: string[] } | { ok: false; reason: string; pattern?: string } {
  if (patterns.length > MAX_HOOKS_PER_CONVERSATION) {
    return { ok: false, reason: `too_many_hooks:${MAX_HOOKS_PER_CONVERSATION}` };
  }
  const hooks: string[] = [];
  for (const pattern of patterns) {
    const verdict = validateHookPattern(pattern);
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason ?? 'invalid_regex', pattern };
    }
    const trimmed = pattern.trim();
    if (!hooks.includes(trimmed)) hooks.push(trimmed);
  }
  return { ok: true, hooks };
}

/**
 * Compiled patterns are cached because the same rules run on every message. The cache is keyed
 * by the pattern text and bounded: a conversation can change its hooks, and a cache that grows
 * without limit would be its own leak.
 */
const compiledCache = new Map<string, RegExp>();
const COMPILED_CACHE_MAX = 500;

function compile(pattern: string): RegExp | undefined {
  const cached = compiledCache.get(pattern);
  if (cached) return cached;
  try {
    const compiled = new RegExp(pattern);
    if (compiledCache.size >= COMPILED_CACHE_MAX) compiledCache.clear();
    compiledCache.set(pattern, compiled);
    return compiled;
  } catch {
    return undefined;
  }
}

export interface HookMatchResult {
  /** The patterns that matched, in the order they were configured. */
  matched: string[];
  /** True when the time budget ran out before every rule was tried. */
  budgetExhausted: boolean;
  /** Rules that could not be compiled (stored before validation existed, or hand-edited). */
  invalid: string[];
}

/**
 * Evaluates the hooks against one message. Never throws: a bad pattern is reported, not
 * propagated, because a broken rule must not break message delivery.
 */
export function matchContentHooks(
  text: string,
  hooks: readonly string[],
  options: { now?: () => number; budgetMs?: number } = {},
): HookMatchResult {
  const result: HookMatchResult = { matched: [], budgetExhausted: false, invalid: [] };
  if (hooks.length === 0) return result;
  if (text.trim() === '' || text.length > MAX_HOOK_INPUT_LENGTH) return result;

  const now = options.now ?? (() => Date.now());
  const started = now();
  const budget = options.budgetMs ?? HOOK_BUDGET_MS;
  for (const pattern of hooks.slice(0, MAX_HOOKS_PER_CONVERSATION)) {
    if (now() - started > budget) {
      result.budgetExhausted = true;
      break;
    }
    const compiled = compile(pattern);
    if (!compiled) {
      result.invalid.push(pattern);
      continue;
    }
    try {
      if (compiled.test(text)) result.matched.push(pattern);
    } catch {
      result.invalid.push(pattern);
    }
  }
  return result;
}

/** Test helper: forgetting the cache between cases keeps them independent. */
export function resetHookCache(): void {
  compiledCache.clear();
}
