import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * An instant later than any `now()` default the same row takes.
 *
 * G8 wrote the literal `'2026-09-21T13:00:00Z'` wherever a case needed a
 * `superseded_at`, `ended_at`, `published_at` or similar that was "later than the
 * row's own start". At 13:00 UTC on 21 September 2026 the clock passed it, and five
 * cases began to trip `..._not_before_...` order checks before the constraint they
 * were written to trip — the gate went red on a pull request that touched none of
 * this. The order checks are not what these cases test, so the instant only has to
 * stay ahead of the clock; an hour is plenty for one test run and never a day.
 */
const soon = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/**
 * A failing insert for every constraint migration 0012 adds, and for the five it adds
 * to `template_versions` (sequences, versions, steps, enrollments, step
 * executions and the holiday calendar). Migration 0018 dropped the LinkedIn results
 * table and the three CHECKs over a step's LinkedIn message; 0019 dropped the audited
 * migration's two tables and replaced the vocabularies that still admitted a LinkedIn
 * marker under the same names.
 *
 * Same rules as `crmCases.ts`, `policyCases.ts` and `todayCases.ts`: their own file so
 * two lanes never edit the middle of one array, each case inside a transaction the
 * caller rolls back, and **each row breaking exactly one thing** — a row that breaks
 * two is reported under whichever constraint PostgreSQL reaches first, and the case
 * would be testing the wrong promise.
 *
 * That last rule is why `sequence_steps_delay_bounded` does not mention the unit and a
 * second constraint bounds business days: a row with an unknown unit would otherwise
 * break the bound as well as `delay_unit_known`.
 *
 * The constraints fixture seeds workspaces and members but no CRM rows, so each case
 * builds the chain it needs. No real business name, address or number appears;
 * `example.test` is reserved by RFC 6761.
 */

export interface SequenceCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

export interface SequenceCase {
  readonly constraint: string;
  readonly run: (fixture: SequenceCaseFixture) => Promise<unknown>;
}

const workspace = (f: SequenceCaseFixture): string => f.seeded.alpha.workspaceId;
const admin = (f: SequenceCaseFixture): string => f.seeded.alpha.admin.userId;
const salesperson = (f: SequenceCaseFixture): string => f.seeded.alpha.salesperson.userId;
/** A member of the other workspace. Every composite foreign key refuses one. */
const outsider = (f: SequenceCaseFixture): string => f.seeded.beta.salesperson.userId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';
const NOW = 'now()';
const STOP_LINE = 'Reply "stop" and I will not email you again.';

async function one(
  f: SequenceCaseFixture,
  sql: string,
  values: readonly unknown[] = [],
): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(sql, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`a case fixture returned no row: ${sql.slice(0, 60)}`);
  return id;
}

async function makeFirm(f: SequenceCaseFixture, name = 'Northwind Test Holdings'): Promise<string> {
  return await one(
    f,
    `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'RI', '02903', 'America/New_York', 'high', 'postal', 'firm-zone.1')
     RETURNING id`,
    [workspace(f), name, salesperson(f)],
  );
}

async function makeContact(
  f: SequenceCaseFixture,
  firmId: string,
  fullName = 'Dana Example',
): Promise<string> {
  return await one(
    f,
    'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
    [workspace(f), firmId, fullName],
  );
}

async function makeOpportunity(f: SequenceCaseFixture, firmId: string): Promise<string> {
  const stageId = await one(
    f,
    'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
    [workspace(f)],
  );
  return await one(
    f,
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, ${NOW}) RETURNING id`,
    [workspace(f), firmId, stageId],
  );
}

async function makeTemplate(f: SequenceCaseFixture, approved = true): Promise<string> {
  return await one(
    f,
    `INSERT INTO template_versions
       (workspace_id, template_id, version, name, subject, body, content_hash,
        footer_sign_off, approved_at, approved_by_user_id)
     VALUES ($1, gen_random_uuid(), 1, 'First touch', 'A question',
             $2, repeat('a', 64), 'Sam Example',
             CASE WHEN $3 THEN ${NOW} END, CASE WHEN $3 THEN $4::uuid END)
     RETURNING id`,
    [workspace(f), `Hello,\n\n${STOP_LINE}`, approved, admin(f)],
  );
}

async function makeSequence(f: SequenceCaseFixture, name = 'Founding outreach'): Promise<string> {
  return await one(
    f,
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspace(f), name, admin(f)],
  );
}

async function makeVersion(
  f: SequenceCaseFixture,
  sequenceId: string,
  version = 1,
): Promise<string> {
  return await one(
    f,
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, $3) RETURNING id',
    [workspace(f), sequenceId, version],
  );
}

async function makeCallStep(
  f: SequenceCaseFixture,
  versionId: string,
  ordinal = 1,
): Promise<string> {
  return await one(
    f,
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, $3, 'call_task', 'elapsed', 1, 'advance') RETURNING id`,
    [workspace(f), versionId, ordinal],
  );
}

interface Chain {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
  readonly sequenceId: string;
  readonly versionId: string;
  readonly stepId: string;
  readonly enrollmentId: string;
}

/** Firm, contact, opportunity, sequence, draft version, one step, one enrollment. */
async function makeChain(f: SequenceCaseFixture, label = ''): Promise<Chain> {
  const firmId = await makeFirm(f, `Northwind Test Holdings${label}`);
  const contactId = await makeContact(f, firmId);
  const opportunityId = await makeOpportunity(f, firmId);
  const sequenceId = await makeSequence(f, `Founding outreach${label}`);
  const versionId = await makeVersion(f, sequenceId);
  const stepId = await makeCallStep(f, versionId);
  const enrollmentId = await one(
    f,
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        firm_time_zone, holiday_calendar_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1') RETURNING id`,
    [workspace(f), versionId, opportunityId, firmId, contactId, salesperson(f)],
  );
  return { firmId, contactId, opportunityId, sequenceId, versionId, stepId, enrollmentId };
}

const EXECUTION_COLUMNS = `(workspace_id, id, enrollment_id, step_id, firm_id, contact_id, channel,
  ordinal, state, due_at, not_before, original_due_at, source_zone, rule_version, attempt_count,
  hold_reason_code, completion_source, result, completed_at, cancelled_at, cancel_reason,
  created_at, updated_at)`;

interface ExecutionOverrides {
  readonly id?: string;
  readonly enrollmentId?: string;
  readonly stepId?: string;
  readonly contactId?: string;
  readonly channel?: string;
  readonly ordinal?: number;
  readonly state?: string;
  readonly sourceZone?: string;
  readonly ruleVersion?: string;
  readonly attemptCount?: number;
  readonly holdReasonCode?: string | null;
  readonly completionSource?: string | null;
  readonly result?: string | null;
  readonly completedAt?: string | null;
  readonly cancelledAt?: string | null;
  readonly cancelReason?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

async function insertExecution(
  f: SequenceCaseFixture,
  chain: Chain,
  overrides: ExecutionOverrides = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO step_executions ${EXECUTION_COLUMNS}
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7,
             $8, $9, ${NOW}, ${NOW}, ${NOW}, $10, $11, $12,
             $13, $14, $15, $16::timestamptz, $17::timestamptz, $18,
             COALESCE($19::timestamptz, ${NOW}), COALESCE($20::timestamptz, ${NOW}))`,
    [
      workspace(f),
      overrides.id ?? null,
      overrides.enrollmentId ?? chain.enrollmentId,
      overrides.stepId ?? chain.stepId,
      chain.firmId,
      overrides.contactId ?? chain.contactId,
      overrides.channel ?? 'call_task',
      overrides.ordinal ?? 1,
      overrides.state ?? 'pending',
      overrides.sourceZone ?? 'America/New_York',
      overrides.ruleVersion ?? 'elapsed.1',
      overrides.attemptCount ?? 0,
      overrides.holdReasonCode ?? null,
      overrides.completionSource ?? null,
      overrides.result ?? null,
      overrides.completedAt ?? null,
      overrides.cancelledAt ?? null,
      overrides.cancelReason ?? null,
      overrides.createdAt ?? null,
      overrides.updatedAt ?? null,
    ],
  );
}

const VERSION_COLUMNS = `(workspace_id, id, sequence_id, version, state, stop_conditions,
  published_at, published_by_user_id, retired_at, retired_by_user_id, created_at, updated_at)`;

const ALL_STOPS = `ARRAY['human_reply','engaged_call','opt_out_or_suppression','stage_closed']`;

interface VersionOverrides {
  readonly id?: string;
  readonly sequenceId?: string;
  readonly version?: number;
  readonly state?: string;
  readonly stopConditions?: string;
  readonly publishedAt?: string | null;
  readonly publishedBy?: string | null;
  readonly retiredAt?: string | null;
  readonly retiredBy?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

async function insertVersion(
  f: SequenceCaseFixture,
  sequenceId: string,
  overrides: VersionOverrides = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO sequence_versions ${VERSION_COLUMNS}
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, ${overrides.stopConditions ?? ALL_STOPS}::text[],
             $6::timestamptz, $7::uuid, $8::timestamptz, $9::uuid,
             COALESCE($10::timestamptz, ${NOW}), COALESCE($11::timestamptz, ${NOW}))`,
    [
      workspace(f),
      overrides.id ?? null,
      overrides.sequenceId ?? sequenceId,
      overrides.version ?? 9,
      overrides.state ?? 'draft',
      overrides.publishedAt ?? null,
      overrides.publishedBy ?? null,
      overrides.retiredAt ?? null,
      overrides.retiredBy ?? null,
      overrides.createdAt ?? null,
      overrides.updatedAt ?? null,
    ],
  );
}

const STEP_COLUMNS = `(workspace_id, id, sequence_version_id, ordinal, channel, delay_unit,
  delay_amount, on_no_answer, template_version_id)`;

interface StepOverrides {
  readonly id?: string;
  readonly versionId?: string;
  readonly ordinal?: number;
  readonly channel?: string;
  readonly delayUnit?: string;
  readonly delayAmount?: number;
  readonly onNoAnswer?: string | null;
  readonly templateVersionId?: string | null;
}

async function insertStep(
  f: SequenceCaseFixture,
  versionId: string,
  overrides: StepOverrides = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO sequence_steps ${STEP_COLUMNS}
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8, $9::uuid)`,
    [
      workspace(f),
      overrides.id ?? null,
      overrides.versionId ?? versionId,
      overrides.ordinal ?? 5,
      overrides.channel ?? 'call_task',
      overrides.delayUnit ?? 'elapsed',
      overrides.delayAmount ?? 1,
      overrides.onNoAnswer === undefined ? 'advance' : overrides.onNoAnswer,
      overrides.templateVersionId ?? null,
    ],
  );
}

const ENROLLMENT_COLUMNS = `(workspace_id, id, sequence_version_id, opportunity_id, firm_id,
  contact_id, assigned_user_id, state, started_at, ended_at, end_reason, firm_time_zone,
  holiday_calendar_version, review_union_milliseconds, created_at, updated_at)`;

interface EnrollmentOverrides {
  readonly id?: string;
  readonly versionId?: string;
  readonly opportunityId?: string;
  readonly firmId?: string;
  readonly contactId?: string;
  readonly assignedUserId?: string;
  readonly state?: string;
  readonly startedAt?: string;
  readonly endedAt?: string | null;
  readonly endReason?: string | null;
  readonly zone?: string;
  readonly calendarVersion?: string;
  readonly reviewUnion?: number | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

async function insertEnrollment(
  f: SequenceCaseFixture,
  chain: Chain,
  overrides: EnrollmentOverrides = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO sequence_enrollments ${ENROLLMENT_COLUMNS}
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5,
             $6, $7, $8, COALESCE($9::timestamptz, ${NOW}), $10::timestamptz, $11, $12,
             $13, $14, COALESCE($15::timestamptz, ${NOW}), COALESCE($16::timestamptz, ${NOW}))`,
    [
      workspace(f),
      overrides.id ?? null,
      overrides.versionId ?? chain.versionId,
      overrides.opportunityId ?? chain.opportunityId,
      overrides.firmId ?? chain.firmId,
      overrides.contactId ?? chain.contactId,
      overrides.assignedUserId ?? salesperson(f),
      overrides.state ?? 'active',
      overrides.startedAt ?? null,
      overrides.endedAt ?? null,
      overrides.endReason ?? null,
      overrides.zone ?? 'America/New_York',
      overrides.calendarVersion ?? 'none.1',
      overrides.reviewUnion ?? null,
      overrides.createdAt ?? null,
      overrides.updatedAt ?? null,
    ],
  );
}

async function insertShift(
  f: SequenceCaseFixture,
  chain: Chain,
  executionId: string,
  overrides: {
    readonly id?: string;
    readonly executionId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly shift?: number;
    readonly reason?: string;
    readonly union?: number | null;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO step_execution_shifts
       (workspace_id, id, step_execution_id, enrollment_id, from_due_at, to_due_at,
        shift_milliseconds, reason, hold_union_milliseconds)
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4,
             ${overrides.from ?? NOW}, ${overrides.to ?? `${NOW} + interval '1 day'`},
             $5, $6, $7)`,
    [
      workspace(f),
      overrides.id ?? null,
      overrides.executionId ?? executionId,
      chain.enrollmentId,
      overrides.shift ?? 86_400_000,
      overrides.reason ?? 'hold_union',
      overrides.union ?? null,
    ],
  );
}

async function insertCalendar(
  f: SequenceCaseFixture,
  overrides: {
    readonly workspaceId?: string;
    readonly id?: string;
    readonly version?: string;
    readonly dates?: string;
    readonly author?: string;
    readonly effectiveFrom?: string;
    readonly supersededAt?: string | null;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO workspace_holiday_calendars
       (workspace_id, id, version, dates, created_by_user_id, effective_from, superseded_at)
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, ${overrides.dates ?? "'{}'"}::date[], $4,
             ${overrides.effectiveFrom ?? NOW}, $5::timestamptz)`,
    [
      overrides.workspaceId ?? workspace(f),
      overrides.id ?? null,
      overrides.version ?? 'holidays.2026',
      overrides.author ?? admin(f),
      overrides.supersededAt ?? null,
    ],
  );
}

async function insertTemplateExtension(
  f: SequenceCaseFixture,
  overrides: {
    readonly strategy?: string | null;
    readonly generator?: string | null;
    readonly prompt?: string | null;
    readonly evidence?: string | null;
    readonly generatedBlock?: string | null;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO template_versions
       (workspace_id, template_id, version, name, subject, body, content_hash,
        footer_sign_off,
        personalization_strategy, generator_version, prompt_version, evidence_item_ids, generated_block)
     VALUES ($1, gen_random_uuid(), 1, 'Extended', 'A question', $2, repeat('b', 64),
             'Sam Example', $3, $4, $5, ${overrides.evidence ?? 'NULL'}::uuid[], $6)`,
    [
      workspace(f),
      `Hello,\n\n${STOP_LINE}`,
      overrides.strategy ?? null,
      overrides.generator ?? null,
      overrides.prompt ?? null,
      overrides.generatedBlock ?? null,
    ],
  );
}

export const SEQUENCE_CONSTRAINT_CASES: readonly SequenceCase[] = [
  // ---------------------------------------------------------- template_versions
  {
    constraint: 'template_versions_personalization_known',
    run: async f => await insertTemplateExtension(f, { strategy: 'handwritten' }),
  },
  {
    // 11.1 and section 17: the vocabulary is reserved and the word is refused.
    constraint: 'template_versions_generated_personalization_disabled',
    run: async f => await insertTemplateExtension(f, { strategy: 'generated' }),
  },
  {
    constraint: 'template_versions_generated_block_reserved',
    run: async f =>
      await insertTemplateExtension(f, { strategy: 'deterministic', generatedBlock: 'A sentence.' }),
  },
  {
    constraint: 'template_versions_generator_version_bounded',
    run: async f => await insertTemplateExtension(f, { generator: '   ' }),
  },
  {
    constraint: 'template_versions_prompt_version_bounded',
    run: async f => await insertTemplateExtension(f, { prompt: '   ' }),
  },
  {
    constraint: 'template_versions_evidence_bounded',
    run: async f =>
      await insertTemplateExtension(f, {
        evidence: `ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 25))`,
      }),
  },

  // -------------------------------------------------- workspace_holiday_calendars
  {
    constraint: 'workspace_holiday_calendars_workspace_id_fkey',
    run: async f => await insertCalendar(f, { workspaceId: MISSING }),
  },
  {
    constraint: 'workspace_holiday_calendars_pkey',
    run: async f => {
      const id = await one(
        f,
        `INSERT INTO workspace_holiday_calendars (workspace_id, version, created_by_user_id)
         VALUES ($1, 'holidays.2026', $2) RETURNING id`,
        [workspace(f), admin(f)],
      );
      // Superseded, so the one-current index is not the thing that refuses it.
      return await insertCalendar(f, { id, version: 'holidays.2027', supersededAt: soon() });
    },
  },
  {
    constraint: 'workspace_holiday_calendars_one_per_version',
    run: async f => {
      await insertCalendar(f, { version: 'holidays.2026' });
      return await insertCalendar(f, { version: 'holidays.2026', supersededAt: soon() });
    },
  },
  {
    constraint: 'workspace_holiday_calendars_one_current',
    run: async f => {
      await insertCalendar(f, { version: 'holidays.2026' });
      return await insertCalendar(f, { version: 'holidays.2027' });
    },
  },
  {
    constraint: 'workspace_holiday_calendars_author_fkey',
    run: async f => await insertCalendar(f, { author: outsider(f) }),
  },
  {
    constraint: 'workspace_holiday_calendars_version_shape',
    run: async f => await insertCalendar(f, { version: 'Holidays 2026!' }),
  },
  {
    constraint: 'workspace_holiday_calendars_dates_bounded',
    run: async f =>
      await insertCalendar(f, {
        dates: `ARRAY(SELECT (DATE '2026-01-01' + n) FROM generate_series(0, 500) n)`,
      }),
  },
  {
    constraint: 'workspace_holiday_calendars_superseded_not_before_effective',
    run: async f =>
      // Superseded an hour from now, effective two days from now: always before, whatever
      // the clock says. The first version fixed `effective_from` at 13:00 UTC on 22 Sep
      // 2026 and the case passed only until noon that day.
      await insertCalendar(f, {
        effectiveFrom: "NOW() + INTERVAL '2 days'",
        supersededAt: soon(),
      }),
  },

  // ------------------------------------------------------------------- sequences
  {
    constraint: 'sequences_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3)',
        [MISSING, 'Orphan', admin(f)],
      ),
  },
  {
    constraint: 'sequences_pkey',
    run: async f => {
      const id = await makeSequence(f, 'Original');
      return await f.session.query(
        'INSERT INTO sequences (workspace_id, id, name, created_by_user_id) VALUES ($1, $2, $3, $4)',
        [workspace(f), id, 'Another name', admin(f)],
      );
    },
  },
  {
    constraint: 'sequences_one_per_name',
    run: async f => {
      await makeSequence(f, 'Founding outreach');
      return await makeSequence(f, 'Founding outreach');
    },
  },
  {
    constraint: 'sequences_author_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3)',
        [workspace(f), 'Outsider', outsider(f)],
      ),
  },
  {
    constraint: 'sequences_name_present',
    run: async f => await makeSequence(f, '   '),
  },
  {
    constraint: 'sequences_description_bounded',
    run: async f =>
      await f.session.query(
        'INSERT INTO sequences (workspace_id, name, description, created_by_user_id) VALUES ($1, $2, $3, $4)',
        [workspace(f), 'Blank description', '   ', admin(f)],
      ),
  },
  {
    constraint: 'sequences_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO sequences (workspace_id, name, created_by_user_id, created_at, updated_at)
         VALUES ($1, 'Backdated', $2, TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f), admin(f)],
      ),
  },

  // ------------------------------------------------------------ sequence_versions
  {
    // The semantic key is created with the table and the primary key by a later
    // ALTER, so a duplicate id at *another* sequence is what reaches the pkey.
    constraint: 'sequence_versions_pkey',
    run: async f => {
      const first = await makeSequence(f, 'One');
      const second = await makeSequence(f, 'Two');
      const id = await makeVersion(f, first, 1);
      return await insertVersion(f, second, { id });
    },
  },
  {
    constraint: 'sequence_versions_semantic_key',
    run: async f => {
      const sequenceId = await makeSequence(f);
      const id = await makeVersion(f, sequenceId, 1);
      return await insertVersion(f, sequenceId, { id, version: 2 });
    },
  },
  {
    constraint: 'sequence_versions_sequence_fkey',
    run: async f => await insertVersion(f, MISSING),
  },
  {
    constraint: 'sequence_versions_one_per_version',
    run: async f => {
      const sequenceId = await makeSequence(f);
      await makeVersion(f, sequenceId, 3);
      return await insertVersion(f, sequenceId, { version: 3, state: 'published', publishedAt: soon(), publishedBy: admin(f) });
    },
  },
  {
    constraint: 'sequence_versions_version_positive',
    run: async f => await insertVersion(f, await makeSequence(f), { version: 0 }),
  },
  {
    constraint: 'sequence_versions_state_known',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        state: 'sketch',
        publishedAt: soon(),
        publishedBy: admin(f),
      }),
  },
  {
    constraint: 'sequence_versions_publication_consistent',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        state: 'draft',
        publishedAt: soon(),
        publishedBy: admin(f),
      }),
  },
  {
    constraint: 'sequence_versions_publisher_fkey',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        state: 'published',
        publishedAt: soon(),
        publishedBy: outsider(f),
      }),
  },
  {
    constraint: 'sequence_versions_retirer_fkey',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        state: 'retired',
        publishedAt: soon(),
        publishedBy: admin(f),
        retiredAt: soon(),
        retiredBy: outsider(f),
      }),
  },
  {
    constraint: 'sequence_versions_retired_has_instant',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        state: 'retired',
        publishedAt: soon(),
        publishedBy: admin(f),
      }),
  },
  {
    constraint: 'sequence_versions_unretired_has_no_instant',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        state: 'published',
        publishedAt: soon(),
        publishedBy: admin(f),
        retiredAt: soon(),
        retiredBy: admin(f),
      }),
  },
  {
    constraint: 'sequence_versions_retired_not_before_published',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        state: 'retired',
        publishedAt: soon(),
        publishedBy: admin(f),
        retiredAt: '2026-09-20T13:00:00Z',
        retiredBy: admin(f),
      }),
  },
  {
    constraint: 'sequence_versions_stop_conditions_known',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        stopConditions: `ARRAY['human_reply','engaged_call','opt_out_or_suppression','stage_closed','the_moon_is_full']`,
      }),
  },
  {
    // 11.2's five terminal conditions are mandatory; a version cannot opt out.
    constraint: 'sequence_versions_stop_conditions_complete',
    run: async f =>
      await insertVersion(f, await makeSequence(f), { stopConditions: `ARRAY['human_reply']` }),
  },
  {
    constraint: 'sequence_versions_updated_not_before_created',
    run: async f =>
      await insertVersion(f, await makeSequence(f), {
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
  },
  {
    constraint: 'sequence_versions_one_draft',
    run: async f => {
      const sequenceId = await makeSequence(f);
      await makeVersion(f, sequenceId, 1);
      return await insertVersion(f, sequenceId, { version: 2 });
    },
  },

  // --------------------------------------------------------------- sequence_steps
  {
    constraint: 'sequence_steps_pkey',
    run: async f => {
      const first = await makeVersion(f, await makeSequence(f, 'One'));
      const second = await makeVersion(f, await makeSequence(f, 'Two'));
      const id = await makeCallStep(f, first, 1);
      return await insertStep(f, second, { id });
    },
  },
  {
    constraint: 'sequence_steps_semantic_key',
    run: async f => {
      const versionId = await makeVersion(f, await makeSequence(f));
      const id = await makeCallStep(f, versionId, 1);
      return await insertStep(f, versionId, { id, ordinal: 2 });
    },
  },
  {
    // The trigger returns rather than raising when the parent is absent, so the
    // foreign key is the thing that refuses this.
    constraint: 'sequence_steps_version_fkey',
    run: async f => await insertStep(f, MISSING),
  },
  {
    constraint: 'sequence_steps_template_fkey',
    run: async f =>
      await insertStep(f, await makeVersion(f, await makeSequence(f)), {
        channel: 'email',
        onNoAnswer: null,
        templateVersionId: MISSING,
      }),
  },
  {
    constraint: 'sequence_steps_one_per_ordinal',
    run: async f => {
      const versionId = await makeVersion(f, await makeSequence(f));
      await makeCallStep(f, versionId, 1);
      return await insertStep(f, versionId, { ordinal: 1 });
    },
  },
  {
    constraint: 'sequence_steps_ordinal_positive',
    run: async f => await insertStep(f, await makeVersion(f, await makeSequence(f)), { ordinal: 0 }),
  },
  {
    constraint: 'sequence_steps_channel_known',
    run: async f =>
      await insertStep(f, await makeVersion(f, await makeSequence(f)), {
        channel: 'carrier_pigeon',
        onNoAnswer: null,
      }),
  },
  {
    constraint: 'sequence_steps_delay_unit_known',
    run: async f =>
      await insertStep(f, await makeVersion(f, await makeSequence(f)), { delayUnit: 'fortnights' }),
  },
  {
    constraint: 'sequence_steps_delay_bounded',
    run: async f =>
      await insertStep(f, await makeVersion(f, await makeSequence(f)), {
        delayUnit: 'elapsed',
        delayAmount: 9000,
      }),
  },
  {
    constraint: 'sequence_steps_business_days_bounded',
    run: async f =>
      await insertStep(f, await makeVersion(f, await makeSequence(f)), {
        delayUnit: 'business_days',
        delayAmount: 400,
      }),
  },
  {
    constraint: 'sequence_steps_no_answer_is_a_call_step',
    run: async f => {
      const templateVersionId = await makeTemplate(f);
      return await insertStep(f, await makeVersion(f, await makeSequence(f)), {
        channel: 'email',
        templateVersionId,
        onNoAnswer: 'advance',
      });
    },
  },
  {
    constraint: 'sequence_steps_no_answer_known',
    run: async f =>
      await insertStep(f, await makeVersion(f, await makeSequence(f)), { onNoAnswer: 'try_harder' }),
  },
  {
    constraint: 'sequence_steps_email_has_template',
    run: async f =>
      await insertStep(f, await makeVersion(f, await makeSequence(f)), {
        channel: 'email',
        onNoAnswer: null,
        templateVersionId: null,
      }),
  },

  // --------------------------------------------------------- sequence_enrollments
  {
    constraint: 'sequence_enrollments_pkey',
    run: async f => {
      const first = await makeChain(f, ' one');
      const second = await makeChain(f, ' two');
      return await insertEnrollment(f, second, { id: first.enrollmentId });
    },
  },
  {
    constraint: 'sequence_enrollments_semantic_key',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, { id: chain.enrollmentId, contactId: other });
    },
  },
  {
    constraint: 'sequence_enrollments_version_fkey',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, { versionId: MISSING, contactId: other });
    },
  },
  {
    constraint: 'sequence_enrollments_opportunity_fkey',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, { opportunityId: MISSING, contactId: other });
    },
  },
  {
    constraint: 'sequence_enrollments_contact_fkey',
    run: async f => await insertEnrollment(f, await makeChain(f), { contactId: MISSING }),
  },
  {
    constraint: 'sequence_enrollments_assignee_fkey',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, { assignedUserId: outsider(f), contactId: other });
    },
  },
  {
    constraint: 'sequence_enrollments_state_known',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, {
        contactId: other,
        state: 'dozing',
        endedAt: soon(),
        endReason: 'admin_stop',
      });
    },
  },
  {
    constraint: 'sequence_enrollments_live_has_no_end',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, {
        contactId: other,
        state: 'active',
        endedAt: soon(),
        endReason: 'admin_stop',
      });
    },
  },
  {
    constraint: 'sequence_enrollments_end_has_reason',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, {
        contactId: other,
        state: 'stopped',
        endedAt: soon(),
      });
    },
  },
  {
    constraint: 'sequence_enrollments_end_reason_known',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, {
        contactId: other,
        state: 'stopped',
        endedAt: soon(),
        endReason: 'they_stopped_answering',
      });
    },
  },
  {
    constraint: 'sequence_enrollments_end_not_before_start',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, {
        contactId: other,
        state: 'stopped',
        startedAt: '2026-09-02T00:00:00Z',
        endedAt: '2026-09-01T00:00:00Z',
        endReason: 'admin_stop',
      });
    },
  },
  {
    constraint: 'sequence_enrollments_zone_shape',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, { contactId: other, zone: 'somewhere!' });
    },
  },
  {
    constraint: 'sequence_enrollments_calendar_version_shape',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, { contactId: other, calendarVersion: 'Holidays!' });
    },
  },
  {
    constraint: 'sequence_enrollments_review_union_present',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, { contactId: other, reviewUnion: 1000 });
    },
  },
  {
    constraint: 'sequence_enrollments_review_union_positive',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, {
        contactId: other,
        state: 'review_required',
        reviewUnion: -1,
      });
    },
  },
  {
    constraint: 'sequence_enrollments_updated_not_before_created',
    run: async f => {
      const chain = await makeChain(f);
      const other = await makeContact(f, chain.firmId, 'Robin Example');
      return await insertEnrollment(f, chain, {
        contactId: other,
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
    },
  },
  {
    // 11.2: one active enrollment per contact, regardless of sequence.
    constraint: 'sequence_enrollments_one_active_per_contact',
    run: async f => await insertEnrollment(f, await makeChain(f)),
  },

  // ------------------------------------------------------------- step_executions
  {
    constraint: 'step_executions_pkey',
    run: async f => {
      const first = await makeChain(f, ' one');
      const second = await makeChain(f, ' two');
      const id = await one(
        f,
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, 'call_task', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspace(f), first.enrollmentId, first.stepId, first.firmId, first.contactId],
      );
      return await insertExecution(f, second, { id });
    },
  },
  {
    constraint: 'step_executions_semantic_key',
    run: async f => {
      const chain = await makeChain(f);
      const second = await makeCallStep(f, chain.versionId, 2);
      const id = await one(
        f,
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, 'call_task', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspace(f), chain.enrollmentId, chain.stepId, chain.firmId, chain.contactId],
      );
      return await insertExecution(f, chain, { id, stepId: second, ordinal: 2 });
    },
  },
  {
    constraint: 'step_executions_enrollment_fkey',
    run: async f => await insertExecution(f, await makeChain(f), { enrollmentId: MISSING }),
  },
  {
    constraint: 'step_executions_step_fkey',
    run: async f => await insertExecution(f, await makeChain(f), { stepId: MISSING }),
  },
  {
    constraint: 'step_executions_contact_fkey',
    run: async f => await insertExecution(f, await makeChain(f), { contactId: MISSING }),
  },
  {
    // Appendix C's `step-execution:{id}` rests on this: one row per step of an
    // enrollment, so a retry re-arms the row rather than inserting a second.
    constraint: 'step_executions_one_per_step',
    run: async f => {
      const chain = await makeChain(f);
      await insertExecution(f, chain);
      return await insertExecution(f, chain);
    },
  },
  {
    constraint: 'step_executions_channel_known',
    run: async f => await insertExecution(f, await makeChain(f), { channel: 'carrier_pigeon' }),
  },
  {
    constraint: 'step_executions_ordinal_positive',
    run: async f => await insertExecution(f, await makeChain(f), { ordinal: 0 }),
  },
  {
    constraint: 'step_executions_state_known',
    run: async f => await insertExecution(f, await makeChain(f), { state: 'thinking' }),
  },
  {
    constraint: 'step_executions_held_has_reason',
    run: async f => await insertExecution(f, await makeChain(f), { state: 'held' }),
  },
  {
    constraint: 'step_executions_hold_reason_code_fkey',
    run: async f =>
      await insertExecution(f, await makeChain(f), {
        state: 'held',
        holdReasonCode: 'nobody_felt_like_it',
      }),
  },
  {
    constraint: 'step_executions_completion_consistent',
    run: async f => await insertExecution(f, await makeChain(f), { state: 'completed' }),
  },
  {
    constraint: 'step_executions_completion_source_known',
    run: async f =>
      await insertExecution(f, await makeChain(f), {
        state: 'completed',
        completedAt: soon(),
        completionSource: 'a_hunch',
        result: 'sent',
      }),
  },
  {
    constraint: 'step_executions_result_known',
    run: async f =>
      await insertExecution(f, await makeChain(f), {
        state: 'completed',
        completedAt: soon(),
        completionSource: 'send',
        result: 'probably_fine',
      }),
  },
  {
    constraint: 'step_executions_cancel_consistent',
    run: async f => await insertExecution(f, await makeChain(f), { state: 'cancelled' }),
  },
  {
    constraint: 'step_executions_cancel_reason_bounded',
    run: async f =>
      await insertExecution(f, await makeChain(f), {
        state: 'cancelled',
        cancelledAt: soon(),
        cancelReason: '   ',
      }),
  },
  {
    constraint: 'step_executions_attempts_bounded',
    run: async f => await insertExecution(f, await makeChain(f), { attemptCount: 99 }),
  },
  {
    constraint: 'step_executions_zone_shape',
    run: async f => await insertExecution(f, await makeChain(f), { sourceZone: 'somewhere!' }),
  },
  {
    constraint: 'step_executions_rule_version_bounded',
    run: async f => await insertExecution(f, await makeChain(f), { ruleVersion: '   ' }),
  },
  {
    constraint: 'step_executions_updated_not_before_created',
    run: async f =>
      await insertExecution(f, await makeChain(f), {
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
  },

  // -------------------------------------------------------- step_execution_shifts
  {
    constraint: 'step_execution_shifts_pkey',
    run: async f => {
      const chain = await makeChain(f);
      const executionId = await one(
        f,
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, 'call_task', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspace(f), chain.enrollmentId, chain.stepId, chain.firmId, chain.contactId],
      );
      const id = await one(
        f,
        `INSERT INTO step_execution_shifts
           (workspace_id, step_execution_id, enrollment_id, from_due_at, to_due_at,
            shift_milliseconds, reason)
         VALUES ($1, $2, $3, now(), now() + interval '1 day', 86400000, 'hold_union') RETURNING id`,
        [workspace(f), executionId, chain.enrollmentId],
      );
      return await insertShift(f, chain, executionId, { id });
    },
  },
  {
    constraint: 'step_execution_shifts_execution_fkey',
    run: async f => await insertShift(f, await makeChain(f), MISSING),
  },
  {
    constraint: 'step_execution_shifts_reason_known',
    run: async f => {
      const chain = await makeChain(f);
      const executionId = await one(
        f,
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, 'call_task', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspace(f), chain.enrollmentId, chain.stepId, chain.firmId, chain.contactId],
      );
      return await insertShift(f, chain, executionId, { reason: 'somebody_asked' });
    },
  },
  {
    // 4.3 and `shiftDueInstant`: a schedule shift never moves work earlier.
    constraint: 'step_execution_shifts_never_earlier',
    run: async f => {
      const chain = await makeChain(f);
      const executionId = await one(
        f,
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, 'call_task', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspace(f), chain.enrollmentId, chain.stepId, chain.firmId, chain.contactId],
      );
      return await insertShift(f, chain, executionId, {
        to: "now() - interval '1 hour'",
        shift: 0,
      });
    },
  },
  {
    constraint: 'step_execution_shifts_union_positive',
    run: async f => {
      const chain = await makeChain(f);
      const executionId = await one(
        f,
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, 'call_task', 1, now(), now(), now(), 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspace(f), chain.enrollmentId, chain.stepId, chain.firmId, chain.contactId],
      );
      return await insertShift(f, chain, executionId, { union: -1 });
    },
  },

  // ---------------------------------------------------- sequence_event_cursors
  {
    constraint: 'sequence_event_cursors_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO sequence_event_cursors (workspace_id, subscriber) VALUES ($1, 'sequences.terminal_stop')",
        [MISSING],
      ),
  },
  {
    constraint: 'sequence_event_cursors_pkey',
    run: async f => {
      await f.session.query(
        "INSERT INTO sequence_event_cursors (workspace_id, subscriber) VALUES ($1, 'sequences.terminal_stop')",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO sequence_event_cursors (workspace_id, subscriber) VALUES ($1, 'sequences.terminal_stop')",
        [workspace(f)],
      );
    },
  },
  {
    constraint: 'sequence_event_cursors_subscriber_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO sequence_event_cursors (workspace_id, subscriber) VALUES ($1, 'Sequences Terminal Stop')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'sequence_event_cursors_progress_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO sequence_event_cursors (workspace_id, subscriber, last_event_at)
         VALUES ($1, 'sequences.terminal_stop', now())`,
        [workspace(f)],
      ),
  },
];
