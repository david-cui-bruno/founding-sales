import { expect, it, vi } from 'vitest';
import { campaignOpeningPgFixture, openingPgHandoff } from './campaignOpeningPgFixture.ts';
import type { Queryable } from '../../db/queryable.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { readFenceByStepExecution } from '../../outbound/fence.ts';
import { databaseNow } from '../../policy/clock.ts';
import { addCalendarDays, localDate, localInstant, weekdayOfDate } from '../../src/rules/localClock.ts';
import { placeEmailSend } from '../../src/rules/sendingWindow.ts';

it('CI1 fixture recipient-close rollover keeps one reservation without changing SQL wall-clock gates', async () => {
  const f = await campaignOpeningPgFixture(false);
  try {
    const zone = 'America/Chicago';
    const wallBefore = await databaseNow(f.worker);
    // Force the exact mismatch even when CI runs during a valid window. The
    // synthetic prepare clock is the previous business day's closing boundary.
    // Other sessions and SQL clock_timestamp()/now() predicates remain real.
    let date = addCalendarDays(localDate(f.at, zone), -1);
    while ([0, 6].includes(weekdayOfDate(date))) date = addCalendarDays(date, -1);
    const justBefore = localInstant(date, { hour: 10, minute: 59 }, zone);
    const close = localInstant(date, { hour: 11, minute: 0 }, zone);
    expect(placeEmailSend(justBefore, zone, { prospecting: true })).toMatchObject({ inPlace: true, localDate: date });
    expect(placeEmailSend(close, zone, { prospecting: true })).toMatchObject({ inPlace: false, localDate: localDate(f.at, zone) });
    expect(localDate(close, zone)).not.toBe(localDate(f.at, zone));
    let fictionalClockReads = 0;
    const db: Queryable = { query: (text, values) => {
      if (text === 'SELECT now() AS now') {
        fictionalClockReads += 1;
        return f.db.query('SELECT $1::timestamptz AS now', [close]);
      }
      return f.db.query(text, values);
    } };
    const handoff = openingPgHandoff(f.at);
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const result = await f.tx(() => runDueStepExecution(f.worker, {
      stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(),
      sendHandoff: { ...handoff, dispatch,
        prepare: (context, request) => handoff.prepare(repositoryContext(context.scope, db), request) },
    }));
    expect(result).toMatchObject({ kind: 'handed_to_send' });
    // The adapter must supply the journey instant, not fall through to the
    // deliberately different explicit clock, nor replace SQL expiry predicates.
    expect(fictionalClockReads).toBe(0);
    expect(await readFenceByStepExecution(f.worker, f.executionId)).toMatchObject({ state: 'prepared', attemptToken: null });
    expect((await f.db.query('SELECT action_id, local_date::text, claimed_at FROM outreach_touch_reservations WHERE workspace_id=$1 AND plan_id=$2', [f.w, f.planId])).rows)
      .toEqual([{ action_id: f.executionId, local_date: localDate(f.at, zone), claimed_at: new Date(f.at) }]);
    expect((await f.db.query('SELECT count(*)::int AS count FROM outbound_messages WHERE workspace_id=$1 AND step_execution_id=$2', [f.w, f.executionId])).rows)
      .toEqual([{ count: 1 }]);
    const wallAfter = await databaseNow(f.worker);
    expect(Date.parse(wallAfter)).toBeGreaterThanOrEqual(Date.parse(wallBefore));
    expect((await f.db.query("SELECT 1 FROM workspace_settings WHERE workspace_id=$1 AND setting_key='sending_enabled' AND value->>'enabled'='true'", [f.w])).rows).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  } finally { await f.stop(); }
});
