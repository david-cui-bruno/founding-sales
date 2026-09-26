import type { SessionQueryable } from './queryable.ts';
import { readAppliedSchemaVersion } from './migrationRunner.ts';

/**
 * Migration 0018's counts, read before the release stops anything (lane A4).
 *
 * `0018_remove_linkedin.sql` refuses — raises, and leaves schema 17 as it was — when a
 * step's `linkedin_message`, a row of `enrollment_linkedin_results` or a contact URL
 * that does not fit beside the title would be erased, unless the session says
 * `fss.remove_linkedin_history = 'on'`. That is a decision for the owner, and the owner
 * should make it before the services are stopped rather than while they are. So the
 * same counts run here, read-only, as `fss admin schema-preflight 0018` on the
 * operations task (`infra/scripts/schema-preflight-0018.sh`), and the seeded test in
 * `packages/domain/test/sequences/removedLinkedIn.test.ts` asserts that the
 * migration's refusal names the numbers this query returns.
 *
 * Every other count is informational: it is what 0018 converts without asking, and
 * the owner sees it so that nothing is converted unannounced.
 */

/** The migration this preflight is for. */
export const LINKEDIN_REMOVAL_MIGRATION = 18;

/** The title a contact's URL is appended to, and the separator. Mirrors 0018 (b). */
export const LINKEDIN_URL_TITLE_SEPARATOR = ' · ';
export const CONTACT_TITLE_MAXIMUM = 200;

/**
 * One row, one column per count. Runs on schema 17 only: on 18 the columns it reads
 * are gone, which is the point of the migration.
 */
export const LINKEDIN_REMOVAL_PREFLIGHT_SQL = `
SELECT
  (SELECT count(*) FROM contacts WHERE linkedin_url IS NOT NULL)::integer AS contact_urls,
  (SELECT count(*) FROM contacts
    WHERE linkedin_url IS NOT NULL
      AND (title IS NULL OR position(linkedin_url IN title) = 0)
      AND length(CASE WHEN title IS NULL THEN linkedin_url ELSE title || '${LINKEDIN_URL_TITLE_SEPARATOR}' || linkedin_url END) > ${String(CONTACT_TITLE_MAXIMUM)}
  )::integer AS contact_urls_that_do_not_fit,
  (SELECT count(*) FROM sequence_steps
    WHERE linkedin_message IS NOT NULL AND btrim(linkedin_message) <> '')::integer AS step_messages,
  (SELECT count(*) FROM sequence_steps WHERE channel = 'linkedin_task')::integer AS linkedin_steps,
  (SELECT count(*) FROM enrollment_linkedin_results)::integer AS recorded_linkedin_results,
  (SELECT count(*) FROM step_executions
    WHERE channel = 'linkedin_task' OR completion_source = 'open_and_copy' OR result = 'handed_off')::integer AS linkedin_executions,
  (SELECT count(*) FROM step_executions WHERE channel = 'linkedin_task' AND state IN ('pending', 'held'))::integer AS unfinished_linkedin_executions,
  (SELECT count(*) FROM step_execution_shifts WHERE reason = 'linkedin_grace')::integer AS linkedin_grace_shifts,
  (SELECT count(*) FROM sequence_enrollments WHERE end_reason = 'linkedin_reply')::integer AS enrollments_ended_by_linkedin_reply,
  (SELECT count(*) FROM today_items WHERE kind = 'linkedin_due')::integer AS linkedin_today_items,
  (SELECT count(*) FROM today_snapshots WHERE linkedin_due <> 0)::integer AS today_cards_counting_linkedin,
  (SELECT count(*) FROM active_holds WHERE 'linkedin_task' = ANY (blocked_action_kinds))::integer AS holds_naming_linkedin,
  (SELECT count(*) FROM active_holds WHERE blocked_action_kinds <@ ARRAY['linkedin_task']::text[])::integer AS holds_only_linkedin,
  (SELECT count(*) FROM administrative_pauses WHERE channel = 'linkedin')::integer AS linkedin_pauses,
  (SELECT count(*) FROM sequence_versions WHERE 'linkedin_reply' = ANY (stop_conditions))::integer AS versions_with_linkedin_reply,
  (SELECT count(*) FROM sequence_versions WHERE state <> 'draft' AND 'linkedin_reply' = ANY (stop_conditions))::integer AS published_versions_with_linkedin_reply
`;

export interface LinkedInRemovalCounts {
  /** Kept: appended to the contact's title. */
  readonly contactUrls: number;
  /** Refuses: the title and the URL together exceed 200 characters. */
  readonly contactUrlsThatDoNotFit: number;
  /** Refuses: text Callie wrote, erased with the column. */
  readonly stepMessages: number;
  readonly linkedInSteps: number;
  /** Refuses: a prospect's recorded reply or observation, erased with the table. */
  readonly recordedLinkedInResults: number;
  /** Converted with the setting: channel, completion source and result become `removed`. */
  readonly linkedInExecutions: number;
  /** Of those, the ones still pending or held; they stay held for a person. */
  readonly unfinishedLinkedInExecutions: number;
  readonly linkedInGraceShifts: number;
  /** Converted: `linkedin_reply` becomes `human_reply`. */
  readonly enrollmentsEndedByLinkedInReply: number;
  /** Deleted: derived, rebuilt every morning. */
  readonly linkedInTodayItems: number;
  readonly todayCardsCountingLinkedIn: number;
  /** Converted: `linkedin_task` leaves the array; a hold that blocked only it blocks `removed`. */
  readonly holdsNamingLinkedIn: number;
  readonly holdsOnlyLinkedIn: number;
  /** Converted: the pause's channel becomes `removed`. */
  readonly linkedInPauses: number;
  /** Converted: `linkedin_reply` leaves `stop_conditions`. Every version, by 0012's default. */
  readonly versionsWithLinkedInReply: number;
  readonly publishedVersionsWithLinkedInReply: number;
}

export type LinkedInRemovalPreflight =
  | {
      readonly applicable: true;
      readonly schemaVersion: number;
      readonly migration: number;
      readonly counts: LinkedInRemovalCounts;
      /**
       * True when 0018 would refuse without `fss.remove_linkedin_history = 'on'`: the
       * owner decides, from `counts`, before the release stops anything.
       */
      readonly refusesWithoutSetting: boolean;
    }
  | { readonly applicable: false; readonly schemaVersion: number; readonly migration: number };

interface CountsRow {
  readonly contact_urls: number;
  readonly contact_urls_that_do_not_fit: number;
  readonly step_messages: number;
  readonly linkedin_steps: number;
  readonly recorded_linkedin_results: number;
  readonly linkedin_executions: number;
  readonly unfinished_linkedin_executions: number;
  readonly linkedin_grace_shifts: number;
  readonly enrollments_ended_by_linkedin_reply: number;
  readonly linkedin_today_items: number;
  readonly today_cards_counting_linkedin: number;
  readonly holds_naming_linkedin: number;
  readonly holds_only_linkedin: number;
  readonly linkedin_pauses: number;
  readonly versions_with_linkedin_reply: number;
  readonly published_versions_with_linkedin_reply: number;
  readonly [column: string]: unknown;
}

/**
 * The counts, inside a READ ONLY transaction that is rolled back: the preflight runs
 * as the runtime identity against production before the stop, and it must not be able
 * to write even by mistake. On any schema but 17 it answers `applicable: false` and
 * reads nothing else — before 17 there is nothing to count against, after it the
 * migration has already run.
 */
export async function readLinkedInRemovalPreflight(session: SessionQueryable): Promise<LinkedInRemovalPreflight> {
  const schemaVersion = await readAppliedSchemaVersion(session);
  if (schemaVersion !== LINKEDIN_REMOVAL_MIGRATION - 1) {
    return { applicable: false, schemaVersion, migration: LINKEDIN_REMOVAL_MIGRATION };
  }
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const { rows } = await session.query<CountsRow>(LINKEDIN_REMOVAL_PREFLIGHT_SQL);
    const row = rows[0];
    if (row === undefined) throw new Error('the preflight count query returned no row');
    const counts: LinkedInRemovalCounts = {
      contactUrls: row.contact_urls,
      contactUrlsThatDoNotFit: row.contact_urls_that_do_not_fit,
      stepMessages: row.step_messages,
      linkedInSteps: row.linkedin_steps,
      recordedLinkedInResults: row.recorded_linkedin_results,
      linkedInExecutions: row.linkedin_executions,
      unfinishedLinkedInExecutions: row.unfinished_linkedin_executions,
      linkedInGraceShifts: row.linkedin_grace_shifts,
      enrollmentsEndedByLinkedInReply: row.enrollments_ended_by_linkedin_reply,
      linkedInTodayItems: row.linkedin_today_items,
      todayCardsCountingLinkedIn: row.today_cards_counting_linkedin,
      holdsNamingLinkedIn: row.holds_naming_linkedin,
      holdsOnlyLinkedIn: row.holds_only_linkedin,
      linkedInPauses: row.linkedin_pauses,
      versionsWithLinkedInReply: row.versions_with_linkedin_reply,
      publishedVersionsWithLinkedInReply: row.published_versions_with_linkedin_reply,
    };
    return {
      applicable: true,
      schemaVersion,
      migration: LINKEDIN_REMOVAL_MIGRATION,
      counts,
      refusesWithoutSetting:
        counts.stepMessages > 0 || counts.recordedLinkedInResults > 0 || counts.contactUrlsThatDoNotFit > 0,
    };
  } finally {
    await session.query('ROLLBACK');
  }
}

/** The session setting 0018 reads, and the only value that lets it erase history. */
export const REMOVE_LINKEDIN_HISTORY_SETTING = 'fss.remove_linkedin_history';

/** The SQLSTATE 0018 raises its refusal with. */
export const LINKEDIN_REMOVAL_REFUSAL_SQLSTATE = 'FS018';
