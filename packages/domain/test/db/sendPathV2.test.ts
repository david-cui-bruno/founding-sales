import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENROLLMENT_END_REASONS, FOLLOW_UP_CONSUMED_REASONS } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { MAIL_EFFECT_KINDS } from '../../mail/types.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedSequences, type SeededSequences } from '../sequences/support/sequenceFixtures.ts';

/**
 * Migration 0026 (send-path v2, slice S0): the two immutability triggers, and the
 * vocabularies it widens, each against a real PostgreSQL 16.
 *
 * Every case runs inside a transaction that is rolled back, so the cases share one
 * seeded database without seeing each other's writes.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

const workspace = (): string => seeded.alpha.workspaceId;
const admin = (): string => seeded.alpha.admin.userId;

async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
  await database.session.query('BEGIN');
  try {
    return await work();
  } finally {
    await database.session.query('ROLLBACK');
  }
}

/** The error a statement raised, or null when the database accepted it. */
async function refusal(sql: string, values: readonly unknown[] = []): Promise<{ code?: string; message?: string; constraint?: string } | null> {
  return await rolledBack(async () => {
    try {
      await database.session.query(sql, values);
      return null;
    } catch (error) {
      return error as { code?: string; message?: string; constraint?: string };
    }
  });
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

describe('the steps of a published sequence version do not move (0026)', () => {
  it('refuses an UPDATE of a published step, even one that changes nothing', async () => {
    for (const sql of [
      'UPDATE sequence_steps SET delay_amount = delay_amount + 1 WHERE workspace_id = $1 AND id = $2',
      'UPDATE sequence_steps SET delay_amount = delay_amount WHERE workspace_id = $1 AND id = $2',
    ]) {
      const error = await refusal(sql, [workspace(), sequences.alpha.emailStepId]);
      expect(error, sql).toMatchObject({ code: '23001' });
      expect(error?.message).toMatch(/published sequence version are immutable/);
    }
  });

  it('refuses a DELETE of a published step', async () => {
    const error = await refusal('DELETE FROM sequence_steps WHERE workspace_id = $1 AND id = $2', [
      workspace(),
      sequences.alpha.callStepId,
    ]);
    expect(error).toMatchObject({ code: '23001' });
  });

  it('refuses an INSERT of a step into a published version', async () => {
    const error = await refusal(
      `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
       VALUES ($1, $2, 90, 'call_task', 'elapsed', 1, 'advance')`,
      [workspace(), sequences.alpha.publishedVersionId],
    );
    expect(error).toMatchObject({ code: '23001' });
    expect(error?.message).toMatch(/published sequence version are immutable/);
  });

  it('lets a step be inserted into a draft', async () => {
    expect(
      await refusal(
        `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
         VALUES ($1, $2, 90, 'call_task', 'elapsed', 1, 'advance')`,
        [workspace(), sequences.alpha.draftVersionId],
      ),
    ).toBeNull();
  });

  it('refuses a step of a retired version too', async () => {
    const error = await rolledBack(async () => {
      await database.session.query(
        `UPDATE sequence_versions SET state = 'retired', retired_at = now(), retired_by_user_id = $3
          WHERE workspace_id = $1 AND id = $2`,
        [workspace(), sequences.alpha.publishedVersionId, admin()],
      );
      try {
        await database.session.query('UPDATE sequence_steps SET delay_amount = 5 WHERE workspace_id = $1 AND id = $2', [
          workspace(),
          sequences.alpha.emailStepId,
        ]);
        return null;
      } catch (caught) {
        return caught as { code?: string };
      }
    });
    expect(error).toMatchObject({ code: '23001' });
  });

  it('refuses moving a draft step into a published version', async () => {
    const error = await refusal(
      `UPDATE sequence_steps SET sequence_version_id = $2, ordinal = 90
        WHERE workspace_id = $1 AND sequence_version_id = $3`,
      [workspace(), sequences.alpha.publishedVersionId, sequences.alpha.draftVersionId],
    );
    expect(error).toMatchObject({ code: '23001' });
  });

  it('lets a draft version’s steps change and go', async () => {
    expect(
      await refusal('UPDATE sequence_steps SET delay_amount = 7 WHERE workspace_id = $1 AND sequence_version_id = $2', [
        workspace(),
        sequences.alpha.draftVersionId,
      ]),
    ).toBeNull();
    expect(
      await refusal('DELETE FROM sequence_steps WHERE workspace_id = $1 AND sequence_version_id = $2', [
        workspace(),
        sequences.alpha.draftVersionId,
      ]),
    ).toBeNull();
  });
});

describe('an approved template version’s content does not move (0026)', () => {
  const approvedId = (): string => sequences.alpha.template.templateVersionId;

  it('refuses a change to any content column of an approved version', async () => {
    for (const [column, value] of [
      ['subject', 'Another subject'],
      ['body', 'Another body.'],
      ['footer_sign_off', 'Someone Else'],
      ['content_hash', 'f'.repeat(64)],
      ['required_variables', '{firm_name}'],
    ] as const) {
      const error = await refusal(`UPDATE template_versions SET ${column} = $3 WHERE workspace_id = $1 AND id = $2`, [
        workspace(),
        approvedId(),
        value,
      ]);
      expect(error, column).toMatchObject({ code: '23001' });
      expect(error?.message).toMatch(/approved template version is immutable/);
    }
  });

  it('refuses un-approving an approved version: a new version is the way', async () => {
    const error = await refusal(
      'UPDATE template_versions SET approved_at = NULL, approved_by_user_id = NULL WHERE workspace_id = $1 AND id = $2',
      [workspace(), approvedId()],
    );
    expect(error).toMatchObject({ code: '23001' });
  });

  it('lets the three metadata columns move: name, retired_at, updated_at', async () => {
    expect(
      await refusal(
        `UPDATE template_versions SET name = 'Renamed', retired_at = now(), updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [workspace(), approvedId()],
      ),
    ).toBeNull();
  });

  it('lets an unapproved version change, and lets the approval transition itself through', async () => {
    const outcome = await rolledBack(async () => {
      const { rows } = await database.session.query<{ id: string }>(
        `INSERT INTO template_versions
           (workspace_id, template_id, version, name, subject, body, content_hash, footer_sign_off)
         VALUES ($1, gen_random_uuid(), 1, 'Draft', 'Hello', 'Hello there.', repeat('a', 64), 'Sam Example')
         RETURNING id`,
        [workspace()],
      );
      const id = rows[0]?.id ?? '';
      await database.session.query("UPDATE template_versions SET body = 'Edited before approval.' WHERE id = $1", [id]);
      // The approval: the approver columns and the bytes approved, in one statement.
      await database.session.query(
        `UPDATE template_versions SET body = 'The approved bytes.', approved_at = now(), approved_by_user_id = $2
          WHERE id = $1`,
        [id, admin()],
      );
      try {
        await database.session.query("UPDATE template_versions SET body = 'After approval.' WHERE id = $1", [id]);
        return 'accepted after approval';
      } catch (caught) {
        return (caught as { code?: string }).code;
      }
    });
    expect(outcome).toBe('23001');
  });
});

describe('the vocabularies 0026 widens', () => {
  it('admits every consumed reason the contract declares, paired with consumed_at', async () => {
    for (const reason of FOLLOW_UP_CONSUMED_REASONS) {
      expect(
        await refusal(
          `INSERT INTO follow_up_permissions
             (workspace_id, firm_id, contact_id, kind, scope, booking_reference, max_steps,
              expires_at, granted_by_user_id, consumed_at, consumed_reason)
           VALUES ($1, $2, $3, 'request', 'contextual_reply', 'cal-0026-vocab', 1,
                   now() + interval '14 days', $4, now(), $5)`,
          [workspace(), crm.alpha.firmId, crm.alpha.contactId, admin(), reason],
        ),
        reason,
      ).toBeNull();
    }
  });

  it('admits every end reason the contract declares, migration_superseded included', async () => {
    expect(ENROLLMENT_END_REASONS).toContain('migration_superseded');
    const { rows } = await database.session.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'sequence_enrollments_end_reason_known'`,
    );
    for (const reason of ENROLLMENT_END_REASONS) expect(rows[0]?.definition, reason).toContain(`'${reason}'`);
  });

  it('records the lineage of a migrated enrollment', async () => {
    const outcome = await rolledBack(async () => {
      const contacts: string[] = [];
      for (const name of ['Lineage Old', 'Lineage New']) {
        const { rows } = await database.session.query<{ id: string }>(
          'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
          [workspace(), crm.alpha.firmId, name],
        );
        contacts.push(rows[0]?.id ?? '');
      }
      const insert = `INSERT INTO sequence_enrollments
           (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
            firm_time_zone, holiday_calendar_version, origin_kind, state, ended_at, end_reason,
            migrated_from_enrollment_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1', 'prospecting', $7,
                 CASE WHEN $8::boolean THEN now() END, $9, $10)
         RETURNING id`;
      const { rows: old } = await database.session.query<{ id: string }>(insert, [
        workspace(), sequences.alpha.publishedVersionId, crm.alpha.opportunityId, crm.alpha.firmId,
        contacts[0], admin(), 'stopped', true, 'migration_superseded', null,
      ]);
      const { rows: fresh } = await database.session.query<{ id: string }>(insert, [
        workspace(), sequences.alpha.publishedVersionId, crm.alpha.opportunityId, crm.alpha.firmId,
        contacts[1], admin(), 'active', false, null, old[0]?.id,
      ]);
      const { rows } = await database.session.query<{ migrated_from_enrollment_id: string }>(
        'SELECT migrated_from_enrollment_id FROM sequence_enrollments WHERE id = $1',
        [fresh[0]?.id],
      );
      return rows[0]?.migrated_from_enrollment_id === old[0]?.id;
    });
    expect(outcome).toBe(true);
  });

  it('admits a cold_outreach mailbox and still refuses a shared one', async () => {
    const insert = `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, status, kind)
                    VALUES ($1, $2, $3, 'cold-0026', 'connected', $4)`;
    expect(await refusal(insert, [workspace(), admin(), 'cold-0026@example.test', 'cold_outreach'])).toBeNull();
    expect(await refusal(insert, [workspace(), admin(), 'shared-0026@example.test', 'shared'])).toMatchObject({
      constraint: 'mailboxes_shared_kind_disabled',
    });
  });

  it('admits every mail effect kind the domain declares, direct_send_conversation included', async () => {
    expect(MAIL_EFFECT_KINDS).toContain('direct_send_conversation');
    expect(MAIL_EFFECT_KINDS).toContain('direct_send_manual');
    const { rows } = await database.session.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'mail_message_effects_kind_known'`,
    );
    for (const kind of MAIL_EFFECT_KINDS) expect(rows[0]?.definition, kind).toContain(`'${kind}'`);
  });

  it('seeds cold_outreach_mailbox_required as recoverable', async () => {
    const { rows } = await database.session.query<{ recoverable: boolean }>(
      "SELECT recoverable FROM hold_reason_codes WHERE code = 'cold_outreach_mailbox_required'",
    );
    expect(rows).toEqual([{ recoverable: true }]);
  });
});
