import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { applyMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { readLinkedInRemovalPreflight, type LinkedInRemovalCounts } from '../../db/linkedinRemoval.ts';
import { emitCrmDomainEvent } from '../../crm/index.ts';
import { databaseNow, listApplicableHolds, listPauses } from '../../policy/index.ts';
import { previewDeletion } from '../../retention/index.ts';
import {
  buildTodaySnapshot,
  businessDateOf,
  defaultTodaySources,
  listTodayCards,
  listTodayItems,
} from '../../today/index.ts';
import {
  SEQUENCE_STOP_CONDITIONS,
  allowAllEligibility,
  consumeTerminalStops,
  createDraftVersion,
  dueSequenceWorkSource,
  enrollContact,
  listSequenceVersions,
  listStepExecutions,
  previewResume,
  proposeEnrollmentMigration,
  publishVersion,
  readEnrollment,
  readSequenceVersion,
  recordingSendHandoff,
  resumeAfterReview,
  runDueStepExecution,
  sequenceVersionForDisplay,
  stopEnrollments,
} from '../../sequences/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * Migration 0018 on a schema-17 database that holds LinkedIn history, and what the code
 * does with what 0018 leaves (lane A4). Appendix G 9 and 18 were LinkedIn's scenarios;
 * `test/release/scenario09.check.ts` and `scenario18.check.ts` point here.
 *
 * PR 234 removed LinkedIn from the code and not from the schema, so a live schema-17
 * database may hold every LinkedIn value: a `linkedin_task` step with its message and
 * its executions (held, and completed with `open_and_copy` / `handed_off`), a
 * `linkedin_grace` shift, a `linkedin_reply` end and a recorded result, a `linkedin_due`
 * Today item and the card that counts it, `linkedin_task` in a hold's kinds, a
 * `linkedin` channel pause, a contact's `linkedin_url` — and `linkedin_reply` in every
 * version's `stop_conditions`, published ones included, because 0012's default put it
 * there and a CHECK required it.
 *
 * The trimmed rehearsal builds its database from zero, so it proves none of this. This
 * file builds schema 17, seeds each value with SQL (the only way left to write one),
 * and then runs the real 0018: without the owner's setting it must refuse with the
 * preflight's counts and change nothing; with it, it must keep the URLs where the owner
 * sees them, strip `linkedin_reply` from published versions, keep the held execution
 * held, and leave Today, the retention preview and the worker working.
 *
 * ## The vacuous-pass trap
 *
 * A migration that found nothing to convert passes every "afterwards" assertion by
 * construction. So the preflight is asserted first, value by value, on the seeded
 * database: each count below is a row this file really stored.
 *
 * ## The channel marker (lane A2)
 *
 * A step's and an execution's `linkedin_task` channel is the one LinkedIn value 0018
 * keeps: lane A2's read-only representation of a removed step keys on it
 * (`removedChannelOf`), a version's steps keep their places and delays, and
 * `isStepChannel` refuses it. This file asserts the rows are still there, unchanged in
 * channel, place and state, and runs A2's three reads after the migration: the version
 * shown with a `removed` step and nothing it carried, the resume review naming
 * `channel_removed`, and a resume that keeps the LinkedIn execution held.
 */

const PARTNER_URL = 'https://www.linkedin.com/in/example-partner';
const UNTITLED_URL = 'https://linkedin.com/in/untitled-example';
const UNFIT_URL = 'https://www.linkedin.com/in/long-title-example';
const LONG_TITLE = 'T'.repeat(190);
const FOUR_STOPS = ['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'];

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

/** Ids of what `seedLinkedInHistory` stored. */
const ids = {
  linkedInSequenceId: '',
  publishedVersionId: '',
  draftVersionId: '',
  publishedOnlySequenceId: '',
  linkedInStepId: '',
  untitledContactId: '',
  unfitContactId: '',
  spareContactId: '',
  heldEnrollmentId: '',
  heldExecutionId: '',
  repliedEnrollmentId: '',
  completedExecutionId: '',
  mixedSequenceId: '',
  mixedVersionId: '',
  mixedLinkedInStepId: '',
  mixedCallStepId: '',
  mixedHoldId: '',
  pauseHoldId: '',
  pauseId: '',
  businessDate: '',
};

const workspaceOf = (): string => seeded.alpha.workspaceId;

const contextFor = (who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha[who].userId, role: who }),
    database.session,
  );

const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

async function one(sql: string, values: readonly unknown[]): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, [...values]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture insert returned no row: ${sql.slice(0, 60)}`);
  return id;
}

async function value<T>(sql: string, values: readonly unknown[]): Promise<T> {
  const { rows } = await database.session.query<{ value: T }>(sql, [...values]);
  return rows[0]?.value as T;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  return await value<boolean>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS value`,
    [table, column],
  );
}

/** A version of one LinkedIn step, as it was stored before 25 September 2026. */
async function linkedInVersion(sequenceId: string, version: number, publish: boolean): Promise<{ versionId: string; stepId: string }> {
  const versionId = await one(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, $3) RETURNING id',
    [workspaceOf(), sequenceId, version],
  );
  const stepId = await one(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, linkedin_message)
     VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0, 'Hello — a note from before.') RETURNING id`,
    [workspaceOf(), versionId],
  );
  if (publish) {
    await database.session.query(
      `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceOf(), versionId, seeded.alpha.admin.userId],
    );
  }
  return { versionId, stepId };
}

/** A contact at the alpha firm. With a URL only on schema 17, which is the only schema that has the column. */
async function contact(fullName: string, title: string | null, url: string | null): Promise<string> {
  if (url === null) {
    return await one('INSERT INTO contacts (workspace_id, firm_id, full_name, title) VALUES ($1, $2, $3, $4) RETURNING id', [
      workspaceOf(),
      crm.alpha.firmId,
      fullName,
      title,
    ]);
  }
  return await one(
    `INSERT INTO contacts (workspace_id, firm_id, full_name, title, linkedin_url) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [workspaceOf(), crm.alpha.firmId, fullName, title, url],
  );
}

async function enrollment(versionId: string, contactId: string, ended: boolean): Promise<string> {
  return await one(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        started_at, firm_time_zone, holiday_calendar_version, state, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '2 hours', 'America/New_York', $7,
             ${ended ? "'stopped', now(), 'linkedin_reply'" : "'active', NULL, NULL"})
     RETURNING id`,
    [
      workspaceOf(),
      versionId,
      crm.alpha.opportunityId,
      crm.alpha.firmId,
      contactId,
      seeded.alpha.salesperson.userId,
      sequences.alpha.calendarVersion,
    ],
  );
}

async function linkedInExecution(enrollmentId: string, contactId: string, state: 'held' | 'completed'): Promise<string> {
  const finish =
    state === 'held'
      ? "'held', 'long_hold_review', NULL, NULL, NULL"
      : "'completed', NULL, 'open_and_copy', 'handed_off', now()";
  return await one(
    `INSERT INTO step_executions
       (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
        due_at, not_before, original_due_at, source_zone, rule_version,
        state, hold_reason_code, completion_source, result, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'linkedin_task', 1, now() - interval '1 hour', now() - interval '1 hour',
             now() - interval '1 hour', 'America/New_York', 'elapsed.1', ${finish})
     RETURNING id`,
    [workspaceOf(), enrollmentId, ids.linkedInStepId, crm.alpha.firmId, contactId],
  );
}

/** Every LinkedIn value a schema-17 database can hold, in workspace alpha. */
async function seedLinkedInHistory(): Promise<void> {
  const workspaceId = workspaceOf();

  // Contacts: a URL beside a title, a URL with no title, and a URL that cannot fit
  // beside a 190-character title.
  await database.session.query(
    `UPDATE contacts SET title = 'Managing Partner', linkedin_url = $3 WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, crm.alpha.contactId, PARTNER_URL],
  );
  ids.untitledContactId = await contact('Untitled Example', null, UNTITLED_URL);
  ids.unfitContactId = await contact('Long Title Example', LONG_TITLE, UNFIT_URL);
  ids.spareContactId = await contact('Spare Example', null, null);

  // Sequences: a published LinkedIn version with a LinkedIn draft after it, and a
  // second sequence whose only version is a published LinkedIn one.
  ids.linkedInSequenceId = await one(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, 'LinkedIn first', seeded.alpha.admin.userId],
  );
  const published = await linkedInVersion(ids.linkedInSequenceId, 1, true);
  ids.publishedVersionId = published.versionId;
  ids.linkedInStepId = published.stepId;
  ids.draftVersionId = (await linkedInVersion(ids.linkedInSequenceId, 2, false)).versionId;
  ids.publishedOnlySequenceId = await one(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, 'LinkedIn only', seeded.alpha.admin.userId],
  );
  await linkedInVersion(ids.publishedOnlySequenceId, 1, true);

  // Lane A2's case: a published version of a LinkedIn task and then a call.
  ids.mixedSequenceId = await one(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, 'LinkedIn then a call', seeded.alpha.admin.userId],
  );
  const mixed = await linkedInVersion(ids.mixedSequenceId, 1, false);
  ids.mixedVersionId = mixed.versionId;
  ids.mixedLinkedInStepId = mixed.stepId;
  ids.mixedCallStepId = await one(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, 2, 'call_task', 'business_days', 2, 'advance') RETURNING id`,
    [workspaceId, ids.mixedVersionId],
  );
  await database.session.query(
    `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, ids.mixedVersionId, seeded.alpha.admin.userId],
  );

  // A live enrollment whose LinkedIn execution is held for a person, as PR 234's worker
  // leaves it; and an ended one: handed off, given the grace shift, replied to.
  ids.heldEnrollmentId = await enrollment(ids.publishedVersionId, crm.alpha.contactId, false);
  ids.heldExecutionId = await linkedInExecution(ids.heldEnrollmentId, crm.alpha.contactId, 'held');
  ids.repliedEnrollmentId = await enrollment(ids.publishedVersionId, ids.untitledContactId, true);
  ids.completedExecutionId = await linkedInExecution(ids.repliedEnrollmentId, ids.untitledContactId, 'completed');
  await database.session.query(
    `INSERT INTO step_execution_shifts
       (workspace_id, step_execution_id, enrollment_id, from_due_at, to_due_at, shift_milliseconds, reason)
     VALUES ($1, $2, $3, now(), now() + interval '10 minutes', 600000, 'linkedin_grace')`,
    [workspaceId, ids.completedExecutionId, ids.repliedEnrollmentId],
  );
  await database.session.query(
    `INSERT INTO enrollment_linkedin_results
       (workspace_id, enrollment_id, firm_id, step_execution_id, result, recorded_by_user_id, note)
     VALUES ($1, $2, $3, $4, 'replied', $5, 'Replied on LinkedIn.')`,
    [workspaceId, ids.repliedEnrollmentId, crm.alpha.firmId, ids.completedExecutionId, seeded.alpha.salesperson.userId],
  );

  // Today: the held execution's item and a new-firm item on the same card, so the card
  // has something left to show when the LinkedIn item goes.
  const now = await databaseNow(worker());
  ids.businessDate = await businessDateOf(worker(), now);
  await database.session.query(
    `SELECT today_upsert_item($1, $2::date, $3, $4, 'linkedin_due', $5::timestamptz, $6, 'step_execution', $7, false)`,
    [workspaceId, ids.businessDate, crm.alpha.firmId, `step-execution:${ids.heldExecutionId}`, now, crm.alpha.contactId, ids.heldExecutionId],
  );
  await database.session.query(
    `SELECT today_upsert_item($1, $2::date, $3, $4, 'new_firm', $5::timestamptz, NULL, 'firm', $3, false)`,
    [workspaceId, ids.businessDate, crm.alpha.firmId, `firm:${crm.alpha.firmId}`, now],
  );

  // Holds: one every writer made before 25 September (LinkedIn among other kinds), and a
  // LinkedIn channel pause with the hold that blocked only LinkedIn.
  ids.mixedHoldId = await one(
    `INSERT INTO active_holds
       (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action)
     VALUES ($1, 'opportunity', $2, 'uncertain_reply',
             ARRAY['email_send', 'call_task', 'linkedin_task', 'enrollment_advance']::text[],
             'mail_message', 'confirm_reply')
     RETURNING id`,
    [workspaceId, crm.alpha.opportunityId],
  );
  ids.pauseHoldId = await one(
    `INSERT INTO active_holds
       (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action)
     VALUES ($1, 'channel', 'linkedin', 'scoped_pause', ARRAY['linkedin_task']::text[], 'administrative_pause', 'release_pause')
     RETURNING id`,
    [workspaceId],
  );
  ids.pauseId = await one(
    `INSERT INTO administrative_pauses
       (workspace_id, scope_kind, scope_key, channel, reason_code, hold_id, created_by_user_id)
     VALUES ($1, 'channel', 'linkedin', 'linkedin', 'scoped_pause', $2, $3)
     RETURNING id`,
    [workspaceId, ids.pauseHoldId, seeded.alpha.admin.userId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase({ throughVersion: 17 });
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
  await seedLinkedInHistory();
});

afterAll(async () => {
  await database.drop();
});

describe('0018 on a schema-17 database holding LinkedIn history', () => {
  it('is at schema 17, and the preflight counts every value this file stored', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(17);
    const versions = await value<number>('SELECT count(*)::integer AS value FROM sequence_versions', []);
    const nonDraft = await value<number>("SELECT count(*)::integer AS value FROM sequence_versions WHERE state <> 'draft'", []);

    const expected: LinkedInRemovalCounts = {
      contactUrls: 3,
      contactUrlsThatDoNotFit: 1,
      stepMessages: 4,
      linkedInSteps: 4,
      recordedLinkedInResults: 1,
      linkedInExecutions: 2,
      unfinishedLinkedInExecutions: 1,
      linkedInGraceShifts: 1,
      enrollmentsEndedByLinkedInReply: 1,
      linkedInTodayItems: 1,
      todayCardsCountingLinkedIn: 1,
      holdsNamingLinkedIn: 2,
      holdsOnlyLinkedIn: 1,
      linkedInPauses: 1,
      // Every version, including the fixtures' own: 0012's default put it in each one.
      versionsWithLinkedInReply: versions,
      publishedVersionsWithLinkedInReply: nonDraft,
    };
    expect(await readLinkedInRemovalPreflight(database.session)).toEqual({
      applicable: true,
      schemaVersion: 17,
      migration: 18,
      counts: expected,
      refusesWithoutSetting: true,
    });

    // The operations task runs it as the runtime identity, so that role must be able to
    // read every table it counts, and the transaction must write nothing.
    const runtime = await database.appRuntimeSession();
    const asRuntime = await readLinkedInRemovalPreflight(runtime);
    expect(asRuntime).toMatchObject({ applicable: true, counts: expected });
  });

  it('refuses without the owner’s setting, naming the preflight’s counts, and changes nothing', async () => {
    const refusal = applyMigrations(database.session);
    await expect(refusal).rejects.toMatchObject({
      code: 'FS018',
      message: expect.stringContaining('0018 refused: linkedin_message=4 linkedin_results=1 unfit_urls=1;') as unknown,
    });
    await expect(applyMigrations(database.session)).rejects.toMatchObject({
      detail: expect.stringContaining('contacts.linkedin_url: 3, of which 1 do not fit') as unknown,
    });

    // One transaction: schema 17, the URL still in its column, the title as it was, the
    // published version still carrying linkedin_reply.
    expect(await readAppliedSchemaVersion(database.session)).toBe(17);
    const { rows } = await database.session.query<{ title: string; linkedin_url: string }>(
      'SELECT title, linkedin_url FROM contacts WHERE workspace_id = $1 AND id = $2',
      [workspaceOf(), crm.alpha.contactId],
    );
    expect(rows[0]).toEqual({ title: 'Managing Partner', linkedin_url: PARTNER_URL });
    expect(
      await value<string[]>('SELECT stop_conditions AS value FROM sequence_versions WHERE workspace_id = $1 AND id = $2', [
        workspaceOf(),
        ids.publishedVersionId,
      ]),
    ).toContain('linkedin_reply');
  });

  it('applies with fss.remove_linkedin_history = on', async () => {
    await database.session.query("SET fss.remove_linkedin_history = 'on'");
    try {
      const applied = await applyMigrations(database.session);
      expect(applied.map(migration => migration.version)).toEqual([18]);
    } finally {
      await database.session.query('RESET fss.remove_linkedin_history');
    }
    expect(await readAppliedSchemaVersion(database.session)).toBe(18);
    // And there is nothing left to count.
    expect(await readLinkedInRemovalPreflight(database.session)).toEqual({
      applicable: false,
      schemaVersion: 18,
      migration: 18,
    });
  });

  it('kept each URL that fits in the contact’s title, where the desktop shows it, and dropped the column', async () => {
    const titles = await database.session.query<{ id: string; title: string | null }>(
      'SELECT id, title FROM contacts WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [workspaceOf(), [crm.alpha.contactId, ids.untitledContactId, ids.unfitContactId]],
    );
    const byId = new Map(titles.rows.map(row => [row.id, row.title]));
    expect(byId.get(crm.alpha.contactId)).toBe(`Managing Partner · ${PARTNER_URL}`);
    expect(byId.get(ids.untitledContactId)).toBe(UNTITLED_URL);
    // The owner chose to erase what did not fit: the title is untouched.
    expect(byId.get(ids.unfitContactId)).toBe(LONG_TITLE);
    expect(await columnExists('contacts', 'linkedin_url')).toBe(false);
  });

  it('took linkedin_reply out of every version, published ones included, and out of the default and CHECKs', async () => {
    const { rows } = await database.session.query<{ state: string; stop_conditions: string[] }>(
      'SELECT state, stop_conditions FROM sequence_versions',
    );
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.some(row => row.state === 'published')).toBe(true);
    for (const row of rows) expect(row.stop_conditions).toEqual(FOUR_STOPS);
    expect([...SEQUENCE_STOP_CONDITIONS]).toEqual(FOUR_STOPS);

    const version = await readSequenceVersion(worker(), ids.publishedVersionId);
    expect(version?.stopConditions).toEqual(FOUR_STOPS);

    // The default is the four, and a fifth member is refused by name.
    const fresh = await one(
      'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 9) RETURNING id',
      [workspaceOf(), ids.publishedOnlySequenceId],
    );
    expect(
      await value<string[]>('SELECT stop_conditions AS value FROM sequence_versions WHERE workspace_id = $1 AND id = $2', [
        workspaceOf(),
        fresh,
      ]),
    ).toEqual(FOUR_STOPS);
    await database.session.query('DELETE FROM sequence_versions WHERE workspace_id = $1 AND id = $2', [workspaceOf(), fresh]);
    await expect(
      database.session.query(
        `INSERT INTO sequence_versions (workspace_id, sequence_id, version, stop_conditions)
         VALUES ($1, $2, 10, ARRAY['human_reply','linkedin_reply','engaged_call','opt_out_or_suppression','stage_closed'])`,
        [workspaceOf(), ids.publishedOnlySequenceId],
      ),
    ).rejects.toMatchObject({ constraint: 'sequence_versions_stop_conditions_known' });

    // The published version is still immutable: the trigger was set aside for 0018 only.
    await expect(
      database.session.query(
        `UPDATE sequence_versions SET stop_conditions = ARRAY['human_reply','engaged_call','opt_out_or_suppression','stage_closed','stage_closed']
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceOf(), ids.publishedVersionId],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('keeps the held LinkedIn execution held, and its step in place, and the worker still never runs it', async () => {
    const { rows } = await database.session.query<{ channel: string; state: string; hold_reason_code: string | null }>(
      'SELECT channel, state, hold_reason_code FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [workspaceOf(), ids.heldExecutionId],
    );
    expect(rows[0]).toEqual({ channel: 'linkedin_task', state: 'held', hold_reason_code: 'long_hold_review' });
    const steps = await database.session.query<{ channel: string; ordinal: number; delay_unit: string; delay_amount: number }>(
      'SELECT channel, ordinal, delay_unit, delay_amount FROM sequence_steps WHERE workspace_id = $1 AND channel = $2 ORDER BY ordinal',
      [workspaceOf(), 'linkedin_task'],
    );
    expect(steps.rows).toHaveLength(4);
    for (const step of steps.rows) expect(step).toEqual({ channel: 'linkedin_task', ordinal: 1, delay_unit: 'elapsed', delay_amount: 0 });

    // A stored `linkedin_task`: runDueStepExecution holds it with long_hold_review,
    // prepares no send, and does so again after its recheck.
    const handoff = recordingSendHandoff();
    const now = await databaseNow(worker());
    for (const at of [now, new Date(Date.parse(now) + 2 * 60 * 60 * 1000).toISOString()]) {
      expect(
        await runDueStepExecution(worker(), {
          stepExecutionId: ids.heldExecutionId,
          now: at,
          eligibility: allowAllEligibility(),
          sendHandoff: handoff,
        }),
      ).toEqual({ kind: 'held', stepExecutionId: ids.heldExecutionId, reasonCode: 'long_hold_review' });
    }
    expect(handoff.prepared).toEqual([]);
  });

  it('shows a version with a LinkedIn step as a removed step, with nothing it carried (lane A2)', async () => {
    const [version] = (await listSequenceVersions(worker(), ids.mixedSequenceId)).map(sequenceVersionForDisplay);
    expect(version?.id).toBe(ids.mixedVersionId);
    expect(version?.steps).toEqual([
      {
        id: ids.mixedLinkedInStepId,
        sequenceVersionId: ids.mixedVersionId,
        ordinal: 1,
        channel: 'removed',
        removedChannel: 'linkedin',
        delay: { unit: 'elapsed', hours: 0 },
        onNoAnswer: null,
        templateVersionId: null,
      },
      {
        id: ids.mixedCallStepId,
        sequenceVersionId: ids.mixedVersionId,
        ordinal: 2,
        channel: 'call_task',
        delay: { unit: 'business_days', days: 2 },
        onNoAnswer: 'advance',
        templateVersionId: null,
      },
    ]);
    expect(JSON.stringify(version)).not.toContain('a note from before');
    expect(version?.stopConditions).toEqual(FOUR_STOPS);

    // Every version of the first sequence, the draft included, reads the same way, and
    // the engine's own read keeps the stored marker `isStepChannel` refuses.
    const all = (await listSequenceVersions(worker(), ids.linkedInSequenceId)).map(sequenceVersionForDisplay);
    expect(all.map(entry => entry.steps.map(step => step.channel))).toEqual([['removed'], ['removed']]);
    expect((await readSequenceVersion(worker(), ids.mixedVersionId))?.steps[0]?.channel).toBe('linkedin_task');
  });

  it('reviews the held LinkedIn execution as held for channel_removed, unmoved (lane A2)', async () => {
    const preview = await previewResume(contextFor('salesperson'), { enrollmentId: ids.heldEnrollmentId });
    if (!preview.ok) throw new Error(`the review was refused: ${preview.reason}`);
    expect(preview.value.steps).toHaveLength(1);
    const [step] = preview.value.steps;
    expect(step).toMatchObject({
      stepExecutionId: ids.heldExecutionId,
      ordinal: 1,
      channel: 'removed',
      removedChannel: 'linkedin',
      state: 'held',
      heldReason: 'channel_removed',
    });
    expect(step?.proposedDueAt).toBe(step?.dueAt);
  });

  it('converted the finished LinkedIn history and reads it as no value', async () => {
    const execution = await database.session.query<{ channel: string; completion_source: string; result: string }>(
      'SELECT channel, completion_source, result FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [workspaceOf(), ids.completedExecutionId],
    );
    expect(execution.rows[0]).toEqual({ channel: 'linkedin_task', completion_source: 'removed', result: 'removed' });
    expect(
      await value<string>('SELECT reason AS value FROM step_execution_shifts WHERE workspace_id = $1 AND step_execution_id = $2', [
        workspaceOf(),
        ids.completedExecutionId,
      ]),
    ).toBe('removed');

    // A LinkedIn reply was a person replying.
    const enrollment = await readEnrollment(worker(), { enrollmentId: ids.repliedEnrollmentId });
    expect(enrollment).toMatchObject({ state: 'stopped', endReason: 'human_reply' });
    const [finished] = await listStepExecutions(worker(), { enrollmentId: ids.repliedEnrollmentId });
    expect(finished).toMatchObject({ state: 'completed', completionSource: null, result: null });
  });

  it('dropped every object PR 234 listed but the channel marker, and the vocabularies refuse LinkedIn values', async () => {
    expect(await value<string | null>("SELECT to_regclass('public.enrollment_linkedin_results')::text AS value", [])).toBeNull();
    expect(await columnExists('sequence_steps', 'linkedin_message')).toBe(false);
    expect(await columnExists('today_snapshots', 'linkedin_due')).toBe(false);
    const constraints = await database.session.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conname LIKE '%linkedin%' OR conname = 'sequence_steps_no_unsubscribe_link'",
    );
    expect(constraints.rows).toEqual([]);
    expect(await value<string | null>("SELECT today_lane_of_kind('linkedin_due') AS value", [])).toBeNull();
    expect(await value<string | null>("SELECT today_lane_of_kind('call_due') AS value", [])).toBe('due_work');

    const refusals: readonly [string, string, readonly unknown[]][] = [
      [
        'step_executions_completion_source_known',
        `UPDATE step_executions SET completion_source = 'open_and_copy' WHERE workspace_id = $1 AND id = $2`,
        [workspaceOf(), ids.completedExecutionId],
      ],
      [
        'step_executions_result_known',
        `UPDATE step_executions SET result = 'handed_off' WHERE workspace_id = $1 AND id = $2`,
        [workspaceOf(), ids.completedExecutionId],
      ],
      [
        'step_execution_shifts_reason_known',
        `INSERT INTO step_execution_shifts
           (workspace_id, step_execution_id, enrollment_id, from_due_at, to_due_at, shift_milliseconds, reason)
         VALUES ($1, $2, $3, now(), now(), 0, 'linkedin_grace')`,
        [workspaceOf(), ids.completedExecutionId, ids.repliedEnrollmentId],
      ],
      [
        'administrative_pauses_channel_known',
        `UPDATE administrative_pauses SET channel = 'linkedin' WHERE workspace_id = $1 AND id = $2`,
        [workspaceOf(), ids.pauseId],
      ],
      [
        'today_items_kind_known',
        `SELECT today_upsert_item($1, $2::date, $3, 'linkedin-probe', 'linkedin_due', now(), NULL, 'firm', $3, false)`,
        [workspaceOf(), ids.businessDate, crm.alpha.firmId],
      ],
      [
        'active_holds_blocked_action_kinds_known',
        `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind)
         VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['linkedin_task'], 'message')`,
        [workspaceOf()],
      ],
      [
        'sequence_enrollments_end_reason_known',
        `UPDATE sequence_enrollments SET end_reason = 'linkedin_reply' WHERE workspace_id = $1 AND id = $2`,
        [workspaceOf(), ids.repliedEnrollmentId],
      ],
    ];
    for (const [constraint, sql, values] of refusals) {
      await expect(database.session.query(sql, values), constraint).rejects.toMatchObject({ constraint });
    }
  });

  it('removed the LinkedIn Today item, refreshed its card without linkedin_due, and Today still builds', async () => {
    const items = await database.session.query<{ kind: string }>(
      'SELECT kind FROM today_items WHERE workspace_id = $1 AND snapshot_date = $2::date AND firm_id = $3',
      [workspaceOf(), ids.businessDate, crm.alpha.firmId],
    );
    expect(items.rows).toEqual([{ kind: 'new_firm' }]);
    const card = await database.session.query<{ lane: string; open_items: number; replies_due: number; emails_due: number; calls_due: number }>(
      `SELECT lane, open_items, replies_due, emails_due, calls_due FROM today_snapshots
        WHERE workspace_id = $1 AND snapshot_date = $2::date AND firm_id = $3`,
      [workspaceOf(), ids.businessDate, crm.alpha.firmId],
    );
    expect(card.rows).toEqual([{ lane: 'new_firm', open_items: 1, replies_due: 0, emails_due: 0, calls_due: 0 }]);

    // The removed execution is nobody's task, and the whole build — every source, the
    // replaced card function behind the trigger — runs on schema 18.
    const now = await databaseNow(worker());
    expect(
      await dueSequenceWorkSource().find(worker(), { businessDate: ids.businessDate, businessTimeZone: 'America/New_York', now }),
    ).toEqual([]);
    const report = await buildTodaySnapshot(worker(), { businessDate: ids.businessDate, now, sources: defaultTodaySources() });
    expect(report.businessDate).toBe(ids.businessDate);
    const cards = await listTodayCards(worker(), { snapshotDate: ids.businessDate });
    for (const listed of cards) expect(Object.keys(listed.counts).sort()).toEqual(['callsDue', 'emailsDue', 'replies']);
    const listed = await listTodayItems(worker(), { businessDate: ids.businessDate, firmId: crm.alpha.firmId, includeFinished: true });
    expect(listed.map(item => item.kind)).not.toContain('linkedin_due');
  });

  it('converted the holds and the pause, and the readers still read them', async () => {
    const holds = await database.session.query<{ id: string; blocked_action_kinds: string[] }>(
      'SELECT id, blocked_action_kinds FROM active_holds WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [workspaceOf(), [ids.mixedHoldId, ids.pauseHoldId]],
    );
    const kinds = new Map(holds.rows.map(row => [row.id, row.blocked_action_kinds]));
    expect(kinds.get(ids.mixedHoldId)).toEqual(['email_send', 'call_task', 'enrollment_advance']);
    expect(kinds.get(ids.pauseHoldId)).toEqual(['removed']);
    expect(
      await value<string>('SELECT channel AS value FROM administrative_pauses WHERE workspace_id = $1 AND id = $2', [
        workspaceOf(),
        ids.pauseId,
      ]),
    ).toBe('removed');

    const applicable = await listApplicableHolds(worker(), { actionKind: 'email_send', opportunityId: crm.alpha.opportunityId });
    expect(applicable.map(hold => hold.blockedActionKinds)).toEqual([['email_send', 'call_task', 'enrollment_advance']]);
    expect(await listPauses(contextFor('admin'))).toEqual([]);
  });

  it('refuses to enrol into, publish or migrate onto a version whose step was LinkedIn', async () => {
    expect(
      await enrollContact(contextFor('salesperson'), {
        sequenceVersionId: ids.publishedVersionId,
        opportunityId: crm.alpha.opportunityId,
        firmId: crm.alpha.firmId,
        contactId: ids.spareContactId,
      }),
    ).toEqual({ ok: false, reason: 'step_unknown' });
    expect(await publishVersion(contextFor('admin'), { sequenceVersionId: ids.draftVersionId })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    const live = await enrollContact(contextFor('salesperson'), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: ids.spareContactId,
    });
    if (!live.ok) throw new Error(`the enrollment fixture was refused: ${live.reason}`);
    expect(
      await proposeEnrollmentMigration(contextFor('admin'), {
        fromSequenceVersionId: sequences.alpha.publishedVersionId,
        toSequenceVersionId: ids.publishedVersionId,
        enrollmentIds: [live.value.enrollmentId],
      }),
    ).toEqual({ ok: false, reason: 'step_unknown' });
    await stopEnrollments(worker(), { enrollmentId: live.value.enrollmentId, reason: 'admin_stop' });
  });

  it('copies a version whose step was LinkedIn to a new draft without it, numbered from 1 (lane D1)', async () => {
    // "Edit as a new draft" is createDraftVersion with no steps. The mixed version is a
    // LinkedIn task at 1 and a call at 2; the copy used to keep the LinkedIn task, and
    // `validateSteps` refused the whole draft as `invalid_input`.
    const mixed = await createDraftVersion(contextFor('admin'), { sequenceId: ids.mixedSequenceId });
    if (!mixed.ok) throw new Error(`the draft was refused: ${mixed.reason}`);
    expect(mixed.value.version).toBe(2);
    const draft = await readSequenceVersion(contextFor('admin'), mixed.value.sequenceVersionId);
    expect(draft?.state).toBe('draft');
    expect(draft?.steps.map(({ ordinal, channel, delay, onNoAnswer, templateVersionId }) => ({ ordinal, channel, delay, onNoAnswer, templateVersionId }))).toEqual([
      { ordinal: 1, channel: 'call_task', delay: { unit: 'business_days', days: 2 }, onNoAnswer: 'advance', templateVersionId: null },
    ]);
    // The published version is untouched: its LinkedIn step is still stored, and still shown.
    expect((await readSequenceVersion(worker(), ids.mixedVersionId))?.steps.map(step => step.channel)).toEqual([
      'linkedin_task',
      'call_task',
    ]);

    // A version of only a LinkedIn step copies to a draft with no steps. A draft may be
    // empty; publishing one is what is refused, for `version_has_no_steps`.
    const only = await createDraftVersion(contextFor('admin'), { sequenceId: ids.publishedOnlySequenceId });
    if (!only.ok) throw new Error(`the draft was refused: ${only.reason}`);
    expect(only.value.version).toBe(2);
    expect((await readSequenceVersion(contextFor('admin'), only.value.sequenceVersionId))?.steps).toEqual([]);
    expect(await publishVersion(contextFor('admin'), { sequenceVersionId: only.value.sequenceVersionId })).toEqual({
      ok: false,
      reason: 'version_has_no_steps',
    });
  });

  it('keeps a held LinkedIn execution held on resume, and returns a current one to pending (lane A2)', async () => {
    const workspaceId = workspaceOf();
    // The opportunity's reply hold would keep everything held; this case is about the
    // channel, so it is released first.
    await database.session.query('UPDATE active_holds SET released_at = now() WHERE workspace_id = $1 AND id = $2', [
      workspaceId,
      ids.mixedHoldId,
    ]);
    const reviewContactId = await contact('Review Example', null, null);
    const enrollmentId = await one(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id, state,
          review_union_milliseconds, started_at, firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'review_required', 864000000, now() - interval '12 days',
               'America/New_York', $7)
       RETURNING id`,
      [
        workspaceId,
        ids.mixedVersionId,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        reviewContactId,
        seeded.alpha.salesperson.userId,
        sequences.alpha.calendarVersion,
      ],
    );
    const held = async (stepId: string, channel: string, ordinal: number): Promise<string> =>
      await one(
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state, hold_reason_code,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'held', 'long_hold_review',
                 now() - interval '1 day', now() - interval '1 day', now() - interval '1 day',
                 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspaceId, enrollmentId, stepId, crm.alpha.firmId, reviewContactId, channel, ordinal],
      );
    // Written on schema 18: the marker is the one LinkedIn value the CHECK still admits.
    const linkedIn = await held(ids.mixedLinkedInStepId, 'linkedin_task', 1);
    const call = await held(ids.mixedCallStepId, 'call_task', 2);

    const resumed = await resumeAfterReview(contextFor('salesperson'), { enrollmentId });
    expect(resumed).toMatchObject({ ok: true, value: { kind: 'resume' } });
    const { rows } = await database.session.query<{ id: string; state: string; hold_reason_code: string | null }>(
      'SELECT id, state, hold_reason_code FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2 ORDER BY ordinal',
      [workspaceId, enrollmentId],
    );
    expect(rows).toEqual([
      { id: linkedIn, state: 'held', hold_reason_code: 'long_hold_review' },
      // The same resume did clear the current step, so the LinkedIn one staying held is the rule, not a no-op.
      { id: call, state: 'pending', hold_reason_code: null },
    ]);
    await stopEnrollments(worker(), { enrollmentId, reason: 'admin_stop' });
  });

  it('previews a deletion of the firm, and a person can stop the enrollment the held execution belongs to', async () => {
    const preview = await previewDeletion(contextFor('admin'), { targetKind: 'firm', firmId: crm.alpha.firmId });
    expect(preview.ok, preview.reason).toBe(true);
    expect(preview.value?.removes).not.toHaveProperty('enrollment_linkedin_results');
    expect(preview.value?.redacts['contacts']).toBeGreaterThan(0);
    expect(preview.value?.stops['sequence_enrollments']).toBe(1);

    // Cancelling the held LinkedIn execution is an UPDATE of a row 0018 kept, which the
    // CHECKs must still accept.
    const stopped = await stopEnrollments(contextFor('admin'), { enrollmentId: ids.heldEnrollmentId, reason: 'admin_stop' });
    expect(stopped).toMatchObject({ enrollmentsStopped: 1, executionsCancelled: 1 });
  });

  it('still stops on a manual-mode event with the removed linkedin_reply origin, as human_reply', async () => {
    const enrolled = await enrollContact(contextFor('salesperson'), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
    await database.session.query(
      `UPDATE opportunities SET control_mode = 'manual', control_mode_reason = 'a LinkedIn reply',
              control_mode_changed_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceOf(), crm.alpha.opportunityId],
    );
    await emitCrmDomainEvent(contextFor('admin'), {
      kind: 'opportunity.manual_mode',
      firmId: crm.alpha.firmId,
      opportunityId: crm.alpha.opportunityId,
      dedupeKey: `manual-mode:linkedin:${crm.alpha.opportunityId}`,
      reasonCode: 'opportunity_manual',
      detail: { reason: 'A LinkedIn reply was recorded by the salesperson.', origin: 'linkedin_reply' },
    });

    const report = await consumeTerminalStops(worker());
    expect(report.enrollmentsStopped).toBe(1);
    expect((await readEnrollment(worker(), { enrollmentId: enrolled.value.enrollmentId }))?.endReason).toBe('human_reply');
  });
});

describe('0018 on a schema-17 database with no LinkedIn history to erase', () => {
  let clean: TestDatabase;

  afterAll(async () => {
    await clean.drop();
  });

  it('needs no setting: it keeps the URL, strips linkedin_reply and the hold kind, and applies', async () => {
    clean = await createTestDatabase({ throughVersion: 17 });
    const cleanSeeded = await seedTwoWorkspaces(clean.session);
    const cleanCrm = await seedCrm(clean.session, cleanSeeded);
    await seedSequences(clean.session, cleanSeeded);
    const workspaceId = cleanSeeded.alpha.workspaceId;
    await clean.session.query('UPDATE contacts SET linkedin_url = $3 WHERE workspace_id = $1 AND id = $2', [
      workspaceId,
      cleanCrm.alpha.contactId,
      PARTNER_URL,
    ]);
    await clean.session.query(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind)
       VALUES ($1, 'opportunity', $2, 'uncertain_reply', ARRAY['email_send', 'linkedin_task'], 'mail_message')`,
      [workspaceId, cleanCrm.alpha.opportunityId],
    );
    const preflight = await readLinkedInRemovalPreflight(clean.session);
    expect(preflight).toMatchObject({
      applicable: true,
      refusesWithoutSetting: false,
      counts: { contactUrls: 1, stepMessages: 0, recordedLinkedInResults: 0, holdsNamingLinkedIn: 1 },
    });

    expect((await applyMigrations(clean.session)).map(migration => migration.version)).toEqual([18]);
    const { rows } = await clean.session.query<{ title: string }>('SELECT title FROM contacts WHERE workspace_id = $1 AND id = $2', [
      workspaceId,
      cleanCrm.alpha.contactId,
    ]);
    expect(rows[0]?.title).toBe(`Operations Lead · ${PARTNER_URL}`);
    const stops = await clean.session.query<{ stop_conditions: string[] }>('SELECT stop_conditions FROM sequence_versions');
    expect(stops.rows.length).toBeGreaterThan(0);
    for (const row of stops.rows) expect(row.stop_conditions).toEqual(FOUR_STOPS);
    const kinds = await clean.session.query<{ blocked_action_kinds: string[] }>(
      'SELECT blocked_action_kinds FROM active_holds WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(kinds.rows).toEqual([{ blocked_action_kinds: ['email_send'] }]);
  });
});
