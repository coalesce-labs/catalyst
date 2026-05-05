// Unit tests for filter-daemon core logic
// Run: bun test plugins/dev/scripts/filter-daemon/index.test.mjs

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  handleRegister,
  handleDeregister,
  handleOrchestratorTerminated,
  shouldSkipEvent,
  buildGroqPrompt,
  getInterests,
  clearInterests,
} from './index.mjs';

describe('interest table', () => {
  beforeEach(() => clearInterests());

  test('handleRegister adds entry keyed by interest_id', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-1',
      detail: {
        interest_id: 'orch-1',
        notify_event: 'filter.wake.orch-1',
        prompt: 'Wake me on CI failure',
        context: { pr_numbers: [42] },
      },
    });
    const entry = getInterests().get('orch-1');
    expect(entry).toBeDefined();
    expect(entry.notify_event).toBe('filter.wake.orch-1');
    expect(entry.prompt).toBe('Wake me on CI failure');
    expect(entry.context).toEqual({ pr_numbers: [42] });
  });

  test('handleRegister falls back to orchestrator field when no interest_id', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-2',
      detail: {
        notify_event: 'filter.wake.orch-2',
        prompt: 'PR merge events',
      },
    });
    expect(getInterests().has('orch-2')).toBe(true);
  });

  test('handleRegister derives notify_event from id when not provided', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-x',
      detail: { interest_id: 'orch-x', prompt: 'any event' },
    });
    expect(getInterests().get('orch-x').notify_event).toBe('filter.wake.orch-x');
  });

  test('handleRegister is idempotent — updates existing entry', () => {
    const base = {
      event: 'filter.register',
      orchestrator: 'orch-3',
      detail: { interest_id: 'orch-3', notify_event: 'filter.wake.orch-3', prompt: 'v1' },
    };
    handleRegister(base);
    handleRegister({ ...base, detail: { ...base.detail, prompt: 'v2' } });
    expect(getInterests().get('orch-3').prompt).toBe('v2');
    expect(getInterests().size).toBe(1);
  });

  test('handleDeregister removes entry by interest_id', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-4',
      detail: { interest_id: 'orch-4', notify_event: 'filter.wake.orch-4', prompt: 'x' },
    });
    handleDeregister({ event: 'filter.deregister', detail: { interest_id: 'orch-4' } });
    expect(getInterests().has('orch-4')).toBe(false);
  });

  test('handleDeregister falls back to orchestrator field', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-5',
      detail: { interest_id: 'orch-5', notify_event: 'filter.wake.orch-5', prompt: 'x' },
    });
    handleDeregister({ event: 'filter.deregister', orchestrator: 'orch-5', detail: {} });
    expect(getInterests().has('orch-5')).toBe(false);
  });

  test('handleDeregister is a no-op for unknown ids', () => {
    expect(() =>
      handleDeregister({ event: 'filter.deregister', detail: { interest_id: 'nonexistent' } })
    ).not.toThrow();
  });

  test('handleRegister stores persistent: false by default', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-p1',
      detail: { interest_id: 'orch-p1', notify_event: 'filter.wake.orch-p1', prompt: 'x' },
    });
    expect(getInterests().get('orch-p1').persistent).toBe(false);
  });

  test('handleRegister stores persistent: true when passed', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-p2',
      detail: { interest_id: 'orch-p2', notify_event: 'filter.wake.orch-p2', prompt: 'x', persistent: true },
    });
    expect(getInterests().get('orch-p2').persistent).toBe(true);
  });

  test('handleRegister treats persistent: false explicitly as false', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-p3',
      detail: { interest_id: 'orch-p3', notify_event: 'filter.wake.orch-p3', prompt: 'x', persistent: false },
    });
    expect(getInterests().get('orch-p3').persistent).toBe(false);
  });
});

describe('handleOrchestratorTerminated', () => {
  beforeEach(() => clearInterests());

  test('removes all interests belonging to the terminated orchestrator', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-A',
      detail: { interest_id: 'orch-A', notify_event: 'filter.wake.orch-A', prompt: 'x' },
    });
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-A',
      detail: { interest_id: 'orch-A-2', notify_event: 'filter.wake.orch-A-2', prompt: 'y' },
    });
    handleOrchestratorTerminated({ event: 'orchestrator-completed', orchestrator: 'orch-A' });
    expect(getInterests().has('orch-A')).toBe(false);
    expect(getInterests().has('orch-A-2')).toBe(false);
  });

  test('does not remove interests belonging to other orchestrators', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-A',
      detail: { interest_id: 'orch-A', notify_event: 'filter.wake.orch-A', prompt: 'x' },
    });
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-B',
      detail: { interest_id: 'orch-B', notify_event: 'filter.wake.orch-B', prompt: 'y' },
    });
    handleOrchestratorTerminated({ event: 'orchestrator-completed', orchestrator: 'orch-A' });
    expect(getInterests().has('orch-A')).toBe(false);
    expect(getInterests().has('orch-B')).toBe(true);
  });

  test('is a no-op when no interests match the orchestrator', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-X',
      detail: { interest_id: 'orch-X', notify_event: 'filter.wake.orch-X', prompt: 'x' },
    });
    handleOrchestratorTerminated({ event: 'orchestrator-failed', orchestrator: 'orch-Y' });
    expect(getInterests().has('orch-X')).toBe(true);
  });

  test('is a no-op when event has no orchestrator field', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-Z',
      detail: { interest_id: 'orch-Z', notify_event: 'filter.wake.orch-Z', prompt: 'x' },
    });
    expect(() =>
      handleOrchestratorTerminated({ event: 'orchestrator-completed' })
    ).not.toThrow();
    expect(getInterests().has('orch-Z')).toBe(true);
  });
});

describe('shouldSkipEvent', () => {
  test('skips filter.wake.* events (self-loop prevention)', () => {
    expect(shouldSkipEvent({ event: 'filter.wake.orch-1' })).toBe(true);
    expect(shouldSkipEvent({ event: 'filter.wake.anything' })).toBe(true);
  });

  test('skips all filter.* events to prevent Groq loop', () => {
    expect(shouldSkipEvent({ event: 'filter.register' })).toBe(true);
    expect(shouldSkipEvent({ event: 'filter.deregister' })).toBe(true);
    expect(shouldSkipEvent({ event: 'filter.anything' })).toBe(true);
  });

  test('does not skip github events', () => {
    expect(shouldSkipEvent({ event: 'github.pr.merged' })).toBe(false);
    expect(shouldSkipEvent({ event: 'github.check_suite.completed' })).toBe(false);
  });

  test('does not skip worker lifecycle events', () => {
    expect(shouldSkipEvent({ event: 'worker-done' })).toBe(false);
    expect(shouldSkipEvent({ event: 'worker-status-change' })).toBe(false);
  });

  test('does not skip linear events', () => {
    expect(shouldSkipEvent({ event: 'linear.issue.state_changed' })).toBe(false);
  });

  test('handles missing event field gracefully', () => {
    expect(shouldSkipEvent({})).toBe(false);
  });
});

describe('buildGroqPrompt', () => {
  beforeEach(() => clearInterests());

  test('returns null when no interests registered', () => {
    expect(buildGroqPrompt([{ event: 'github.push' }])).toBeNull();
  });

  test('includes all events numbered in userPrompt', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-a',
      detail: { interest_id: 'orch-a', notify_event: 'filter.wake.orch-a', prompt: 'CI failures' },
    });
    const events = [
      { event: 'github.check_suite.completed', detail: { conclusion: 'failure' } },
      { event: 'github.push' },
    ];
    const result = buildGroqPrompt(events);
    expect(result).not.toBeNull();
    expect(result.userPrompt).toContain('1.');
    expect(result.userPrompt).toContain('2.');
    expect(result.userPrompt).toContain('github.check_suite.completed');
    expect(result.userPrompt).toContain('github.push');
  });

  test('includes all registered interests in userPrompt', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-a',
      detail: { interest_id: 'orch-a', notify_event: 'filter.wake.orch-a', prompt: 'CI failures' },
    });
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-b',
      detail: { interest_id: 'orch-b', notify_event: 'filter.wake.orch-b', prompt: 'PR merges' },
    });
    const result = buildGroqPrompt([{ event: 'github.push' }]);
    expect(result.userPrompt).toContain('CI failures');
    expect(result.userPrompt).toContain('PR merges');
  });

  test('includes context in interest description when present', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-c',
      detail: {
        interest_id: 'orch-c',
        notify_event: 'filter.wake.orch-c',
        prompt: 'my PRs',
        context: { pr_numbers: [123] },
      },
    });
    const result = buildGroqPrompt([{ event: 'github.push' }]);
    expect(result.userPrompt).toContain('pr_numbers');
    expect(result.userPrompt).toContain('123');
  });

  test('systemPrompt instructs JSON-only output', () => {
    handleRegister({
      event: 'filter.register',
      orchestrator: 'orch-d',
      detail: { interest_id: 'orch-d', notify_event: 'filter.wake.orch-d', prompt: 'anything' },
    });
    const result = buildGroqPrompt([{ event: 'github.push' }]);
    expect(result.systemPrompt).toContain('JSON array');
    expect(result.systemPrompt.toLowerCase()).toContain('no other text');
  });
});
