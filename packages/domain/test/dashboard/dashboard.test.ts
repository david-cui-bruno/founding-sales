import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  readDashboard,
  readDiagnostics,
  unavailableDashboardSources,
  type DashboardSources,
} from '../../dashboard/index.ts';
import { raiseCriticalAlert, recordHeartbeat } from '../../jobs/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, stageIdByKey, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';

/**
 * The minimum performance dashboard and Diagnostics (13.4, 13.3, Appendix F).
 *
 * The frame is two salespeople in one workspace, each with one firm, plus a second
 * workspace with colliding rows. The question the read matrix asks of an aggregate is
 * exactly this one: when a workspace has two people with one firm each, a
 * workspace-wide count *is* the other person's count, so a salesperson's dashboard is
 * computed over their own firms and an admin's over the workspace.
 */

const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };

describe('the dashboard', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let assignee: RepositoryContext;
  let colleague: RepositoryContext;
  let admin: RepositoryContext;
  let betaAdmin: RepositoryContext;
  let colleagueFirmId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);

    const other = await database.session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'second.salesperson@example.test', 'Second Salesperson'],
    );
    const otherUserId = other.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'active')",
      [seeded.alpha.workspaceId, otherUserId],
    );

    // The colleague's own firm, with its own call and its own stage change.
    const firm = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [seeded.alpha.workspaceId, 'Southwind Test Partners', otherUserId],
    );
    colleagueFirmId = firm.rows[0]?.id ?? '';

    assignee = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    colleague = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: otherUserId, role: 'salesperson' }),
      database.session,
    );
    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    betaAdmin = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );

    // One call on each salesperson's firm, with different outcomes.
    const identity = await database.session.query<{ id: string }>(
      `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                       verified_at, verified_by_user_id, verification_method)
       VALUES ($1, $2, '+14015550101', 'verified', true, now(), $2, 'owner_attestation') RETURNING id`,
      [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
    );
    await database.session.query(
      `INSERT INTO call_logs (workspace_id, firm_id, calling_identity_id, outcome, step_effect,
                              occurred_at, actor_user_id)
       VALUES ($1, $2, $3, 'voicemail_left', 'complete_and_advance',
               TIMESTAMPTZ '2026-09-10 15:00:00+00', $4)`,
      [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
        identity.rows[0]?.id ?? null,
        seeded.alpha.salesperson.userId,
      ],
    );
    await database.session.query(
      `INSERT INTO call_logs (workspace_id, firm_id, outcome, step_effect, occurred_at, actor_user_id)
       VALUES ($1, $2, 'no_answer', 'none', TIMESTAMPTZ '2026-09-11 15:00:00+00', $3)`,
      [seeded.alpha.workspaceId, colleagueFirmId, otherUserId],
    );

    // A reply in the Today list, created and handled, so the handling time is real.
    await database.session.query(
      `INSERT INTO today_items (workspace_id, snapshot_date, firm_id, item_key, kind, due_at,
                                status, source_kind, created_at, updated_at, completed_at)
       VALUES ($1, DATE '2026-09-12', $2, 'reply:1', 'reply', TIMESTAMPTZ '2026-09-12 12:00:00+00',
               'completed', 'reply_message', TIMESTAMPTZ '2026-09-12 12:00:00+00',
               TIMESTAMPTZ '2026-09-12 13:00:00+00', TIMESTAMPTZ '2026-09-12 13:00:00+00')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );

    // A stage change on the assignee's firm.
    await database.session.query(
      `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id,
                                             actor_kind, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, $4, 'user', $5, TIMESTAMPTZ '2026-09-13 10:00:00+00')`,
      [
        seeded.alpha.workspaceId,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        await stageIdByKey(database.session, seeded.alpha.workspaceId, 'contacting'),
        seeded.alpha.salesperson.userId,
      ],
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('gives an admin the workspace and a salesperson their own firms', async () => {
    const theAdmins = await readDashboard(admin, { window: WINDOW });
    expect(theAdmins.audience).toBe('workspace');
    expect(theAdmins.firmsInScope).toBe(2);
    expect(theAdmins.calls.map(entry => entry.key).sort()).toEqual(['no_answer', 'voicemail_left']);

    const theirs = await readDashboard(assignee, { window: WINDOW });
    expect(theirs.audience).toBe('assigned');
    expect(theirs.firmsInScope).toBe(1);
    // The colleague's call is not in it. An aggregate is never a way to learn about
    // a colleague's firm.
    expect(theirs.calls).toEqual([{ key: 'voicemail_left', count: 1 }]);

    const theOthers = await readDashboard(colleague, { window: WINDOW });
    expect(theOthers.calls).toEqual([{ key: 'no_answer', count: 1 }]);
    expect(theOthers.stageMovement).toEqual([]);
  });

  it('counts stage movement and reply handling for the caller s own firms', async () => {
    const theirs = await readDashboard(assignee, { window: WINDOW });
    // Two events: the one the fixture's opportunity was opened with, and the move
    // above. Every stage change writes an append-only event in the same transaction
    // (8.1), so "opened at New" is movement too.
    expect(theirs.stageMovement).toEqual([
      { key: 'contacting', count: 1 },
      { key: 'new', count: 1 },
    ]);
    expect(theirs.replyHandling).toEqual({
      replies: 1,
      handled: 1,
      medianSecondsToHandle: 3600,
      slowestSecondsToHandle: 3600,
    });
  });

  it('respects the window it was given and has no clock of its own', async () => {
    const before = await readDashboard(admin, {
      window: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    });
    expect(before.calls).toEqual([]);
    expect(before.stageMovement).toEqual([]);
    expect(before.replyHandling.replies).toBe(0);
    // Two runs over the same window give the same answer.
    const once = await readDashboard(admin, { window: WINDOW });
    const twice = await readDashboard(admin, { window: WINDOW });
    expect(once.calls).toEqual(twice.calls);
  });

  it('never crosses a workspace', async () => {
    const beta = await readDashboard(betaAdmin, { window: WINDOW });
    expect(beta.firmsInScope).toBe(1);
    expect(beta.calls).toEqual([]);
    // Its own firm's opening event and nothing of alpha's, despite the colliding
    // firm name and the identical default pipeline.
    expect(beta.stageMovement).toEqual([{ key: 'new', count: 1 }]);
  });

  it('names no firm, contact or person anywhere in the DTO', async () => {
    const theAdmins = await readDashboard(admin, { window: WINDOW });
    const rendered = JSON.stringify(theAdmins);
    // Redaction by construction: there is no field these could be in.
    expect(rendered).not.toContain('Northwind');
    expect(rendered).not.toContain('Southwind');
    expect(rendered).not.toContain('example.test');
    expect(rendered).not.toContain(crm.alpha.firmId);
  });

  it('says a figure is unavailable rather than rendering it as zero', async () => {
    const theAdmins = await readDashboard(admin, { window: WINDOW, sources: unavailableDashboardSources() });
    expect(theAdmins.sending).toEqual({
      available: false,
      owner: 'G7-2',
      reason: 'the outbound fence and sending ramp are not in this build',
    });
    expect(theAdmins.enrollments).toMatchObject({ available: false, owner: 'G8' });
    expect(theAdmins.classifier).toMatchObject({ available: false, owner: 'G7b' });
  });

  it('wires a real source when one exists, and passes it the audience', async () => {
    const seen: unknown[] = [];
    const fake: DashboardSources = {
      sending: async (_context, window, audience) => {
        seen.push({ window, audience });
        return await Promise.resolve({
          available: true,
          sent: 12,
          skipped: 1,
          resolvedDelivered: 0,
          held: 2,
          unknown: 0,
          providerDeferrals: 0,
          reputationWarnings: 0,
          posture: { domain: null, ramps: [] },
          bySequence: [{ key: 'intro.v1', sent: 12, replies: 3, positiveReplies: 1 }],
          byTemplateVersion: [],
          bySegment: { available: false, owner: 'G8', reason: 'no segment in the fixture' },
          byWeekday: [],
          byLocalSendHour: [],
        });
      },
      enrollments: async () =>
        await Promise.resolve({
          available: true,
          started: 5,
          active: 4,
          reviewRequired: 1,
          ended: [{ key: 'completed', count: 1 }],
          stepsCompleted: [{ key: 'email', count: 6 }],
          heldSteps: [{ key: 'scoped_pause', count: 1 }],
          linkedinHandoffs: 2,
          linkedinRecordedReplies: 1,
          linkedinNoEngagement: 0,
        }),
      classifier: async () =>
        await Promise.resolve({
          available: true,
          enabled: true,
          modelName: 'claude-opus-5',
          effort: 'low',
          dailyCallCap: 500,
          promptVersions: ['fixture-prompt.1'],
          callsAttempted: 9,
          callsSent: 7,
          byOutcome: [{ key: 'accepted', count: 7 }],
          inputTokens: 4200,
          cachedInputTokens: 0,
          outputTokens: 210,
          totalLatencyMs: 9000,
          confirmations: 10,
          accepted: 9,
          corrected: 1,
          correctionRate: 0.1,
          correctedBySuggester: [{ key: 'model', count: 1 }],
        }),
    };

    const theirs = await readDashboard(assignee, { window: WINDOW, sources: fake });
    expect(theirs.sending).toMatchObject({ available: true, sent: 12, held: 2 });
    expect(theirs.enrollments).toMatchObject({ linkedinHandoffs: 2 });
    expect(theirs.classifier).toMatchObject({ correctionRate: 0.1 });
    // The source is told whose figures to compute, so a later real implementation
    // cannot accidentally answer workspace-wide for a salesperson.
    expect(seen).toEqual([
      { window: WINDOW, audience: { onlyAssignedTo: seeded.alpha.salesperson.userId } },
    ]);
  });
});

describe('diagnostics', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let mail: SeededMail;
  let admin: RepositoryContext;
  let owner: RepositoryContext;
  let colleague: RepositoryContext;

  const input = {
    appliedSchemaVersion: 13,
    declaredRange: { minimum: 13, maximum: 13 },
    expectedSystemGeneration: 1,
    clientVersions: { minimum: '1.0.0', maximum: '1.2.0' } as const,
    deploymentSendingEnabled: true,
    adminSendingEnabled: false,
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    mail = await seedMail(database.session, seeded, crm);

    const other = await database.session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'third.salesperson@example.test', 'Third Salesperson'],
    );
    const otherUserId = other.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'active')",
      [seeded.alpha.workspaceId, otherUserId],
    );

    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    owner = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    colleague = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: otherUserId, role: 'salesperson' }),
      database.session,
    );

    await recordHeartbeat(database.session, { component: 'worker', instanceKey: 'worker-1' });
    await raiseCriticalAlert(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      alertKey: 'canary_stale',
      severity: 'critical',
    });
    await raiseCriticalAlert(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      alertKey: 'something_nobody_wrote_a_runbook_for',
      severity: 'warning',
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('reports the schema, the client range and both halves of the sending switch', async () => {
    const report = await readDiagnostics(admin, input);
    expect(report.schema).toEqual({
      appliedVersion: 13,
      declaredRange: { minimum: 13, maximum: 13 },
      accepted: true,
    });
    expect(report.clientVersions).toEqual({ minimum: '1.0.0', maximum: '1.2.0' });
    // 16.2 is two switches ANDed. Showing only the effective value would leave an
    // admin who has enabled sending unable to see that the release process has not.
    expect(report.sending).toEqual({ deploymentEnabled: true, adminEnabled: false, effective: false });
  });

  it('reports the restore generation and whether it matches the operator s', async () => {
    const report = await readDiagnostics(admin, input);
    expect(report.restore.expectedSystemGeneration).toBe(1);
    expect(report.restore.mismatch).toBe(report.restore.systemGeneration !== 1);

    const unpinned = await readDiagnostics(admin, { ...input, expectedSystemGeneration: null });
    // No pinned generation is not a mismatch; it is an operator who has not pinned one.
    expect(unpinned.restore.mismatch).toBe(false);
  });

  it('reports job health, heartbeats, the canary and the open alerts with their runbooks', async () => {
    const report = await readDiagnostics(admin, input);
    expect(report.jobs).toMatchObject({ runnable: 0, running: 0, dead: 0 });
    expect(report.heartbeats.map(entry => entry.component)).toContain('worker');
    expect(report.canaryCompletionAgeSeconds).toBeNull();

    const alerts = Object.fromEntries(report.alerts.map(alert => [alert.alertKey, alert.runbookPath]));
    expect(alerts['canary_stale']).toBe('docs/greenfield/runbooks/canary_stale.md');
    // An alert key that is not an alarm key gets null rather than a page describing
    // a different failure.
    expect(alerts['something_nobody_wrote_a_runbook_for']).toBeNull();
  });

  it('shows a salesperson their own mailbox and no other', async () => {
    const theirs = await readDiagnostics(owner, input);
    expect(theirs.mailboxVisibility).toBe('own');
    expect(theirs.mailboxes.map(entry => entry.mailboxId)).toEqual([mail.alpha.mailboxId]);
    expect(theirs.mailboxes[0]?.coverageWatermarkAt).toBe('2026-09-01T12:00:00.000Z');
    expect(theirs.mailboxes[0]?.watchExpiresAt).toBe('2026-09-08T12:00:00.000Z');

    // Appendix F row 3: a colleague is not the mailbox owner and is not an admin.
    const theOthers = await readDiagnostics(colleague, input);
    expect(theOthers.mailboxes).toEqual([]);
    expect(theOthers.mailboxVisibility).toBe('own');
  });

  it('audits an admin reading somebody else s mailbox diagnostics', async () => {
    const before = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE workspace_id = $1 AND action = 'read.mailbox_diagnostics'`,
      [seeded.alpha.workspaceId],
    );
    const report = await readDiagnostics(admin, input);
    expect(report.mailboxVisibility).toBe('all');
    expect(report.mailboxes.map(entry => entry.mailboxId)).toEqual([mail.alpha.mailboxId]);

    const after = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE workspace_id = $1 AND action = 'read.mailbox_diagnostics'`,
      [seeded.alpha.workspaceId],
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);

    // The salesperson's own read is ordinary work and writes nothing.
    await readDiagnostics(owner, input);
    const unchanged = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE workspace_id = $1 AND action = 'read.mailbox_diagnostics'`,
      [seeded.alpha.workspaceId],
    );
    expect(unchanged.rows[0]?.count).toBe(after.rows[0]?.count);
  });

  it('never shows the other workspace s mailbox', async () => {
    const report = await readDiagnostics(admin, input);
    expect(report.mailboxes.map(entry => entry.mailboxId)).not.toContain(mail.beta.mailboxId);
  });
});
