import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { POSTURE_STATEMENT_KEYS, selectApplicablePosture } from '../../src/rules/statePosture.ts';
import { CALLING_WINDOW_FLOOR } from '../../src/rules/callingWindow.ts';
import {
  currentCallingWindow,
  evaluateConfiguredCallingWindow,
  listApplicableHolds,
  openPause,
  recordStatePosture,
  releasePause,
  revokeStatePosture,
  setCallingWindow,
} from '../../policy/index.ts';
import { authorizeDial, callOutcomeEffects, logCallOutcome } from '../../dial/index.ts';
import { isSuppressed, recordingSuppressionJournal } from '../../suppression/index.ts';
import { readOpenOpportunity } from '../../crm/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { POSTURE_STATE, seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * Policy, pauses and call outcomes: Appendix G scenarios 6, 25 and 26, and the
 * parts of deliverables 1, 4 and 5 that are not in `appendixG.test.ts`.
 *
 *   6. Opt-out commits while email and dial work is queued or claimed, including a
 *      shared handle: no post-commit external action.
 *  25. Policy versions with zero, one, and two applicable rows fail, allow, and fail
 *      respectively.
 *  26. Engaged call outcome after handoff prevents every successor.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let policy: SeededPolicy;

const contextFor = (
  workspaceId: string,
  userId: string,
  role: 'admin' | 'salesperson',
  db: SessionQueryable = database.session,
): RepositoryContext => repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role }), db);

const salesperson = (): RepositoryContext =>
  contextFor(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson');
const admin = (): RepositoryContext => contextFor(seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin');
const betaSalesperson = (): RepositoryContext =>
  contextFor(seeded.beta.workspaceId, seeded.beta.salesperson.userId, 'salesperson');

const dialInput = (): Parameters<typeof authorizeDial>[1] => ({
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

describe('scenario 25: zero, one and two applicable postures', () => {
  it('fails on zero, allows on one, and fails on two', async () => {
    const context = salesperson();

    // One: the seeded posture. Allow.
    expect(await authorizeDial(context, dialInput())).toMatchObject({ allowed: true });

    // Two: refused by the database before it can ever be read as an allow.
    const overlapping = await recordStatePosture(admin(), {
      state: POSTURE_STATE,
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      confirmedStatements: [...POSTURE_STATEMENT_KEYS],
    });
    expect(overlapping).toEqual({ ok: false, reason: 'posture_overlapping' });

    // Two applicable rows cannot be reached through the database at all: the
    // exclusion constraint refuses the second one, revoked or not. The reader fails
    // closed anyway, because a restore or a migration is not bound by the same
    // constraint in the instant before it is revalidated.
    await expect(
      database.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at, rules_revision,
                                     confirmed_statements, confirmed_by_user_id)
         VALUES ($1, $2, 2, TIMESTAMPTZ '2026-06-01 00:00:00+00', TIMESTAMPTZ '2027-06-01 00:00:00+00', 2,
                 ARRAY['businessToBusiness']::text[], $3)`,
        [seeded.alpha.workspaceId, POSTURE_STATE, seeded.alpha.admin.userId],
      ),
    ).rejects.toMatchObject({ constraint: 'state_postures_no_overlap' });
    expect(
      selectApplicablePosture(
        [
          { state: POSTURE_STATE, revision: 1, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, reviewAt: '2027-01-01T00:00:00.000Z', revokedAt: null },
          { state: POSTURE_STATE, revision: 2, effectiveFrom: '2026-06-01T00:00:00.000Z', effectiveTo: null, reviewAt: '2027-06-01T00:00:00.000Z', revokedAt: null },
        ],
        POSTURE_STATE,
        policy.insideWindow,
      ),
    ).toEqual({ kind: 'refused', reason: 'posture_overlapping' });

    // Zero: revoke the only one.
    const revoked = await revokeStatePosture(admin(), { postureId: policy.alpha.postureId });
    expect(revoked.ok).toBe(true);
    expect(await authorizeDial(context, dialInput())).toEqual({ allowed: false, reason: 'posture_missing' });
    expect(await revokeStatePosture(admin(), { postureId: policy.alpha.postureId })).toEqual({
      ok: false,
      reason: 'posture_already_revoked',
    });

    // Put it back so the rest of the file has one applicable posture again.
    await database.session.query(
      'UPDATE state_postures SET revoked_at = NULL, revoked_by_user_id = NULL WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, policy.alpha.postureId],
    );
    expect(await authorizeDial(context, dialInput())).toMatchObject({ allowed: true });
  });

  it('records the sources from the domain package and refuses a partial confirmation', async () => {
    const recorded = await recordStatePosture(admin(), {
      state: 'MA',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      confirmedStatements: [...POSTURE_STATEMENT_KEYS],
    });
    if (!recorded.ok) throw new Error(`expected a posture, got ${recorded.reason}`);
    expect(recorded.value.rulesRevision).toBe(2);
    expect(recorded.value.sources.length).toBeGreaterThan(0);
    for (const source of recorded.value.sources) expect(source.url.startsWith('https://')).toBe(true);
    // One calendar year, from `postureReviewAt`.
    expect(recorded.value.reviewAt).toBe('2027-01-01T00:00:00.000Z');

    expect(
      await recordStatePosture(admin(), {
        state: 'TX',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        confirmedStatements: ['businessToBusiness'],
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('is admin-only', async () => {
    expect(
      await recordStatePosture(salesperson(), {
        state: 'CT',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        confirmedStatements: [...POSTURE_STATEMENT_KEYS],
      }),
    ).toEqual({ ok: false, reason: 'admin_only' });
  });
});

describe('the calling window narrows the floor and never widens it', () => {
  it('refuses a configuration outside the floor and accepts one inside it', async () => {
    expect(await setCallingWindow(admin(), { startMinute: 7 * 60, endMinute: 17 * 60 })).toEqual({
      ok: false,
      reason: 'window_not_narrower',
    });
    expect(await setCallingWindow(admin(), { startMinute: 9 * 60, endMinute: 21 * 60 })).toEqual({
      ok: false,
      reason: 'window_not_narrower',
    });
    expect(await setCallingWindow(admin(), { startMinute: 9 * 60, endMinute: 17 * 60, weekdays: [6] })).toEqual({
      ok: false,
      reason: 'window_not_narrower',
    });
    expect(await setCallingWindow(salesperson(), { startMinute: 9 * 60, endMinute: 17 * 60 })).toEqual({
      ok: false,
      reason: 'admin_only',
    });
  });

  it('defaults to the floor, then supersedes one configuration with the next', async () => {
    const beta = contextFor(seeded.beta.workspaceId, seeded.beta.admin.userId, 'admin');
    expect(await currentCallingWindow(beta)).toMatchObject({ version: 0, window: CALLING_WINDOW_FLOOR });

    const first = await setCallingWindow(beta, { startMinute: 9 * 60, endMinute: 17 * 60 });
    if (!first.ok) throw new Error(`expected a window, got ${first.reason}`);
    const second = await setCallingWindow(beta, { startMinute: 10 * 60, endMinute: 16 * 60, weekdays: [1, 2, 3] });
    if (!second.ok) throw new Error(`expected a window, got ${second.reason}`);
    expect(second.value.version).toBe(2);

    const current = await currentCallingWindow(beta);
    expect(current.window).toEqual({ startMinute: 600, endMinute: 960 });
    expect(current.weekdays).toEqual([1, 2, 3]);

    // 2026-09-17 is a Thursday: inside the hours, outside the configured weekdays.
    expect(evaluateConfiguredCallingWindow('2026-09-17T15:00:00.000Z', 'America/New_York', current)).toMatchObject({
      allowed: false,
      refusal: 'outside_calling_window',
    });
    // The same hour on the Wednesday is allowed.
    expect(evaluateConfiguredCallingWindow('2026-09-16T15:00:00.000Z', 'America/New_York', current)).toMatchObject({
      allowed: true,
    });
    // And a firm with no zone cannot be placed on any clock.
    expect(evaluateConfiguredCallingWindow('2026-09-16T15:00:00.000Z', null, current)).toMatchObject({
      allowed: false,
      refusal: 'zone_unknown',
    });
  });
});

describe('scoped pauses are holds with history, never suppressions', () => {
  it('blocks the dial while it is open, and only the hold it opened when released', async () => {
    const context = salesperson();
    expect(await authorizeDial(context, dialInput())).toMatchObject({ allowed: true });

    const paused = await openPause(admin(), { scopeKind: 'channel', channel: 'call', reasonNote: 'holiday' });
    if (!paused.ok) throw new Error(`expected a pause, got ${paused.reason}`);
    expect(await authorizeDial(context, dialInput())).toEqual({ allowed: false, reason: 'scoped_pause' });

    // A pause is never a suppression (10.1, decision table).
    expect(await isSuppressed(context, { scope: 'firm', canonicalKey: crm.alpha.firmId })).toBeNull();

    const released = await releasePause(admin(), { pauseId: paused.value.id });
    expect(released.ok).toBe(true);
    expect(await authorizeDial(context, dialInput())).toMatchObject({ allowed: true });
    expect(await releasePause(admin(), { pauseId: paused.value.id })).toEqual({
      ok: false,
      reason: 'pause_already_released',
    });
  });

  it('leaves manual calling alone when only sending is paused', async () => {
    const paused = await openPause(admin(), { scopeKind: 'channel', channel: 'email' });
    if (!paused.ok) throw new Error(`expected a pause, got ${paused.reason}`);
    // "A sending pause does not stop ... manual calling unless calling is separately paused."
    expect(await authorizeDial(salesperson(), dialInput())).toMatchObject({ allowed: true });
    expect(
      await listApplicableHolds(salesperson(), { actionKind: 'email_send', firmId: crm.alpha.firmId, channel: 'email' }),
    ).toHaveLength(1);
    await releasePause(admin(), { pauseId: paused.value.id });
  });

  it('never crosses workspaces', async () => {
    const paused = await openPause(admin(), { scopeKind: 'all_automation' });
    if (!paused.ok) throw new Error(`expected a pause, got ${paused.reason}`);
    expect(await authorizeDial(salesperson(), dialInput())).toEqual({ allowed: false, reason: 'scoped_pause' });
    expect(
      await authorizeDial(betaSalesperson(), {
        firmId: crm.beta.firmId,
        contactId: crm.beta.contactId,
        routeId: policy.beta.phoneRouteId,
        routeVersion: policy.beta.phoneRouteVersion,
        callingIdentityId: policy.beta.callingIdentityId,
        at: policy.insideWindow,
      }),
    ).toMatchObject({ allowed: true });
    await releasePause(admin(), { pauseId: paused.value.id });
  });

  it('is admin-only and refuses an inconsistent scope', async () => {
    expect(await openPause(salesperson(), { scopeKind: 'workspace' })).toEqual({ ok: false, reason: 'admin_only' });
    expect(await openPause(admin(), { scopeKind: 'workspace', scopeKey: 'anything' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(await openPause(admin(), { scopeKind: 'channel' })).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('the 9.1 outcome table', () => {
  it('maps every outcome to the effect the specification gives it', () => {
    expect(callOutcomeEffects('interested')).toMatchObject({ setsManual: true, stepEffect: 'complete_and_advance' });
    expect(callOutcomeEffects('referral_or_wrong_person')).toMatchObject({ setsManual: true });
    expect(callOutcomeEffects('callback_requested')).toMatchObject({
      setsManual: true,
      createsCallbackOnConfirmation: true,
    });
    expect(callOutcomeEffects('not_interested')).toMatchObject({ setsManual: true, suggestsLost: true });
    expect(callOutcomeEffects('do_not_call')).toMatchObject({ suppressesNumber: true });
    // "Wrong number — retire the route; do not suppress the firm."
    expect(callOutcomeEffects('wrong_number')).toMatchObject({ retiresRoute: true, suppressesNumber: false, setsManual: false });
    expect(callOutcomeEffects('voicemail_left')).toMatchObject({ stepEffect: 'complete_and_advance' });
    // "No answer or busy — follow the step's configured advance | retry_call behavior."
    expect(callOutcomeEffects('no_answer', 'retry_call').stepEffect).toBe('retry_call');
    expect(callOutcomeEffects('busy', 'advance').stepEffect).toBe('advance');
    // A retry behaviour offered for another outcome changes nothing.
    expect(callOutcomeEffects('interested', 'retry_call').stepEffect).toBe('complete_and_advance');
    // "Policy or technical failure — do not complete the step."
    expect(callOutcomeEffects('policy_or_technical_failure').stepEffect).toBe('none');
  });
});

describe('scenario 26: an engaged call outcome prevents every successor', () => {
  it('sets the opportunity manual and records the step effect', async () => {
    const context = betaSalesperson();
    const before = await readOpenOpportunity(context, crm.beta.firmId);
    expect(before?.control_mode).toBe('automated');

    const logged = await logCallOutcome(context, {
      firmId: crm.beta.firmId,
      contactId: crm.beta.contactId,
      routeId: policy.beta.phoneRouteId,
      outcome: 'interested',
      occurredAt: policy.insideWindow,
      note: 'wants a demo',
      commandId: 'cmd-beta-interested',
    });
    if (!logged.ok) throw new Error(`expected a call log, got ${logged.reason}`);
    expect(logged.value.setManual).toBe(true);
    expect(logged.value.stepEffect).toBe('complete_and_advance');

    const after = await readOpenOpportunity(context, crm.beta.firmId);
    expect(after?.control_mode).toBe('manual');
    // The signal the sequences lane subscribes to, committed with the change.
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM crm_domain_events WHERE workspace_id = $1 AND event_kind = 'opportunity.manual_mode'",
      [seeded.beta.workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe('scenario 6: an opt-out recorded on a call stops contact at once', () => {
  it('suppresses the number always and the firm only when the request covered all contact', async () => {
    const context = salesperson();
    const journal = recordingSuppressionJournal();

    const logged = await logCallOutcome(context, {
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
      routeId: policy.alpha.phoneRouteId,
      outcome: 'do_not_call',
      occurredAt: policy.insideWindow,
      commandId: 'cmd-alpha-dnc',
      journal,
    });
    if (!logged.ok) throw new Error(`expected a call log, got ${logged.reason}`);
    expect(logged.value.suppressionEventIds).toHaveLength(1);
    // The journal was written, and before the row: the fake records every append.
    expect(journal.appended).toHaveLength(1);
    expect(journal.appended[0]?.eventId).toBe(logged.value.suppressionEventIds[0]);

    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: policy.alpha.e164 })).not.toBeNull();
    // Only the number: the firm is not suppressed by a request about one line.
    expect(await isSuppressed(context, { scope: 'firm', canonicalKey: crm.alpha.firmId })).toBeNull();
    // And the dial is refused on the number from here on.
    expect(await authorizeDial(context, dialInput())).toEqual({ allowed: false, reason: 'handle_suppressed' });
  });

  it('fails the command when the journal write fails, and writes nothing', async () => {
    const context = betaSalesperson();
    const journal = recordingSuppressionJournal();
    journal.failNext();

    const before = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1',
      [seeded.beta.workspaceId],
    );
    await expect(
      logCallOutcome(context, {
        firmId: crm.beta.firmId,
        routeId: policy.beta.phoneRouteId,
        outcome: 'do_not_call',
        occurredAt: policy.insideWindow,
        commandId: 'cmd-beta-dnc-journal-fails',
        journal,
      }),
    ).rejects.toMatchObject({ name: 'SuppressionJournalError' });

    // The throw is what rolls the command's transaction back in production. Here
    // there is no transaction, so the assertion that matters is the narrow one: the
    // suppression the journal refused was never inserted.
    const after = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1',
      [seeded.beta.workspaceId],
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count));
  });

  it('suppresses the firm when the salesperson says the request covered all contact', async () => {
    const context = betaSalesperson();
    const journal = recordingSuppressionJournal();
    const logged = await logCallOutcome(context, {
      firmId: crm.beta.firmId,
      routeId: policy.beta.phoneRouteId,
      outcome: 'do_not_call',
      occurredAt: policy.insideWindow,
      doNotCallCoversAllContact: true,
      commandId: 'cmd-beta-dnc-all',
      journal,
    });
    if (!logged.ok) throw new Error(`expected a call log, got ${logged.reason}`);
    expect(logged.value.suppressionEventIds).toHaveLength(2);
    expect(await isSuppressed(context, { scope: 'firm', canonicalKey: crm.beta.firmId })).not.toBeNull();
  });
});
