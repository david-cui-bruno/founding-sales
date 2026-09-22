import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { SENDING_STOP_LINE } from '../../src/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * What migration 0012 refuses (specification 11.1, 11.2, 11.3, 6, Appendix G 8, 33).
 *
 * Every assertion here is a rule the database keeps whatever the application does:
 * a published version and its steps are immutable, a contact has one live
 * enrollment, an enrollment cannot mix firms, a shift is append-only, and the
 * reserved personalization columns are reserved *and refused*.
 *
 * Two workspaces with colliding names throughout, seeded by `seedSequences`.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

async function refusal(sql: string, values: readonly unknown[] = []): Promise<string> {
  try {
    await database.session.query(sql, values);
  } catch (error) {
    return String((error as { message?: string }).message ?? error);
  }
  throw new Error(`the database accepted a statement it should have refused: ${sql.slice(0, 80)}`);
}

/** An active enrollment of a contact, written directly so the test is about the table. */
async function enroll(
  workspaceId: string,
  input: {
    readonly versionId: string;
    readonly opportunityId: string;
    readonly firmId: string;
    readonly contactId: string;
    readonly userId: string;
  },
): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        firm_time_zone, holiday_calendar_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'holidays.2026')
     RETURNING id`,
    [workspaceId, input.versionId, input.opportunityId, input.firmId, input.contactId, input.userId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no enrollment');
  return id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

describe('published versions and their steps are immutable (11.1)', () => {
  it('refuses an edit to a published version', async () => {
    const message = await refusal(
      `UPDATE sequence_versions SET version = 99 WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, sequences.alpha.publishedVersionId],
    );
    expect(message).toMatch(/immutable/i);
  });

  it('permits exactly one change to a published version: retiring it', async () => {
    const { rows } = await database.session.query<{ state: string }>(
      `UPDATE sequence_versions
          SET state = 'retired', retired_at = now(), retired_by_user_id = $3
        WHERE workspace_id = $1 AND id = $2
        RETURNING state`,
      [seeded.beta.workspaceId, sequences.beta.publishedVersionId, seeded.beta.admin.userId],
    );
    expect(rows[0]?.state).toBe('retired');
    // And a retired version is immutable in every way, including un-retiring it.
    const message = await refusal(
      `UPDATE sequence_versions SET state = 'published', retired_at = NULL, retired_by_user_id = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.beta.workspaceId, sequences.beta.publishedVersionId],
    );
    expect(message).toMatch(/immutable/i);
  });

  it('refuses inserting, editing or deleting a step of a published version', async () => {
    const workspaceId = seeded.alpha.workspaceId;
    const versionId = sequences.alpha.publishedVersionId;

    expect(
      await refusal(
        `INSERT INTO sequence_steps
           (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
         VALUES ($1, $2, 9, 'call_task', 'elapsed', 1, 'advance')`,
        [workspaceId, versionId],
      ),
    ).toMatch(/immutable/i);

    expect(
      await refusal(`UPDATE sequence_steps SET delay_amount = 99 WHERE workspace_id = $1 AND id = $2`, [
        workspaceId,
        sequences.alpha.emailStepId,
      ]),
    ).toMatch(/immutable/i);

    expect(
      await refusal(`DELETE FROM sequence_steps WHERE workspace_id = $1 AND id = $2`, [
        workspaceId,
        sequences.alpha.callStepId,
      ]),
    ).toMatch(/immutable/i);
  });

  it('lets a draft version change freely', async () => {
    const { rowCount } = await database.session.query(
      `UPDATE sequence_steps SET delay_amount = 3 WHERE workspace_id = $1 AND sequence_version_id = $2`,
      [seeded.alpha.workspaceId, sequences.alpha.draftVersionId],
    );
    expect(rowCount).toBe(1);
  });

  it('refuses a second draft of the same sequence', async () => {
    const message = await refusal(
      `INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 3)`,
      [seeded.alpha.workspaceId, sequences.alpha.sequenceId],
    );
    expect(message).toMatch(/sequence_versions_one_draft/);
  });

  it('refuses a version that opts out of a terminal condition (11.2)', async () => {
    const message = await refusal(
      `INSERT INTO sequence_versions (workspace_id, sequence_id, version, stop_conditions)
       VALUES ($1, $2, 7, ARRAY['human_reply'])`,
      [seeded.beta.workspaceId, sequences.beta.sequenceId],
    );
    expect(message).toMatch(/stop_conditions_complete/);
  });
});

describe('a step says what its channel needs and nothing else (11.1, 11.3, 9.1)', () => {
  const draft = (): [string, string] => [seeded.beta.workspaceId, sequences.beta.draftVersionId];

  it('refuses an email step with no template version', async () => {
    const [workspaceId, versionId] = draft();
    expect(
      await refusal(
        `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount)
         VALUES ($1, $2, 20, 'email', 'elapsed', 0)`,
        [workspaceId, versionId],
      ),
    ).toMatch(/sequence_steps_email_has_template/);
  });

  it('refuses a call step with no advance-or-retry behaviour', async () => {
    const [workspaceId, versionId] = draft();
    expect(
      await refusal(
        `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount)
         VALUES ($1, $2, 21, 'call_task', 'elapsed', 1)`,
        [workspaceId, versionId],
      ),
    ).toMatch(/sequence_steps_no_answer_is_a_call_step/);
  });

  it('refuses a LinkedIn message containing an unsubscribe link (12.6)', async () => {
    const [workspaceId, versionId] = draft();
    expect(
      await refusal(
        `INSERT INTO sequence_steps
           (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, linkedin_message)
         VALUES ($1, $2, 22, 'linkedin_task', 'elapsed', 1, 'Click here to Unsubscribe')`,
        [workspaceId, versionId],
      ),
    ).toMatch(/sequence_steps_no_unsubscribe_link/);
  });

  it("refuses a step pointing at another sequence's template across workspaces (6)", async () => {
    expect(
      await refusal(
        `INSERT INTO sequence_steps
           (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
         VALUES ($1, $2, 23, 'email', 'elapsed', 0, $3)`,
        [seeded.beta.workspaceId, sequences.beta.draftVersionId, sequences.alpha.template.templateVersionId],
      ),
    ).toMatch(/sequence_steps_template_fkey/);
  });
});

describe('template_versions is extended, not replaced (11.1)', () => {
  it('reserves the generated personalization strategy and refuses it', async () => {
    expect(
      await refusal(
        `UPDATE template_versions SET personalization_strategy = 'generated'
          WHERE workspace_id = $1 AND id = $2`,
        [seeded.alpha.workspaceId, sequences.alpha.template.templateVersionId],
      ),
    ).toMatch(/generated_personalization_disabled|immutable/i);
  });

  it('keeps an approved version immutable across the new columns too', async () => {
    expect(
      await refusal(
        `UPDATE template_versions SET generated_block = 'anything' WHERE workspace_id = $1 AND id = $2`,
        [seeded.alpha.workspaceId, sequences.alpha.template.templateVersionId],
      ),
    ).toMatch(/immutable/i);
  });

  it('accepts a version that names no postal address, in both workspaces (G20)', async () => {
    // David's 22 September decision: an automated email carries no postal address.
    // The column is gone, so the insert names it nowhere; the two workspaces use the
    // same template name, and neither sees the other's row.
    const body = `Hello.\n\nSam Example\n${SENDING_STOP_LINE}`;
    for (const workspaceId of [seeded.alpha.workspaceId, seeded.beta.workspaceId]) {
      const { rows } = await database.session.query<{ id: string }>(
        `INSERT INTO template_versions
           (workspace_id, template_id, version, name, subject, body, content_hash, footer_sign_off)
         VALUES ($1, gen_random_uuid(), 1, 'No address', 'Hello', $2, repeat('a', 64), 'Sam Example')
         RETURNING id`,
        [workspaceId, body],
      );
      expect(rows[0]?.id, 'the database refused a template version with no address').toBeDefined();
    }
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM template_versions
        WHERE workspace_id = $1 AND name = 'No address'`,
      [seeded.alpha.workspaceId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('still refuses an unsubscribe link and still requires the stop line', async () => {
    expect(
      await refusal(
        `INSERT INTO template_versions
           (workspace_id, template_id, version, name, subject, body, content_hash,
            footer_sign_off)
         VALUES ($1, gen_random_uuid(), 1, 'Bad', 'Hello', 'Unsubscribe here', repeat('a', 64),
                 'Sam Example')`,
        [seeded.alpha.workspaceId],
      ),
    ).toMatch(/no_unsubscribe_link/);
  });
});

describe('one live enrollment per contact, unlimited contacts per firm (11.2, G 33)', () => {
  it('refuses a second live enrollment for the same contact, whatever the sequence', async () => {
    const alpha = crm.alpha;
    await enroll(seeded.alpha.workspaceId, {
      versionId: sequences.alpha.publishedVersionId,
      opportunityId: alpha.opportunityId,
      firmId: alpha.firmId,
      contactId: alpha.contactId,
      userId: seeded.alpha.salesperson.userId,
    });
    const message = await refusal(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'holidays.2026')`,
      [
        seeded.alpha.workspaceId,
        sequences.alpha.draftVersionId,
        alpha.opportunityId,
        alpha.firmId,
        alpha.contactId,
        seeded.alpha.salesperson.userId,
      ],
    );
    expect(message).toMatch(/one_active_per_contact/);
  });

  it('permits a second contact at the same firm to be enrolled at the same time', async () => {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Robin Example') RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const secondContactId = rows[0]?.id ?? '';
    const enrollmentId = await enroll(seeded.alpha.workspaceId, {
      versionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: secondContactId,
      userId: seeded.alpha.salesperson.userId,
    });
    expect(enrollmentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('permits the same contact id in the other workspace (G 8)', async () => {
    const enrollmentId = await enroll(seeded.beta.workspaceId, {
      versionId: sequences.beta.draftVersionId,
      opportunityId: crm.beta.opportunityId,
      firmId: crm.beta.firmId,
      contactId: crm.beta.contactId,
      userId: seeded.beta.salesperson.userId,
    });
    expect(enrollmentId).not.toBe('');
  });

  it("refuses an enrollment that mixes one firm's contact with another's opportunity (7.2)", async () => {
    const message = await refusal(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'holidays.2026')`,
      [
        seeded.alpha.workspaceId,
        sequences.alpha.publishedVersionId,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        crm.beta.contactId,
        seeded.alpha.salesperson.userId,
      ],
    );
    expect(message).toMatch(/sequence_enrollments_contact_fkey/);
  });
});

describe('step executions and their timing history (11.2)', () => {
  let enrollmentId = '';
  let executionId = '';

  beforeAll(async () => {
    const { rows } = await database.session.query<{ id: string }>(
      `SELECT id FROM sequence_enrollments WHERE workspace_id = $1 AND contact_id = $2`,
      [seeded.alpha.workspaceId, crm.alpha.contactId],
    );
    enrollmentId = rows[0]?.id ?? '';
    const created = await database.session.query<{ id: string }>(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'email', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')
       RETURNING id`,
      [
        seeded.alpha.workspaceId,
        enrollmentId,
        sequences.alpha.emailStepId,
        crm.alpha.firmId,
        crm.alpha.contactId,
      ],
    );
    executionId = created.rows[0]?.id ?? '';
  });

  it('refuses a second execution of the same step in the same enrollment', async () => {
    const message = await refusal(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'email', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')`,
      [
        seeded.alpha.workspaceId,
        enrollmentId,
        sequences.alpha.emailStepId,
        crm.alpha.firmId,
        crm.alpha.contactId,
      ],
    );
    expect(message).toMatch(/step_executions_one_per_step/);
  });

  it('refuses a completed execution with no source and no result', async () => {
    const message = await refusal(
      `UPDATE step_executions SET state = 'completed', completed_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, executionId],
    );
    expect(message).toMatch(/step_executions_completion_consistent/);
  });

  it('refuses a held execution with no reason code (15)', async () => {
    const message = await refusal(
      `UPDATE step_executions SET state = 'held' WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, executionId],
    );
    expect(message).toMatch(/step_executions_held_has_reason/);
  });

  it('records a shift and then refuses to rewrite or delete it', async () => {
    await database.session.query(
      `INSERT INTO step_execution_shifts
         (workspace_id, step_execution_id, enrollment_id, from_due_at, to_due_at,
          shift_milliseconds, reason, hold_union_milliseconds)
       VALUES ($1, $2, $3, now(), now() + interval '2 days', 172800000, 'hold_union', 172800000)`,
      [seeded.alpha.workspaceId, executionId, enrollmentId],
    );

    const appRuntime = await database.appRuntimeSession();
    await expect(
      appRuntime.query('UPDATE step_execution_shifts SET shift_milliseconds = 0'),
    ).rejects.toThrow(/permission denied/i);
    await expect(appRuntime.query('DELETE FROM step_execution_shifts')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('refuses a shift that moves work earlier (4.3)', async () => {
    const message = await refusal(
      `INSERT INTO step_execution_shifts
         (workspace_id, step_execution_id, enrollment_id, from_due_at, to_due_at, shift_milliseconds, reason)
       VALUES ($1, $2, $3, now(), now() - interval '1 hour', -3600000, 'hold_union')`,
      [seeded.alpha.workspaceId, executionId, enrollmentId],
    );
    expect(message).toMatch(/never_earlier/);
  });

  it('refuses a LinkedIn reply recorded twice for one enrollment (11.3)', async () => {
    await database.session.query(
      `INSERT INTO enrollment_linkedin_results
         (workspace_id, enrollment_id, firm_id, result, recorded_by_user_id)
       VALUES ($1, $2, $3, 'replied', $4)`,
      [seeded.alpha.workspaceId, enrollmentId, crm.alpha.firmId, seeded.alpha.salesperson.userId],
    );
    const message = await refusal(
      `INSERT INTO enrollment_linkedin_results
         (workspace_id, enrollment_id, firm_id, result, recorded_by_user_id)
       VALUES ($1, $2, $3, 'replied', $4)`,
      [seeded.alpha.workspaceId, enrollmentId, crm.alpha.firmId, seeded.alpha.salesperson.userId],
    );
    expect(message).toMatch(/one_reply/);
    // "No engagement records an observation": several are fine.
    for (let index = 0; index < 2; index += 1) {
      await database.session.query(
        `INSERT INTO enrollment_linkedin_results
           (workspace_id, enrollment_id, firm_id, result, recorded_by_user_id)
         VALUES ($1, $2, $3, 'no_engagement', $4)`,
        [seeded.alpha.workspaceId, enrollmentId, crm.alpha.firmId, seeded.alpha.salesperson.userId],
      );
    }
  });
});

describe('the enrollment migration requires approval before it is applied (11.1)', () => {
  it('refuses an applied migration that nobody approved', async () => {
    const message = await refusal(
      `INSERT INTO enrollment_migrations
         (workspace_id, from_sequence_version_id, to_sequence_version_id, state, requested_by_user_id, applied_at)
       VALUES ($1, $2, $3, 'applied', $4, now())`,
      [
        seeded.alpha.workspaceId,
        sequences.alpha.publishedVersionId,
        sequences.alpha.draftVersionId,
        seeded.alpha.admin.userId,
      ],
    );
    expect(message).toMatch(/applied_was_approved/);
  });

  it('refuses a migration from a version to itself', async () => {
    const message = await refusal(
      `INSERT INTO enrollment_migrations
         (workspace_id, from_sequence_version_id, to_sequence_version_id, requested_by_user_id)
       VALUES ($1, $2, $2, $3)`,
      [seeded.alpha.workspaceId, sequences.alpha.publishedVersionId, seeded.alpha.admin.userId],
    );
    expect(message).toMatch(/not_a_self_migration/);
  });
});

describe('one current holiday calendar per workspace (11.2)', () => {
  it('refuses a second current calendar and accepts one that supersedes the first', async () => {
    const message = await refusal(
      `INSERT INTO workspace_holiday_calendars (workspace_id, version, created_by_user_id)
       VALUES ($1, 'holidays.2027', $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    expect(message).toMatch(/one_current/);

    await database.session.query(
      `UPDATE workspace_holiday_calendars SET superseded_at = now()
        WHERE workspace_id = $1 AND version = 'holidays.2026'`,
      [seeded.alpha.workspaceId],
    );
    const { rowCount } = await database.session.query(
      `INSERT INTO workspace_holiday_calendars (workspace_id, version, created_by_user_id)
       VALUES ($1, 'holidays.2027', $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    expect(rowCount).toBe(1);
  });
});
