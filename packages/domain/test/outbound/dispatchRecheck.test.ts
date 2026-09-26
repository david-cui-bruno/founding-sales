import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { setManualControlMode } from '../../crm/pipeline.ts';
import { COVERAGE_FRESHNESS_SECONDS, runMailSync } from '../../mail/index.ts';
import {
  claimedAutomatedSends,
  dispatchOutboundMessage,
  readFence,
  type SendReport,
} from '../../outbound/index.ts';
import { openHold, releaseHold } from '../../policy/index.ts';
import { recordHolidayCalendar, stopEnrollments } from '../../sequences/index.ts';
import {
  TEMPLATE_BODY,
  TEMPLATE_SUBJECT,
  createOutboundWorld,
  type OutboundWorld,
} from './support/outboundWorld.ts';
import { automatedSent, prepareFor, seedFirm } from './support/dispatchFixtures.ts';

/**
 * The dispatch re-asks everything, immediately before the claim (lane g77: S02, S03,
 * S05, S09).
 *
 * Each scenario prepares a fence while the world is sendable, changes one fact the
 * specification says the send must re-read — 11.2's list — and dispatches. Before lane
 * g77 every one of these sent, because the dispatch gate asked five of the questions
 * itself and never the rest: a revoked template approval, a route re-decided since the
 * fence froze it, a `candidate` route, manual mode, a stopped enrollment, an email
 * channel pause, a reassignment, a mailbox whose `ready` flag outlived its coverage,
 * a holiday, and a cap charged to the day the fence was planned rather than the day it
 * left.
 *
 * ## The vacuous-pass trap
 *
 * "Held" is cheap: a world that could never send holds everything. So every refusal
 * names its reason, and each group ends with the same shape sending once the one fact
 * is put back — the refusal was that fact and nothing else.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());
const admin = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(workspaceId(), { kind: 'user', userId: world.alpha.workspace.admin.userId, role: 'admin' }),
    world.database.session,
  );

async function dispatch(fenceId: string, at?: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(
    context(),
    world.sendDeps(world.alpha, { gmail, ...(at === undefined ? {} : { now: () => new Date(at) }) }),
    { outboundMessageId: fenceId },
  );
  return { report, sends: gmail.sends.length };
}

const why = (report: SendReport): string => `${report.outcome} ${report.refusal ?? ''} ${report.detail ?? ''}`;

describe('S02: the complete eligibility, asked again at the claim', () => {
  it('refuses a fence whose template approval was withdrawn after it was prepared', async () => {
    const firm = await seedFirm(world, world.alpha, 'template');
    // A template version of its own, so withdrawing it leaves the world's alone.
    const templateId = '33333333-4444-4555-8666-777777777777';
    const hash = createHash('sha256').update(`g77 fixture template ${templateId}`, 'utf8').digest('hex');
    const { rows } = await world.database.session.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, approved_at, approved_by_user_id)
       VALUES ($1, $2, 1, 'Withdrawn later', $3, $4, $5, 'Signed off', now(), $6)
       RETURNING id`,
      [workspaceId(), templateId, TEMPLATE_SUBJECT, TEMPLATE_BODY, hash, world.alpha.workspace.admin.userId],
    );
    const templateVersionId = rows[0]?.id ?? '';
    const fenceId = await prepareFor(world, world.alpha, firm, { templateVersionId, templateContentHash: hash });

    // Nothing retires a version since wave 2 (S3) but a stored row still can be one.
    const retired = await world.database.session.query(
      'UPDATE template_versions SET retired_at = now() WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), templateVersionId],
    );
    expect(retired.rowCount).toBe(1);

    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('template_unapproved');
    expect(sends).toBe(0);
  });

  it('refuses a fence whose frozen route was re-decided since, even though it is usable again', async () => {
    const firm = await seedFirm(world, world.alpha, 'route-version');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const frozen = await readFence(context(), fenceId);

    // A bounce invalidates the route and a person restores it: usable, two versions on.
    for (const eligibility of ['invalid', 'usable']) {
      await world.database.session.query(
        `UPDATE email_addresses SET eligibility = $3, version = version + 1, updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId(), firm.routeId, eligibility],
      );
    }

    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('route_invalid');
    expect(report.detail).toBe(
      `route_invalid:version:${String(frozen?.recipientRouteVersion)}->${String((frozen?.recipientRouteVersion ?? 0) + 2)}`,
    );
    expect(sends).toBe(0);

    // A fence prepared on the route as it is now names the current version, and goes.
    await world.clearHolds(workspaceId());
    const fresh = await prepareFor(world, world.alpha, firm);
    expect((await dispatch(fresh)).report.outcome).toBe('sent');
  });

  it('refuses a candidate route, which the gate used to let through', async () => {
    const firm = await seedFirm(world, world.alpha, 'route-candidate');
    const fenceId = await prepareFor(world, world.alpha, firm);
    await world.database.session.query(
      `UPDATE email_addresses SET eligibility = 'candidate', version = version + 1, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), firm.routeId],
    );
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('route_invalid');
    expect(report.detail ?? '').toMatch(/^route_candidate/);
    expect(sends).toBe(0);
  });

  it('refuses a fence whose opportunity went manual after planning', async () => {
    const firm = await seedFirm(world, world.alpha, 'manual');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const manual = await setManualControlMode(context(), {
      opportunityId: firm.opportunityId,
      reason: 'the salesperson took it over',
      origin: 'salesperson_command',
    });
    expect(manual.ok).toBe(true);

    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail ?? '').toMatch(/^opportunity_manual/);
    expect(sends).toBe(0);
    // A refusal that is somebody else's state opens no hold of its own.
    const { rows } = await world.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM active_holds
        WHERE workspace_id = $1 AND source_event_id = $2 AND released_at IS NULL`,
      [workspaceId(), fenceId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('refuses a fence whose enrollment was stopped after planning', async () => {
    const firm = await seedFirm(world, world.alpha, 'stopped');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const fence = await readFence(context(), fenceId);
    await stopEnrollments(context(), { enrollmentId: fence?.enrollmentId ?? '', reason: 'admin_stop' });

    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail).toBe('scoped_pause:enrollment_ended');
    expect(sends).toBe(0);
  });

  it('refuses a fence whose firm was reassigned before it was claimed', async () => {
    const firm = await seedFirm(world, world.alpha, 'reassigned');
    const fenceId = await prepareFor(world, world.alpha, firm);
    await world.database.session.query('UPDATE firms SET assigned_user_id = $3 WHERE workspace_id = $1 AND id = $2', [
      workspaceId(),
      firm.firmId,
      world.alpha.workspace.admin.userId,
    ]);
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail ?? '').toMatch(/^reassignment/);
    expect(sends).toBe(0);
  });

  it('honours an email channel pause, which no send path asked about before', async () => {
    const firm = await seedFirm(world, world.alpha, 'channel');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const holdId = await openHold(context(), {
      scopeKind: 'channel',
      scopeKey: 'email',
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['email_send'],
      sourceEventKind: 'administrative_pause',
      recoveryAction: 'release_pause',
    });
    const paused = await dispatch(fenceId);
    expect(paused.report.outcome, why(paused.report)).toBe('held');
    expect(paused.report.refusal).toBe('step_ineligible');
    expect(paused.report.detail).toBe('scoped_pause');
    expect(paused.sends).toBe(0);

    await releaseHold(context(), holdId);
    const released = await dispatch(fenceId);
    expect(released.report.outcome, why(released.report)).toBe('sent');
    expect(released.sends).toBe(1);
  });
});

describe('S03: proven coverage, not a ready flag', () => {
  const watermark = async (): Promise<{ readonly watermarkAt: Date | null; readonly attemptAt: Date | null }> => {
    const { rows } = await world.database.session.query<{
      coverage_watermark_at: Date | null;
      last_synced_at: Date | null;
    }>('SELECT coverage_watermark_at, last_synced_at FROM mailboxes WHERE workspace_id = $1 AND id = $2', [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    return { watermarkAt: rows[0]?.coverage_watermark_at ?? null, attemptAt: rows[0]?.last_synced_at ?? null };
  };
  const sync = async (overrides: { readonly rateLimited?: boolean }) =>
    await withTransaction(
      world.database.session,
      async () =>
        await runMailSync(
          context(),
          world.syncDeps(world.alpha, { gmail: world.clientWith(world.alpha, { messages: [], ...overrides }) }),
          { mailboxId: world.alpha.mailboxId },
        ),
    );

  it('holds a send whose coverage was last proved longer ago than the window, however ready the mailbox says it is', async () => {
    const firm = await seedFirm(world, world.alpha, 'coverage');
    const fenceId = await prepareFor(world, world.alpha, firm);
    await world.database.session.query(
      `UPDATE mailboxes SET coverage_watermark_at = now() - make_interval(secs => $3)
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), world.alpha.mailboxId, COVERAGE_FRESHNESS_SECONDS + 300],
    );

    const stale = await dispatch(fenceId);
    expect(stale.report.outcome, why(stale.report)).toBe('held');
    expect(stale.report.refusal).toBe('coverage_incomplete');
    expect(stale.report.detail ?? '').toMatch(/^coverage_incomplete:stale:/);
    expect(stale.sends).toBe(0);

    // A rate-limited sync is an attempt, not a success: `last_synced_at` moves, the
    // watermark does not, and the send stays held.
    const before = await watermark();
    const limited = await sync({ rateLimited: true });
    expect(limited.outcome).toBe('rate_limited');
    const after = await watermark();
    expect(after.attemptAt?.getTime() ?? 0).toBeGreaterThan(before.attemptAt?.getTime() ?? 0);
    expect(after.watermarkAt?.toISOString()).toBe(before.watermarkAt?.toISOString());
    const stillStale = await dispatch(fenceId);
    expect(stillStale.report.outcome, why(stillStale.report)).toBe('held');
    expect(stillStale.report.refusal).toBe('coverage_incomplete');
    expect(stillStale.sends).toBe(0);

    // A sync that finishes the history proves coverage now, and the same fence goes.
    const synced = await sync({});
    expect(synced.outcome).toBe('synced');
    expect((await watermark()).watermarkAt?.getTime() ?? 0).toBeGreaterThan(before.watermarkAt?.getTime() ?? 0);
    const fresh = await dispatch(fenceId);
    expect(fresh.report.outcome, why(fresh.report)).toBe('sent');
    expect(fresh.sends).toBe(1);
  });
});

describe('S05: the cap counts on the business date of the claim', () => {
  it('a fence planned for one day and held into the next is the next day’s send', async () => {
    const firm = await seedFirm(world, world.alpha, 'next-day');
    const planned = '2026-09-28';
    const claimed = '2026-09-29';
    const fenceId = await prepareFor(world, world.alpha, firm, { businessDate: planned });

    // Monday, three in the morning in the firm's zone: the window holds it overnight.
    const night = await dispatch(fenceId, '2026-09-28T03:00:00.000Z');
    expect(night.report.outcome, why(night.report)).toBe('held');
    expect(night.report.refusal).toBe('outside_email_window');
    await world.clearHolds(workspaceId());

    const plannedBefore = await automatedSent(world.database.session, world.alpha, planned);
    const claimedBefore = await automatedSent(world.database.session, world.alpha, claimed);

    // Tuesday morning it goes, and Tuesday pays for it.
    const morning = await dispatch(fenceId, '2026-09-29T13:00:00.000Z');
    expect(morning.report.outcome, why(morning.report)).toBe('sent');
    expect(await automatedSent(world.database.session, world.alpha, claimed)).toBe(claimedBefore + 1);
    expect(await automatedSent(world.database.session, world.alpha, planned)).toBe(plannedBefore);
    expect((await readFence(context(), fenceId))?.businessDate).toBe(claimed);

    // And the counter is the fences, on both days.
    for (const date of [planned, claimed]) {
      expect(await claimedAutomatedSends(context(), { mailboxId: world.alpha.mailboxId, businessDate: date })).toBe(
        await automatedSent(world.database.session, world.alpha, date),
      );
    }
  });
});

describe('S09: the dispatch window knows the holidays', () => {
  it('refuses on a holiday the current calendar names, and sends once it is removed', async () => {
    const firm = await seedFirm(world, world.alpha, 'holiday-current');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const holiday = '2026-09-30T13:00:00.000Z';

    const recorded = await recordHolidayCalendar(admin(), { version: 'g77-current.1', dates: ['2026-09-30'] });
    expect(recorded.ok).toBe(true);
    const refused = await dispatch(fenceId, holiday);
    expect(refused.report.outcome, why(refused.report)).toBe('held');
    expect(refused.report.refusal).toBe('outside_email_window');
    expect(refused.sends).toBe(0);

    const cleared = await recordHolidayCalendar(admin(), { version: 'g77-current.2', dates: [] });
    expect(cleared.ok).toBe(true);
    await world.clearHolds(workspaceId());
    const sent = await dispatch(fenceId, holiday);
    expect(sent.report.outcome, why(sent.report)).toBe('sent');
  });

  it('refuses on a holiday the enrollment’s frozen calendar names, although the current one does not', async () => {
    const frozenVersion = 'g77-frozen.1';
    expect((await recordHolidayCalendar(admin(), { version: frozenVersion, dates: ['2026-10-01'] })).ok).toBe(true);
    // Superseded at once: the current calendar no longer names the day.
    expect((await recordHolidayCalendar(admin(), { version: 'g77-after.1', dates: [] })).ok).toBe(true);

    const held = await seedFirm(world, world.alpha, 'holiday-frozen');
    const heldFence = await prepareFor(world, world.alpha, held);
    await world.database.session.query(
      `UPDATE sequence_enrollments SET holiday_calendar_version = $3
        WHERE workspace_id = $1 AND id = (SELECT enrollment_id FROM outbound_messages WHERE workspace_id = $1 AND id = $2)`,
      [workspaceId(), heldFence, frozenVersion],
    );
    const control = await seedFirm(world, world.alpha, 'holiday-control');
    const controlFence = await prepareFor(world, world.alpha, control);

    const holiday = '2026-10-01T13:00:00.000Z';
    const refused = await dispatch(heldFence, holiday);
    expect(refused.report.outcome, why(refused.report)).toBe('held');
    expect(refused.report.refusal).toBe('outside_email_window');
    expect(refused.sends).toBe(0);
    const sent = await dispatch(controlFence, holiday);
    expect(sent.report.outcome, why(sent.report)).toBe('sent');
  });
});
