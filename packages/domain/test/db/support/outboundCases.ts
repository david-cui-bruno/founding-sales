import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
import type { SeededOutbound } from './outboundFixtures.ts';
import { FIXTURE_BODY, FIXTURE_SUBJECT } from './outboundFixtures.ts';
import { makeStepExecution } from '../../../db/testing/stepExecutions.ts';

/**
 * A failing insert for every constraint migration 0010 adds (lane G7-2: the outbound
 * fence, its append-only event ledger, the sending domain, the reputation ramp and
 * the per-day counters).
 *
 * Same rules as `mailCases.ts`: its own file so two lanes never edit the middle of
 * one array, each case inside a transaction the caller rolls back, and each row
 * breaking exactly one thing. A row that breaks two is reported under whichever
 * index or check PostgreSQL reaches first, and the case would be testing the wrong
 * promise — which matters more here than anywhere else in the schema, because these
 * constraints are what stand between a prospect and a second copy of the same email.
 *
 * The state-machine trigger is not exercised here. A trigger is not a constraint the
 * coverage test enumerates, and its transitions deserve more than one failing insert
 * each; they are in `packages/domain/test/outbound/fence.test.ts`.
 *
 * No real person, address, business name or credential appears here.
 */

export interface OutboundCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
  readonly mail: SeededMail;
  readonly outbound: SeededOutbound;
}

export interface OutboundCase {
  readonly constraint: string;
  readonly run: (fixture: OutboundCaseFixture) => Promise<unknown>;
}

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';
const HASH = 'b'.repeat(64);
const AT = "TIMESTAMPTZ '2026-09-02 13:00:00+00'";
const EARLIER = "TIMESTAMPTZ '2026-09-01 09:00:00+00'";
const LATER = "TIMESTAMPTZ '2026-09-03 09:00:00+00'";
const BUSINESS_DATE = "DATE '2026-09-02'";

const workspace = (f: OutboundCaseFixture): string => f.seeded.alpha.workspaceId;
const admin = (f: OutboundCaseFixture): string => f.seeded.alpha.admin.userId;
const otherWorkspaceUser = (f: OutboundCaseFixture): string => f.seeded.beta.salesperson.userId;
const otherWorkspaceAdmin = (f: OutboundCaseFixture): string => f.seeded.beta.admin.userId;
const mailbox = (f: OutboundCaseFixture): string => f.mail.alpha.mailboxId;
const otherMailbox = (f: OutboundCaseFixture): string => f.mail.beta.mailboxId;
const firm = (f: OutboundCaseFixture): string => f.crm.alpha.firmId;
const contact = (f: OutboundCaseFixture): string => f.crm.alpha.contactId;
const opportunity = (f: OutboundCaseFixture): string => f.crm.alpha.opportunityId;
const alpha = (f: OutboundCaseFixture) => f.outbound.alpha;

/** A uuid as a SQL literal. Every value passed here is a fixture-generated uuid. */
const u = (id: string): string => `'${id}'::uuid`;
/** A text literal, with the one escaping SQL asks for. */
const t = (value: string): string => `'${value.replace(/'/g, "''")}'`;

let sequence = 0;
/** A value unique within one case run, so a case never trips uniqueness by accident. */
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

type Fragments = Readonly<Record<string, string>>;

/**
 * A second mailbox in the alpha workspace, owned by the admin.
 *
 * `mailboxes_one_per_owner` means the salesperson cannot have two, so the cases that
 * need a *different* mailbox — a primary-key collision that must not also collide on
 * the mailbox — make one for the admin rather than reusing beta's, which would break
 * the workspace foreign key first and test the wrong thing.
 */
async function adminMailbox(f: OutboundCaseFixture): Promise<string> {
  const created = await f.session.query<{ id: string }>(
    `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address)
     VALUES ($1, $2, $3) RETURNING id`,
    [workspace(f), admin(f), `${unique('admin.mailbox.')}@example.test`],
  );
  return created.rows[0]?.id ?? '';
}

/**
 * The columns a lawful fence carries, as SQL expressions, before a case breaks one.
 *
 * `step_execution_id` is a row that exists, not a fresh uuid: migration 0012 adds
 * `outbound_messages_step_execution_fkey`, so an invented id would break that key
 * first and every case would be testing it instead of its own constraint. A new
 * execution per fence, because `outbound_messages_one_per_step_execution` allows one
 * fence each.
 */
function fenceDefaults(f: OutboundCaseFixture, stepExecutionId: string): Record<string, string> {
  return {
    workspace_id: u(workspace(f)),
    mailbox_id: u(mailbox(f)),
    origin_kind: t('step_execution'),
    step_execution_id: u(stepExecutionId),
    firm_id: u(firm(f)),
    contact_id: u(contact(f)),
    opportunity_id: u(opportunity(f)),
    recipient_address: t(`${unique('prospect.')}@example.test`),
    recipient_route_id: u(alpha(f).routeId),
    recipient_route_version: '1',
    subject: t(FIXTURE_SUBJECT),
    body: t(FIXTURE_BODY),
    template_version_id: u(alpha(f).templateVersionId),
    rendered_hash: t(HASH),
    provider_message_id_header: t(`<fss.${unique('case-')}@sending.example.test>`),
    send_at: AT,
    source_zone: t('America/New_York'),
    placement_rule_version: t('email-window.1'),
    business_date: BUSINESS_DATE,
  };
}

async function insertFence(f: OutboundCaseFixture, overrides: Fragments = {}): Promise<unknown> {
  const stepExecutionId = await makeStepExecution(f.session, {
    workspaceId: workspace(f),
    firmId: firm(f),
    opportunityId: opportunity(f),
    userId: f.seeded.alpha.salesperson.userId,
    templateVersionId: alpha(f).templateVersionId,
  });
  const row = { ...fenceDefaults(f, stepExecutionId), ...overrides };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO outbound_messages (${columns.join(', ')}) VALUES (${columns.map(name => row[name]).join(', ')})`,
  );
}

/** The columns a lawful ledger row carries. */
function eventDefaults(f: OutboundCaseFixture): Record<string, string> {
  return {
    workspace_id: u(workspace(f)),
    outbound_message_id: u(alpha(f).preparedFenceId),
    sequence_number: '1',
    from_state: 'NULL',
    to_state: t('prepared'),
    attempt_token: 'NULL',
    actor: t('constraint-case'),
  };
}

async function insertEvent(f: OutboundCaseFixture, overrides: Fragments = {}): Promise<unknown> {
  const row = { ...eventDefaults(f), ...overrides };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO outbound_message_events (${columns.join(', ')}) VALUES (${columns
      .map(name => row[name])
      .join(', ')})`,
  );
}

function domainDefaults(f: OutboundCaseFixture): Record<string, string> {
  return {
    workspace_id: u(workspace(f)),
    domain: t(`${unique('spare')}.example.test`),
    // The seeded row is already the workspace's one primary, so a spare never is.
    is_primary: 'false',
  };
}

async function insertDomain(f: OutboundCaseFixture, overrides: Fragments = {}): Promise<unknown> {
  const row = { ...domainDefaults(f), ...overrides };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO sending_domains (${columns.join(', ')}) VALUES (${columns.map(name => row[name]).join(', ')})`,
  );
}

async function insertRamp(f: OutboundCaseFixture, overrides: Fragments): Promise<unknown> {
  const row: Record<string, string> = { workspace_id: u(workspace(f)), ...overrides };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO mailbox_send_ramp (${columns.join(', ')}) VALUES (${columns.map(name => row[name]).join(', ')})`,
  );
}

async function insertDay(f: OutboundCaseFixture, overrides: Fragments): Promise<unknown> {
  const row: Record<string, string> = {
    workspace_id: u(workspace(f)),
    business_date: "DATE '2026-09-20'",
    cap_granted: '5',
    ...overrides,
  };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO mailbox_send_days (${columns.join(', ')}) VALUES (${columns.map(name => row[name]).join(', ')})`,
  );
}

export const OUTBOUND_CONSTRAINT_CASES: readonly OutboundCase[] = [
  // ------------------------------------------------------------ sending_domains
  {
    constraint: 'sending_domains_pkey',
    run: async f => await insertDomain(f, { id: u(alpha(f).sendingDomainId) }),
  },
  {
    constraint: 'sending_domains_workspace_id_fkey',
    run: async f => await insertDomain(f, { workspace_id: u(MISSING) }),
  },
  {
    constraint: 'sending_domains_checker_fkey',
    run: async f =>
      await insertDomain(f, {
        authentication_checked_at: AT,
        authentication_checked_by_user_id: u(otherWorkspaceAdmin(f)),
      }),
  },
  {
    constraint: 'sending_domains_one_per_domain',
    run: async f => await insertDomain(f, { domain: t(f.outbound.collidingDomain) }),
  },
  {
    // The seeded row is this workspace's primary; a second one would make "the
    // primary-domain guard" a question rather than a fact.
    constraint: 'sending_domains_one_primary',
    run: async f => await insertDomain(f, { is_primary: 'true' }),
  },
  {
    constraint: 'sending_domains_domain_shape',
    run: async f => await insertDomain(f, { domain: t('Not A Domain') }),
  },
  {
    constraint: 'sending_domains_check_consistent',
    run: async f => await insertDomain(f, { authentication_checked_at: AT }),
  },
  {
    // A pass with nobody's confirmation behind it.
    constraint: 'sending_domains_passes_are_checked',
    run: async f => await insertDomain(f, { spf_pass: 'true' }),
  },
  {
    // 12.7: "SPF, DKIM, and DMARC must pass before automated sending is enabled."
    constraint: 'sending_domains_enable_requires_authentication',
    run: async f =>
      await insertDomain(f, { automated_sending_enabled: 'true', automated_sending_enabled_at: AT }),
  },
  {
    constraint: 'sending_domains_enable_consistent',
    run: async f => await insertDomain(f, { automated_sending_enabled_at: AT }),
  },
  {
    constraint: 'sending_domains_updated_not_before_created',
    run: async f => await insertDomain(f, { created_at: AT, updated_at: EARLIER }),
  },

  // ---------------------------------------------------------- mailbox_send_ramp
  {
    constraint: 'mailbox_send_ramp_pkey',
    run: async f =>
      await insertRamp(f, { id: u(alpha(f).rampId), mailbox_id: u(await adminMailbox(f)) }),
  },
  {
    constraint: 'mailbox_send_ramp_mailbox_fkey',
    run: async f => await insertRamp(f, { mailbox_id: u(otherMailbox(f)) }),
  },
  {
    constraint: 'mailbox_send_ramp_one_per_mailbox',
    run: async f => await insertRamp(f, { mailbox_id: u(mailbox(f)) }),
  },
  {
    constraint: 'mailbox_send_ramp_admin_fkey',
    run: async f =>
      await insertRamp(f, {
        mailbox_id: u(await adminMailbox(f)),
        admin_daily_cap: '3',
        admin_changed_at: AT,
        admin_changed_by_user_id: u(otherWorkspaceUser(f)),
      }),
  },
  {
    constraint: 'mailbox_send_ramp_days_not_negative',
    run: async f =>
      await insertRamp(f, { mailbox_id: u(await adminMailbox(f)), healthy_sending_days: '-1' }),
  },
  {
    // 12.7's hard ceiling of 100, on the column an admin lowers with.
    constraint: 'mailbox_send_ramp_admin_cap_bounded',
    run: async f =>
      await insertRamp(f, {
        mailbox_id: u(await adminMailbox(f)),
        admin_daily_cap: '101',
        admin_changed_at: AT,
        admin_changed_by_user_id: u(admin(f)),
      }),
  },
  {
    // And on the column an admin raises with. 12.7: "a hard automated ceiling of 100".
    constraint: 'mailbox_send_ramp_raised_cap_bounded',
    run: async f =>
      await insertRamp(f, {
        mailbox_id: u(await adminMailbox(f)),
        raised_daily_cap: '101',
        admin_changed_at: AT,
        admin_changed_by_user_id: u(admin(f)),
      }),
  },
  {
    constraint: 'mailbox_send_ramp_admin_change_consistent',
    run: async f =>
      await insertRamp(f, { mailbox_id: u(await adminMailbox(f)), admin_changed_at: AT }),
  },
  {
    // An admin cap with no record of an admin having set it.
    constraint: 'mailbox_send_ramp_admin_change_recorded',
    run: async f =>
      await insertRamp(f, { mailbox_id: u(await adminMailbox(f)), admin_daily_cap: '3' }),
  },
  {
    constraint: 'mailbox_send_ramp_health_failure_bounded',
    run: async f =>
      await insertRamp(f, { mailbox_id: u(await adminMailbox(f)), last_health_failure: t('   ') }),
  },
  {
    constraint: 'mailbox_send_ramp_updated_not_before_created',
    run: async f =>
      await insertRamp(f, {
        mailbox_id: u(await adminMailbox(f)),
        created_at: AT,
        updated_at: EARLIER,
      }),
  },

  // ---------------------------------------------------------- mailbox_send_days
  {
    constraint: 'mailbox_send_days_pkey',
    run: async f =>
      await insertDay(f, { id: u(alpha(f).sendDayId), mailbox_id: u(await adminMailbox(f)) }),
  },
  {
    constraint: 'mailbox_send_days_mailbox_fkey',
    run: async f => await insertDay(f, { mailbox_id: u(otherMailbox(f)) }),
  },
  {
    constraint: 'mailbox_send_days_one_per_date',
    run: async f => await insertDay(f, { mailbox_id: u(mailbox(f)), business_date: BUSINESS_DATE }),
  },
  {
    constraint: 'mailbox_send_days_counts_not_negative',
    run: async f => await insertDay(f, { mailbox_id: u(mailbox(f)), bounces: '-1' }),
  },
  {
    constraint: 'mailbox_send_days_cap_bounded',
    run: async f => await insertDay(f, { mailbox_id: u(mailbox(f)), cap_granted: '101' }),
  },
  {
    // The backstop: a day that sent more than every cap it was ever granted.
    constraint: 'mailbox_send_days_within_cap',
    run: async f =>
      await insertDay(f, { mailbox_id: u(mailbox(f)), automated_sent: '6', cap_granted: '5' }),
  },
  {
    constraint: 'mailbox_send_days_verdict_consistent',
    run: async f => await insertDay(f, { mailbox_id: u(mailbox(f)), healthy: 'true' }),
  },
  {
    constraint: 'mailbox_send_days_updated_not_before_created',
    run: async f =>
      await insertDay(f, { mailbox_id: u(mailbox(f)), created_at: AT, updated_at: EARLIER }),
  },

  // ----------------------------------------------- outbound_messages: identity
  {
    constraint: 'outbound_messages_pkey',
    run: async f => await insertFence(f, { id: u(alpha(f).sentFenceId) }),
  },
  {
    constraint: 'outbound_messages_workspace_id_fkey',
    run: async f => await insertFence(f, { workspace_id: u(MISSING) }),
  },
  {
    constraint: 'outbound_messages_mailbox_fkey',
    run: async f => await insertFence(f, { mailbox_id: u(otherMailbox(f)) }),
  },
  {
    constraint: 'outbound_messages_firm_fkey',
    run: async f => await insertFence(f, { firm_id: u(f.crm.beta.firmId), contact_id: 'NULL' }),
  },
  {
    constraint: 'outbound_messages_contact_fkey',
    run: async f => await insertFence(f, { contact_id: u(f.crm.beta.contactId) }),
  },
  {
    constraint: 'outbound_messages_opportunity_fkey',
    run: async f => await insertFence(f, { opportunity_id: u(f.crm.beta.opportunityId) }),
  },
  {
    constraint: 'outbound_messages_route_fkey',
    run: async f => await insertFence(f, { recipient_route_id: u(MISSING) }),
  },
  {
    constraint: 'outbound_messages_template_fkey',
    run: async f => await insertFence(f, { template_version_id: u(MISSING) }),
  },
  {
    constraint: 'outbound_messages_resolver_fkey',
    run: async f =>
      await insertFence(f, {
        state: t('unknown_terminal'),
        attempt_token: 'gen_random_uuid()',
        dispatch_started_at: AT,
        unknown_terminal_at: LATER,
        admin_resolution: t('delivered'),
        admin_resolved_at: LATER,
        admin_resolved_by_user_id: u(otherWorkspaceUser(f)),
      }),
  },

  // ------------------------------------------------- outbound_messages: origin
  {
    // 12.5: "A check requires exactly one origin."
    constraint: 'outbound_messages_exactly_one_origin',
    run: async f => await insertFence(f, { draft_id: 'gen_random_uuid()' }),
  },
  {
    constraint: 'outbound_messages_origin_kind_known',
    run: async f =>
      await insertFence(f, {
        origin_kind: t('reply'),
        step_execution_id: 'NULL',
        draft_id: 'gen_random_uuid()',
      }),
  },
  {
    constraint: 'outbound_messages_origin_kind_matches',
    run: async f => await insertFence(f, { origin_kind: t('draft') }),
  },
  {
    constraint: 'outbound_messages_enrollment_needs_step',
    run: async f =>
      await insertFence(f, {
        origin_kind: t('draft'),
        step_execution_id: 'NULL',
        draft_id: 'gen_random_uuid()',
        enrollment_id: 'gen_random_uuid()',
      }),
  },
  {
    // 12.5: "partial unique indexes enforce one fence per origin."
    constraint: 'outbound_messages_one_per_step_execution',
    run: async f => await insertFence(f, { step_execution_id: u(f.outbound.collidingStepExecutionId) }),
  },
  // The two keys 0010 asked for and migration 0012 adds, once the tables they point
  // at exist. Both are here rather than in `sequenceCases.ts` because the table they
  // constrain is this one, and a reader looking for what `outbound_messages` refuses
  // should find all of it in one place.
  {
    constraint: 'outbound_messages_step_execution_fkey',
    run: async f => await insertFence(f, { step_execution_id: u(MISSING) }),
  },
  {
    constraint: 'outbound_messages_enrollment_fkey',
    run: async f => await insertFence(f, { enrollment_id: u(MISSING) }),
  },
  {
    constraint: 'outbound_messages_one_per_draft',
    run: async f => {
      const draftId = '55555555-6666-4777-8888-999999999999';
      const asDraft = {
        origin_kind: t('draft'),
        step_execution_id: 'NULL',
        draft_id: u(draftId),
      };
      await insertFence(f, asDraft);
      return await insertFence(f, asDraft);
    },
  },
  {
    // 12.5: "deterministic Message-ID is unique per mailbox."
    constraint: 'outbound_messages_one_header_per_mailbox',
    run: async f => await insertFence(f, { provider_message_id_header: t(f.outbound.collidingHeader) }),
  },

  // ----------------------------------------------- outbound_messages: envelope
  {
    constraint: 'outbound_messages_recipient_shape',
    run: async f => await insertFence(f, { recipient_address: t('UPPER@example.test') }),
  },
  {
    constraint: 'outbound_messages_route_consistent',
    run: async f => await insertFence(f, { recipient_route_version: 'NULL' }),
  },
  {
    constraint: 'outbound_messages_route_version_positive',
    run: async f => await insertFence(f, { recipient_route_version: '0' }),
  },
  {
    constraint: 'outbound_messages_subject_bounded',
    run: async f => await insertFence(f, { subject: t('   ') }),
  },
  {
    constraint: 'outbound_messages_body_bounded',
    run: async f => await insertFence(f, { body: t('   ') }),
  },
  {
    // 12.6 and David's decision, restated on the bytes that actually leave.
    constraint: 'outbound_messages_no_unsubscribe_link',
    run: async f =>
      await insertFence(f, { body: t(`${FIXTURE_BODY}\n\nOr Unsubscribe here.`) }),
  },
  {
    constraint: 'outbound_messages_rendered_hash_shape',
    run: async f => await insertFence(f, { rendered_hash: t('not-a-hash') }),
  },
  {
    constraint: 'outbound_messages_header_shape',
    run: async f => await insertFence(f, { provider_message_id_header: t('no-angle-brackets') }),
  },
  {
    constraint: 'outbound_messages_zone_shape',
    // A space is never in an IANA name. `UTC` is, which is why the pattern permits
    // a zone with no region at all.
    run: async f => await insertFence(f, { source_zone: t('America/New York') }),
  },
  {
    constraint: 'outbound_messages_placement_rule_shape',
    run: async f => await insertFence(f, { placement_rule_version: t('Email Window 1') }),
  },
  {
    constraint: 'outbound_messages_updated_not_before_created',
    run: async f => await insertFence(f, { created_at: AT, updated_at: EARLIER }),
  },

  // ------------------------------------------ outbound_messages: state machine
  {
    constraint: 'outbound_messages_state_known',
    run: async f => await insertFence(f, { state: t('queued') }),
  },
  {
    // A dispatch instant with no token to go with it.
    constraint: 'outbound_messages_dispatch_consistent',
    run: async f => await insertFence(f, { dispatch_started_at: AT }),
  },
  {
    // Appendix B: only the atomic transition authorizes a call, and it writes a
    // token. A `dispatching` fence without one never had that authorization.
    constraint: 'outbound_messages_dispatch_states',
    run: async f => await insertFence(f, { state: t('dispatching') }),
  },
  {
    constraint: 'outbound_messages_sent_consistent',
    run: async f =>
      await insertFence(f, {
        state: t('sent'),
        attempt_token: 'gen_random_uuid()',
        dispatch_started_at: AT,
        provider_message_id: t('18f3d1b2c3d4e5ff'),
      }),
  },
  {
    // A send with no provider identifier is a send nothing can reconcile against.
    constraint: 'outbound_messages_sent_has_provider_id',
    run: async f =>
      await insertFence(f, {
        state: t('sent'),
        attempt_token: 'gen_random_uuid()',
        dispatch_started_at: AT,
        sent_at: LATER,
      }),
  },
  {
    constraint: 'outbound_messages_provider_id_bounded',
    run: async f => await insertFence(f, { provider_message_id: t('   ') }),
  },
  {
    constraint: 'outbound_messages_provider_thread_bounded',
    run: async f => await insertFence(f, { provider_thread_id: t('   ') }),
  },
  {
    constraint: 'outbound_messages_held_consistent',
    run: async f => await insertFence(f, { state: t('held') }),
  },
  {
    constraint: 'outbound_messages_held_has_reason',
    run: async f => await insertFence(f, { state: t('held'), held_at: AT }),
  },
  {
    constraint: 'outbound_messages_held_reason_bounded',
    run: async f => await insertFence(f, { state: t('held'), held_at: AT, held_reason: t('   ') }),
  },
  {
    constraint: 'outbound_messages_reconcile_consistent',
    run: async f => await insertFence(f, { reconcile_started_at: AT }),
  },
  {
    constraint: 'outbound_messages_reconcile_window_ordered',
    run: async f =>
      await insertFence(f, { reconcile_started_at: LATER, reconcile_deadline_at: EARLIER }),
  },
  {
    constraint: 'outbound_messages_reconcile_attempts_not_negative',
    run: async f => await insertFence(f, { reconcile_attempts: '-1' }),
  },
  {
    constraint: 'outbound_messages_unknown_consistent',
    run: async f =>
      await insertFence(f, {
        state: t('unknown_terminal'),
        attempt_token: 'gen_random_uuid()',
        dispatch_started_at: AT,
      }),
  },

  // --------------------------------------- outbound_messages: admin resolution
  {
    constraint: 'outbound_messages_resolution_known',
    run: async f =>
      await insertFence(f, {
        state: t('unknown_terminal'),
        attempt_token: 'gen_random_uuid()',
        dispatch_started_at: AT,
        unknown_terminal_at: LATER,
        admin_resolution: t('maybe'),
        admin_resolved_at: LATER,
        admin_resolved_by_user_id: u(admin(f)),
      }),
  },
  {
    // 12.5: only an `unknown_terminal` fence has a resolution to make.
    constraint: 'outbound_messages_resolution_only_when_unknown',
    run: async f =>
      await insertFence(f, {
        admin_resolution: t('delivered'),
        admin_resolved_at: LATER,
        admin_resolved_by_user_id: u(admin(f)),
      }),
  },
  {
    constraint: 'outbound_messages_resolution_consistent',
    run: async f =>
      await insertFence(f, {
        state: t('unknown_terminal'),
        attempt_token: 'gen_random_uuid()',
        dispatch_started_at: AT,
        unknown_terminal_at: LATER,
        admin_resolution: t('delivered'),
      }),
  },

  // ------------------------------------------------- outbound_message_events
  {
    constraint: 'outbound_message_events_pkey',
    run: async f =>
      await insertEvent(f, {
        id: `(SELECT id FROM outbound_message_events WHERE workspace_id = ${u(workspace(f))} ORDER BY id LIMIT 1)`,
        sequence_number: '99',
      }),
  },
  {
    constraint: 'outbound_message_events_fence_fkey',
    run: async f => await insertEvent(f, { outbound_message_id: u(f.outbound.beta.sentFenceId) }),
  },
  {
    constraint: 'outbound_message_events_ordered',
    run: async f =>
      await insertEvent(f, { outbound_message_id: u(alpha(f).sentFenceId), sequence_number: '1' }),
  },
  {
    constraint: 'outbound_message_events_sequence_positive',
    run: async f => await insertEvent(f, { sequence_number: '0' }),
  },
  {
    constraint: 'outbound_message_events_from_state_known',
    run: async f => await insertEvent(f, { from_state: t('queued') }),
  },
  {
    constraint: 'outbound_message_events_to_state_known',
    run: async f => await insertEvent(f, { to_state: t('queued') }),
  },
  {
    constraint: 'outbound_message_events_actor_bounded',
    run: async f => await insertEvent(f, { actor: t('   ') }),
  },
  {
    constraint: 'outbound_message_events_detail_is_object',
    run: async f => await insertEvent(f, { detail: `'[]'::jsonb` }),
  },
  {
    constraint: 'outbound_message_events_detail_bounded',
    run: async f =>
      await insertEvent(f, {
        detail: `jsonb_build_object('note', repeat('x', 5000))`,
      }),
  },
];
