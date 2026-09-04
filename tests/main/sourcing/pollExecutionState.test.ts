import { describe, expect, it } from 'vitest';

import {
  evaluatePollHealth,
  type PollExecutionState,
} from '../../../src/main/sourcing/pollExecutionState';

const CADENCE_MS = 15 * 60_000;
const TOTAL_DEADLINE_MS = 14 * 60_000;
const NOW_MS = Date.parse('2026-09-04T12:00:00.000Z');

function state(overrides: Partial<PollExecutionState> = {}): PollExecutionState {
  return {
    state: 'idle',
    pollId: null,
    startedAt: null,
    lastCompletedAt: '2026-09-04T11:45:00.000Z',
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureCode: null,
    backlogCount: 0,
    ...overrides,
  };
}

function evaluate(input: {
  state?: PollExecutionState;
  credentialState?: 'keychain' | 'file' | 'none';
  consecutiveBackloggedPolls?: number;
}) {
  return evaluatePollHealth({
    state: input.state ?? state(),
    credentialState: input.credentialState ?? 'keychain',
    consecutiveBackloggedPolls: input.consecutiveBackloggedPolls ?? 0,
    nowMs: NOW_MS,
    cadenceMs: CADENCE_MS,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
  });
}

describe('evaluatePollHealth', () => {
  it.each([
    {
      name: 'a running poll exceeds the total deadline',
      state: state({
        state: 'running',
        pollId: 'poll-1',
        startedAt: new Date(NOW_MS - TOTAL_DEADLINE_MS - 1).toISOString(),
      }),
      credentialState: 'keychain' as const,
      consecutiveBackloggedPolls: 0,
      reason: 'POLL_EXCEEDED_TOTAL_DEADLINE',
    },
    {
      name: 'the last successful poll is older than two cadences',
      state: state({
        lastCompletedAt: new Date(NOW_MS - (2 * CADENCE_MS) - 1).toISOString(),
      }),
      credentialState: 'keychain' as const,
      consecutiveBackloggedPolls: 0,
      reason: 'NO_SUCCESS_WITHIN_TWO_CADENCES',
    },
    {
      name: 'nonzero backlog persisted across two successful polls',
      state: state({ backlogCount: 3 }),
      credentialState: 'keychain' as const,
      consecutiveBackloggedPolls: 2,
      reason: 'BACKLOG_PERSISTED_ACROSS_POLLS',
    },
    {
      name: 'credentials exist before any successful poll',
      state: state({ lastCompletedAt: null }),
      credentialState: 'file' as const,
      consecutiveBackloggedPolls: 0,
      reason: 'CREDENTIALS_WITHOUT_COMPLETED_POLL',
    },
  ])('degrades when $name', (testCase) => {
    const health = evaluate(testCase);

    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual([testCase.reason]);
    expect(health.state).toEqual(testCase.state);
  });

  it('treats exactly two cadences as fresh and reports the exact age', () => {
    const health = evaluate({
      state: state({
        lastCompletedAt: new Date(NOW_MS - (2 * CADENCE_MS)).toISOString(),
      }),
    });

    expect(health.status).toBe('healthy');
    expect(health.reasons).toEqual([]);
    expect(health.lastSuccessAgeMs).toBe(30 * 60_000);
  });

  it('requires two consecutive successful nonzero-backlog polls', () => {
    expect(evaluate({
      state: state({ backlogCount: 1 }),
      consecutiveBackloggedPolls: 1,
    }).reasons).toEqual([]);

    expect(evaluate({
      state: state({ backlogCount: 1 }),
      consecutiveBackloggedPolls: 2,
    }).reasons).toEqual(['BACKLOG_PERSISTED_ACROSS_POLLS']);
  });

  it('recovers to healthy after a fresh successful poll clears the backlog streak', () => {
    const health = evaluate({
      state: state({
        lastCompletedAt: new Date(NOW_MS - 1_000).toISOString(),
        backlogCount: 0,
        consecutiveFailures: 0,
        lastFailureAt: '2026-09-04T11:00:00.000Z',
        lastFailureCode: 'S3_LIST_TIMEOUT',
      }),
      consecutiveBackloggedPolls: 0,
    });

    expect(health).toEqual({
      status: 'healthy',
      reasons: [],
      state: health.state,
      lastSuccessAgeMs: 1_000,
    });
  });

  it('returns degraded reasons in the declared union order', () => {
    const health = evaluate({
      state: state({
        state: 'running',
        pollId: 'poll-all',
        startedAt: new Date(NOW_MS - TOTAL_DEADLINE_MS - 1).toISOString(),
        lastCompletedAt: null,
        backlogCount: 4,
      }),
      consecutiveBackloggedPolls: 2,
    });

    expect(health.reasons).toEqual([
      'POLL_EXCEEDED_TOTAL_DEADLINE',
      'BACKLOG_PERSISTED_ACROSS_POLLS',
      'CREDENTIALS_WITHOUT_COMPLETED_POLL',
    ]);
  });

  it('does not report a credential degradation when credentials are absent', () => {
    const health = evaluate({
      state: state({ lastCompletedAt: null }),
      credentialState: 'none',
    });

    expect(health.status).toBe('healthy');
    expect(health.reasons).toEqual([]);
    expect(health.lastSuccessAgeMs).toBeNull();
  });
});
