import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { retireRoute } from '../../crm/index.ts';
import { authorizeDial, authorizeDialCommand, consumeDialTicket } from '../../dial/index.ts';
import {
  finalizeManualSuppression,
  isSuppressed,
  recordCorrection,
  recordSuppression,
  recordingSuppressionJournal,
} from '../../suppression/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * Appendix G scenarios 17, 21, 29 and 30, against a real PostgreSQL 16.
 *
 * These four are the ones this lane exists for, so they are written first and they
 * are written as the specification words them:
 *
 *  17. Dial command replay after suppression, route retirement, posture expiry, or
 *      ticket consumption yields no allow.
 *  21. Suppression update, delete, cross-key supersession, and unsupported
 *      canonicalizer change are refused.
 *  29. A manual suppression corrects at 9:59 while the finalizer races; correction
 *      wins or finalization wins atomically, never contact during the window.
 *  30. A prospect opt-out cannot use the salesperson correction path.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let policy: SeededPolicy;

const scopeFor = (
  workspaceId: string,
  userId: string,
  role: 'admin' | 'salesperson',
  db: SessionQueryable,
): RepositoryContext => repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role }), db);

const salespersonContext = (db: SessionQueryable = database.session): RepositoryContext =>
  scopeFor(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson', db);

/**
 * Run one unit of work in a real transaction, the way `runCommand` and the job
 * runner do in production. It matters here rather than being tidiness: the
 * correction claims the decision before it writes the event that satisfies
 * `suppression_finalizations_correction_fkey`, and that constraint is only deferred
 * until commit.
 */
async function inTransaction<T>(work: (session: SessionQueryable) => Promise<T>): Promise<T> {
  const session = await database.appRuntimeSession();
  await session.query('BEGIN');
  try {
    const value = await work(session);
    await session.query('COMMIT');
    return value;
  } catch (error) {
    await session.query('ROLLBACK');
    throw error;
  }
}

const dialInput = (): {
  firmId: string;
  contactId: string;
  routeId: string;
  routeVersion: number;
  callingIdentityId: string;
  at: string;
} => ({
  firmId: crm.alpha.firmId,
  contactId: crm.alpha.contactId,
  routeId: policy.alpha.phoneRouteId,
  routeVersion: policy.alpha.phoneRouteVersion,
  callingIdentityId: policy.alpha.callingIdentityId,
  at: policy.insideWindow,
});

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  policy = await seedPolicy(database.session, seeded, crm);
});

afterAll(async () => {
  await database.drop();
});

describe('scenario 17: no replay ever yields a second allow', () => {
  it('allows the first authorization and refuses the replay of the same command id', async () => {
    const context = salespersonContext();
    const first = await authorizeDialCommand(context, {
      ...dialInput(),
      deviceId: seeded.alpha.salesperson.deviceId,
      commandId: 'cmd-dial-first',
    });
    expect(first.ok).toBe(true);

    const replay = await authorizeDialCommand(context, {
      ...dialInput(),
      deviceId: seeded.alpha.salesperson.deviceId,
      commandId: 'cmd-dial-first',
    });
    expect(replay).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('refuses a second consumption of one ticket', async () => {
    const context = salespersonContext();
    const issued = await authorizeDialCommand(context, {
      ...dialInput(),
      deviceId: seeded.alpha.salesperson.deviceId,
      commandId: 'cmd-dial-consume',
    });
    if (!issued.ok) throw new Error(`expected a ticket, got ${issued.reason}`);

    // Consumption re-runs `authorizeDial` (lane g79, S10), calling window included, so
    // it takes the same pinned instant as the authorization. Left to database time it
    // passed only on weekdays 08:00-20:00 Providence time, and failed from 20:00 on
    // Friday 25 Sep 2026, 00:00Z (lane g101). The replay is asked at the same
    // in-window instant, so its refusal cannot be the window's.
    const consumed = await consumeDialTicket(context, {
      ticketId: issued.value.ticketId,
      deviceId: seeded.alpha.salesperson.deviceId,
      at: policy.insideWindow,
    });
    expect(consumed.ok).toBe(true);

    const again = await consumeDialTicket(context, {
      ticketId: issued.value.ticketId,
      deviceId: seeded.alpha.salesperson.deviceId,
      at: policy.insideWindow,
    });
    expect(again).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('re-decides the calling window at consumption, and a refused ticket stays unconsumed', async () => {
    // 23:59:30Z and 00:00:10Z on a Wednesday are 19:59:30 and 20:00:10 in
    // America/New_York: the window's end falls between issue and consumption. The
    // window is the firm's local clock, not a UTC date, so this refusal is the rule.
    const context = salespersonContext();
    const issued = await authorizeDialCommand(context, {
      ...dialInput(),
      at: '2026-09-16T23:59:30.000Z',
      deviceId: seeded.alpha.salesperson.deviceId,
      commandId: 'cmd-dial-window-close',
    });
    if (!issued.ok) throw new Error(`expected a ticket, got ${issued.reason}`);

    const input = { ticketId: issued.value.ticketId, deviceId: seeded.alpha.salesperson.deviceId };
    expect(await consumeDialTicket(context, { ...input, at: '2026-09-17T00:00:10.000Z' })).toEqual({
      ok: false,
      reason: 'outside_calling_window',
    });
    // The refusal wrote nothing, so the ticket is still decided on its merits once,
    // and then never again.
    expect((await consumeDialTicket(context, { ...input, at: policy.insideWindow })).ok).toBe(true);
    expect(await consumeDialTicket(context, { ...input, at: policy.insideWindow })).toEqual({
      ok: false,
      reason: 'already_consumed',
    });
  });

  it('refuses after a firm suppression, a retired route and an expired posture', async () => {
    // A separate workspace-shaped case for each cause, on the beta workspace's firm,
    // so the alpha assertions above stay independent of them.
    const context = scopeFor(
      seeded.beta.workspaceId,
      seeded.beta.salesperson.userId,
      'salesperson',
      database.session,
    );
    const input = {
      firmId: crm.beta.firmId,
      contactId: crm.beta.contactId,
      routeId: policy.beta.phoneRouteId,
      routeVersion: policy.beta.phoneRouteVersion,
      callingIdentityId: policy.beta.callingIdentityId,
      at: policy.insideWindow,
    };
    expect(await authorizeDial(context, input)).toMatchObject({ allowed: true });

    // (a) a review date in the past no longer expires the posture (wave 2, S4.2): an old
    // row is read, and the dial is still allowed.
    await database.session.query(
      "UPDATE state_postures SET review_at = TIMESTAMPTZ '2026-02-01 00:00:00+00' WHERE workspace_id = $1",
      [seeded.beta.workspaceId],
    );
    expect(await authorizeDial(context, input)).toMatchObject({ allowed: true });
    await database.session.query(
      "UPDATE state_postures SET review_at = TIMESTAMPTZ '2027-01-01 00:00:00+00' WHERE workspace_id = $1",
      [seeded.beta.workspaceId],
    );

    // (b) route retirement: the card's version is now stale and the route is retired.
    const retired = await retireRoute(context, {
      routeKind: 'phone',
      routeId: policy.beta.phoneRouteId,
      reason: 'wrong number',
    });
    expect(retired.ok).toBe(true);
    expect(await authorizeDial(context, input)).toEqual({ allowed: false, reason: 'route_version_stale' });
    if (retired.ok) {
      expect(await authorizeDial(context, { ...input, routeVersion: retired.value.version })).toEqual({
        allowed: false,
        reason: 'route_retired',
      });
    }

    // (c) suppression: the firm is suppressed, and suppression is checked first.
    const journal = recordingSuppressionJournal();
    const suppression = await recordSuppression(context, {
      scope: 'firm',
      firmId: crm.beta.firmId,
      source: 'prospect_do_not_call',
      commandId: 'cmd-beta-suppress',
      journal,
    });
    expect(suppression.ok).toBe(true);
    expect(await authorizeDial(context, input)).toEqual({ allowed: false, reason: 'firm_suppressed' });
  });
});

describe('scenario 21: the insert-only protocol refuses everything else', () => {
  it('refuses UPDATE and DELETE on suppression_events for the application role', async () => {
    const app = await database.appRuntimeSession();
    await expect(app.query('UPDATE suppression_events SET source = $1', ['import'])).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.query('DELETE FROM suppression_events')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a supersession that names another scope or another canonical key', async () => {
    const context = salespersonContext();
    const journal = recordingSuppressionJournal();
    const original = await recordSuppression(context, {
      scope: 'handle',
      value: '+14015550133',
      source: 'salesperson_manual',
      commandId: 'cmd-cross-key-original',
      journal,
    });
    if (!original.ok) throw new Error(`expected an event, got ${original.reason}`);

    await expect(
      database.session.query(
        `INSERT INTO suppression_events
           (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
            actor_user_id, supersedes_event_id, supersession_reason)
         VALUES ($1, 'cross-key-supersession', 'handle', '+14015550199', $2, 'mistaken_entry_correction', $3, $4, 'mistaken_entry')`,
        [
          seeded.alpha.workspaceId,
          original.value.canonicalizerVersion,
          seeded.alpha.salesperson.userId,
          original.value.eventId,
        ],
      ),
    ).rejects.toMatchObject({ constraint: 'suppression_events_supersession_same_key' });
  });

  it('refuses a correction to an event written by an unsupported canonicalizer', async () => {
    await database.session.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id)
       VALUES ($1, 'unsupported-canonicalizer', 'handle', '+14015550144', 'e164-lower.99', 'salesperson_manual', $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
    );
    const correction = await recordCorrection(salespersonContext(), {
      eventId: 'unsupported-canonicalizer',
      commandId: 'cmd-unsupported',
      journal: recordingSuppressionJournal(),
    });
    expect(correction).toEqual({ ok: false, reason: 'canonicalizer_unsupported' });
  });
});

describe('scenario 29: correction races the finalizer, and one of them wins', () => {
  it('never permits contact during the ten-minute window', async () => {
    const context = salespersonContext();
    const recorded = await recordSuppression(context, {
      scope: 'firm',
      firmId: crm.alpha.firmId,
      source: 'salesperson_manual',
      commandId: 'cmd-window-suppress',
      journal: recordingSuppressionJournal(),
    });
    if (!recorded.ok) throw new Error(`expected an event, got ${recorded.reason}`);

    // Effective immediately, and the review hold exists beside it.
    expect(await isSuppressed(context, { scope: 'firm', canonicalKey: crm.alpha.firmId })).not.toBeNull();
    expect(recorded.value.reviewHoldIds.length).toBeGreaterThan(0);
    expect(await authorizeDial(context, dialInput())).toEqual({ allowed: false, reason: 'firm_suppressed' });
  });

  it('lets the correction win when it claims first, and releases only its own hold', async () => {
    const context = salespersonContext();
    // A handle nothing else in this file touches: scenario 29's first case already
    // suppressed the firm key for good, and a lifted suppression has to be provably
    // lifted rather than shadowed by somebody else's event on the same key.
    const recorded = await recordSuppression(context, {
      scope: 'handle',
      value: '+14015550188',
      firmId: crm.alpha.firmId,
      source: 'salesperson_manual',
      commandId: 'cmd-correct-first',
      journal: recordingSuppressionJournal(),
    });
    if (!recorded.ok) throw new Error(`expected an event, got ${recorded.reason}`);
    const deadline = recorded.value.correctionDeadline;
    if (deadline === null) throw new Error('a manual suppression has a correction deadline');

    // A second, unrelated hold on the same firm. Section 4.3: "clearing one hold
    // never clears another", and this is the one that must survive.
    const other = await database.session.query<{ id: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
                                 source_event_kind, source_event_id)
       VALUES ($1, 'firm', $2, 'uncertain_reply', ARRAY['dial_authorization']::text[], 'message.received', 'other-event')
       RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );

    const correction = await inTransaction(async session =>
      await recordCorrection(salespersonContext(session), {
        eventId: recorded.value.eventId,
        commandId: 'cmd-correct-first-correction',
        journal: recordingSuppressionJournal(),
      }),
    );
    if (!correction.ok) throw new Error(`expected the correction to win, got ${correction.reason}`);
    expect(correction.value.releasedHoldIds).toHaveLength(1);
    expect(correction.value.blockedMilliseconds).toBeGreaterThanOrEqual(0);

    // The suppression is lifted, the other hold is not.
    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: '+14015550188' })).toBeNull();
    const survivor = await database.session.query<{ released_at: Date | null }>(
      'SELECT released_at FROM active_holds WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, other.rows[0]?.id],
    );
    expect(survivor.rows[0]?.released_at).toBeNull();

    // And the finalizer that wakes at the deadline loses, atomically.
    const finalizerContext = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
      database.session,
    );
    expect(await finalizeManualSuppression(finalizerContext, { eventId: recorded.value.eventId, at: deadline })).toBe(
      'lost_to_correction',
    );

    await database.session.query('UPDATE active_holds SET released_at = now() WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      other.rows[0]?.id,
    ]);
  });

  it('lets the finalizer win when it claims first, and the correction is refused', async () => {
    const context = salespersonContext();
    const recorded = await recordSuppression(context, {
      scope: 'handle',
      value: '+14015550155',
      firmId: crm.alpha.firmId,
      source: 'salesperson_manual',
      commandId: 'cmd-finalize-first',
      journal: recordingSuppressionJournal(),
    });
    if (!recorded.ok) throw new Error(`expected an event, got ${recorded.reason}`);
    const deadline = recorded.value.correctionDeadline;
    if (deadline === null) throw new Error('a manual suppression has a correction deadline');

    const finalizerContext = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
      database.session,
    );
    expect(await finalizeManualSuppression(finalizerContext, { eventId: recorded.value.eventId, at: deadline })).toBe(
      'finalized',
    );
    // Idempotent: the same job run twice writes once.
    expect(await finalizeManualSuppression(finalizerContext, { eventId: recorded.value.eventId, at: deadline })).toBe(
      'already_finalized',
    );

    const correction = await inTransaction(async session =>
      await recordCorrection(salespersonContext(session), {
        eventId: recorded.value.eventId,
        commandId: 'cmd-finalize-first-correction',
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(correction).toEqual({ ok: false, reason: 'already_finalized' });
    // Never contact: the suppression the finalizer made terminal is still effective.
    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: '+14015550155' })).not.toBeNull();

    const { rows } = await database.session.query<{ outcome: string }>(
      'SELECT outcome FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = $2',
      [seeded.alpha.workspaceId, recorded.value.eventId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('finalized');
  });

  it('serializes two corrections racing on two connections into one winner', async () => {
    const context = salespersonContext();
    const recorded = await recordSuppression(context, {
      scope: 'handle',
      value: '+14015550177',
      firmId: crm.alpha.firmId,
      source: 'salesperson_manual',
      commandId: 'cmd-two-corrections',
      journal: recordingSuppressionJournal(),
    });
    if (!recorded.ok) throw new Error(`expected an event, got ${recorded.reason}`);

    const one = await database.appRuntimeSession();
    const two = await database.appRuntimeSession();
    const attempt = async (session: SessionQueryable, commandId: string): Promise<boolean> => {
      await session.query('BEGIN');
      try {
        const outcome = await recordCorrection(salespersonContext(session), {
          eventId: recorded.value.eventId,
          commandId,
          journal: recordingSuppressionJournal(),
        });
        await session.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
        return outcome.ok;
      } catch (error) {
        await session.query('ROLLBACK');
        throw error;
      }
    };

    const results = await Promise.all([attempt(one, 'cmd-race-a'), attempt(two, 'cmd-race-b')]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1 AND supersedes_event_id = $2",
      [seeded.alpha.workspaceId, recorded.value.eventId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe('scenario 30: a prospect opt-out is never salesperson-reversible', () => {
  it('refuses the salesperson correction path for a prospect-originated event', async () => {
    const context = salespersonContext();
    const recorded = await recordSuppression(context, {
      scope: 'handle',
      value: '+14015550166',
      firmId: crm.alpha.firmId,
      source: 'prospect_opt_out',
      commandId: 'cmd-optout',
      journal: recordingSuppressionJournal(),
    });
    if (!recorded.ok) throw new Error(`expected an event, got ${recorded.reason}`);
    expect(recorded.value.terminal).toBe(true);
    expect(recorded.value.reviewHoldIds).toEqual([]);

    const correction = await recordCorrection(context, {
      eventId: recorded.value.eventId,
      commandId: 'cmd-optout-correct',
      journal: recordingSuppressionJournal(),
    });
    expect(correction).toEqual({ ok: false, reason: 'not_salesperson_originated' });
  });
});
