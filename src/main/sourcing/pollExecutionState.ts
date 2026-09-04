import type {
  PollDegradedReason,
  PollExecutionState,
  SourcingCredentialState,
  SourcingPollHealth,
} from '../../shared/contracts/sourcingContract';

export type { PollDegradedReason, PollExecutionState, SourcingPollHealth };

export function evaluatePollHealth(input: {
  state: PollExecutionState;
  credentialState: SourcingCredentialState;
  consecutiveBackloggedPolls: number;
  nowMs: number;
  cadenceMs: number;
  totalDeadlineMs: number;
}): SourcingPollHealth {
  const reasons: PollDegradedReason[] = [];
  const startedAtMs = input.state.startedAt === null
    ? null
    : Date.parse(input.state.startedAt);
  const lastCompletedAtMs = input.state.lastCompletedAt === null
    ? null
    : Date.parse(input.state.lastCompletedAt);
  const lastSuccessAgeMs = lastCompletedAtMs === null
    ? null
    : Math.max(0, input.nowMs - lastCompletedAtMs);

  if (
    input.state.state === 'running'
    && startedAtMs !== null
    && input.nowMs - startedAtMs > input.totalDeadlineMs
  ) {
    reasons.push('POLL_EXCEEDED_TOTAL_DEADLINE');
  }
  if (lastSuccessAgeMs !== null && lastSuccessAgeMs > 2 * input.cadenceMs) {
    reasons.push('NO_SUCCESS_WITHIN_TWO_CADENCES');
  }
  if (input.consecutiveBackloggedPolls >= 2) {
    reasons.push('BACKLOG_PERSISTED_ACROSS_POLLS');
  }
  if (input.credentialState !== 'none' && input.state.lastCompletedAt === null) {
    reasons.push('CREDENTIALS_WITHOUT_COMPLETED_POLL');
  }

  return {
    status: reasons.length === 0 ? 'healthy' : 'degraded',
    reasons,
    state: { ...input.state },
    lastSuccessAgeMs,
  };
}
