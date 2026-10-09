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
  | "swept"
  /** Kept as Callie business history, or kept because the privilege to remove it is revoked. */
  | "retained"
  /** The admin deletion workflow removes these rows. */
  | "deletion_removes"
  /** The admin deletion workflow clears the personal fields and keeps the row. */
  | "deletion_redacts"
  /** The departure command revokes, ends or deletes rows here. */
  | "departure_revokes"
  /**
   * The admin deletion workflow terminally stops the row without removing or
   * blanking it. Nothing personal leaves; what changes is that no worker will act
   * on it again.
   */
  | "deletion_stops"
  /**
   * The departure command opens a `reassignment` hold naming this row, so automation
   * stops until an admin gives the work a new owner. The row itself is untouched.
   */
  | "departure_holds"
  /** Configuration, catalog or queue mechanics: no prospect or personal data. */
  | "operational";

export interface TableCoverage {
  readonly dispositions: readonly TableDisposition[];
  readonly note: string;
}

const coverage = (
  dispositions: readonly TableDisposition[],
  note: string,
): TableCoverage => ({
  dispositions,
  note,
});

export const TABLE_RETENTION_COVERAGE: Readonly<Record<string, TableCoverage>> =
  Object.freeze({
  crm_mail_import_allocations: coverage(['operational'], 'Operator-configured proven account/project allocation, exact verification receipt, unit costs and reserved operational headroom; mutable revisions require separate external verification before use.'),
  crm_mail_import_read_reservations: coverage(['operational','retained'], 'Body-free read unit conservation across workers and allocation revisions; unknown and observed attempts both consume the rolling window, independent of source deletion.'),
  crm_mail_imports: coverage(['operational'], 'Body-free exact owner/account/generation import scope and enumeration coverage; completion does not establish copied-body coverage or sending authority.'),
  crm_mail_import_messages: coverage(['deletion_redacts','swept'], 'Versioned exact import causal metadata with opaque terminal hash barriers; available, refused and provider-confirmed missing results are distinct from copied bodies. Thread, provider date and raw ID clear on terminal deletion; conservation ledger remains.'),
  crm_mail_history_recoveries: coverage(['swept','retained'], 'Bounded recovery gap checkpoints clear after ninety days without verified progress; opaque immutable epochs, account/config bindings and conserved quota survive. Scoped copy deletion does not erase unrelated mailbox recovery coverage.'),
  crm_mail_import_slices: coverage(['operational'], 'Bounded historical enumeration checkpoints, without message bodies, addresses or tokens; import-head deletion cascades checkpoints.'),
  crm_selected_file_receipts: coverage(['retained','deletion_redacts'], 'Explicit original-file provenance follows its sole selected source copy. Source or scoped context deletion atomically clears names, hashes, format, parser, origin and byte count; only opaque identity/revisions and unavailable state remain. Restore requires fresh selection. Departed or unauthorized actors cannot read or analyze the copy; no duplicate original body or financial ledger.'),
  crm_mail_progress_scan_cursors:coverage(['retained'],'Opaque workspace-local UUID scan cursor; wrapping revisits changed dependencies and advancing never certifies processing or grants acquisition.'),
  crm_mail_progress_receipts:coverage(['retained','deletion_removes'],'Body-free exact mail progress proof; reads recheck current source and prerequisites. Terminal whole-context deletion removes proof metadata and dates.'),
  crm_mail_reply_resolutions:coverage(['retained','deletion_redacts'],'Immutable opaque workspace/request completion markers prevent completed work from reappearing. Terminal deletion clears provider dates and receipt links while retaining completion identity.'),
    crm_selected_imports: coverage(
      ["retained", "deletion_redacts"],
      "Selected source labels, participants and attachment references redact atomically via the source-deletion trigger; only body-free import hashes and source identity remain to block replay. No duplicate body store; disconnect does not delete approved copied history.",
    ),
    crm_mail_capture_controls: coverage(
      ["operational"],
      "Disabled owner/account-bound capture configuration and exact evaluation/release proof hashes; no bodies, endpoints or sending authority.",
    ),
    crm_mail_capture_identities: coverage(
      ["retained", "deletion_stops"],
      "Opaque provider/account-to-canonical identity and body-free original context references survive copy deletion to prevent replay or replacement identities; scoped deletion terminally blocks pending and copied capture.",
    ),
    crm_mail_sources: coverage(
      ["retained", "deletion_redacts", "deletion_removes"],
      "Approved copy provenance and participants, with the only body held in mail_message_bodies. Explicit copy deletion clears personal metadata, copied dates and body bytes while preserving an opaque unavailable head; scoped firm/contact deletion explicitly removes the head and canonical copy. Disconnect retains approved history.",
    ),
    crm_mail_source_contexts: coverage(
      ["retained", "deletion_removes"],
      "Original and explicitly reviewed context IDs, opaque endpoint hashes and observed-label status; no copied labels or bodies. Terminal source-head deletion cascades contexts; unavailable heads retain the last explicit scope without restoring claims, and current source availability gates reads.",
    ),
    crm_mail_acquisition_tombstones: coverage(
      ["retained"],
      "Versioned opaque owner/source/capture identity and hashes persist without bodies, labels, dates or endpoints; old source revisions and ordinary provider replay remain unavailable after explicit restoration.",
    ),
    crm_mail_source_intents: coverage(
      ["retained", "deletion_stops"],
      "Body-free exact source/revision/hash successor intents; deletion invalidates pending work. Current source, account and purpose authority gate processing; no provider request or sending permission is retained here.",
    ),
    crm_business_conversations: coverage(
      ["deletion_redacts", "swept"],
      "Owner-private proven account metadata, redacted whole with mapped source or exact target address; 90-day review horizon. No bodies or sending authority.",
    ),
    crm_business_decision_revisions: coverage(
      ["retained"],
      "Content-free durable business inclusion/exclusion decisions; opaque IDs and revisions survive metadata redaction.",
    ),
    crm_business_policies: coverage(
      ["operational"],
      "Disabled mailbox-bound metadata review configuration; no message bodies or sending authority.",
    ),
    human_reply_send_intents: coverage(
      ["deletion_removes"],
      "Exact human approval and envelope/thread metadata, with no duplicate body store. Firm/contact deletion removes this metadata under the send gate; the original outbound draft fence/source identity retains no-repeat history. Short expiry and current authority checks forbid replay. Outbound removal cascades this metadata.",
    ),
    actionable_notification_attempts: coverage(
      ["operational", "retained"],
      "Body-free user/device/source delivery and acknowledgement markers are retained for event deduplication through prospect deletion, departure and whole-database restore. Current ownership and source reads gate every new alert and context; a retained attempt never authorizes a replay.",
    ),
    mailbox_provider_incidents: coverage(
      ["operational", "retained"],
      "Coded mailbox safety history and hold identities; retained after prospect deletion/departure and with the whole database restore. Deadlines do not authorize fresh external action.",
    ),
    social_weekly_settings: coverage(
      ["operational"],
      "Owner opt-in and next weekly draft check; active membership required, no transcripts or publication permission.",
    ),
    social_library_usage: coverage(
      ["operational"],
      "Workspace storage quota; released only after physical object deletion.",
    ),
    social_assets: coverage(
      ["retained"],
      "Owner-authored library metadata; explicit asset deletion tombstones it and queues private object removal.",
    ),
    social_asset_objects: coverage(
      ["retained"],
      "Version/hash tombstones remain; pending uploads expire after 24 hours and their objects enter the deletion queue.",
    ),
    social_object_deletions: coverage(
      ["operational"],
      "Idempotent object deletion and quota-release receipts; no image bytes.",
    ),
    social_accounts: coverage(
      ["retained"],
      "Profile/Page identity and adapter observations; disconnect invalidates the connection but retains native schedule reconciliation identity.",
    ),
    social_posts: coverage(
      ["retained"],
      "Owner-authored content identity, retained with revision and delivery history.",
    ),
    social_post_revisions: coverage(
      ["retained"],
      "Authored public content revisions; retained independently of prospect evidence.",
    ),
    social_post_approvals: coverage(
      ["retained"],
      "Immutable exact-content approvals; retained to reconcile external schedules and prevent duplicate publication.",
    ),
    social_deliveries: coverage(
      ["retained"],
      "Native scheduling receipts and cancellation state; local deletion cannot recall an external schedule.",
    ),
    social_draft_requests: coverage(
      ["retained"],
      "Source references/hashes and anonymized draft suggestions, never copied transcripts; deleted or changed sources block generation and result acceptance.",
    ),
    outreach_reply_deliveries: coverage(
      ["retained"],
      "Immutable draft hashes and delivery bindings only; source and permission gates refuse deleted or changed prospects.",
    ),
    outreach_email_admission_settings: coverage(
      ["operational"],
      "Disabled email capability bindings and evaluation hashes only; no prospect text or credentials.",
    ),
    outreach_settings: coverage(
      ["operational"],
      "Disabled-by-default reply settings; no prospect text.",
    ),
    outreach_reply_requests: coverage(
      ["retained"],
      "Coded decisions and immutable source hashes only; source deletion makes requests unavailable, plan deletion workflow stops dispatch.",
    ),
    meeting_qualification_revisions: coverage(
      ["deletion_removes"],
      "Immutable qualification answers and source references cascade with meeting deletion.",
    ),
    sourcing_targeting_versions: coverage(
      ["operational"],
      "Immutable public search policies, no contact data; used to interpret past dispatches.",
    ),
    sourcing_targeting_proposals: coverage(
      ["retained"],
      "Admin-authored search changes and approval audit; no copied prospect evidence.",
    ),
    call_need_revisions: coverage(
      ["deletion_removes"],
      "Cascades with the call log; confirmation holds no free text.",
    ),
    sourcing_attributions: coverage(
      ["deletion_removes"],
      "Source IDs and coded hypotheses; full-firm deletion removes them, candidate deletion makes the source unavailable.",
    ),
    sourcing_interactions: coverage(
      ["deletion_removes"],
      "Interaction references and revisions; removed with their source firm or deleted contact interactions.",
    ),
    sourcing_first_touches: coverage(
      ["deletion_removes"],
      "Frozen first-contact source; removed with its firm attribution, not replaced by a newer source.",
    ),
    sourcing_search_account: coverage(
      ["operational"],
      "Shared search allowance and halt state; no credential material.",
    ),
    sourcing_discovery_settings: coverage(
      ["operational"],
      "Workspace discovery schedule and status.",
    ),
    sourcing_discovery_attempts: coverage(
      ["retained"],
      "Search dispatch and quota history, containing fixed queries only; required to prevent replay.",
    ),
    sourcing_discovery_hits: coverage(
      ["retained"],
      "Public source URL deduplication tombstones; kept after candidate deletion to prevent rediscovery.",
    ),
    sourcing_qualification_runs: coverage(
      ["deletion_removes"],
      "Bounded candidate evidence and interpretations cascade on candidate deletion. Provider accounting remains independent.",
    ),
    sourcing_feedback: coverage(
      ["retained"],
      "Versioned sourcing feedback; removed with candidate evidence by cascading deletion.",
    ),
    sourcing_admissions: coverage(
      ["deletion_removes"],
      "Candidate-to-CRM provenance cascades with candidate evidence; deleting it does not delete a CRM firm or undo a stop.",
    ),
    sourcing_candidates: coverage(
      ["deletion_removes"],
      "Independent unverified drafts; the admin candidate delete command removes the payload. No CRM contact or firm is created.",
    ),
    // ------------------------------------------------------------- foundation
    workspaces: coverage(["operational"], "The tenant itself."),
    users: coverage(
      ["retained"],
      "A Callie member, not a prospect; departure revokes the membership and leaves the person.",
    ),
    workspace_memberships: coverage(
      ["departure_revokes"],
      "Set inactive by departure; the row is the history of the access.",
    ),
    devices: coverage(
      ["departure_revokes"],
      "Revoked by departure; the row records which Mac held a credential.",
    ),
    calling_identities: coverage(
      ["operational"],
      "A verified Callie outbound number.",
    ),
    command_receipts: coverage(
      ["retained"],
      "13.2 keeps a receipt at least through its device credential’s lifetime.",
    ),
    audit_events: coverage(
      ["retained"],
      "Seven years, and UPDATE, DELETE and TRUNCATE are revoked from both roles.",
    ),
    suppression_events: coverage(
      ["retained"],
      "Indefinite, insert-only, and the tombstone a deletion leaves behind.",
    ),
    active_holds: coverage(
      ["retained"],
      "The record of why automation was blocked; departure opens reassignment holds.",
    ),
    administrative_pauses: coverage(
      ["retained"],
      "A pause and its reason history.",
    ),
    retention_policies: coverage(["operational"], "The horizons themselves."),
    jobs: coverage(
      ["swept"],
      "Payloads are redacted after the operational window; the dedupe key stays.",
    ),
    daily_counters: coverage(
      ["operational"],
      "Counts by workspace, subject and business date; no prospect identity.",
    ),
    heartbeats: coverage(["operational"], "Liveness per component."),
    hold_reason_codes: coverage(
      ["operational"],
      "The closed vocabulary of section 15.",
    ),
    canary_runs: coverage(
      ["operational"],
      "Scheduler-to-worker liveness proof.",
    ),
    critical_alerts: coverage(
      ["operational"],
      "Open and acknowledged alarm conditions.",
    ),

    // -------------------------------------------------------------- identity
    sessions: coverage(
      ["departure_revokes"],
      "Ended by departure; the row records the session that existed.",
    ),
    oidc_authorization_requests: coverage(
      ["operational"],
      "Single-use digests of an in-flight sign-in.",
    ),

    crm_commitment_reviews: coverage(['retained','deletion_redacts'],'Structured human promise attestation follows its exact canonical evidence anchor and all original/current source authority. Copy deletion clears private label/date/actor/context/target fields via the anchor deletion hook; temporary access denial is not deletion. No copied quotation body.'),
    crm_internal_tasks: coverage(['deletion_redacts','retained'],'Opaque workspace/task identity and completed action time survive evidence redaction to prevent reactivation. Private initial activation receipt and review binding are erased on whole-copy or terminal original-context deletion; quote/date/labels are resolved only from current permitted review/source; no outbound or stage authority.'),
    // ------------------------------------------------------------------- CRM
    crm_claim_review_anchors: coverage(
      ["retained", "deletion_redacts"],
      "Body-free exact semantic equality, immutable original owner/context and dated human-history identity remain. Copy deletion clears original event/observation dates and vetoes old approval; restoration never restores the approval.",
    ),
    crm_claim_decision_revisions: coverage(
      ["retained", "deletion_redacts"],
      "Dated human actions remain separate from model claims. Copy deletion physically clears correction and rationale text across every revision; protected history can show only redacted actions.",
    ),
    crm_claim_conflicts: coverage(
      ["retained"],
      "Body-free conflict identity/current revision; every read requires all current and original member scopes.",
    ),
    crm_claim_conflict_revisions: coverage(
      ["retained", "deletion_redacts"],
      "Dated conflict decisions preserve every member. Deleting any source clears rationale across all conflict revisions; no quoted model or source text is duplicated.",
    ),
    crm_claim_conflict_members: coverage(
      ["retained"],
      "Body-free versioned anchor membership and preference support; no copied bodies, labels or endpoints.",
    ),
    crm_claim_work_dependencies: coverage(
      ["retained"],
      "Body-free exact existing work/anchor/version dependencies. Human changes and source deletion flag open work for review without rewriting completed status, times or delivered facts.",
    ),
    crm_extraction_financial_receipts: coverage(
      ["operational", "retained"],
      "Body-free exact route/grant/price dispatch markers and reservations survive source deletion and restoration. Unknown paid acceptance blocks a second submission across revisions; money is conserved independently from evidence publication.",
    ),
    crm_extraction_claims: coverage(
      ["retained", "deletion_removes"],
      "Versioned bounded quote and interpretation projections are erased transactionally when their original selected/call/meeting source becomes deleted or its content becomes stale. Context-only superseded claims stay bound to their original context and remain unpublished; later source deletion still erases them. Restoring a source does not restore old quotes; every read revalidates current source and access.",
    ),
    crm_ask_actions: coverage(['retained','deletion_redacts'],'Explicit human tasks, notes and preference proposals retain independent original input authority; source deletion erases all copied fields while source-free completion facts survive.'),
    crm_ask_requests: coverage(['retained','deletion_redacts'],'Owner-private questions and answers follow every initial source and context. Scoped deletion erases all private fields and keeps an irreversible opaque identity; capture is not sending permission.'),
    crm_ask_request_windows: coverage(['deletion_removes'],'Immutable body-free canonical window and duplicate group proofs are removed with the whole affected private request.'),
    crm_ask_financial_receipts: coverage(['retained'],'Opaque priced stage, attempt and reservation receipts conserve provider spending after private source and request deletion; no question or copied conversation body.'),
    crm_ask_purposes: coverage(['retained'],'Independent disabled Ask purposes and exact configuration/evaluation/budget approvals are operational history and do not enable sending.'),
    crm_extraction_generations: coverage(
      ["retained", "deletion_stops"],
      "Body-free source/version processing receipts remain; every selected-source deletion invalidates work without reviving it on restoration. Call and meeting originals also invalidate receipts and erase quote projections; unproven mail remains unavailable.",
    ),
    crm_extraction_purposes: coverage(
      ["retained"],
      "Purpose-specific disabled configuration and approved budget metadata remain operational history; no copied conversations or credentials.",
    ),
    crm_people: coverage(
      ["retained", "deletion_redacts"],
      "Independent business identity; operational contact deletion redacts its legacy bridge identity unless unrelated, currently supported firm evidence survives. Unknown-firm people are owner/admin sensitive and source-copy deletion does not delete the person.",
    ),
    crm_relationships: coverage(
      ["retained", "deletion_stops"],
      "Human-selected business associations and exact source references, without copied quotations. Deleted evidence invalidates support and requires context review; current context authority remains required.",
    ),
    crm_relationship_revisions: coverage(
      ["retained"],
      "Body-free human association decisions and original firm/date context; no excerpt or endpoint literal copies in revision history.",
    ),
    crm_source_relationship_contexts: coverage(
      ["retained", "deletion_stops"],
      "Original source/relationship revisions and firm snapshots remain body-free history. Deleting the copied source requires review without rebinding original context.",
    ),
    crm_identity_endpoints: coverage(
      ["retained", "deletion_redacts"],
      "Shared endpoint identity is not person ownership. Deletion clears its literal value when no other current retained claim supports it; a hash remains for deduplication.",
    ),
    crm_endpoint_claims: coverage(
      ["retained", "deletion_stops"],
      "Temporal endpoint assertions reference exact evidence and become unavailable when that source is deleted; unavailable assertions cannot authorize identity matching or sending.",
    ),
    crm_endpoint_claim_revisions: coverage(
      ["retained"],
      "Body-free human endpoint decisions retain context IDs and source references, without copied endpoint literals or source excerpts.",
    ),
    crm_legacy_contact_people: coverage(
      ["retained"],
      "Body-free legacy contact/person bridge; operational identifiers remain unchanged through deletion and prevent duplicate identity backfill.",
    ),
    crm_selected_sources: coverage(
      ["retained", "deletion_redacts"],
      "Approved selected-note copies stay with the business record until explicit source deletion. Explicit source deletion and exact original person/firm context deletion remove the entire indivisible excerpt/hash/event date; unrelated firm copies survive. Minimal reimport identity and revision remain; explicit restore requires recapture.",
    ),
    firms: coverage(
      ["retained", "deletion_redacts"],
      "Business history; a deletion clears the identifying fields and keeps the row the append-only history references.",
    ),
    contacts: coverage(
      ["retained", "deletion_redacts"],
      "Business history; a deletion clears the person’s name and title (which carries the LinkedIn URL migration 0018 kept) and keeps the row the append-only history references.",
    ),
    phone_routes: coverage(
      ["deletion_removes"],
      "A normalized personal handle; a deletion removes it and leaves a suppression tombstone.",
    ),
    email_addresses: coverage(
      ["deletion_removes"],
      "A normalized personal handle; a deletion removes it and leaves a suppression tombstone for the same key.",
    ),
    evidence_items: coverage(
      ["swept", "deletion_removes"],
      "Deleted at the provider’s own expiry, and with the firm on deletion.",
    ),
    pipeline_stages: coverage(["operational"], "Workspace configuration."),
    opportunities: coverage(["retained"], "Business history."),
    opportunity_stage_events: coverage(
      ["retained"],
      "Append-only; DELETE revoked from both roles.",
    ),
    record_aliases: coverage(
      ["deletion_removes"],
      "Preserved identifiers of a merged record, which name the prospect.",
    ),
    crm_domain_events: coverage(["retained"], "Append-only; DELETE revoked."),

    // ----------------------------------------------------------- funnel (0022)
    funnel_facts: coverage(
      ["retained", "deletion_redacts"],
      "Business history: counts of what happened, by kind, with ids and no name, address, number or body. Nothing sweeps it, DELETE and TRUNCATE are revoked, and UPDATE exists for one column and one writer — a deletion clears `detail` and keeps the row, whose ids point at rows the same deletion redacted.",
    ),

    // ---------------------------------------------------------------- policy
    state_postures: coverage(
      ["operational"],
      "Callie’s reviewed legal posture.",
    ),
    calling_windows: coverage(["operational"], "Workspace configuration."),
    suppression_finalizations: coverage(
      ["retained"],
      "Append-only marker of the ten-minute window’s winner.",
    ),
    dial_tickets: coverage(
      ["deletion_removes"],
      "A one-use ticket naming the route dialled.",
    ),
    call_logs: coverage(
      ["deletion_removes"],
      "Call history for the deleted firm, including its notes.",
    ),
    callbacks: coverage(
      ["deletion_removes"],
      "A promised call back to the deleted person.",
    ),

    // ----------------------------------------------------------------- today
    today_snapshots: coverage(
      ["operational"],
      "One derived snapshot per workspace business date.",
    ),
    today_items: coverage(
      ["deletion_removes"],
      "Derived work items naming the deleted firm and contact.",
    ),
    today_snoozes: coverage(
      ["deletion_removes"],
      "A snoozed task naming the deleted firm and contact; derived work, removed with them.",
    ),

    // ------------------------------------------------------------------ mail
    gmail_prospecting_authorizations: coverage(
      ["departure_revokes"],
      "Mailbox-scoped authority; disconnected or departed identities cannot send. Restore explicitly revokes.",
    ),
    outreach_fence_authorizations: coverage(
      ["retained"],
      "Coded authorization binding retained with outbound reconciliation evidence; contains no message or recipient text.",
    ),
    outreach_answer_blocks: coverage(
      ["retained"],
      "Workspace product-content version identity; no CRM person identity.",
    ),
    outreach_answer_block_versions: coverage(
      ["retained"],
      "Explicitly approved reusable product/pricing content; not prospect conversation text.",
    ),
    outreach_touch_reservations: coverage(
      ["retained"],
      "Coded dispatch history retained for lifetime and daily limits; carries no message text or contact addresses.",
    ),
    outreach_plans: coverage(
      ["retained", "deletion_stops"],
      "Retains authority IDs for stopped enrollment history; deletion stops the plan and redacts its contact through the existing contact row.",
    ),
    outreach_email_sources: coverage(
      ["deletion_removes"],
      "Source association removed on contact or firm deletion; candidate deletion cascades.",
    ),
    mailboxes: coverage(
      ["departure_revokes"],
      "Disconnected by departure; the row is what the firm’s messages hang off.",
    ),
    mailbox_tokens: coverage(
      ["departure_revokes"],
      "The envelope-encrypted refresh token, deleted outright by departure.",
    ),
    mailbox_watches: coverage(
      ["departure_revokes"],
      "Cancelled when the grant goes.",
    ),
    mailbox_recoveries: coverage(
      ["swept"],
      "Mailbox diagnostics; completed runs go after seven days.",
    ),
    mailbox_accounts: coverage(
      ["retained"],
      "Which Google account a mailbox row was, and when (0027): the salesperson’s own addresses, kept as long as the mailbox row whose messages they name the account of.",
    ),
    gmail_push_notifications: coverage(
      ["swept"],
      "Temporary mailbox material; seven days.",
    ),
    mail_messages: coverage(
      ["swept", "retained", "deletion_removes"],
      "Unmatched metadata goes at thirty days, matched correspondence is business history, and a deletion removes the deleted firm’s.",
    ),
    mail_message_bodies: coverage(
      ["swept", "retained", "deletion_removes"],
      "Follows its message through the cascade.",
    ),
    mail_message_matches: coverage(
      ["swept", "retained", "deletion_removes"],
      "Follows its message through the cascade.",
    ),
    mail_message_classifications: coverage(
      ["swept", "retained", "deletion_removes"],
      "Follows its message through the cascade.",
    ),
    mail_message_effects: coverage(
      ["swept", "retained", "deletion_removes"],
      "Follows its message through the cascade.",
    ),
    template_versions: coverage(
      ["operational"],
      "Template bodies, edited in place since migration 0019 (a send keeps the bytes its fence froze); Callie’s, not a prospect’s.",
    ),

    // -------------------------------------------------------------- sending
    outbound_messages: coverage(
      ["swept", "retained", "deletion_redacts"],
      "A held draft’s subject and body are cleared at thirty days and on deletion; the row never goes, because DELETE is revoked and the fence is what stops a second send.",
    ),
    outbound_message_events: coverage(
      ["retained"],
      "Append-only transition log; UPDATE and DELETE revoked.",
    ),
    sending_domains: coverage(
      ["operational"],
      "Callie’s own domain authentication and ramp posture.",
    ),
    mailbox_send_ramp: coverage(
      ["operational"],
      "A Callie mailbox’s position in the new-domain ramp.",
    ),
    mailbox_send_days: coverage(
      ["operational"],
      "Per-mailbox daily counts; no prospect identity.",
    ),
    mailbox_recovery_epochs: coverage(
      ["operational", "retained"],
      "Mailbox inactivity anchors and reversible recovery credits, without prospect text; retained with ramp/day references through prospect deletion and departure, and restored together by database point-in-time recovery.",
    ),

    // ------------------------------------------------- classification (G7b)
    classifier_settings: coverage(
      ["operational"],
      "Workspace configuration for the reply classifier.",
    ),
    mail_classification_calls: coverage(
      ["retained", "deletion_removes"],
      "Counts, ids and outcomes only — 0011 keeps no prompt, message text or excerpt here — so it is a cost record rather than a copy of correspondence. It cascades with its message, and a deletion removes the firm’s messages.",
    ),
    mail_reply_confirmations: coverage(
      ["retained", "deletion_removes"],
      "A person’s decision about a reply: business history while the firm exists, and removed with the correspondence it is about. Deleted before the messages that would cascade it, because it also references a callback the deletion removes.",
    ),

    // ---------------------------------------------------- settings (G9, 0013)
    workspace_settings: coverage(
      ["operational"],
      "Workspace configuration and its audited history; no prospect identity.",
    ),
    // ------------------------------------------------ release records (g71, 0017)
    release_records: coverage(
      ["operational", "retained"],
      "The rehearsal gate a sending attestation names: image digests and scenario report lines, no prospect or personal data. Append-only; UPDATE and DELETE revoked.",
    ),

    // ------------------------------------------------------- sequences (G8)
    workspace_holiday_calendars: coverage(
      ["operational"],
      "Versioned holiday sets; Callie’s configuration.",
    ),
    sequences: coverage(["operational"], "A named cadence Callie wrote."),
    sequence_versions: coverage(
      ["operational"],
      "A sequence plan’s version; once published only retirement changes the row. Callie’s words, not a prospect’s.",
    ),
    sequence_steps: coverage(
      ["operational"],
      "The steps of a plan, edited in place since migration 0019, published ones included.",
    ),
    sequence_enrollments: coverage(
      ["retained", "deletion_stops", "departure_holds"],
      "Business history of who was worked and how: the row stays, its personal fields living on the contact it names. A deletion stops it with `admin_stop`; a departure holds the ones its member was running.",
    ),
    step_executions: coverage(
      ["retained", "deletion_stops"],
      "What was due, when it moved and how it finished. A deletion cancels the unexecuted ones; the executed history stays, because 11.1 requires it preserved.",
    ),
    step_execution_shifts: coverage(
      ["retained"],
      "Append-only schedule history; UPDATE and DELETE revoked.",
    ),
    sequence_event_cursors: coverage(
      ["operational"],
      "Per-consumer position in the event stream; ids only.",
    ),

    // ------------------------------------------------------------- retention
    retention_runs: coverage(
      ["retained"],
      "The run ledger and the deletion tombstone; DELETE revoked.",
    ),
    deletion_requests: coverage(
      ["retained"],
      "What was previewed and what was committed; DELETE revoked.",
    ),
    departures: coverage(
      ["retained"],
      "What a departure revoked; DELETE revoked.",
    ),

    // ---------------------------------------------------------- research (0023)
    research_settings: coverage(
      ["operational"],
      "The workspace’s research ceilings and model; no prospect data.",
    ),
    provider_ledger: coverage(
      ["operational"],
      "Calls, failures and cents per provider per business date; no prospect identity.",
    ),
    // Authorized-and-not-yet-invoiced cents, one row per paid attempt. A uuid and an
    // amount: it names the run it paid for, never a firm, a person or an address — and it
    // outlives the run deliberately, because what a provider billed is not a prospect
    // record that a deletion may remove.
    provider_reservations: coverage(
      ["operational"],
      "Cents authorized per paid attempt and how each one settled; no prospect identity.",
    ),
    // The four below quote the firm’s own site or name a person at it, so they go with
    // the firm exactly as `call_logs` does, rather than being swept on a horizon.
    research_runs: coverage(
      ["deletion_removes"],
      "One run of one firm; removed with the firm it researched.",
    ),
    firm_facts: coverage(
      ["deletion_removes"],
      "Quotes from the firm’s own pages; removed with the firm.",
    ),
    firm_judgments: coverage(
      ["deletion_removes"],
      "The firm’s current judgment and the contact it points at; removed with the firm.",
    ),
    firm_links: coverage(
      ["deletion_removes"],
      "Pages a person added for this firm; removed with the firm.",
    ),

    // ------------------------------------------ follow-up permissions (0025)
    // Why a firm’s deletion removes these rather than keeping them as history: a
    // permission is a pointer at one person’s call log or one inbound e-mail, both of
    // which a deletion removes, and its foreign keys onto them are what stop the evidence
    // being deleted from under it. A permission whose evidence has gone is exactly the
    // row `followUpPermissionSource` refuses anyway, so keeping it would preserve nothing
    // and block the deletion.
    follow_up_permissions: coverage(
      ["deletion_removes"],
      "Why Callie might write to one person at this firm, and the event it rests on; removed with the firm.",
    ),

    // ------------------------------------------------ call-to-booking (0028)
    // The pipeline's own history: keyed on the opportunity, which a deletion keeps (the
    // firm is redacted, its opportunities stay as business history), and carrying no
    // name, address or number.
    opportunity_values: coverage(
      ["retained"],
      "Monthly value per opportunity, append-only; no prospect identity.",
    ),
    opportunity_stage_pins: coverage(
      ["retained"],
      "Which opportunity a person placed by hand; ids only.",
    ),
    opportunity_stage_evidence: coverage(
      ["retained"],
      "The evidence id an automatic move rested on, append-only; ids only.",
    ),
    stage_rules: coverage(["operational"], "The evidence-to-stage vocabulary."),
    // These three name a firm's call or meeting — the call's recording, the attendee's
    // e-mail — so they go with the firm or the person, as `call_logs` does.
    stage_review_items: coverage(
      ["deletion_removes"],
      "Evidence waiting for a person, naming the firm; removed with the firm.",
    ),
    call_sessions: coverage(
      ["deletion_removes"],
      "One Twilio call attempt and its recording reference; removed with the firm or the person.",
    ),
    meetings: coverage(
      ["deletion_removes"],
      "A Cal.com booking and the attendee’s e-mail; removed with the firm or the person.",
    ),
    mail_message_duplicates: coverage(
      ["swept", "deletion_removes"],
      "A provider message id the pipeline skips; goes with the message it names (ON DELETE CASCADE).",
    ),
    calcom_events: coverage(
      ["deletion_removes"],
      "Delivery digests of a deleted meeting; removed with it. Unmatched ones carry no identity.",
    ),

    // ------------------------------------------------ Cal.com depth (0029, slice M1)
    meeting_booking_uids: coverage(
      ["deletion_removes"],
      "Every Cal.com booking uid a meeting has been; identifiers, not personal data; removed with the meeting (ON DELETE CASCADE).",
    ),

    // ------------------------------------------------ call transcription (0030, slice C2)
    // What the prospect said on a recorded call: personal data, so it goes with the
    // firm or the person, exactly as the session it belongs to does.
    call_transcripts: coverage(
      ["deletion_removes"],
      "The transcript of one recorded call (what each side said); removed with its call session, the firm or the person.",
    ),

    // ------------------------------------------------ after-call summaries (0032, slice C3b)
    // A model's summary of what the prospect said, with quotes of it: personal data, so it
    // goes with the call it summarizes, exactly as the transcript does.
    call_summaries: coverage(
      ["deletion_removes"],
      "The summary, suggested next steps and quoted commitments of one transcribed call; removed with its call session, the firm or the person.",
    ),

    // ------------------------------------------------ post-call analyses (0035, slice 3a)
    // A model's reading of what the prospect said, with quotes of it, and David's edited
    // notes: personal data, so it goes with the call it reads, exactly as the transcript does.
    call_analyses: coverage(
      ["deletion_removes"],
      "Each version of one transcribed call's analysis (the reading, its quotes and proposals, or David's notes); removed with its call session, the firm or the person.",
    ),

    // ------------------------------------------------ call tasks (0036, slice 3a)
    // A promise made on a call, its text often the quote itself: personal data, removed with
    // the firm or the person (it outlives the call's session on purpose: it is David's work).
    call_tasks: coverage(
      ["deletion_removes"],
      "A promise made on a call (its text and quote key), or the overview an agreement left to send; removed with the firm or the person.",
    ),

    // ------------------------------------------------ prepared briefs (0038, lane PB)
    // Text somebody prepared about the firm (it can name the person to ask for) and its
    // source links: removed with the firm. A contact-scoped deletion leaves it, as it leaves
    // the research facts: it carries no contact id.
    firm_prepared_briefs: coverage(
      ["deletion_removes"],
      "A prepared call brief and its source links for one firm; removed with the firm.",
    ),

    // ------------------------------------------------ transcription jobs (0032, slice C3a)
    // Ids, a provider job name and two object keys: what collecting a Transcribe job needs.
    // Kept past a deletion on purpose, so the workflow can still name the call's objects.
    transcription_provider_jobs: coverage(
      ["operational"],
      "One Amazon Transcribe job per attempt and how far collecting it got; ids, a job name and object keys, no prospect identity; outlives a deleted session so its S3 objects can still be named and deleted.",
    ),

    // ------------------------------------------------ demo recordings (0041, lane M4)
    // A file name (which may carry a participant's display name) and a digest of their voice:
    // it goes with the meeting, as the meeting's uids do. The object expires with the bucket.
    meeting_recording_aliases: coverage(
      ["deletion_removes"],
      "Folded recording identities, removed with the surviving recording.",
    ),
    meeting_note_revisions: coverage(
      ["deletion_removes"],
      "Human debriefs and corrections cascade with their meeting.",
    ),
    meeting_recording_setup: coverage(
      ["deletion_removes"],
      "Demo identity and recording setup history cascade with their meeting.",
    ),
    meeting_analyses: coverage(
      ["deletion_removes"],
      "Structured meeting evidence cascades with its meeting.",
    ),
    meeting_tasks: coverage(
      ["deletion_removes"],
      "Meeting promises and evidence cascade with their meeting.",
    ),
    meeting_follow_through: coverage(
      ["deletion_removes"],
      "Meeting follow-through scope and scheduling cascade with their meeting.",
    ),
    meeting_follow_through_drafts: coverage(
      ["deletion_removes"],
      "Personalized recap revisions cascade with their meeting plan.",
    ),
    meeting_analysis_requests: coverage(
      ["deletion_redacts", "retained"],
      "Request identity and spend survive deletion; the database scrubs result content when its meeting link is cleared.",
    ),
    meeting_transcripts: coverage(
      ["deletion_removes"],
      "Demo speech and attribution, removed with the recording and meeting.",
    ),
    meeting_transcription_attempts: coverage(
      ["operational"],
      "Provider job IDs, object keys and reservations, without speech; retains accounting after subject deletion.",
    ),
    meeting_recordings: coverage(
      ["deletion_removes"],
      "One uploaded audio file of a demo: its Zoom file name, size, digest and object key; removed with the meeting (ON DELETE CASCADE); the object expires a day after upload.",
    ),
  });

/** Tables the coverage registry deliberately does not classify. */
export const COVERAGE_EXEMPT_TABLES: readonly string[] = Object.freeze([
  "schema_versions",
]);
