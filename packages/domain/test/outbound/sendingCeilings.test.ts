import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { lockDomainGuard } from '../../outbound/domainGuard.ts';
import {
  ACCOUNT_OPERATIONAL_CEILING,
  RAMP_RAISE_HEALTHY_STREAK,
  claimForDispatch,
  dispatchOutboundMessage,
  personalGmailRecipientsInWindow,
  readFence,
  readRamp,
  setAdminCap,
  type SendReport,
} from '../../outbound/index.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import {
  backendPid,
  openExtraSession,
  prepareFor,
  seedFirm,
  settle,
  tracked,
  waitUntilBlocked,
  type ExtraSession,
  type SeededFirm,
} from './support/dispatchFixtures.ts';

/**
 * The three ceilings above the automated cap, against a real PostgreSQL (lane g87:
 * audit S06, S07, S08).
 *
 *   * **S06, the ramp raise.** 12.7: "After sustained healthy results they may raise a
 *     mailbox to 75". Before g87 a raise to 75 was accepted for a mailbox on its first
 *     day and replaced the schedule, so the ramp was one admin click deep.
 *   * **S07, the account headroom.** 12.7: "All outgoing Gmail messages, including
 *     direct sends, count toward operational headroom." Both counters existed and
 *     nothing read their sum.
 *   * **S08, recipient exposure.** 12.6's guard counted only `sent` fences, and a
 *     direct message once however many Gmail recipients it named.
 *
 * ## The vacuous-pass traps
 *
 * A hold is cheap: a world that could never send holds everything. Every refusal here
 * names its reason *and* its detail, and each group then changes the one fact the
 * refusal was about and requires the same shape to send — so the refusal was that fact
 * and nothing else. Each dispatch uses a firm of its own, because a held fence opens a
 * firm hold and the next dispatch would otherwise refuse for that.
 *
 * Every date is chosen by the instant the dispatch is judged at (the cap and the
 * headroom count on the claim's business date, lane g77), and no two groups share one.
 */

let world: OutboundWorld;
let extra: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  extra = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await extra?.close();
  await world?.stop();
});

// A test that fails between its BEGIN and its COMMIT must not leave the next one
// waiting on a lock it never released. ROLLBACK outside a transaction only warns.
afterEach(async () => {
  await extra?.session.query('ROLLBACK');
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const mailboxId = (): string => world.alpha.mailboxId;
const adminUserId = (): string => world.alpha.workspace.admin.userId;
const context = () => world.systemContext(workspaceId());
const session = () => world.database.session;

const why = (report: SendReport): string => `${report.outcome} ${report.refusal ?? ''} ${report.detail ?? ''}`;

async function dispatch(
  fenceId: string,
  at: string,
  behaviour: 'ok' | 'indeterminate' = 'ok',
): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, behaviour === 'ok' ? {} : { sendBehaviour: 'indeterminate' });
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail, now: () => new Date(at) }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

/** A firm of its own and a fence for it, optionally to a personal-Gmail address. */
async function freshFence(label: string, address?: string): Promise<{ readonly firm: SeededFirm; readonly fenceId: string }> {
  await world.clearHolds(workspaceId());
  const firm = await seedFirm(world, world.alpha, label);
  if (address !== undefined) {
    await session().query('UPDATE email_addresses SET address = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2', [
      workspaceId(),
      firm.routeId,
      address,
    ]);
  }
  const fenceId = await prepareFor(world, world.alpha, firm, address === undefined ? {} : { toAddress: address });
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

describe('S07: every outgoing message of the account counts against its headroom', () => {
  afterEach(async () => {
    await setRamp(40);
  });

  it('holds an automated send once the account’s own mail reaches the ceiling, counting yesterday', async () => {
    const at = '2026-10-15T13:00:00.000Z';
    const today = await businessDate(at);
    const yesterday = await businessDate('2026-10-14T13:00:00.000Z');
    const before = await businessDate('2026-10-13T13:00:00.000Z');

    // A thousand by hand yesterday and five hundred this morning: Google is counting
    // fifteen hundred of this account's messages whatever FSS has sent.
    await setDay(yesterday, { direct: 1000 });
    await setDay(today, { direct: ACCOUNT_OPERATIONAL_CEILING - 1000 });
    const first = await freshFence('headroom-full');
    const held = await dispatch(first.fenceId, at);
    expect(held.report.outcome, why(held.report)).toBe('held');
    expect(held.report.refusal).toBe('daily_cap');
    expect(held.report.detail).toBe(`account ${String(ACCOUNT_OPERATIONAL_CEILING)}/${String(ACCOUNT_OPERATIONAL_CEILING)}`);
    expect(held.sends).toBe(0);
    expect((await readFence(context(), first.fenceId))?.heldReason).toBe('daily_cap');

    // One message fewer this morning and there is room for exactly one automated send,
    // which then counts against the same ceiling as the person's own.
    await setDay(today, { direct: ACCOUNT_OPERATIONAL_CEILING - 1001 });
    const second = await freshFence('headroom-one-left');
    const sent = await dispatch(second.fenceId, at);
    expect(sent.report.outcome, why(sent.report)).toBe('sent');
    const third = await freshFence('headroom-full-again');
    const heldAgain = await dispatch(third.fenceId, at);
    expect(heldAgain.report.detail, why(heldAgain.report)).toBe(
      `account ${String(ACCOUNT_OPERATIONAL_CEILING)}/${String(ACCOUNT_OPERATIONAL_CEILING)}`,
    );

    // The day before yesterday is outside any 24 hours that end today, and is not counted.
    await setDay(before, { direct: 5000 });
    await setDay(yesterday, { direct: 0 });
    const fourth = await freshFence('headroom-two-days-ago');
    const allowed = await dispatch(fourth.fenceId, at);
    expect(allowed.report.outcome, why(allowed.report)).toBe('sent');
  });

  it('is its own ceiling, beside the automated cap: a quiet cap does not make room the account lacks', async () => {
    const at = '2026-10-16T13:00:00.000Z';
    const today = await businessDate(at);
    // No automated send today, so the cap of fifty is untouched — and the account is full.
    await setDay(today, { automated: 0, direct: ACCOUNT_OPERATIONAL_CEILING });
    const { fenceId } = await freshFence('headroom-cap-untouched');
    const held = await dispatch(fenceId, at);
    expect(held.report.refusal, why(held.report)).toBe('daily_cap');
    expect(held.report.detail ?? '').toMatch(/^account /);
  });
});

describe('S08: the domain guard counts recipient exposure', () => {
  const GUARD_DEFAULT = 4000;

  const setGuard = async (guard: number): Promise<void> => {
    await session().query('UPDATE sending_domains SET personal_gmail_guard_per_24h = $2 WHERE workspace_id = $1', [
      workspaceId(),
      guard,
    ]);
  };

  afterEach(async () => {
    await setGuard(GUARD_DEFAULT);
  });

  let messages = 0;
  const importDirect = async (to: readonly string[], cc: readonly string[] = [], rfcMessageId?: string): Promise<void> => {
    messages += 1;
    await session().query(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, rfc_message_id,
                                  direction, internal_date, header_to, header_cc)
       VALUES ($1, $2, $3, $4, $5, 'outgoing', now() - interval '1 hour', $6::text[], $7::text[])`,
      [workspaceId(), mailboxId(), `g87direct${String(messages)}`, `g87thread${String(messages)}`, rfcMessageId ?? null, to, cc],
    );
  };

  it('counts every personal-Gmail recipient of a direct message, once each, and holds on them', async () => {
    const before = await personalGmailRecipientsInWindow(context());
    // Three distinct personal-Gmail recipients across To and Cc — one of them named
    // twice — and one on a customer's own domain, which Google's rule is not about.
    await importDirect(
      ['first.person@gmail.com', 'second.person@googlemail.com', 'reception@northwind.example.test'],
      ['FIRST.PERSON@gmail.com', 'third.person@gmail.com'],
    );
    const after = await personalGmailRecipientsInWindow(context());
    expect(after.direct - before.direct).toBe(3);
    expect(after.automated).toBe(before.automated);
    expect(after.total).toBe(after.automated + after.direct);

    // A direct message to two Gmail recipients takes two places under the guard.
    await setGuard(after.total + 2);
    await importDirect(['fourth.person@gmail.com', 'fifth.person@gmail.com']);
    const blocked = await freshFence('exposure-direct', 'blocked.prospect@gmail.com');
    const held = await dispatch(blocked.fenceId, '2026-10-20T13:00:00.000Z');
    expect(held.report.outcome, why(held.report)).toBe('held');
    expect(held.report.refusal).toBe('domain_guard');
    expect(held.report.detail).toBe(`${String(after.total + 2)}/${String(after.total + 2)}`);
    expect(held.sends).toBe(0);

    // One more place and the same send goes: the refusal was the count.
    await setGuard(after.total + 3);
    const allowed = await freshFence('exposure-direct-room', 'allowed.prospect@gmail.com');
    expect((await dispatch(allowed.fenceId, '2026-10-20T13:00:00.000Z')).report.outcome).toBe('sent');
  });

  it('reserves an FSS send in doubt against the guard, and does not count its imported copy twice', async () => {
    const at = '2026-10-21T13:00:00.000Z';
    const before = await personalGmailRecipientsInWindow(context());

    // Gmail goes quiet: the fence is reconciling, and the message may well have left.
    const doubtful = await freshFence('exposure-doubt', 'doubtful.prospect@gmail.com');
    const quiet = await dispatch(doubtful.fenceId, at, 'indeterminate');
    expect(quiet.report.outcome, why(quiet.report)).toBe('reconciling');
    const inDoubt = await personalGmailRecipientsInWindow(context());
    expect(inDoubt.automated - before.automated).toBe(1);
    expect(inDoubt.direct).toBe(before.direct);

    // The sync imports the copy from Sent before reconciliation has matched it: it is
    // FSS's own message, by its deterministic Message-ID, and is counted once.
    const fence = await readFence(context(), doubtful.fenceId);
    const header = fence?.providerMessageIdHeader ?? '';
    await importDirect(['doubtful.prospect@gmail.com'], [], header.slice(1, -1));
    expect(await personalGmailRecipientsInWindow(context())).toEqual(inDoubt);

    // With the guard at exactly that exposure, the next personal-Gmail send holds.
    await setGuard(inDoubt.total);
    const next = await freshFence('exposure-after-doubt', 'next.prospect@gmail.com');
    const held = await dispatch(next.fenceId, at);
    expect(held.report.outcome, why(held.report)).toBe('held');
    expect(held.report.refusal).toBe('domain_guard');
    expect(held.sends).toBe(0);

    await setGuard(inDoubt.total + 1);
    const room = await freshFence('exposure-after-doubt-room', 'room.prospect@gmail.com');
    expect((await dispatch(room.fenceId, at)).report.outcome).toBe('sent');
  });

  it('serializes the decision: a claim waits for the one before it, then counts it', async () => {
    const at = '2026-10-22T13:00:00.000Z';
    const before = await personalGmailRecipientsInWindow(context());
    await setGuard(before.total + 1);

    // Another worker's claim, in flight: it holds the guard and has claimed its fence
    // to personal Gmail, and has not committed.
    const racing = await freshFence('serialize-other', 'racing.prospect@gmail.com');
    const ours = await freshFence('serialize-ours', 'ours.prospect@gmail.com');
    const mainPid = await backendPid(session());
    await extra.session.query('BEGIN');
    await lockDomainGuard(extra.context(workspaceId()));
    const claimed = await claimForDispatch(extra.context(workspaceId()), { outboundMessageId: racing.fenceId });
    expect(claimed.ok).toBe(true);

    const gmail = world.clientWith(world.alpha, {});
    const pending = tracked(
      dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail, now: () => new Date(at) }), {
        outboundMessageId: ours.fenceId,
      }),
    );
    // Ours waits on the guard rather than counting a total the other claim is about to change.
    await waitUntilBlocked(extra.session, mainPid, 'advisory');
    await settle(100);
    expect(pending.settled()).toBe(false);
    expect(gmail.sends).toHaveLength(0);

    await extra.session.query('COMMIT');
    const report = await pending.promise;
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('domain_guard');
    expect(gmail.sends).toHaveLength(0);

    // The control: with room for one more, the same shape sends.
    await setGuard(before.total + 2);
    const control = await freshFence('serialize-control', 'control.prospect@gmail.com');
    expect((await dispatch(control.fenceId, at)).report.outcome).toBe('sent');
  });
});
