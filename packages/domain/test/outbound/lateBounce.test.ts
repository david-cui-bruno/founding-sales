import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordBounceAgainstDay } from '../../outbound/ramp.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';

/**
 * Counting a bounce against the day that earned it (12.7, lane G22).
 *
 * The mail suite proves the attribution end to end — a delivery report whose
 * `References` name an FSS fence is counted against that fence's send day and not
 * against the morning it was read. This suite is the arithmetic underneath it, on a
 * real PostgreSQL: which late bounces move the ramp, which do not, and what happens
 * when one lands on a day that was already condemned.
 *
 * Both workspaces get the same dates and the same counters, and every case asserts
 * that the other one did not move.
 */
describe('a bounce counted against a send day that has already closed', () => {
  let world: OutboundWorld;

  beforeAll(async () => {
    world = await createOutboundWorld();
  });

  afterAll(async () => {
    await world.stop();
  });

  const context = (which: 'alpha' | 'beta') =>
    world.systemContext(world[which].workspace.workspaceId);

  /** A date no other suite in this world touches, derived from PostgreSQL's clock. */
  const dateOffsetByDays = async (offset: number): Promise<string> => {
    const { rows } = await world.database.session.query<{ date: string }>(
      `SELECT ((now() AT TIME ZONE w.business_time_zone)::date + $2::integer)::text AS date
         FROM workspaces w WHERE w.id = $1`,
      [world.alpha.workspace.workspaceId, offset],
    );
    const date = rows[0]?.date;
    if (date === undefined) throw new Error('the workspace has no business zone');
    return date;
  };

  /** One closed, healthy day in both workspaces, and a ramp that counted it. */
  const seedDay = async (
    businessDate: string,
    day: {
      readonly automatedSent: number;
      readonly bounces?: number | undefined;
      readonly closed?: boolean | undefined;
      readonly healthy?: boolean | undefined;
      readonly healthyDays?: number | undefined;
    },
  ): Promise<void> => {
    for (const which of ['alpha', 'beta'] as const) {
      const workspaceId = world[which].workspace.workspaceId;
      await world.database.session.query(
        `INSERT INTO mailbox_send_days
           (workspace_id, mailbox_id, business_date, automated_sent, bounces, cap_granted,
            healthy, closed_at)
         VALUES ($1, $2, $3::date, $4, $5, 50, $6, CASE WHEN $7 THEN now() - interval '1 hour' END)
         ON CONFLICT (workspace_id, mailbox_id, business_date) DO UPDATE
           SET automated_sent = EXCLUDED.automated_sent,
               bounces = EXCLUDED.bounces,
               healthy = EXCLUDED.healthy,
               closed_at = EXCLUDED.closed_at,
               updated_at = now()`,
        [
          workspaceId,
          world[which].mailboxId,
          businessDate,
          day.automatedSent,
          day.bounces ?? 0,
          day.closed === false ? null : (day.healthy ?? true),
          day.closed !== false,
        ],
      );
      await world.database.session.query(
        `UPDATE mailbox_send_ramp
            SET healthy_sending_days = $3, last_advanced_on = $4::date, last_health_failure = NULL
          WHERE workspace_id = $1 AND mailbox_id = $2`,
        [workspaceId, world[which].mailboxId, day.healthyDays ?? 6, businessDate],
      );
    }
  };

  const readDay = async (
    which: 'alpha' | 'beta',
    businessDate: string,
  ): Promise<{ bounces: number; healthy: boolean | null }> => {
    const { rows } = await world.database.session.query<{ bounces: number; healthy: boolean | null }>(
      `SELECT bounces, healthy FROM mailbox_send_days
        WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
      [world[which].workspace.workspaceId, world[which].mailboxId, businessDate],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the fixture day is missing');
    return row;
  };

  const readRampRow = async (
    which: 'alpha' | 'beta',
  ): Promise<{ healthy_sending_days: number; last_advanced_on: Date | string | null; last_health_failure: string | null }> => {
    const { rows } = await world.database.session.query<{
      healthy_sending_days: number;
      last_advanced_on: Date | string | null;
      last_health_failure: string | null;
    }>(
      `SELECT healthy_sending_days, last_advanced_on, last_health_failure FROM mailbox_send_ramp
        WHERE workspace_id = $1 AND mailbox_id = $2`,
      [world[which].workspace.workspaceId, world[which].mailboxId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the mailbox has no ramp');
    return row;
  };

  it('counts against an open day and judges nothing: the close is what judges', async () => {
    const businessDate = await dateOffsetByDays(-11);
    await seedDay(businessDate, { automatedSent: 4, closed: false, healthyDays: 6 });

    const outcome = await recordBounceAgainstDay(context('alpha'), {
      mailboxId: world.alpha.mailboxId,
      businessDate,
    });
    expect(outcome).toEqual({ businessDate, late: false, ramp: 'unchanged', failure: null });
    expect((await readDay('alpha', businessDate)).bounces).toBe(1);
    expect((await readRampRow('alpha')).healthy_sending_days).toBe(6);
    expect((await readDay('beta', businessDate)).bounces).toBe(0);
  });

  it('counts against a closed day without taking it back when the rate still passes', async () => {
    const businessDate = await dateOffsetByDays(-12);
    await seedDay(businessDate, { automatedSent: 20, healthyDays: 6 });

    const outcome = await recordBounceAgainstDay(context('alpha'), {
      mailboxId: world.alpha.mailboxId,
      businessDate,
    });
    // One in twenty is exactly five per cent, and RAMP_MAX_BOUNCE_RATE is "more than".
    expect(outcome).toEqual({ businessDate, late: true, ramp: 'unchanged', failure: null });
    expect(await readDay('alpha', businessDate)).toEqual({ bounces: 1, healthy: true });
    expect((await readRampRow('alpha')).healthy_sending_days).toBe(6);
  });

  it('takes the day back exactly once when the late bounce crosses the threshold', async () => {
    const businessDate = await dateOffsetByDays(-13);
    await seedDay(businessDate, { automatedSent: 20, bounces: 1, healthyDays: 6 });

    const crossing = await recordBounceAgainstDay(context('alpha'), {
      mailboxId: world.alpha.mailboxId,
      businessDate,
    });
    expect(crossing).toEqual({ businessDate, late: true, ramp: 'reversed', failure: 'bounce_rate' });
    expect(await readDay('alpha', businessDate)).toEqual({ bounces: 2, healthy: false });

    const afterReversal = await readRampRow('alpha');
    expect(afterReversal.healthy_sending_days).toBe(5);
    expect(afterReversal.last_health_failure).toBe('bounce_rate');
    // `last_advanced_on` does not move: it is what stops `closeSendDay` advancing the
    // same date twice, and rewinding it would let a later close re-earn this day.
    const advanced = afterReversal.last_advanced_on;
    expect(advanced instanceof Date ? advanced.toISOString().slice(0, 10) : advanced).toBe(businessDate);

    // A third report for the same day. The day is already condemned, so it is counted
    // and nothing further is taken.
    const again = await recordBounceAgainstDay(context('alpha'), {
      mailboxId: world.alpha.mailboxId,
      businessDate,
    });
    expect(again).toEqual({ businessDate, late: true, ramp: 'unchanged', failure: null });
    expect(await readDay('alpha', businessDate)).toEqual({ bounces: 3, healthy: false });
    expect((await readRampRow('alpha')).healthy_sending_days).toBe(5);

    // The other workspace holds the same date, the same counters and the same ramp,
    // and none of the three reports above touched it.
    expect(await readDay('beta', businessDate)).toEqual({ bounces: 1, healthy: true });
    expect((await readRampRow('beta')).healthy_sending_days).toBe(6);
  });

  it('never takes the count below zero, because the column may not go there', async () => {
    const businessDate = await dateOffsetByDays(-14);
    await seedDay(businessDate, { automatedSent: 20, bounces: 1, healthyDays: 0 });

    const outcome = await recordBounceAgainstDay(context('alpha'), {
      mailboxId: world.alpha.mailboxId,
      businessDate,
    });
    expect(outcome?.ramp).toBe('reversed');
    expect((await readRampRow('alpha')).healthy_sending_days).toBe(0);
  });

  it('answers null for a mailbox and date that never sent anything automated', async () => {
    const businessDate = await dateOffsetByDays(-15);
    expect(
      await recordBounceAgainstDay(context('alpha'), {
        mailboxId: world.alpha.mailboxId,
        businessDate,
      }),
    ).toBeNull();
  });
});
