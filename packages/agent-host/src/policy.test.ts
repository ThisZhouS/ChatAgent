/**
 * One capability list, checked at the door and again before the executor runs.
 *
 * The regression this pins: `host.ts` and `adapter.ts` each had their own forbidden list and
 * they had drifted, so a side-effect task asking for `browser` (or `computer_use`, `cronjob`,
 * `delegation`, `homeassistant`, `spotify`) passed the submit-time check and only failed
 * later, as an executor error.
 */
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_TOOLSETS,
  capabilityBrief,
  isForbiddenToolset,
  refuseCapabilities,
  refusedToolsets,
} from './policy';

const DRIFTED = ['browser', 'computer_use', 'cronjob', 'delegation', 'homeassistant', 'spotify'];

describe('capability policy', () => {
  it('refuses every switched-off capability for every kind of task', () => {
    for (const toolset of FORBIDDEN_TOOLSETS) {
      for (const kind of ['document', 'side_effect'] as const) {
        expect(refuseCapabilities(kind, [toolset]), `${kind} + ${toolset}`).toBe(
          'capability_not_granted',
        );
      }
    }
  });

  it('refuses the capabilities the two old lists disagreed about', () => {
    for (const toolset of DRIFTED) {
      // Previously: accepted by the host, refused by the adapter at execution time.
      expect(refuseCapabilities('side_effect', [toolset])).toBe('capability_not_granted');
      expect(refusedToolsets('side_effect', ['messages.send', toolset])).toEqual([toolset]);
    }
  });

  it('keeps the document capability floor closed', () => {
    expect(refuseCapabilities('document', ['document', 'file'])).toBeUndefined();
    expect(refuseCapabilities('document', [])).toBe('capability_not_granted');
    expect(refuseCapabilities('document', [''])).toBe('capability_not_granted');
    expect(refuseCapabilities('document', ['document '])).toBe('capability_not_granted');
    expect(refuseCapabilities('document', ['web'])).toBe('capability_not_granted');
    // A side effect may name product capabilities; it is gated by delegation instead.
    expect(refuseCapabilities('side_effect', ['messages.send'])).toBeUndefined();
  });

  it('treats a non-list as a refusal rather than as an empty grant', () => {
    expect(refuseCapabilities('side_effect', undefined as never)).toBe('capability_not_granted');
    expect(refusedToolsets('document', undefined as never)).toEqual(['(toolsets is not a list)']);
  });

  it('describes the boundary from the same list the checks use', () => {
    const brief = capabilityBrief(['file']);
    expect(brief).toContain('Available toolsets for this run: file');
    for (const toolset of FORBIDDEN_TOOLSETS) {
      if (toolset === '*') continue; // the wildcard is not a capability to advertise
      expect(brief, toolset).toContain(toolset);
    }
    expect(brief).toContain('never emulate it');
    expect(brief).toContain('report which capability is missing');
    expect(isForbiddenToolset('browser')).toBe(true);
    expect(isForbiddenToolset('file')).toBe(false);
  });
});
