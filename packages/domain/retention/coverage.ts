/**
 * What happens to every table in the schema, under retention, deletion and departure.
 *
 * `PENDING_RETENTION_TABLES` is the named-in-advance half of the guard, and it is
 * empty now that G7b, G8 and G9 have landed and their tables are answered for below.
 * This registry is the half that does not need naming in advance: every table
 * PostgreSQL reports has to appear here, so a lane that adds one and does not say
 * what its rows are under section 10.3 fails the build rather than quietly creating a
 * store of prospect data with no horizon.
 *
 * That is the failure mode worth preventing. A retention policy is not a document;
 * it is a claim about every row in the database, and the only way that claim stays
 * true across eleven lanes is for the claim to be checked against the catalog.
 *
 * The dispositions are not mutually exclusive — `contacts` is retained as business
 * history *and* redacted by the deletion workflow — so each table names a set.
 */

export type TableDisposition =
  /** A scheduled retention target deletes or redacts rows here. */
  | 'swept'
  /** Kept as Callie business history, or kept because the privilege to remove it is revoked. */
  | 'retained'
  /** The admin deletion workflow removes these rows. */
  | 'deletion_removes'
  /** The admin deletion workflow clears the personal fields and keeps the row. */
  | 'deletion_redacts'
  /** The departure command revokes, ends or deletes rows here. */
  | 'departure_revokes'
  /**
   * The admin deletion workflow terminally stops the row without removing or
   * blanking it. Nothing personal leaves; what changes is that no worker will act
   * on it again.
   */
  | 'deletion_stops'
  /**
   * The departure command opens a `reassignment` hold naming this row, so automation
   * stops until an admin gives the work a new owner. The row itself is untouched.
   */
  | 'departure_holds'
  /** Configuration, catalog or queue mechanics: no prospect or personal data. */
  | 'operational';

export interface TableCoverage {
  readonly dispositions: readonly TableDisposition[];
  readonly note: string;
}

const coverage = (dispositions: readonly TableDisposition[], note: string): TableCoverage => ({
  dispositions,
  note,
});

export const TABLE_RETENTION_COVERAGE: Readonly<Record<string, TableCoverage>> = Object.freeze({
  // ------------------------------------------------------------- foundation
  workspaces: coverage(['operational'], 'The tenant itself.'),
  users: coverage(['retained'], 'A Callie member, not a prospect; departure revokes the membership and leaves the person.'),
  workspace_memberships: coverage(['departure_revokes'], 'Set inactive by departure; the row is the history of the access.'),
  devices: coverage(['departure_revokes'], 'Revoked by departure; the row records which Mac held a credential.'),
  calling_identities: coverage(['operational'], 'A verified Callie outbound number.'),
  command_receipts: coverage(['retained'], '13.2 keeps a receipt at least through its device credential’s lifetime.'),
  audit_events: coverage(['retained'], 'Seven years, and UPDATE, DELETE and TRUNCATE are revoked from both roles.'),
  suppression_events: coverage(['retained'], 'Indefinite, insert-only, and the tombstone a deletion leaves behind.'),
  active_holds: coverage(['retained'], 'The record of why automation was blocked; departure opens reassignment holds.'),
  administrative_pauses: coverage(['retained'], 'A pause and its reason history.'),
  system_generations: coverage(['operational'], 'Appendix E’s restore generation.'),
  retention_policies: coverage(['operational'], 'The horizons themselves.'),
  jobs: coverage(['swept'], 'Payloads are redacted after the operational window; the dedupe key stays.'),
  daily_counters: coverage(['operational'], 'Counts by workspace, subject and business date; no prospect identity.'),
  heartbeats: coverage(['operational'], 'Liveness per component.'),
  hold_reason_codes: coverage(['operational'], 'The closed vocabulary of section 15.'),
  canary_runs: coverage(['operational'], 'Scheduler-to-worker liveness proof.'),
  critical_alerts: coverage(['operational'], 'Open and acknowledged alarm conditions.'),

  // -------------------------------------------------------------- identity
  sessions: coverage(['departure_revokes'], 'Ended by departure; the row records the session that existed.'),
  device_refresh_credentials: coverage(['departure_revokes'], 'Revoked by departure; only digests are stored.'),
  oidc_authorization_requests: coverage(['operational'], 'Single-use digests of an in-flight sign-in.'),

  // ------------------------------------------------------------------- CRM
  firms: coverage(['retained', 'deletion_redacts'], 'Business history; a deletion clears the identifying fields and keeps the row the append-only history references.'),
  contacts: coverage(['retained', 'deletion_redacts'], 'Business history; a deletion clears the person’s name and title (which carries the LinkedIn URL migration 0018 kept) and keeps the row the append-only history references.'),
  phone_routes: coverage(['deletion_removes'], 'A normalized personal handle; a deletion removes it and leaves a suppression tombstone.'),
  email_addresses: coverage(['deletion_removes'], 'A normalized personal handle; a deletion removes it and leaves a suppression tombstone for the same key.'),
  evidence_items: coverage(['swept', 'deletion_removes'], 'Deleted at the provider’s own expiry, and with the firm on deletion.'),
  pipeline_stages: coverage(['operational'], 'Workspace configuration.'),
  opportunities: coverage(['retained'], 'Business history.'),
  opportunity_stage_events: coverage(['retained'], 'Append-only; DELETE revoked from both roles.'),
  record_aliases: coverage(['deletion_removes'], 'Preserved identifiers of a merged record, which name the prospect.'),
  record_merge_events: coverage(['retained'], 'Append-only; DELETE revoked.'),
  crm_domain_events: coverage(['retained'], 'Append-only; DELETE revoked.'),

  // ---------------------------------------------------------------- policy
  state_postures: coverage(['operational'], 'Callie’s reviewed legal posture.'),
  calling_windows: coverage(['operational'], 'Workspace configuration.'),
  suppression_finalizations: coverage(['retained'], 'Append-only marker of the ten-minute window’s winner.'),
  dial_tickets: coverage(['deletion_removes'], 'A one-use ticket naming the route dialled.'),
  call_logs: coverage(['deletion_removes'], 'Call history for the deleted firm, including its notes.'),
  callbacks: coverage(['deletion_removes'], 'A promised call back to the deleted person.'),

  // -------------------------------------------------------------- research
  research_settings: coverage(['operational'], 'Workspace configuration.'),
  research_providers: coverage(['operational'], 'Provider configuration and reviewed terms.'),
  research_provider_ledger: coverage(['operational'], 'Calls and costs; no prospect identity.'),
  research_route_policies: coverage(['operational'], 'Versioned thresholds; append-only.'),
  research_pages: coverage(['operational'], 'Provider page bookkeeping keyed by query and page hash.'),
  firm_locations: coverage(['deletion_removes'], 'Resolved coordinates for a firm.'),
  research_firm_runs: coverage(['operational'], 'Enrichment run bookkeeping.'),
  research_suggestions: coverage(['swept', 'deletion_removes'], 'Pointer cleared when its evidence expires; removed with the firm.'),

  // ----------------------------------------------------------------- today
  today_snapshots: coverage(['operational'], 'One derived snapshot per workspace business date.'),
  today_items: coverage(['deletion_removes'], 'Derived work items naming the deleted firm and contact.'),
  today_snoozes: coverage(['deletion_removes'], 'A snoozed task naming the deleted firm and contact; derived work, removed with them.'),

  // ------------------------------------------------------------------ mail
  mailboxes: coverage(['departure_revokes'], 'Disconnected by departure; the row is what the firm’s messages hang off.'),
  mailbox_tokens: coverage(['departure_revokes'], 'The envelope-encrypted refresh token, deleted outright by departure.'),
  mailbox_watches: coverage(['departure_revokes'], 'Cancelled when the grant goes.'),
  mailbox_recoveries: coverage(['swept'], 'Mailbox diagnostics; completed runs go after seven days.'),
  gmail_push_notifications: coverage(['swept'], 'Temporary mailbox material; seven days.'),
  mail_messages: coverage(['swept', 'retained', 'deletion_removes'], 'Unmatched metadata goes at thirty days, matched correspondence is business history, and a deletion removes the deleted firm’s.'),
  mail_message_bodies: coverage(['swept', 'retained', 'deletion_removes'], 'Follows its message through the cascade.'),
  mail_message_matches: coverage(['swept', 'retained', 'deletion_removes'], 'Follows its message through the cascade.'),
  mail_message_classifications: coverage(['swept', 'retained', 'deletion_removes'], 'Follows its message through the cascade.'),
  mail_message_effects: coverage(['swept', 'retained', 'deletion_removes'], 'Follows its message through the cascade.'),
  template_versions: coverage(['operational'], 'Approved immutable template bodies; Callie’s, not a prospect’s.'),

  // -------------------------------------------------------------- sending
  outbound_messages: coverage(
    ['swept', 'retained', 'deletion_redacts'],
    'A held draft’s subject and body are cleared at thirty days and on deletion; the row never goes, because DELETE is revoked and the fence is what stops a second send.',
  ),
  outbound_message_events: coverage(['retained'], 'Append-only transition log; UPDATE and DELETE revoked.'),
  sending_domains: coverage(['operational'], 'Callie’s own domain authentication and ramp posture.'),
  mailbox_send_ramp: coverage(['operational'], 'A Callie mailbox’s position in the new-domain ramp.'),
  mailbox_send_days: coverage(['operational'], 'Per-mailbox daily counts; no prospect identity.'),

  // ------------------------------------------------- classification (G7b)
  classifier_settings: coverage(['operational'], 'Workspace configuration for the reply classifier.'),
  mail_classification_calls: coverage(
    ['retained', 'deletion_removes'],
    'Counts, ids and outcomes only — 0011 keeps no prompt, message text or excerpt here — so it is a cost record rather than a copy of correspondence. It cascades with its message, and a deletion removes the firm’s messages.',
  ),
  mail_reply_confirmations: coverage(
    ['retained', 'deletion_removes'],
    'A person’s decision about a reply: business history while the firm exists, and removed with the correspondence it is about. Deleted before the messages that would cascade it, because it also references a callback the deletion removes.',
  ),

  // ---------------------------------------------------- settings (G9, 0013)
  workspace_settings: coverage(['operational'], 'Workspace configuration and its audited history; no prospect identity.'),
  // ------------------------------------------------ release records (g71, 0017)
  release_records: coverage(
    ['operational', 'retained'],
    'The rehearsal gate a sending attestation names: image digests and scenario report lines, no prospect or personal data. Append-only; UPDATE and DELETE revoked.',
  ),

  // ------------------------------------------------------- sequences (G8)
  workspace_holiday_calendars: coverage(['operational'], 'Versioned holiday sets; Callie’s configuration.'),
  sequences: coverage(['operational'], 'A named cadence Callie wrote.'),
  sequence_versions: coverage(['operational'], 'An immutable published plan; Callie’s words, not a prospect’s.'),
  sequence_steps: coverage(['operational'], 'The steps of a published plan.'),
  sequence_enrollments: coverage(
    ['retained', 'deletion_stops', 'departure_holds'],
    'Business history of who was worked and how: the row stays, its personal fields living on the contact it names. A deletion stops it with `admin_stop`; a departure holds the ones its member was running.',
  ),
  step_executions: coverage(
    ['retained', 'deletion_stops'],
    'What was due, when it moved and how it finished. A deletion cancels the unexecuted ones; the executed history stays, because 11.1 requires it preserved.',
  ),
  step_execution_shifts: coverage(['retained'], 'Append-only schedule history; UPDATE and DELETE revoked.'),
  enrollment_migrations: coverage(['retained'], 'The audited admin command of 11.1 and its approval.'),
  enrollment_migration_items: coverage(['retained'], 'Which enrollment the migration remapped or refused, and why.'),
  sequence_event_cursors: coverage(['operational'], 'Per-consumer position in the event stream; ids only.'),

  // ------------------------------------------------------------- retention
  retention_runs: coverage(['retained'], 'The run ledger and the deletion tombstone; DELETE revoked.'),
  deletion_requests: coverage(['retained'], 'What was previewed and what was committed; DELETE revoked.'),
  departures: coverage(['retained'], 'What a departure revoked; DELETE revoked.'),
});

/** Tables the coverage registry deliberately does not classify. */
export const COVERAGE_EXEMPT_TABLES: readonly string[] = Object.freeze(['schema_versions']);
