import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0028 adds (the call-to-booking walking
 * skeleton, slice W).
 *
 * Each table has one valid row builder and every case overrides one column of it, so a
 * case breaks exactly one constraint. The two constraints 0028 swaps under their old
 * names (`provider_reservations_subject_known`, `workspace_settings_key_known`) keep the
 * cases they already had.
 */

interface Fixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
  readonly mail: SeededMail;
}

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

type Row = Readonly<Record<string, unknown>>;

const workspace = (f: Fixture): string => f.seeded.alpha.workspaceId;
const salesperson = (f: Fixture): string => f.seeded.alpha.salesperson.userId;
/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000002f8';

let sequence = 0;
const next = (): number => {
  sequence += 1;
  return sequence;
};

/** A Twilio-shaped SID with a distinct tail per call. */
const sid = (prefix: 'CA' | 'RE'): string => `${prefix}${next().toString(16).padStart(32, '0')}`;

async function insert(f: Fixture, table: string, row: Row): Promise<string> {
  const names = Object.keys(row);
  const placeholders = names.map((_name, index) => `$${String(index + 1)}`);
  const { rows } = await f.session.query<{ id?: string }>(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    names.map(name => row[name]),
  );
  return String(rows[0]?.id ?? '');
}

async function one(f: Fixture, sql: string, values: readonly unknown[]): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(sql, values);
  return rows[0]?.id ?? '';
}

const stage = async (f: Fixture, key: string): Promise<string> =>
  await one(f, 'SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = $2', [workspace(f), key]);

/** A firm of its own, with an open opportunity, so a case never collides with another's. */
async function firmWithOpportunity(f: Fixture): Promise<{ firmId: string; opportunityId: string; contactId: string }> {
  const n = next();
  const firmId = await one(
    f,
    `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, time_zone, time_zone_confidence,
                        time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'RI', 'America/New_York', 'medium', 'state_default', 'firm-zone.1') RETURNING id`,
    [workspace(f), `Call To Booking Case Firm ${String(n)}`, salesperson(f)],
  );
  const contactId = await one(f, 'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id', [
    workspace(f),
    firmId,
    `Case Contact ${String(n)}`,
  ]);
  const opportunityId = await one(
    f,
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [workspace(f), firmId, await stage(f, 'new')],
  );
  return { firmId, opportunityId, contactId };
}

async function stageEvent(f: Fixture, opportunityId: string, firmId: string): Promise<string> {
  return await one(
    f,
    `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, 'user', $6) RETURNING id`,
    [workspace(f), opportunityId, firmId, await stage(f, 'new'), await stage(f, 'demo_booked'), salesperson(f)],
  );
}

// ------------------------------------------------------------ opportunity_stage_pins
async function pin(f: Fixture, overrides: Row = {}): Promise<string> {
  const { firmId, opportunityId } = await firmWithOpportunity(f);
  const eventId = await stageEvent(f, opportunityId, firmId);
  return await insert(f, 'opportunity_stage_pins', {
    workspace_id: workspace(f),
    opportunity_id: opportunityId,
    firm_id: firmId,
    stage_id: await stage(f, 'demo_booked'),
    pinned_by_user_id: salesperson(f),
    source_event_id: eventId,
    pinned_at: new Date().toISOString(),
    ...overrides,
  });
}

// ---------------------------------------------------------------- opportunity_values
async function value(f: Fixture, overrides: Row = {}): Promise<string> {
  const { firmId, opportunityId } = await firmWithOpportunity(f);
  return await insert(f, 'opportunity_values', {
    workspace_id: workspace(f),
    opportunity_id: opportunityId,
    firm_id: firmId,
    monthly_cents: 49900,
    kind: 'estimated',
    source: 'research',
    recorded_by_user_id: salesperson(f),
    ...overrides,
  });
}

// ------------------------------------------------------------------------ stage_rules
async function rule(f: Fixture, overrides: Row = {}): Promise<string> {
  return await insert(f, 'stage_rules', {
    evidence_kind: `case.rule_${String(next())}`,
    action: 'advance',
    target_stage_key: 'onboarding',
    description: 'A case rule.',
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

// --------------------------------------------------------- opportunity_stage_evidence
async function evidence(f: Fixture, overrides: Row = {}): Promise<string> {
  const { firmId, opportunityId } = await firmWithOpportunity(f);
  const eventId = await stageEvent(f, opportunityId, firmId);
  return await insert(f, 'opportunity_stage_evidence', {
    workspace_id: workspace(f),
    stage_event_id: eventId,
    opportunity_id: opportunityId,
    firm_id: firmId,
    evidence_kind: 'meeting.booked',
    evidence_id: `meeting-${String(next())}`,
    occurred_at: new Date().toISOString(),
    ...overrides,
  });
}

// ------------------------------------------------------------------ stage_review_items
async function review(f: Fixture, overrides: Row = {}): Promise<string> {
  const { firmId, opportunityId } = await firmWithOpportunity(f);
  return await insert(f, 'stage_review_items', {
    workspace_id: workspace(f),
    firm_id: firmId,
    opportunity_id: opportunityId,
    evidence_kind: 'meeting.booked',
    evidence_id: `review-${String(next())}`,
    reason: 'opportunity_closed',
    ...overrides,
  });
}

// ------------------------------------------------------------------------ call_sessions
async function sessionParts(f: Fixture): Promise<Row> {
  const { firmId, contactId } = await firmWithOpportunity(f);
  const n = next();
  const e164 = `+1401555${String(1000 + (n % 9000)).padStart(4, '0')}`;
  const routeId = await one(
    f,
    `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, association_confidence,
                               technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, 'salesperson', now(), 0.900, 'passed', 'usable', 'route-policy.1') RETURNING id`,
    [workspace(f), firmId, e164],
  );
  const postureId = await one(
    f,
    `INSERT INTO state_postures
       (workspace_id, state, revision, effective_from, review_at, rules_revision, confirmed_statements, confirmed_by_user_id)
     VALUES ($1, $2, 1, TIMESTAMPTZ '2026-01-01 00:00:00+00', TIMESTAMPTZ '2027-01-01 00:00:00+00', 2,
             ARRAY['businessToBusiness']::text[], $3) RETURNING id`,
    [workspace(f), `Z${String.fromCharCode(65 + (n % 26))}`, f.seeded.alpha.admin.userId],
  );
  const identityId = await one(
    f,
    `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                     verified_at, verified_by_user_id, verification_method)
     VALUES ($1, $2, $3, 'verified', true, now(), $2, 'owner_attestation') RETURNING id`,
    [workspace(f), salesperson(f), `+1212555${String(1000 + (n % 9000)).padStart(4, '0')}`],
  );
  const ticketId = await one(
    f,
    `INSERT INTO dial_tickets (workspace_id, command_id, firm_id, contact_id, phone_route_id, route_version, posture_id,
                               posture_revision, calling_identity_id, actor_user_id, device_id, assigned_user_id,
                               e164, firm_time_zone, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 1, $7, $8, $9, $8, $10, 'America/New_York', now(), now() + INTERVAL '60 seconds')
     RETURNING id`,
    [workspace(f), `c2b-case-${String(n)}`, firmId, contactId, routeId, postureId, identityId, salesperson(f),
      f.seeded.alpha.salesperson.deviceId, e164],
  );
  const reservationId = await one(
    f,
    `INSERT INTO provider_reservations
       (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
        cents, priced_unit, max_units, unit_price_micros)
     VALUES ($1, 'twilio.voice', 'call_session', gen_random_uuid(), 1, '2026-09-30', 'America/New_York',
             42, 'minute', 30, 14000) RETURNING id`,
    [workspace(f)],
  );
  return {
    workspace_id: workspace(f),
    ticket_id: ticketId,
    firm_id: firmId,
    contact_id: contactId,
    actor_user_id: salesperson(f),
    reservation_id: reservationId,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function callSession(f: Fixture, overrides: Row = {}): Promise<string> {
  return await insert(f, 'call_sessions', { ...(await sessionParts(f)), ...overrides });
}

/** A consumed session: the shape every progressed status needs. */
const consumed = (): Row => ({ consumed_at: new Date().toISOString(), twilio_call_sid: sid('CA') });

// ----------------------------------------------------------------------------- meetings
async function meeting(f: Fixture, overrides: Row = {}): Promise<string> {
  const { firmId, contactId, opportunityId } = await firmWithOpportunity(f);
  const uid = `booking${String(next())}`;
  return await insert(f, 'meetings', {
    workspace_id: workspace(f),
    booking_uid: uid,
    current_booking_uid: uid,
    firm_id: firmId,
    contact_id: contactId,
    opportunity_id: opportunityId,
    state: 'booked',
    starts_at: '2026-10-05T15:00:00Z',
    ends_at: '2026-10-05T15:30:00Z',
    organizer_email: 'david@usecallie.example',
    attendee_email: 'partner@firm.example',
    last_event_at: '2026-09-30T12:00:00Z',
    ...overrides,
  });
}

// ------------------------------------------------------------------------ calcom_events
async function calcomEvent(f: Fixture, overrides: Row = {}): Promise<string> {
  return await insert(f, 'calcom_events', {
    workspace_id: workspace(f),
    event_id: next().toString(16).padStart(64, '0'),
    trigger_event: 'BOOKING_CREATED',
    booking_uid: 'booking-case',
    payload_created_at: '2026-09-30T12:00:00Z',
    outcome: 'applied',
    ...overrides,
  });
}

// -------------------------------------------------------------- mail_message_duplicates
async function duplicate(f: Fixture, overrides: Row = {}): Promise<string> {
  return await insert(f, 'mail_message_duplicates', {
    workspace_id: workspace(f),
    mailbox_id: f.mail.alpha.mailboxId,
    provider_message_id: `dup${String(next())}`,
    duplicate_of_message_id: f.mail.alpha.messageId,
    reason: 'proven_duplicate',
    ...overrides,
  });
}

export const CALL_TO_BOOKING_CONSTRAINT_CASES: readonly Case[] = [
  // ---------------------------------------------------------- opportunity_stage_pins
  {
    constraint: 'opportunity_stage_pins_pkey',
    run: async f => {
      const { firmId, opportunityId } = await firmWithOpportunity(f);
      const eventId = await stageEvent(f, opportunityId, firmId);
      const row = {
        workspace_id: workspace(f),
        opportunity_id: opportunityId,
        firm_id: firmId,
        stage_id: await stage(f, 'demo_booked'),
        pinned_by_user_id: salesperson(f),
        source_event_id: eventId,
        pinned_at: new Date().toISOString(),
      };
      await insert(f, 'opportunity_stage_pins', row);
      return await insert(f, 'opportunity_stage_pins', row);
    },
  },
  {
    constraint: 'opportunity_stage_pins_opportunity_fkey',
    run: async f => await pin(f, { opportunity_id: ABSENT }),
  },
  { constraint: 'opportunity_stage_pins_stage_fkey', run: async f => await pin(f, { stage_id: ABSENT }) },
  { constraint: 'opportunity_stage_pins_event_fkey', run: async f => await pin(f, { source_event_id: ABSENT }) },
  { constraint: 'opportunity_stage_pins_user_fkey', run: async f => await pin(f, { pinned_by_user_id: ABSENT }) },

  // --------------------------------------------------------------- opportunity_values
  {
    constraint: 'opportunity_values_pkey',
    run: async f => {
      const id = await value(f);
      const { firmId, opportunityId } = await firmWithOpportunity(f);
      return await insert(f, 'opportunity_values', {
        id,
        workspace_id: workspace(f),
        opportunity_id: opportunityId,
        firm_id: firmId,
        monthly_cents: 1,
        kind: 'agreed',
        source: 'call',
      });
    },
  },
  { constraint: 'opportunity_values_opportunity_fkey', run: async f => await value(f, { opportunity_id: ABSENT }) },
  { constraint: 'opportunity_values_recorder_fkey', run: async f => await value(f, { recorded_by_user_id: ABSENT }) },
  { constraint: 'opportunity_values_cents_bounded', run: async f => await value(f, { monthly_cents: -1 }) },
  { constraint: 'opportunity_values_kind_known', run: async f => await value(f, { kind: 'hoped' }) },
  { constraint: 'opportunity_values_source_shape', run: async f => await value(f, { source: 'A Person' }) },

  // ---------------------------------------------------------------------- stage_rules
  { constraint: 'stage_rules_pkey', run: async f => await rule(f, { evidence_kind: 'meeting.booked' }) },
  { constraint: 'stage_rules_evidence_kind_shape', run: async f => await rule(f, { evidence_kind: 'Meeting Booked' }) },
  { constraint: 'stage_rules_action_known', run: async f => await rule(f, { action: 'teleport' }) },
  { constraint: 'stage_rules_target_key_shape', run: async f => await rule(f, { target_stage_key: 'Demo Booked' }) },
  { constraint: 'stage_rules_description_present', run: async f => await rule(f, { description: '  ' }) },

  // ------------------------------------------------------- opportunity_stage_evidence
  {
    constraint: 'opportunity_stage_evidence_pkey',
    run: async f => {
      const id = await evidence(f);
      return await evidence(f, { id });
    },
  },
  {
    constraint: 'opportunity_stage_evidence_one_per_event',
    run: async f => {
      const { firmId, opportunityId } = await firmWithOpportunity(f);
      const eventId = await stageEvent(f, opportunityId, firmId);
      const row = {
        workspace_id: workspace(f),
        stage_event_id: eventId,
        opportunity_id: opportunityId,
        firm_id: firmId,
        evidence_kind: 'meeting.booked',
        occurred_at: new Date().toISOString(),
      };
      await insert(f, 'opportunity_stage_evidence', { ...row, evidence_id: 'first' });
      return await insert(f, 'opportunity_stage_evidence', { ...row, evidence_id: 'second' });
    },
  },
  {
    constraint: 'opportunity_stage_evidence_once',
    run: async f => {
      const { firmId, opportunityId } = await firmWithOpportunity(f);
      const row = (eventId: string): Row => ({
        workspace_id: workspace(f),
        stage_event_id: eventId,
        opportunity_id: opportunityId,
        firm_id: firmId,
        evidence_kind: 'meeting.booked',
        evidence_id: 'the-same-meeting',
        occurred_at: new Date().toISOString(),
      });
      await insert(f, 'opportunity_stage_evidence', row(await stageEvent(f, opportunityId, firmId)));
      return await insert(f, 'opportunity_stage_evidence', row(await stageEvent(f, opportunityId, firmId)));
    },
  },
  { constraint: 'opportunity_stage_evidence_event_fkey', run: async f => await evidence(f, { stage_event_id: ABSENT }) },
  {
    constraint: 'opportunity_stage_evidence_opportunity_fkey',
    run: async f => await evidence(f, { firm_id: f.crm.alpha.firmId }),
  },
  { constraint: 'opportunity_stage_evidence_rule_fkey', run: async f => await evidence(f, { evidence_kind: 'meeting.imagined' }) },
  { constraint: 'opportunity_stage_evidence_id_shape', run: async f => await evidence(f, { evidence_id: 'has a space' }) },
  {
    constraint: 'opportunity_stage_evidence_detail_bounded',
    run: async f => await evidence(f, { detail: JSON.stringify(['not', 'an', 'object']) }),
  },

  // --------------------------------------------------------------- stage_review_items
  {
    constraint: 'stage_review_items_pkey',
    run: async f => {
      const id = await review(f);
      return await review(f, { id });
    },
  },
  { constraint: 'stage_review_items_workspace_id_fkey', run: async f => await review(f, { workspace_id: ABSENT, firm_id: null, opportunity_id: null }) },
  {
    constraint: 'stage_review_items_once',
    run: async f => {
      await review(f, { evidence_id: 'twice' });
      return await review(f, { evidence_id: 'twice' });
    },
  },
  { constraint: 'stage_review_items_firm_fkey', run: async f => await review(f, { firm_id: ABSENT, opportunity_id: null }) },
  {
    constraint: 'stage_review_items_opportunity_fkey',
    run: async f => await review(f, { firm_id: f.crm.alpha.firmId }),
  },
  { constraint: 'stage_review_items_resolver_fkey', run: async f => await review(f, { resolved_at: new Date().toISOString(), resolved_by_user_id: ABSENT }) },
  { constraint: 'stage_review_items_kind_shape', run: async f => await review(f, { evidence_kind: 'no dots here' }) },
  { constraint: 'stage_review_items_id_shape', run: async f => await review(f, { evidence_id: 'a b' }) },
  { constraint: 'stage_review_items_reason_known', run: async f => await review(f, { reason: 'felt_wrong' }) },
  { constraint: 'stage_review_items_opportunity_has_firm', run: async f => await review(f, { firm_id: null }) },
  { constraint: 'stage_review_items_resolution_consistent', run: async f => await review(f, { resolved_at: new Date().toISOString() }) },
  { constraint: 'stage_review_items_detail_bounded', run: async f => await review(f, { detail: JSON.stringify('text') }) },

  // ------------------------------------------------------ provider_reservations (0028)
  {
    constraint: 'provider_reservations_priced_shape',
    // A call subject priced like a model call: the shape the telephony subjects may not have.
    run: async f =>
      await f.session.query(
        `INSERT INTO provider_reservations
           (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
            cents, model_name, max_input_tokens, max_output_tokens)
         VALUES ($1, 'twilio.voice', 'call_session', gen_random_uuid(), 1, '2026-09-30', 'America/New_York',
                 42, 'claude-haiku-4-5', 100, 100)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'provider_reservations_priced_shape',
    // A telephony reservation with its minutes and price but no unit. `priced_unit =
    // 'minute'` alone is NULL here, which a CHECK accepts; the IS NOT NULL is the test.
    run: async f =>
      await f.session.query(
        `INSERT INTO provider_reservations
           (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
            cents, max_units, unit_price_micros)
         VALUES ($1, 'twilio.voice', 'call_session', gen_random_uuid(), 1, '2026-09-30', 'America/New_York',
                 42, 30, 14000)`,
        [workspace(f)],
      ),
  },

  // -------------------------------------------------------------------- call_sessions
  {
    constraint: 'call_sessions_pkey',
    run: async f => {
      const id = await callSession(f);
      return await callSession(f, { id });
    },
  },
  {
    constraint: 'call_sessions_one_per_ticket',
    run: async f => {
      const parts = await sessionParts(f);
      await insert(f, 'call_sessions', parts);
      return await insert(f, 'call_sessions', parts);
    },
  },
  {
    constraint: 'call_sessions_call_sid_unique',
    run: async f => {
      const shared = sid('CA');
      await callSession(f, { consumed_at: new Date().toISOString(), twilio_call_sid: shared });
      return await callSession(f, { consumed_at: new Date().toISOString(), twilio_call_sid: shared });
    },
  },
  { constraint: 'call_sessions_ticket_fkey', run: async f => await callSession(f, { ticket_id: ABSENT }) },
  { constraint: 'call_sessions_firm_fkey', run: async f => await callSession(f, { firm_id: ABSENT, contact_id: null }) },
  { constraint: 'call_sessions_contact_fkey', run: async f => await callSession(f, { contact_id: f.crm.alpha.contactId }) },
  { constraint: 'call_sessions_actor_fkey', run: async f => await callSession(f, { actor_user_id: ABSENT }) },
  { constraint: 'call_sessions_reservation_fkey', run: async f => await callSession(f, { reservation_id: ABSENT }) },
  { constraint: 'call_sessions_call_log_fkey', run: async f => await callSession(f, { call_log_id: ABSENT }) },
  { constraint: 'call_sessions_status_known', run: async f => await callSession(f, { ...consumed(), status: 'teleported' }) },
  { constraint: 'call_sessions_provider_status_shape', run: async f => await callSession(f, { provider_status: 'In Progress!' }) },
  {
    constraint: 'call_sessions_call_sid_shape',
    run: async f => await callSession(f, { consumed_at: new Date().toISOString(), twilio_call_sid: 'not-a-sid' }),
  },
  { constraint: 'call_sessions_dial_call_sid_shape', run: async f => await callSession(f, { dial_call_sid: 'CAxyz' }) },
  { constraint: 'call_sessions_recording_sid_shape', run: async f => await callSession(f, { recording_sid: sid('CA') }) },
  {
    constraint: 'call_sessions_recording_path_shape',
    run: async f => await callSession(f, { recording_path: 'https://api.twilio.com/Recordings/RE1' }),
  },
  {
    constraint: 'call_sessions_consumed_within_life',
    run: async f =>
      await callSession(f, {
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        consumed_at: new Date().toISOString(),
        twilio_call_sid: sid('CA'),
      }),
  },
  { constraint: 'call_sessions_sid_iff_consumed', run: async f => await callSession(f, { twilio_call_sid: sid('CA') }) },
  { constraint: 'call_sessions_progress_needs_consumption', run: async f => await callSession(f, { status: 'ringing' }) },
  { constraint: 'call_sessions_finished_has_end', run: async f => await callSession(f, { ...consumed(), status: 'completed' }) },
  { constraint: 'call_sessions_counts_nonnegative', run: async f => await callSession(f, { duration_seconds: -1 }) },
  {
    constraint: 'call_sessions_updated_not_before_created',
    run: async f => await callSession(f, { created_at: '2026-09-30T12:00:00Z', updated_at: '2026-09-30T11:00:00Z' }),
  },

  // ------------------------------------------------------------------------- meetings
  {
    constraint: 'meetings_pkey',
    run: async f => {
      const id = await meeting(f);
      return await meeting(f, { id });
    },
  },
  { constraint: 'meetings_workspace_id_fkey', run: async f => await meeting(f, { workspace_id: ABSENT, firm_id: null, contact_id: null, opportunity_id: null }) },
  {
    constraint: 'meetings_booking_uid_unique',
    run: async f => {
      await meeting(f, { booking_uid: 'dupe-booking', current_booking_uid: 'dupe-current-1' });
      return await meeting(f, { booking_uid: 'dupe-booking', current_booking_uid: 'dupe-current-2' });
    },
  },
  {
    constraint: 'meetings_current_uid_unique',
    run: async f => {
      await meeting(f, { booking_uid: 'first-booking', current_booking_uid: 'dupe-current' });
      return await meeting(f, { booking_uid: 'second-booking', current_booking_uid: 'dupe-current' });
    },
  },
  { constraint: 'meetings_firm_fkey', run: async f => await meeting(f, { firm_id: ABSENT, contact_id: null, opportunity_id: null }) },
  { constraint: 'meetings_contact_fkey', run: async f => await meeting(f, { contact_id: f.crm.alpha.contactId }) },
  { constraint: 'meetings_opportunity_fkey', run: async f => await meeting(f, { opportunity_id: f.crm.alpha.opportunityId }) },
  { constraint: 'meetings_uid_shape', run: async f => await meeting(f, { booking_uid: 'has spaces', current_booking_uid: 'fine' }) },
  { constraint: 'meetings_state_known', run: async f => await meeting(f, { state: 'maybe' }) },
  { constraint: 'meetings_no_show_remembers', run: async f => await meeting(f, { state: 'no_show' }) },
  { constraint: 'meetings_ends_after_start', run: async f => await meeting(f, { ends_at: '2026-10-05T14:00:00Z' }) },
  { constraint: 'meetings_links_need_firm', run: async f => await meeting(f, { firm_id: null }) },
  { constraint: 'meetings_emails_shape', run: async f => await meeting(f, { attendee_email: 'Partner@Firm.Example' }) },
  {
    constraint: 'meetings_updated_not_before_created',
    run: async f => await meeting(f, { created_at: '2026-09-30T12:00:00Z', updated_at: '2026-09-30T11:00:00Z' }),
  },

  // -------------------------------------------------------------------- calcom_events
  {
    constraint: 'calcom_events_pkey',
    run: async f => {
      const id = await calcomEvent(f);
      return await calcomEvent(f, { id });
    },
  },
  { constraint: 'calcom_events_workspace_id_fkey', run: async f => await calcomEvent(f, { workspace_id: ABSENT }) },
  {
    constraint: 'calcom_events_once',
    run: async f => {
      await calcomEvent(f, { event_id: 'e'.repeat(64) });
      return await calcomEvent(f, { event_id: 'e'.repeat(64) });
    },
  },
  { constraint: 'calcom_events_meeting_fkey', run: async f => await calcomEvent(f, { meeting_id: ABSENT }) },
  { constraint: 'calcom_events_event_id_shape', run: async f => await calcomEvent(f, { event_id: 'not-a-digest' }) },
  { constraint: 'calcom_events_trigger_shape', run: async f => await calcomEvent(f, { trigger_event: 'booking created' }) },
  { constraint: 'calcom_events_booking_uid_shape', run: async f => await calcomEvent(f, { booking_uid: 'a b' }) },
  { constraint: 'calcom_events_outcome_known', run: async f => await calcomEvent(f, { outcome: 'shrugged' }) },

  // --------------------------------------------------------- mail_message_duplicates
  {
    constraint: 'mail_message_duplicates_pkey',
    run: async f => {
      await duplicate(f, { provider_message_id: 'twice-seen' });
      return await duplicate(f, { provider_message_id: 'twice-seen' });
    },
  },
  { constraint: 'mail_message_duplicates_mailbox_fkey', run: async f => await duplicate(f, { mailbox_id: ABSENT }) },
  { constraint: 'mail_message_duplicates_message_fkey', run: async f => await duplicate(f, { duplicate_of_message_id: ABSENT }) },
  { constraint: 'mail_message_duplicates_provider_id_shape', run: async f => await duplicate(f, { provider_message_id: 'has space' }) },
  { constraint: 'mail_message_duplicates_reason_known', run: async f => await duplicate(f, { reason: 'looked_similar' }) },
];
