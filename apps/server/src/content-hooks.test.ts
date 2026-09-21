/**
 * Content hooks, and the two places where a regex could hurt.
 *
 * A rule runs on every inbound message, so the interesting tests are not "does it match" but
 * "what happens when the pattern is hostile, broken, or too slow".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_BUDGET_MS,
  MAX_HOOK_INPUT_LENGTH,
  MAX_HOOK_PATTERN_LENGTH,
  matchContentHooks,
  looksUnsafe,
  resetHookCache,
  validateHookList,
  validateHookPattern,
} from './content-hooks';

beforeEach(() => resetHookCache());

describe('hook validation', () => {
  it('accepts an ordinary keyword rule', () => {
    expect(validateHookPattern('周报').ok).toBe(true);
    expect(validateHookPattern('^(紧急|加急)[:：]').ok).toBe(true);
    expect(validateHookPattern('预算\\s*\\d+').ok).toBe(true);
  });

  it('refuses a pattern that is empty, too long, or not a regex at all', () => {
    expect(validateHookPattern('   ').reason).toBe('invalid_regex');
    expect(validateHookPattern('('.repeat(3)).reason).toBe('invalid_regex');
    expect(validateHookPattern('a'.repeat(MAX_HOOK_PATTERN_LENGTH + 1)).reason).toBe('too_long');
    // The classic catastrophic-backtracking shapes are refused before they can run.
    expect(validateHookPattern('(a+)+$').reason).toBe('unsafe_pattern');
    expect(validateHookPattern('(a|aa)+$').reason).toBe('unsafe_pattern');
    expect(validateHookPattern('a{10000}').reason).toBe('unsafe_pattern');
    expect(looksUnsafe('(x+)*')).toBe(true);
    expect(looksUnsafe('普通关键词')).toBe(false);
  });

  it('validates a whole list, naming the offending pattern', () => {
    const ok = validateHookList(['周报', '周报', '日报']);
    expect(ok.ok).toBe(true);
    // Duplicates collapse: the same rule twice would only cost time twice.
    expect(ok.ok && ok.hooks).toEqual(['周报', '日报']);

    const bad = validateHookList(['ok', '(a+)+']);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toBe('unsafe_pattern');
    expect(bad.ok === false && bad.pattern).toBe('(a+)+');

    const tooMany = validateHookList(Array.from({ length: 21 }, (_, index) => 'k' + index));
    expect(tooMany.ok === false && tooMany.reason.startsWith('too_many_hooks')).toBe(true);
  });
});

describe('hook matching', () => {
  it('reports which rules matched, in configuration order', () => {
    const result = matchContentHooks('本周周报请今晚发我', ['周报', '日报', '今晚']);
    expect(result.matched).toEqual(['周报', '今晚']);
    expect(result.invalid).toEqual([]);
    expect(result.budgetExhausted).toBe(false);
  });

  it('does nothing without rules, on empty text, or on an oversized message', () => {
    expect(matchContentHooks('周报', []).matched).toEqual([]);
    expect(matchContentHooks('   ', ['周报']).matched).toEqual([]);
    // Scanning a wall of text with every rule is exactly the cost we refuse to pay.
    const huge = 'x'.repeat(MAX_HOOK_INPUT_LENGTH + 1);
    expect(matchContentHooks(huge, ['x']).matched).toEqual([]);
  });

  it('reports a rule that cannot compile instead of throwing', () => {
    const result = matchContentHooks('周报', ['周报', '(']);
    expect(result.matched).toEqual(['周报']);
    expect(result.invalid).toEqual(['(']);
  });

  it('stops spending time once the budget is gone, and says so', () => {
    let clock = 0;
    const result = matchContentHooks(
      '周报',
      Array.from({ length: 20 }, (_, index) => 'k' + index),
      {
        // Every rule "costs" more than the whole budget, so only the first one is tried.
        now: () => (clock += HOOK_BUDGET_MS),
        budgetMs: HOOK_BUDGET_MS,
      },
    );
    expect(result.budgetExhausted).toBe(true);
    expect(result.matched).toEqual([]);
  });
});
