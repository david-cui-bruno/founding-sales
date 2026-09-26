import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  RAMP_RAISE_HEALTHY_STREAK,
  dispatchOutboundMessage,
  readRamp,
  setAdminCap,
  type SendReport,
} from '../../outbound/index.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { prepareFor, seedFirm, type SeededFirm } from './support/dispatchFixtures.ts';

/**
 * The ramp raise, against a real PostgreSQL (lane g87, audit S06). 12.7: "After
 * sustained healthy results they may raise a mailbox to 75". Before g87 a raise to 75
 * was accepted for a mailbox on its first day and replaced the schedule, so the ramp
 * was one admin click deep.
 *
 * ## The vacuous-pass traps
 *
 * A hold is cheap: a world that could never send holds everything. Every refusal here
 * names its reason *and* its detail, and each group then changes the one fact the
 * refusal was about and requires the same shape to send — so the refusal was that fact
 * and nothing else. Each dispatch uses a firm of its own, because a held fence opens a
 * firm hold and the next dispatch would otherwise refuse for that.
 *
 * Every date is chosen by the instant the dispatch is judged at (the cap counts on the
 * claim's business date, lane g77), and no two groups share one.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const mailboxId = (): string => world.alpha.mailboxId;
const adminUserId = (): string => world.alpha.workspace.admin.userId;
const context = () => world.systemContext(workspaceId());
const session = () => world.database.session;

const why = (report: SendReport): string => `${report.outcome} ${report.refusal ?? ''} ${report.detail ?? ''}`;

async function dispatch(fenceId: string, at: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail, now: () => new Date(at) }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

/** A firm of its own and a fence for it. */
async function freshFence(label: string): Promise<{ readonly firm: SeededFirm; readonly fenceId: string }> {
  await world.clearHolds(workspaceId());
  const firm = await seedFirm(world, world.alpha, label);
  const fenceId = await prepareFor(world, world.alpha, firm, {});
  return { firm, fenceId };
}

/** The ramp as a test wants it: healthy days, and a raise written straight to the row. */
async function setRamp(healthySendingDays: number, raisedDailyCap: number | null = null): Promise<void> {
  await session().query(
    `UPDATE mailbox_send_ramp
        SET healthy_sending_days = $3, admin_daily_cap = NULL, raised_daily_cap = $4::integer,
            admin_changed_at = CASE WHEN $4::integer IS NULL THEN NULL ELSE now() END,
            admin_changed_by_user_id = CASE WHEN $4::integer IS NULL THEN NULL ELSE $5::uuid END,
            last_health_failure = NULL, updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2`,
    [workspaceId(), mailboxId(), healthySendingDays, raisedDailyCap, adminUserId()],
  );
}

/**
 * Closed sending days in August, oldest first, each healthy or not. August is this
 * file's: nothing else here closes a day, so these are the mailbox's most recent
 * verdicts. A day with no automated send is written as `quiet` — closed, judged
 * `no_sends`, and not a sending day.
 */
async function seedVerdicts(verdicts: readonly ('healthy' | 'unhealthy' | 'quiet')[]): Promise<void> {
  await session().query(
    `DELETE FROM mailbox_send_days WHERE workspace_id = $1 AND mailbox_id = $2
        AND business_date BETWEEN '2026-08-01' AND '2026-08-31'`,
    [workspaceId(), mailboxId()],
  );
  for (const [index, verdict] of verdicts.entries()) {
    await session().query(
      `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, cap_granted,
                                      healthy, closed_at)
       VALUES ($1, $2, '2026-08-01'::date + $3::integer, $4, 50, $5, now() - interval '1 hour')`,
      [workspaceId(), mailboxId(), index, verdict === 'quiet' ? 0 : 5, verdict === 'healthy'],
    );
  }
}

/** Put one business date's counters where a test wants them. */
async function setDay(businessDate: string, counts: { readonly automated?: number; readonly direct?: number }): Promise<void> {
  await session().query(
    `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, direct_sent, cap_granted)
     VALUES ($1, $2, $3::date, $4, $5, 100)
     ON CONFLICT (workspace_id, mailbox_id, business_date)
     DO UPDATE SET automated_sent = EXCLUDED.automated_sent, direct_sent = EXCLUDED.direct_sent,
                   cap_granted = greatest(mailbox_send_days.cap_granted, EXCLUDED.cap_granted), updated_at = now()`,
    [workspaceId(), mailboxId(), businessDate, counts.automated ?? 0, counts.direct ?? 0],
  );
}

const businessDate = async (instant: string): Promise<string> => await businessDateOf(context(), instant);

const earnedStreak = (): readonly 'healthy'[] => Array.from({ length: RAMP_RAISE_HEALTHY_STREAK }, () => 'healthy' as const);

describe('S06: a raise to 75 is earned by sustained healthy results', () => {
  afterEach(async () => {
    await setRamp(40);
    await seedVerdicts([]);
  });

  it('refuses a raise for a mailbox that has not finished the schedule, and writes nothing', async () => {
    await setRamp(12);
    await seedVerdicts(earnedStreak());
    for (const raiseTo of [75, 20]) {
      const refused = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), raiseTo });
      expect(refused).toEqual({ ok: false, reason: 'ramp_not_settled' });
    }
    expect((await readRamp(context(), mailboxId()))?.raisedDailyCap).toBeNull();

    // Lowering is never refused for health: it only makes the cap smaller.
    const lowered = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), lowerTo: 3 });
    expect(lowered.ok && lowered.effectiveCap).toBe(3);
  });

  it('refuses a raise for a settled mailbox whose last ten sending days were not all healthy', async () => {
    await setRamp(40);
    // Nine healthy days after one that was not: nine, not ten. The quiet day in the
    // middle is not a sending day and neither breaks the run nor extends it.
    await seedVerdicts(['healthy', 'unhealthy', 'healthy', 'healthy', 'healthy', 'healthy', 'quiet', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy']);
    const refused = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), raiseTo: 75 });
    expect(refused).toEqual({ ok: false, reason: 'health_not_sustained' });

    // One more healthy sending day and it is ten.
    await seedVerdicts(['unhealthy', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy', 'quiet', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy']);
    const accepted = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), raiseTo: 75 });
    expect(accepted.ok && accepted.effectiveCap).toBe(75);
  });

  it('keeps the raise when only the lowering changes, because absent is not null', async () => {
    await setRamp(40);
    await seedVerdicts(earnedStreak());
    const raised = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), raiseTo: 75 });
    expect(raised.ok && raised.effectiveCap).toBe(75);

    const lowered = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), lowerTo: 10 });
    expect(lowered.ok && lowered.effectiveCap).toBe(10);
    expect(lowered.ok && lowered.ramp.raisedDailyCap).toBe(75);

    const restored = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), lowerTo: null });
    expect(restored.ok && restored.effectiveCap).toBe(75);

    const cleared = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), raiseTo: null });
    expect(cleared.ok && cleared.effectiveCap).toBe(50);
  });

  it('the bypass: a stored raise on a mailbox’s first day still sends only the schedule’s five', async () => {
    const at = '2026-10-06T13:00:00.000Z';
    const today = await businessDate(at);
    // A raise to 75 written to the row, as the command wrote one before g87.
    await setRamp(0, 75);
    await setDay(today, { automated: 5 });

    const first = await freshFence('bypass');
    const held = await dispatch(first.fenceId, at);
    expect(held.report.outcome, why(held.report)).toBe('held');
    expect(held.report.refusal).toBe('daily_cap');
    expect(held.report.detail).toBe('automated 5/5');
    expect(held.sends).toBe(0);

    // The same raise, once earned, is the cap in force: the refusal was the rule.
    await setRamp(40, 75);
    await seedVerdicts(earnedStreak());
    const second = await freshFence('bypass-earned');
    const sent = await dispatch(second.fenceId, at);
    expect(sent.report.outcome, why(sent.report)).toBe('sent');
  });

  it('the gate asks again before every send: a raise stops counting the day its health lapses', async () => {
    const at = '2026-10-07T13:00:00.000Z';
    const today = await businessDate(at);
    await setRamp(40);
    await seedVerdicts(earnedStreak());
    const raised = await setAdminCap(context(), { mailboxId: mailboxId(), adminUserId: adminUserId(), raiseTo: 75 });
    expect(raised.ok).toBe(true);
    await setDay(today, { automated: 50 });

    // Fifty already today: under the earned 75, so it goes.
    const first = await freshFence('lapse-before');
    const sent = await dispatch(first.fenceId, at);
    expect(sent.report.outcome, why(sent.report)).toBe('sent');

    // A late bounce condemns the most recent closed day (lane G22): the streak is
    // broken, the stored raise is unchanged, and the schedule's fifty governs today.
    await session().query(
      `UPDATE mailbox_send_days SET healthy = false WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
      [workspaceId(), mailboxId(), `2026-08-${String(RAMP_RAISE_HEALTHY_STREAK).padStart(2, '0')}`],
    );
    expect((await readRamp(context(), mailboxId()))?.raisedDailyCap).toBe(75);
    const second = await freshFence('lapse-after');
    const held = await dispatch(second.fenceId, at);
    expect(held.report.outcome, why(held.report)).toBe('held');
    expect(held.report.refusal).toBe('daily_cap');
    expect(held.report.detail).toBe('automated 51/50');
    expect(held.sends).toBe(0);
  });
});
