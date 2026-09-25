import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0006 adds (lane G4: state
 * postures, calling windows, suppression finalizations, dial tickets, call logs and
 * callbacks), plus the exclusion constraint and the supersession trigger.
 *
 * Same rules as `crmCases.ts`: their own file so two lanes never edit the middle of
 * one array, each case inside a transaction the caller rolls back, and each row
 * breaking exactly one thing — a row that breaks two is reported under whichever
 * index or check PostgreSQL reaches first, and the case would be testing the wrong
 * promise.
 *
 * No real business name, address or number appears here. Every number is in the NANP
 * 555-01XX fictional block.
 */

export interface PolicyCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

export interface PolicyCase {
  readonly constraint: string;
  readonly run: (fixture: PolicyCaseFixture) => Promise<unknown>;
}

const workspace = (f: PolicyCaseFixture): string => f.seeded.alpha.workspaceId;
const admin = (f: PolicyCaseFixture): string => f.seeded.alpha.admin.userId;
const salesperson = (f: PolicyCaseFixture): string => f.seeded.alpha.salesperson.userId;
const device = (f: PolicyCaseFixture): string => f.seeded.alpha.salesperson.deviceId;
const otherWorkspaceUser = (f: PolicyCaseFixture): string => f.seeded.beta.salesperson.userId;
const otherWorkspaceDevice = (f: PolicyCaseFixture): string => f.seeded.beta.salesperson.deviceId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';
const STATEMENTS = "ARRAY['businessToBusiness']::text[]";
const FROM = "TIMESTAMPTZ '2026-01-01 00:00:00+00'";
const REVIEW = "TIMESTAMPTZ '2027-01-01 00:00:00+00'";

let sequence = 0;

/**
 * A number in the NANP's reserved fictional block, 555-0100 to 555-0199.
 *
 * That block holds only a hundred numbers per area code, and this file needs more
 * than a hundred distinct ones, so the area code varies and the line number stays
 * inside the block. Every value is guaranteed unassignable; none of them reaches
 * anybody.
 */
const FICTIONAL_AREA_CODES = ['401', '212', '617', '312', '415', '206', '305', '702', '503', '802'];
function fictionalNumber(): string {
  sequence += 1;
  const area = FICTIONAL_AREA_CODES[Math.floor(sequence / 100) % FICTIONAL_AREA_CODES.length] ?? '401';
  return `+1${area}555${String(100 + (sequence % 100)).padStart(4, '0')}`;
}

/** A distinct two-letter state per posture, so a case never trips the exclusion by accident. */
const STATES = ['RI', 'MA', 'TX', 'NY', 'CA', 'CO', 'WA', 'IL', 'OH', 'GA', 'NC', 'SC', 'VA', 'MD', 'PA', 'NJ', 'CT', 'ME', 'VT', 'NH'];
const nextState = (): string => {
  sequence += 1;
  return STATES[sequence % STATES.length] ?? 'RI';
};

async function aPosture(f: PolicyCaseFixture, state = nextState()): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO state_postures
       (workspace_id, state, revision, effective_from, review_at, rules_revision, confirmed_statements, confirmed_by_user_id)
     VALUES ($1, $2, 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $3)
     RETURNING id`,
    [workspace(f), state, admin(f)],
  );
  return rows[0]?.id ?? '';
}

async function aFirm(f: PolicyCaseFixture): Promise<string> {
  sequence += 1;
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, time_zone, time_zone_confidence,
                        time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'RI', 'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [workspace(f), `Policy Case Firm ${String(sequence)}`, salesperson(f)],
  );
  return rows[0]?.id ?? '';
}

async function aContact(f: PolicyCaseFixture, firmId: string): Promise<string> {
  sequence += 1;
  const { rows } = await f.session.query<{ id: string }>(
    'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
    [workspace(f), firmId, `Policy Case Contact ${String(sequence)}`],
  );
  return rows[0]?.id ?? '';
}

async function anOpportunity(f: PolicyCaseFixture, firmId: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, (SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1), now())
     RETURNING id`,
    [workspace(f), firmId],
  );
  return rows[0]?.id ?? '';
}

async function aRoute(f: PolicyCaseFixture, firmId: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, association_confidence,
                               technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, 'salesperson', now(), 0.900, 'passed', 'usable', 'route-policy.1')
     RETURNING id`,
    [workspace(f), firmId, fictionalNumber()],
  );
  return rows[0]?.id ?? '';
}

async function anIdentity(f: PolicyCaseFixture): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                     verified_at, verified_by_user_id, verification_method)
     VALUES ($1, $2, $3, 'verified', true, now(), $2, 'owner_attestation') RETURNING id`,
    [workspace(f), salesperson(f), fictionalNumber()],
  );
  return rows[0]?.id ?? '';
}

interface TicketParts {
  readonly firmId: string;
  readonly contactId: string;
  readonly routeId: string;
  readonly postureId: string;
  readonly identityId: string;
}

async function ticketParts(f: PolicyCaseFixture): Promise<TicketParts> {
  const firmId = await aFirm(f);
  return {
    firmId,
    contactId: await aContact(f, firmId),
    routeId: await aRoute(f, firmId),
    postureId: await aPosture(f),
    identityId: await anIdentity(f),
  };
}

/** Insert a ticket, overriding one column at a time. Returns the new row's id. */
async function aTicket(
  f: PolicyCaseFixture,
  parts: TicketParts,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  sequence += 1;
  const columns: Record<string, unknown> = {
    command_id: `case-command-${String(sequence)}`,
    firm_id: parts.firmId,
    contact_id: parts.contactId,
    phone_route_id: parts.routeId,
    route_version: 1,
    posture_id: parts.postureId,
    posture_revision: 1,
    calling_identity_id: parts.identityId,
    actor_user_id: salesperson(f),
    device_id: device(f),
    assigned_user_id: salesperson(f),
    e164: '+14015550123',
    firm_time_zone: 'America/New_York',
    ...overrides,
  };
  const names = Object.keys(columns);
  const placeholders = names.map((_name, index) => `$${String(index + 2)}`);
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO dial_tickets (workspace_id, ${names.join(', ')}, issued_at, expires_at)
     VALUES ($1, ${placeholders.join(', ')}, now(), now() + INTERVAL '60 seconds')
     RETURNING id`,
    [workspace(f), ...names.map(name => columns[name])],
  );
  return rows[0]?.id ?? '';
}

async function aCallLog(
  f: PolicyCaseFixture,
  firmId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const columns: Record<string, unknown> = {
    firm_id: firmId,
    outcome: 'no_answer',
    step_effect: 'advance',
    occurred_at: new Date('2026-09-16T14:00:00.000Z'),
    actor_user_id: salesperson(f),
    ...overrides,
  };
  const names = Object.keys(columns);
  const placeholders = names.map((_name, index) => `$${String(index + 2)}`);
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO call_logs (workspace_id, ${names.join(', ')}) VALUES ($1, ${placeholders.join(', ')}) RETURNING id`,
    [workspace(f), ...names.map(name => columns[name])],
  );
  return rows[0]?.id ?? '';
}

async function aCallback(
  f: PolicyCaseFixture,
  firmId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const columns: Record<string, unknown> = {
    firm_id: firmId,
    assigned_user_id: salesperson(f),
    requested_local_date: '2026-09-18',
    source_time_zone: 'America/New_York',
    due_at: new Date('2026-09-18T18:00:00.000Z'),
    confirmed_at: new Date('2026-09-16T14:00:00.000Z'),
    confirmed_by_user_id: salesperson(f),
    ...overrides,
  };
  const names = Object.keys(columns);
  const placeholders = names.map((_name, index) => `$${String(index + 2)}`);
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO callbacks (workspace_id, ${names.join(', ')}) VALUES ($1, ${placeholders.join(', ')}) RETURNING id`,
    [workspace(f), ...names.map(name => columns[name])],
  );
  return rows[0]?.id ?? '';
}

async function aManualSuppression(f: PolicyCaseFixture, eventId: string): Promise<string> {
  await f.session.query(
    `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id)
     VALUES ($1, $2, 'handle', $3, 'e164-lower.1', 'salesperson_manual', $4)`,
    [workspace(f), eventId, fictionalNumber(), salesperson(f)],
  );
  return eventId;
}

async function aWindow(
  f: PolicyCaseFixture,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const columns: Record<string, unknown> = {
    version: 1,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
    created_by_user_id: admin(f),
    ...overrides,
  };
  const names = Object.keys(columns);
  const placeholders = names.map((_name, index) => `$${String(index + 2)}`);
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO calling_windows (workspace_id, ${names.join(', ')}) VALUES ($1, ${placeholders.join(', ')}) RETURNING id`,
    [workspace(f), ...names.map(name => columns[name])],
  );
  return rows[0]?.id ?? '';
}

export const POLICY_CONSTRAINT_CASES: readonly PolicyCase[] = [
  // --------------------------------------------------------- state_postures
  {
    constraint: 'state_postures_pkey',
    run: async f => {
      const id = await aPosture(f);
      return await f.session.query(
        `INSERT INTO state_postures (workspace_id, id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, $2, 'WY', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $3)`,
        [workspace(f), id, admin(f)],
      );
    },
  },
  {
    constraint: 'state_postures_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'RI', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2)`,
        [MISSING, admin(f)],
      ),
  },
  {
    constraint: 'state_postures_confirmer_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'AK', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2)`,
        [workspace(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'state_postures_revoker_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id,
                                     revoked_at, revoked_by_user_id)
         VALUES ($1, 'AL', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2, now(), $3)`,
        [workspace(f), admin(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'state_postures_one_per_revision',
    run: async f => {
      await aPosture(f, 'AZ');
      return await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id, revoked_at, revoked_by_user_id)
         VALUES ($1, 'AZ', 1, TIMESTAMPTZ '2030-01-01 00:00:00+00', TIMESTAMPTZ '2031-01-01 00:00:00+00',
                 2, ${STATEMENTS}, $2, now(), $2)`,
        [workspace(f), admin(f)],
      );
    },
  },
  {
    // Appendix G 25's second half: two applicable rows for one state.
    constraint: 'state_postures_no_overlap',
    run: async f => {
      await aPosture(f, 'AR');
      return await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'AR', 2, TIMESTAMPTZ '2026-06-01 00:00:00+00', ${REVIEW}, 2, ${STATEMENTS}, $2)`,
        [workspace(f), admin(f)],
      );
    },
  },
  {
    constraint: 'state_postures_state_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'Rhode Island', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_revision_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'DE', 0, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_rules_revision_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'FL', 1, ${FROM}, ${REVIEW}, 0, ${STATEMENTS}, $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_range_ordered',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, effective_to, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'GA', 1, ${FROM}, TIMESTAMPTZ '2025-01-01 00:00:00+00', ${REVIEW}, 2, ${STATEMENTS}, $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_review_after_effective',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'HI', 1, ${FROM}, TIMESTAMPTZ '2025-06-01 00:00:00+00', 2, ${STATEMENTS}, $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_statements_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id)
         VALUES ($1, 'IA', 1, ${FROM}, ${REVIEW}, 2, ARRAY[]::text[], $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_sources_is_array',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, sources, confirmed_by_user_id)
         VALUES ($1, 'ID', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, '{"title":"not an array"}'::jsonb, $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_note_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id, note)
         VALUES ($1, 'IL', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2, '   ')`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_revocation_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id, revoked_at)
         VALUES ($1, 'IN', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2, now())`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'state_postures_revoked_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO state_postures (workspace_id, state, revision, effective_from, review_at,
                                     rules_revision, confirmed_statements, confirmed_by_user_id,
                                     created_at, revoked_at, revoked_by_user_id)
         VALUES ($1, 'KS', 1, ${FROM}, ${REVIEW}, 2, ${STATEMENTS}, $2,
                 TIMESTAMPTZ '2026-05-01 00:00:00+00', TIMESTAMPTZ '2026-04-01 00:00:00+00', $2)`,
        [workspace(f), admin(f)],
      ),
  },

  // -------------------------------------------------------- calling_windows
  {
    constraint: 'calling_windows_pkey',
    run: async f => {
      const id = await aWindow(f);
      return await f.session.query(
        `INSERT INTO calling_windows (workspace_id, id, version, start_minute, end_minute, created_by_user_id,
                                      superseded_at, superseded_by_user_id)
         VALUES ($1, $2, 2, 540, 1020, $3, now(), $3)`,
        [workspace(f), id, admin(f)],
      );
    },
  },
  {
    constraint: 'calling_windows_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO calling_windows (workspace_id, start_minute, end_minute, created_by_user_id) VALUES ($1, 540, 1020, $2)',
        [MISSING, admin(f)],
      ),
  },
  {
    constraint: 'calling_windows_creator_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO calling_windows (workspace_id, start_minute, end_minute, created_by_user_id) VALUES ($1, 540, 1020, $2)',
        [workspace(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'calling_windows_superseder_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO calling_windows (workspace_id, start_minute, end_minute, created_by_user_id,
                                      superseded_at, superseded_by_user_id)
         VALUES ($1, 540, 1020, $2, now(), $3)`,
        [workspace(f), admin(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'calling_windows_one_per_version',
    run: async f => {
      await aWindow(f, { version: 3 });
      return await f.session.query(
        `INSERT INTO calling_windows (workspace_id, version, start_minute, end_minute, created_by_user_id,
                                      superseded_at, superseded_by_user_id)
         VALUES ($1, 3, 540, 1020, $2, now(), $2)`,
        [workspace(f), admin(f)],
      );
    },
  },
  {
    constraint: 'calling_windows_one_current',
    run: async f => {
      await aWindow(f, { version: 4 });
      return await aWindow(f, { version: 5 });
    },
  },
  {
    constraint: 'calling_windows_version_positive',
    run: async f => await aWindow(f, { version: 0 }),
  },
  {
    constraint: 'calling_windows_start_in_day',
    // Only this one: a negative start is still ordered before a 10:00 end.
    run: async f => await aWindow(f, { start_minute: -1, end_minute: 600 }),
  },
  {
    constraint: 'calling_windows_end_in_day',
    // Only this one: an end past midnight is still ordered after a 09:00 start.
    run: async f => await aWindow(f, { start_minute: 540, end_minute: 1441 }),
  },
  {
    constraint: 'calling_windows_ordered',
    run: async f => await aWindow(f, { start_minute: 1020, end_minute: 540 }),
  },
  {
    constraint: 'calling_windows_weekdays_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO calling_windows (workspace_id, start_minute, end_minute, weekdays, created_by_user_id)
         VALUES ($1, 540, 1020, ARRAY[0]::smallint[], $2)`,
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'calling_windows_supersession_consistent',
    run: async f => await aWindow(f, { superseded_at: new Date('2026-09-16T14:00:00.000Z') }),
  },
  {
    constraint: 'calling_windows_supersession_not_before_create',
    run: async f =>
      await f.session.query(
        `INSERT INTO calling_windows (workspace_id, start_minute, end_minute, created_by_user_id,
                                      created_at, superseded_at, superseded_by_user_id)
         VALUES ($1, 540, 1020, $2, TIMESTAMPTZ '2026-05-01 00:00:00+00', TIMESTAMPTZ '2026-04-01 00:00:00+00', $2)`,
        [workspace(f), admin(f)],
      ),
  },

  // ------------------------------------------------ suppression_finalizations
  {
    constraint: 'suppression_finalizations_pkey',
    run: async f => {
      const eventId = await aManualSuppression(f, 'finalization-pkey-event');
      await f.session.query(
        "INSERT INTO suppression_finalizations (workspace_id, event_id, outcome) VALUES ($1, $2, 'finalized')",
        [workspace(f), eventId],
      );
      return await f.session.query(
        "INSERT INTO suppression_finalizations (workspace_id, event_id, outcome) VALUES ($1, $2, 'finalized')",
        [workspace(f), eventId],
      );
    },
  },
  {
    constraint: 'suppression_finalizations_event_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_finalizations (workspace_id, event_id, outcome) VALUES ($1, 'no-such-event', 'finalized')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'suppression_finalizations_correction_fkey',
    run: async f => {
      const eventId = await aManualSuppression(f, 'finalization-correction-fkey-event');
      // Deferred, so the insert itself is accepted and the refusal arrives when the
      // constraint is next checked. `SET CONSTRAINTS ALL IMMEDIATE` is that moment,
      // brought forward so the case does not have to commit the caller's
      // transaction to see it.
      await f.session.query(
        `INSERT INTO suppression_finalizations (workspace_id, event_id, outcome, correction_event_id)
         VALUES ($1, $2, 'corrected', 'no-such-correction')`,
        [workspace(f), eventId],
      );
      return await f.session.query('SET CONSTRAINTS ALL IMMEDIATE');
    },
  },
  {
    constraint: 'suppression_finalizations_decider_fkey',
    run: async f => {
      const eventId = await aManualSuppression(f, 'finalization-decider-event');
      return await f.session.query(
        `INSERT INTO suppression_finalizations (workspace_id, event_id, outcome, decided_by_user_id)
         VALUES ($1, $2, 'finalized', $3)`,
        [workspace(f), eventId, otherWorkspaceUser(f)],
      );
    },
  },
  {
    constraint: 'suppression_finalizations_outcome_known',
    run: async f => {
      const eventId = await aManualSuppression(f, 'finalization-outcome-event');
      return await f.session.query(
        "INSERT INTO suppression_finalizations (workspace_id, event_id, outcome) VALUES ($1, $2, 'reversed')",
        [workspace(f), eventId],
      );
    },
  },
  {
    constraint: 'suppression_finalizations_correction_consistent',
    run: async f => {
      const eventId = await aManualSuppression(f, 'finalization-consistent-event');
      return await f.session.query(
        "INSERT INTO suppression_finalizations (workspace_id, event_id, outcome) VALUES ($1, $2, 'corrected')",
        [workspace(f), eventId],
      );
    },
  },

  // ----------------------------------------------------------- dial_tickets
  {
    constraint: 'dial_tickets_pkey',
    run: async f => {
      const parts = await ticketParts(f);
      const id = await aTicket(f, parts);
      return await aTicket(f, parts, { id });
    },
  },
  {
    constraint: 'dial_tickets_one_per_command',
    run: async f => {
      const parts = await ticketParts(f);
      await aTicket(f, parts, { command_id: 'duplicate-dial-command' });
      return await aTicket(f, parts, { command_id: 'duplicate-dial-command' });
    },
  },
  {
    constraint: 'dial_tickets_firm_fkey',
    run: async f => await aTicket(f, await ticketParts(f), { firm_id: MISSING, contact_id: null }),
  },
  {
    constraint: 'dial_tickets_contact_fkey',
    run: async f => {
      const parts = await ticketParts(f);
      const otherFirm = await aFirm(f);
      // A contact that exists, at another firm: the semantic key refuses it.
      return await aTicket(f, parts, { contact_id: await aContact(f, otherFirm) });
    },
  },
  {
    constraint: 'dial_tickets_route_fkey',
    run: async f => await aTicket(f, await ticketParts(f), { phone_route_id: MISSING }),
  },
  {
    constraint: 'dial_tickets_posture_fkey',
    run: async f => await aTicket(f, await ticketParts(f), { posture_id: MISSING }),
  },
  {
    constraint: 'dial_tickets_identity_fkey',
    run: async f => await aTicket(f, await ticketParts(f), { calling_identity_id: MISSING }),
  },
  {
    constraint: 'dial_tickets_actor_fkey',
    run: async f => await aTicket(f, await ticketParts(f), { actor_user_id: otherWorkspaceUser(f) }),
  },
  {
    constraint: 'dial_tickets_assignee_fkey',
    run: async f => await aTicket(f, await ticketParts(f), { assigned_user_id: otherWorkspaceUser(f) }),
  },
  {
    constraint: 'dial_tickets_device_fkey',
    run: async f => await aTicket(f, await ticketParts(f), { device_id: otherWorkspaceDevice(f) }),
  },
  {
    constraint: 'dial_tickets_command_id_shape',
    run: async f => await aTicket(f, await ticketParts(f), { command_id: 'has a space' }),
  },
  {
    constraint: 'dial_tickets_route_version_positive',
    run: async f => await aTicket(f, await ticketParts(f), { route_version: 0 }),
  },
  {
    constraint: 'dial_tickets_posture_revision_positive',
    run: async f => await aTicket(f, await ticketParts(f), { posture_revision: 0 }),
  },
  {
    constraint: 'dial_tickets_e164_shape',
    run: async f => await aTicket(f, await ticketParts(f), { e164: '401-555-0123' }),
  },
  {
    constraint: 'dial_tickets_zone_shape',
    run: async f => await aTicket(f, await ticketParts(f), { firm_time_zone: 'EST5EDT?' }),
  },
  {
    constraint: 'dial_tickets_expiry_after_issue',
    run: async f => {
      const parts = await ticketParts(f);
      sequence += 1;
      // Ninety seconds: longer than the minute 9.2 allows.
      return await f.session.query(
        `INSERT INTO dial_tickets (workspace_id, command_id, firm_id, phone_route_id, route_version, posture_id,
                                   posture_revision, calling_identity_id, actor_user_id, device_id, assigned_user_id,
                                   e164, firm_time_zone, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, 1, $5, 1, $6, $7, $8, $7, '+14015550123', 'America/New_York',
                 now(), now() + INTERVAL '90 seconds')`,
        [
          workspace(f),
          `long-ticket-${String(sequence)}`,
          parts.firmId,
          parts.routeId,
          parts.postureId,
          parts.identityId,
          salesperson(f),
          device(f),
        ],
      );
    },
  },
  {
    constraint: 'dial_tickets_consumed_within_life',
    run: async f => {
      const parts = await ticketParts(f);
      sequence += 1;
      return await f.session.query(
        `INSERT INTO dial_tickets (workspace_id, command_id, firm_id, phone_route_id, route_version, posture_id,
                                   posture_revision, calling_identity_id, actor_user_id, device_id, assigned_user_id,
                                   e164, firm_time_zone, issued_at, expires_at, consumed_at)
         VALUES ($1, $2, $3, $4, 1, $5, 1, $6, $7, $8, $7, '+14015550123', 'America/New_York',
                 now(), now() + INTERVAL '60 seconds', now() + INTERVAL '10 minutes')`,
        [
          workspace(f),
          `late-consumption-${String(sequence)}`,
          parts.firmId,
          parts.routeId,
          parts.postureId,
          parts.identityId,
          salesperson(f),
          device(f),
        ],
      );
    },
  },

  // -------------------------------------------------------------- call_logs
  {
    constraint: 'call_logs_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const id = await aCallLog(f, firmId);
      return await aCallLog(f, firmId, { id });
    },
  },
  {
    constraint: 'call_logs_one_per_command',
    run: async f => {
      const firmId = await aFirm(f);
      await aCallLog(f, firmId, { command_id: 'duplicate-call-command' });
      return await aCallLog(f, firmId, { command_id: 'duplicate-call-command' });
    },
  },
  {
    constraint: 'call_logs_firm_fkey',
    run: async f => await aCallLog(f, MISSING),
  },
  {
    constraint: 'call_logs_contact_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirm = await aFirm(f);
      return await aCallLog(f, firmId, { contact_id: await aContact(f, otherFirm) });
    },
  },
  {
    constraint: 'call_logs_opportunity_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirm = await aFirm(f);
      return await aCallLog(f, firmId, { opportunity_id: await anOpportunity(f, otherFirm) });
    },
  },
  {
    constraint: 'call_logs_route_fkey',
    run: async f => await aCallLog(f, await aFirm(f), { phone_route_id: MISSING }),
  },
  {
    constraint: 'call_logs_identity_fkey',
    run: async f => await aCallLog(f, await aFirm(f), { calling_identity_id: MISSING }),
  },
  {
    constraint: 'call_logs_ticket_fkey',
    run: async f => await aCallLog(f, await aFirm(f), { ticket_id: MISSING }),
  },
  {
    constraint: 'call_logs_actor_fkey',
    run: async f => await aCallLog(f, await aFirm(f), { actor_user_id: otherWorkspaceUser(f) }),
  },
  {
    constraint: 'call_logs_outcome_known',
    run: async f => await aCallLog(f, await aFirm(f), { outcome: 'they_hung_up' }),
  },
  {
    constraint: 'call_logs_step_effect_known',
    run: async f => await aCallLog(f, await aFirm(f), { step_effect: 'skip' }),
  },
  {
    constraint: 'call_logs_command_id_shape',
    run: async f => await aCallLog(f, await aFirm(f), { command_id: 'has a space' }),
  },
  {
    constraint: 'call_logs_note_bounded',
    run: async f => await aCallLog(f, await aFirm(f), { note: '   ' }),
  },
  {
    constraint: 'call_logs_recorded_not_before_occurred',
    run: async f =>
      await aCallLog(f, await aFirm(f), {
        occurred_at: new Date('2026-09-16T14:00:00.000Z'),
        recorded_at: new Date('2026-09-16T13:00:00.000Z'),
      }),
  },

  // -------------------------------------------------------------- callbacks
  {
    constraint: 'callbacks_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const id = await aCallback(f, firmId);
      return await aCallback(f, firmId, { id });
    },
  },
  {
    constraint: 'callbacks_firm_fkey',
    run: async f => await aCallback(f, MISSING),
  },
  {
    constraint: 'callbacks_contact_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirm = await aFirm(f);
      return await aCallback(f, firmId, { contact_id: await aContact(f, otherFirm) });
    },
  },
  {
    constraint: 'callbacks_opportunity_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirm = await aFirm(f);
      return await aCallback(f, firmId, { opportunity_id: await anOpportunity(f, otherFirm) });
    },
  },
  {
    constraint: 'callbacks_call_log_fkey',
    run: async f => await aCallback(f, await aFirm(f), { call_log_id: MISSING }),
  },
  {
    constraint: 'callbacks_assignee_fkey',
    run: async f => await aCallback(f, await aFirm(f), { assigned_user_id: otherWorkspaceUser(f) }),
  },
  {
    constraint: 'callbacks_confirmer_fkey',
    run: async f => await aCallback(f, await aFirm(f), { confirmed_by_user_id: otherWorkspaceUser(f) }),
  },
  {
    constraint: 'callbacks_completer_fkey',
    run: async f =>
      // `created_at` defaults to now(), so the completion has to be after it or the
      // row would break `callbacks_completed_not_before_created` first.
      await aCallback(f, await aFirm(f), {
        status: 'completed',
        completed_at: new Date(Date.now() + 60_000),
        completed_by_user_id: otherWorkspaceUser(f),
      }),
  },
  {
    constraint: 'callbacks_status_known',
    run: async f => await aCallback(f, await aFirm(f), { status: 'snoozed' }),
  },
  {
    constraint: 'callbacks_zone_shape',
    run: async f => await aCallback(f, await aFirm(f), { source_time_zone: 'EST5EDT?' }),
  },
  {
    constraint: 'callbacks_completion_consistent',
    run: async f => await aCallback(f, await aFirm(f), { status: 'completed' }),
  },
  {
    constraint: 'callbacks_cancellation_consistent',
    run: async f => await aCallback(f, await aFirm(f), { status: 'cancelled' }),
  },
  {
    constraint: 'callbacks_cancelled_reason_bounded',
    run: async f => await aCallback(f, await aFirm(f), { status: 'cancelled', cancelled_reason: '   ' }),
  },
  {
    constraint: 'callbacks_completed_not_before_created',
    run: async f =>
      await aCallback(f, await aFirm(f), {
        status: 'completed',
        created_at: new Date('2026-09-18T14:00:00.000Z'),
        completed_at: new Date('2026-09-17T14:00:00.000Z'),
        completed_by_user_id: salesperson(f),
      }),
  },
];
