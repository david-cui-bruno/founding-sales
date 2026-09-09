import { describe, expect, it } from 'vitest';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { PLAYBOOK_CHANNEL_POLICIES_V2, scheduleComponent } from '../../src/main/domain/cadence/cadenceScheduler';
import { planDailyAccountCalls, planTodayQueue } from '../../src/main/domain/today/todayOrdering';
import { DEFAULT_TODAY_CAPACITY, type ParsedTodayCandidate } from '../../src/main/domain/today/todayTypes';

const now = '2026-09-08T15:00:00.000Z';
function lead(id: string, extra: Partial<ParsedTodayCandidate> = {}): ParsedTodayCandidate {
  return { cycleId: id, personId: id, prospectId: id, stage: 'contacted', workflowStatus: 'active',
    segment: 'cold', commitment: null,
    action: { id: `${id}-action`, actionType: 'call', channel: 'phone', workIntent: 'promised_follow_up',
      dueAt: now, timezone: 'America/New_York', allowedWindow: 'morning',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null } },
    cadence: null, priority: null, priorityState: 'missing', selectedTriggerReasons: [], verifyFirst: false,
    lastActivity: null, stageEnteredAt: now, resurfaceAt: null, resurfaceReason: null, inlineDiagnostics: [], ...extra };
}
function queue(candidates: ParsedTodayCandidate[], dialBudget = 0) {
  return planTodayQueue({ candidates, generatedAt: now, timezone: 'America/New_York',
    capacity: { ...DEFAULT_TODAY_CAPACITY, dialBudget }, completedDiscretionaryDialCount: 0 });
}

describe('approved playbook queue', () => {
  it('does not hide an independently due post-stage action behind a future callback', () => {
    const interview = lead('interview', { stage: 'interviewed',
      commitment: { kind: 'callback', activityId: 'promise', dueAt: '2026-09-10T15:00:00.000Z' } });
    interview.action.actionType = 'email';
    const result = queue([interview]);
    expect(result.lanes.flatMap(lane => lane.items).map(item => item.personId)).toEqual(['interview']);
  });
  it('counts unprotected automatic calls against the same discretionary meter used for capacity', () => {
    const result = queue([lead('automatic')], 1);
    expect(result.queuedDiscretionaryDialCount).toBe(1);
    expect(result.remainingDiscretionaryDialCount).toBe(0);
  });
  it('idles legacy automatic cold promises but preserves evidenced callbacks before warm work at zero dial cap', () => {
    const result = queue([lead('automatic'), lead('warm-intro', { segment: 'warm' }),
      lead('due-callback', { commitment: { kind: 'callback', activityId: 'promise-activity', dueAt: now } })]);
    expect(result.lanes.filter(lane => lane.lane !== 'later').flatMap(lane => lane.items.map(item => item.personId)))
      .toEqual(['due-callback', 'warm-intro']);
    expect(result.suppressed).toContainEqual({ cycleId: 'automatic', reason: 'warm_pipeline_active' });
  });
  it('keeps future warm work active for idling without making it prematurely due', () => {
    const warm = lead('future-warm', { segment: 'warm' });
    warm.action.dueAt = '2026-09-10T15:00:00.000Z';
    const result = queue([warm, lead('automatic')]);
    expect(result.lanes.flatMap(lane => lane.items)).toEqual([]);
    expect(result.suppressed).toEqual([
      { cycleId: 'automatic', reason: 'warm_pipeline_active' },
      { cycleId: 'future-warm', reason: 'not_due' },
    ]);
  });
  it('keeps post-stage work regardless of dial cap and never interprets a legacy label as callback proof', () => {
    const result = queue([lead('interview', { stage: 'interviewed', commitment: { kind: 'post_stage' } }),
      lead('legacy-label')]);
    expect(result.lanes.filter(lane => lane.lane !== 'later').flatMap(lane => lane.items.map(item => item.personId)))
      .toEqual(['interview']);
  });
  it('keeps callback and warm obligations while adding configured meeting-first new account work', () => {
    const result = queue([lead('warm-intro', { segment: 'warm' }),
      lead('due-callback', { commitment: { kind: 'callback', activityId: 'promise-activity', dueAt: now } })]);
    expect(result.lanes.filter(lane => lane.lane !== 'later').flatMap(lane => lane.items.map(item => item.personId)))
      .toEqual(['due-callback', 'warm-intro']);
    expect(planDailyAccountCalls({
      due: ['due-callback-account', 'warm-intro-account'],
      ranked: ['new-pm-account'],
      newCallSlots: 1,
      completedAccountIds: [],
      totalCallCapacity: null,
    })).toEqual({
      accountIds: ['due-callback-account', 'warm-intro-account', 'new-pm-account'],
      workloadConflict: false,
    });
  });
});

describe('approved playbook scheduling', () => {
  it('schedules weekday calls only before 18:00 and moves weekend booking deadlines to a legal window', () => {
    const step = BUILTIN_CADENCES[2].steps[1];
    const planned = scheduleComponent({ step, component: step.components[0],
      anchorAt: '2026-09-11T15:00:00.000Z', evaluationAt: '2026-09-11T15:00:00.000Z',
      timezone: 'America/New_York', policies: PLAYBOOK_CHANNEL_POLICIES_V2, priorCallWindow: null });
    expect(planned.dueAt).toBe('2026-09-14T13:00:00.000Z');
    expect(planned.slaDueAt).toBe('2026-09-14T22:00:00.000Z');
    const initial = BUILTIN_CADENCES[0].steps[0];
    expect(scheduleComponent({ step: initial, component: initial.components[0],
      anchorAt: '2026-09-08T22:00:00.000Z', evaluationAt: '2026-09-08T22:00:00.000Z',
      timezone: 'America/New_York', policies: PLAYBOOK_CHANNEL_POLICIES_V2, priorCallWindow: null }).dueAt)
      .toBe('2026-09-09T13:00:00.000Z');
  });
});
