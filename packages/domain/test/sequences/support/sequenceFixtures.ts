import type { SessionQueryable } from '../../../db/queryable.ts';
import { SENDING_STOP_LINE, templateContentHash } from '../../../src/index.ts';
import type { SeededWorkspace, TwoWorkspaces } from '../../db/support/fixtures.ts';

/**
 * Sequence, template and holiday-calendar rows for the two-workspace fixture
 * (specification 6, 11.1, Appendix G 8 and 33).
 *
 * Everything is created in *both* workspaces with colliding names — the same
 * sequence name, the same template name, the same calendar version — so that every
 * test in this directory is a two-workspace test whether or not it says so.
 *
 * No real person, firm, address or number appears. The footer's sign-off is an
 * obviously fictional string, and since migration 0015 there is no address anywhere in
 * it: an automated email carries none
 * (`docs/decisions/g20-automated-email-carries-no-postal-address.md`).
 */

export const FIXTURE_SIGN_OFF = 'Sam Example\nCallie';

/** A body that satisfies every rule `templateTextIssues` applies, including the footer. */
export function fixtureBody(opening: string): string {
  return `${opening}\n\n${FIXTURE_SIGN_OFF}\n${SENDING_STOP_LINE}`;
}

export interface SeededTemplate {
  readonly templateVersionId: string;
  readonly templateId: string;
  readonly contentHash: string;
}

export interface SeededSequence {
  readonly sequenceId: string;
  readonly draftVersionId: string;
  readonly publishedVersionId: string;
  readonly emailStepId: string;
  readonly callStepId: string;
  readonly template: SeededTemplate;
  readonly calendarVersion: string;
}

export interface SeededSequences {
  readonly alpha: SeededSequence;
  readonly beta: SeededSequence;
  readonly collidingSequenceName: string;
  readonly collidingCalendarVersion: string;
}

const COLLIDING_SEQUENCE_NAME = 'Founding outreach';
const COLLIDING_CALENDAR_VERSION = 'holidays.2026';

async function one<Row extends { id: string }>(
  session: SessionQueryable,
  sql: string,
  values: readonly unknown[],
): Promise<string> {
  const { rows } = await session.query<Row>(sql, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture insert returned no row: ${sql.slice(0, 60)}`);
  return id;
}

async function seedTemplate(
  session: SessionQueryable,
  workspace: SeededWorkspace,
  approved: boolean,
): Promise<SeededTemplate> {
  const templateId = await one<{ id: string }>(session, 'SELECT gen_random_uuid() AS id', []);
  const subject = 'A quick question about {firm_name}';
  const body = fixtureBody('Hello {contact_first_name},\n\nI work with firms like yours.');
  const contentHash = templateContentHash({ templateId, version: 1, subject, body });
  const templateVersionId = await one<{ id: string }>(
    session,
    `INSERT INTO template_versions
       (workspace_id, template_id, version, name, subject, body, content_hash,
        footer_sign_off, required_variables,
        approved_at, approved_by_user_id, personalization_strategy)
     VALUES ($1, $2, 1, 'First touch', $3, $4, $5, $6,
             ARRAY['firm_name','contact_first_name'],
             CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN $8::uuid END, 'deterministic')
     RETURNING id`,
    [
      workspace.workspaceId,
      templateId,
      subject,
      body,
      contentHash,
      FIXTURE_SIGN_OFF,
      approved,
      workspace.admin.userId,
    ],
  );
  return { templateVersionId, templateId, contentHash };
}

async function seedSequence(session: SessionQueryable, workspace: SeededWorkspace): Promise<SeededSequence> {
  await session.query(
    `INSERT INTO workspace_holiday_calendars (workspace_id, version, dates, created_by_user_id)
     VALUES ($1, $2, ARRAY[DATE '2026-12-25', DATE '2027-01-01'], $3)`,
    [workspace.workspaceId, COLLIDING_CALENDAR_VERSION, workspace.admin.userId],
  );

  const template = await seedTemplate(session, workspace, true);

  const sequenceId = await one<{ id: string }>(
    session,
    `INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [workspace.workspaceId, COLLIDING_SEQUENCE_NAME, workspace.admin.userId],
  );

  // Version 1 is published and carries the two channels; version 2 stays a draft,
  // because "editing a published sequence creates a new draft" (11.1) and the tests
  // need one of each.
  const publishedVersionId = await one<{ id: string }>(
    session,
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id`,
    [workspace.workspaceId, sequenceId],
  );

  const emailStepId = await one<{ id: string }>(
    session,
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
     VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3) RETURNING id`,
    [workspace.workspaceId, publishedVersionId, template.templateVersionId],
  );
  const callStepId = await one<{ id: string }>(
    session,
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, 2, 'call_task', 'business_days', 2, 'retry_call') RETURNING id`,
    [workspace.workspaceId, publishedVersionId],
  );
  await session.query(
    `UPDATE sequence_versions
        SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [workspace.workspaceId, publishedVersionId, workspace.admin.userId],
  );

  const draftVersionId = await one<{ id: string }>(
    session,
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 2) RETURNING id`,
    [workspace.workspaceId, sequenceId],
  );
  await session.query(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
     VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3)`,
    [workspace.workspaceId, draftVersionId, template.templateVersionId],
  );

  return {
    sequenceId,
    draftVersionId,
    publishedVersionId,
    emailStepId,
    callStepId,
    template,
    calendarVersion: COLLIDING_CALENDAR_VERSION,
  };
}

export async function seedSequences(
  session: SessionQueryable,
  seeded: TwoWorkspaces,
): Promise<SeededSequences> {
  return {
    alpha: await seedSequence(session, seeded.alpha),
    beta: await seedSequence(session, seeded.beta),
    collidingSequenceName: COLLIDING_SEQUENCE_NAME,
    collidingCalendarVersion: COLLIDING_CALENDAR_VERSION,
  };
}
