import {lockAskLifecycle} from '../crm/askAnswerLifecycle.ts';
import {redactBackfillMetadataRows} from '../mail/crmBackfillMetadata.ts';
import {
  mailContextPredicate,
  eligibleObservedMailLabelRedactions,
  redactUnsupportedObservedMailLabels,
} from "../mail/crmSources.ts";
import {
  redactBusinessMetadata,
  lockBusinessMetadataAddresses,
} from "../business/acquisition.ts";
import { deleteMeetingOutcomeContent } from "../meetings/outcomeCorrections.ts";
import { lockTodayForFirmChange } from "../today/build.ts";
import { createHash } from "node:crypto";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import { isAdminScope } from "../db/workspaceScope.ts";
import { recordCrmAuditEvent } from "../crm/audit.ts";
import { invalidateSelectedIdentitySources } from "../crm/identityInvalidation.ts";
import { sourceContextPredicate } from "../crm/identityAccess.ts";
import { databaseNow } from "../policy/clock.ts";
import {
  finaliseTranscriptionsOfSessions,
  lockSessionsForDeletion,
} from "../calls/transcription.ts";
import {
  finaliseSummariesOfSessions,
  lockSummariesForDeletion,
} from "../calls/summary.ts";
import {
  finaliseAnalysesOfSessions,
  lockAnalysesForDeletion,
} from "../calls/analysisPaid.ts";
import {
  finaliseSubjectReservations,
  settleAttempt,
} from "../research/reservations.ts";
import { lockMonthlySpend } from "../research/ledger.ts";
import { lockRun } from "../research/runs.ts";
import { recordSuppression } from "../suppression/events.ts";
import { canonicalizeHandle } from "../src/rules/suppressionCanonicalization.ts";
import { deletionTombstoneKeyOf } from "../meetings/attendee.ts";
import { lockSendGateForStopFact } from "../policy/sendGate.ts";
import type { SuppressionJournal } from "../suppression/journal.ts";
import { CALL_ANALYSIS_PENDING_SOURCE } from "@fss/contracts";
import { accept, refuse, type RetentionResult } from "./result.ts";

/**
 * The documented deletion workflow (specification 10.3).
 *
 * > A documented deletion workflow removes ordinary personal and correspondence data
 * > while retaining a minimal normalized suppression tombstone where needed to
 * > prevent renewed contact. Backup copies expire naturally under retention. Every
 * > deletion and export is audited.
 *
 * ## Why deletion is remove *and* redact
 *
 * Five tables in this schema have `DELETE` revoked from both application roles —
 * `audit_events`, `suppression_events`, `opportunity_stage_events`,
 * `crm_domain_events` and `funnel_facts` — and each of them carries foreign
 * keys onto `firms`, `contacts` or `opportunities`. A deletion that removed the firm
 * row would have to remove that history first, and it is not allowed to, and it
 * should not be: section 10.3's first row keeps "firms, contacts, opportunities,
 * stages" as Callie business history, and 5.2 makes the audit trail append-only on
 * purpose.
 *
 * So the workflow does exactly what the sentence asks and no more. *Ordinary
 * personal and correspondence data* is removed: the handles, the messages and their
 * bodies, the call history, the callbacks, the evidence, the derived work items. The
 * rows the append-only history points at stay, with their identifying fields
 * cleared, so the history remains readable and nothing in it names a person. A
 * funnel fact is redacted the same way and for the same reason: the count stays and
 * its `detail` is cleared.
 * See docs/decisions/g14-deletion-is-remove-and-redact.md.
 *
 * ## The tombstone has its own source
 *
 * A tombstone has to be effective against renewed contact, terminal, and never
 * reversible by a salesperson. `effective_suppressions` is the one authoritative
 * view (10.2), so it has to be a row in `suppression_events`.
 *
 * Migration 0014 widens that table's source vocabulary with `deletion_tombstone`,
 * which has all three properties and its own name. The first draft of this lane
 * borrowed `prospect_opt_out` because the vocabulary is closed and cross-lane, and
 * that was wrong: the audit trail would have said a prospect opted out when an admin
 * ran a deletion. See docs/decisions/g14-deletion-tombstone-source.md.
 *
 * Terminal comes from `TERMINAL_SOURCES`, so no ten-minute review hold is opened —
 * there is nothing left to protect, the handles having just been removed.
 * Irreversible by a salesperson comes from `mayCorrectSuppression`, which allows
 * only `salesperson_manual` and therefore refuses this one with
 * `not_salesperson_originated`. Neither is a new rule written for this source; both
 * are existing rules it inherits by being what it is.
 *
 * ## Why a preview, and why a hash
 *
 * "A preview before commit" is the brief's, and a preview is only worth anything if
 * the commit is the thing that was previewed. The hash is over the counts and the
 * handles, recomputed at commit; a world that changed under the admin — a new
 * contact, a new message — makes them disagree and the commit is refused rather than
 * silently deleting more than was approved.
 */

export type DeletionTargetKind = "firm" | "contact";

export type DeletionRefusal =
  | "admin_only"
  | "firm_unknown"
  | "contact_unknown"
  | "request_unknown"
  | "preview_stale"
  | "already_committed"
  | "handle_uncanonical";

export interface DeletionPreview {
  readonly requestId: string;
  readonly targetKind: DeletionTargetKind;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly previewHash: string;
  /** Rows a commit would delete outright, by table. */
  readonly removes: Readonly<Record<string, number>>;
  /** Rows a commit would clear the identifying fields of, by table. */
  readonly redacts: Readonly<Record<string, number>>;
  /**
   * Rows a commit would terminally stop, by table.
   *
   * Its own map rather than a line in `redacts`, because stopping an enrollment is
   * not the same act as clearing a name and an approver should not have to read it
   * as one. Nothing is removed here and nothing is blanked; what changes is whether
   * a worker will ever act on the row again.
   */
  readonly stops: Readonly<Record<string, number>>;
  /** Rows a commit would leave alone, by table, so an approver is told what stays. */
  readonly retains: Readonly<Record<string, number>>;
  /**
   * The normalized handles the commit would suppress. Returned to the admin who is
   * approving it and deliberately never stored: a deletion record that quoted them
   * would keep a copy of what it deleted.
   */
  readonly tombstoneHandles: readonly string[];
}

export interface DeletionOutcome {
  readonly requestId: string;
  readonly removed: Readonly<Record<string, number>>;
  readonly redacted: Readonly<Record<string, number>>;
  readonly stopped: Readonly<Record<string, number>>;
  readonly tombstoneEventIds: readonly string[];
}

/** What a redacted firm or contact is called afterwards. Non-blank, because the CHECK requires it. */
export const REDACTED_NAME = "[deleted]";

interface Scope {
  readonly firmId: string;
  readonly contactId: string | null;
}

/** `contact_id = $2 OR ($2 IS NULL)` as one predicate, so every count uses the same rule. */
const contactPredicate = (column: string, parameter: string): string =>
  `(${parameter}::uuid IS NULL OR ${column} = ${parameter}::uuid)`;

/**
 * Lane R's tables carry a firm and no contact, so a contact-scoped deletion must not
 * touch them: a quote from the firm's careers page is not one person's data, and
 * deleting it because somebody asked for their own record removed would destroy the
 * evidence behind a judgment nobody asked about. A firm-scoped deletion takes them all.
 */
const FIRM_SCOPED_ONLY = "$2::uuid IS NULL";

const CRM_TARGET_PEOPLE = `SELECT b.person_id FROM crm_legacy_contact_people b
  JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id
  WHERE b.workspace_id=$1 AND c.firm_id=$3 AND ${contactPredicate("c.id", "$2")}`;
const CRM_SOURCE_CONTEXT = sourceContextPredicate("s", "x");
// Explicit original context wins over the legacy default. A mixed copy is indivisible.
const CRM_SOURCE_IN_SCOPE = `((s.original_access_closure->'firmIds' ? $3::uuid::text AND (${FIRM_SCOPED_ONLY} OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(s.original_access_closure->'personIds') original_person(id) WHERE original_person.id IN (SELECT person_id::text FROM (${CRM_TARGET_PEOPLE}) target_people)))) OR (${FIRM_SCOPED_ONLY} AND ((s.firm_id IS NOT NULL AND s.firm_id=$3) OR
    EXISTS (SELECT 1 FROM crm_source_relationship_contexts x WHERE ${CRM_SOURCE_CONTEXT} AND x.firm_id=$3))) OR
  EXISTS (SELECT 1 FROM crm_source_relationship_contexts x WHERE ${CRM_SOURCE_CONTEXT}
    AND x.firm_id=$3 AND x.person_id IN (${CRM_TARGET_PEOPLE})) OR
  (s.person_id IS NOT NULL AND s.person_id IN (${CRM_TARGET_PEOPLE}) AND (
    EXISTS (SELECT 1 FROM crm_source_relationship_contexts x WHERE ${CRM_SOURCE_CONTEXT} AND x.firm_id=$3)
    OR NOT EXISTS (SELECT 1 FROM crm_source_relationship_contexts x WHERE ${CRM_SOURCE_CONTEXT}))))`;
const CRM_PERSON_IN_SCOPE = `p.id IN (${CRM_TARGET_PEOPLE}) AND NOT EXISTS (
  SELECT 1 FROM crm_selected_sources s JOIN crm_source_relationship_contexts x ON ${CRM_SOURCE_CONTEXT}
  WHERE s.workspace_id=p.workspace_id AND (s.person_id=p.id OR x.person_id=p.id) AND s.availability='available'
    AND x.firm_id<>$3 AND NOT ${CRM_SOURCE_IN_SCOPE}) AND NOT EXISTS (
  SELECT 1 FROM crm_relationships r JOIN crm_selected_sources s ON s.workspace_id=r.workspace_id AND s.id=r.source_id
  WHERE r.workspace_id=p.workspace_id AND r.person_id=p.id AND r.firm_id<>$3 AND NOT r.source_invalidated
    AND s.availability='available' AND s.revision=r.source_revision AND s.content_hash=r.source_hash
    AND NOT ${CRM_SOURCE_IN_SCOPE})`;
const CRM_SELECTED_SOURCE_IDS = `SELECT s.id FROM crm_selected_sources s
  WHERE s.workspace_id=$1 AND s.availability<>'deleted' AND ${CRM_SOURCE_IN_SCOPE}`;
// Original acquired context and current reviewed context select an indivisible copy.
const CRM_MAIL_MESSAGE_IDS = `SELECT x.mail_message_id AS id FROM mail_message_matches x
  WHERE x.workspace_id=$1 AND x.firm_id=$3 AND ${contactPredicate("x.contact_id", "$2")}
  UNION SELECT s.source_id FROM crm_mail_sources s WHERE s.workspace_id=$1 AND EXISTS(
    SELECT 1 FROM crm_mail_source_contexts cx WHERE cx.workspace_id=s.workspace_id AND cx.source_id=s.source_id
      AND ${mailContextPredicate("s", "cx")} AND cx.firm_id=$3
      AND ($2::uuid IS NULL OR cx.person_id IN (${CRM_TARGET_PEOPLE}) OR EXISTS(
        SELECT 1 FROM mail_message_matches mx WHERE mx.workspace_id=cx.workspace_id
        AND mx.id=cx.operational_match_id AND mx.contact_id=$2)))`;
const CRM_PROGRESS_IN_SCOPE = `r.workspace_id=$1 AND (r.source_id IN (${CRM_MAIL_MESSAGE_IDS})
 OR r.prerequisite_source_id IN (${CRM_MAIL_MESSAGE_IDS})
 OR ($2::uuid IS NULL AND $3=ANY(r.original_firm_ids))
 OR r.original_person_ids && ARRAY(${CRM_TARGET_PEOPLE}))`;
const CRM_PROGRESS_IDS = `SELECT r.id FROM crm_mail_progress_receipts r WHERE ${CRM_PROGRESS_IN_SCOPE}`;
const CRM_COMPLETION_IN_SCOPE = `workspace_id=$1 AND (request_message_id IN (${CRM_MAIL_MESSAGE_IDS}) OR sent_receipt_id IN (${CRM_PROGRESS_IDS}))`;
const CRM_MAIL_CAPTURE_IDS = `SELECT i.id FROM crm_mail_capture_identities i WHERE i.workspace_id=$1
  AND (i.source_id IN (${CRM_MAIL_MESSAGE_IDS}) OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(i.context_snapshot) captured
      WHERE captured->>'firmId'=$3::text AND ($2::uuid IS NULL OR captured->>'contactId'=$2::text)))`;
// Only explicit supported endpoint evidence contributes; metadata never invents firm membership.
const BUSINESS_TARGET_ADDRESSES = `SELECT address FROM email_addresses
  WHERE workspace_id=$1 AND firm_id=$3 AND ${contactPredicate("contact_id", "$2")}
  UNION SELECT e.value AS address FROM crm_identity_endpoints e
  JOIN crm_endpoint_claims c ON c.workspace_id=e.workspace_id AND c.endpoint_id=e.id
  JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id
  WHERE e.workspace_id=$1 AND e.kind='email' AND e.value IS NOT NULL AND NOT c.source_invalidated
    AND s.availability='available' AND s.revision=c.source_revision AND s.content_hash=c.source_hash
    AND ((${FIRM_SCOPED_ONLY} AND c.firm_id=$3) OR
      (c.person_id IN (${CRM_TARGET_PEOPLE}) AND c.source_id IN (${CRM_SELECTED_SOURCE_IDS})))`;
const BUSINESS_METADATA_IN_SCOPE = `b.metadata_availability='available' AND (
  EXISTS(SELECT 1 FROM jsonb_array_elements_text(b.participants) AS participant(address)
    WHERE participant.address IN (${BUSINESS_TARGET_ADDRESSES}))
  OR b.id IN(SELECT conversation_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id IN (${CRM_MAIL_MESSAGE_IDS}))
  OR EXISTS(SELECT 1 FROM crm_mail_capture_identities i JOIN jobs j ON j.workspace_id=i.workspace_id AND j.id=i.job_id
    WHERE i.workspace_id=$1 AND i.id IN (${CRM_MAIL_CAPTURE_IDS}) AND b.mailbox_id=i.mailbox_id
      AND b.account_binding=i.account_binding AND b.id::text=j.payload->>'conversationId'))`;

const IMPORT_METADATA_IN_SCOPE = `x.state<>'deleted' AND (
 EXISTS(SELECT 1 FROM crm_mail_imports i JOIN crm_business_conversations b ON b.workspace_id=i.workspace_id AND b.mailbox_id=i.mailbox_id AND b.owner_user_id=i.owner_user_id AND b.account_binding=i.account_binding AND b.provider_thread_id=x.provider_thread_id WHERE i.workspace_id=x.workspace_id AND i.id=x.import_id AND ${BUSINESS_METADATA_IN_SCOPE})
 OR EXISTS(SELECT 1 FROM crm_mail_imports i JOIN crm_mail_capture_identities c ON c.workspace_id=i.workspace_id AND c.mailbox_id=i.mailbox_id AND c.account_binding=i.account_binding AND c.provider_message_id=x.provider_message_id WHERE i.workspace_id=x.workspace_id AND i.id=x.import_id AND c.id IN (${CRM_MAIL_CAPTURE_IDS})))`;

/** Collect the identity dependency closure before any firm/person/source locks. */
async function lockBusinessMetadataForDeletion(
  context: RepositoryContext,
  scope: Scope,
): Promise<void> {
  const metadataAddresses = (
    await context.db.query<{ address: string }>(
      `${BUSINESS_TARGET_ADDRESSES}`,
      [context.scope.workspaceId, scope.contactId, scope.firmId],
    )
  ).rows.map((value) => value.address);
  await lockBusinessMetadataAddresses(context, metadataAddresses);
  await context.db.query(
    `SELECT b.id FROM crm_business_conversations b WHERE b.workspace_id=$1
    AND ${BUSINESS_METADATA_IN_SCOPE} ORDER BY b.id FOR UPDATE`,
    [context.scope.workspaceId, scope.contactId, scope.firmId],
  );
  await context.db.query(`SELECT x.id FROM crm_mail_import_messages x WHERE x.workspace_id=$1 AND ${IMPORT_METADATA_IN_SCOPE} ORDER BY x.id FOR UPDATE`,[context.scope.workspaceId,scope.contactId,scope.firmId]);
}

async function identityDeletionClosure(
  context: RepositoryContext,
  scope: Scope,
) {
  return (
    await context.db.query<{
      firms: string[];
      people: string[];
      sources: string[];
      selected: string[];
      mailSources: string[];
      mailIdentities: string[];
      mailSelected: string[];
      mailIdentitiesSelected: string[];
      humanAnchors: string[];
      humanVersions: string[];
      humanReviews: string[];
      humanTasks: string[];
      progressReceipts: string[];
      askActions: string[];
      askRequests: string[];
      askWindows: string[];
    }>(
      `
    WITH selected AS (${CRM_SELECTED_SOURCE_IDS}),
    ask_selected AS (${CRM_ASK_REQUEST_IDS}),
    ask_actions_selected AS (${CRM_ASK_ACTION_IDS}),
    progress_selected AS (${CRM_PROGRESS_IDS}),
    human_selected AS (${CRM_HUMAN_ANCHOR_IDS}),
    human_reviews AS (SELECT r.* FROM crm_commitment_reviews r WHERE r.workspace_id=$1 AND ${CRM_COMMITMENT_REVIEW_IN_SCOPE}),
    human_tasks AS (SELECT t.* FROM crm_internal_tasks t WHERE t.workspace_id=$1 AND ${CRM_COMMITMENT_TASK_IN_SCOPE}),
    human_private_contexts AS (
      SELECT cx AS snapshot,a.initial_access_closure AS closure FROM crm_ask_requests a CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.initial_contexts,'[]'::jsonb)) cx WHERE a.workspace_id=$1 AND a.id IN(SELECT id FROM ask_selected)
      UNION ALL SELECT cx,a.original_access_closure FROM crm_ask_actions a CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.initial_contexts,'[]'::jsonb)) cx WHERE a.workspace_id=$1 AND a.id IN(SELECT id FROM ask_actions_selected)
      UNION ALL SELECT context_snapshot,original_access_closure FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id IN(SELECT id FROM ask_selected)
      UNION ALL SELECT initial_context_snapshot AS snapshot,original_access_closure AS closure FROM human_reviews
      UNION ALL SELECT context_snapshot,original_access_closure FROM human_reviews
      UNION ALL SELECT activation_receipt->'initialContextSnapshot',activation_receipt->'originalAccessClosure' FROM human_tasks
      UNION ALL SELECT activation_receipt->'contextSnapshot',activation_receipt->'originalAccessClosure' FROM human_tasks
    ),
    human_private_sources AS (
      SELECT src->>'kind' AS kind,(src->>'sourceId')::uuid AS id FROM crm_ask_requests a CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.scope->'sources','[]'::jsonb)) src WHERE a.workspace_id=$1 AND a.id IN(SELECT id FROM ask_selected)
      UNION SELECT src->>'kind',(src->>'sourceId')::uuid FROM crm_ask_actions a CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.input_scope->'sources','[]'::jsonb)) src WHERE a.workspace_id=$1 AND a.id IN(SELECT id FROM ask_actions_selected)
      UNION SELECT target->'source'->>'kind' AS kind,(target->'source'->>'sourceId')::uuid AS id FROM human_reviews
      UNION SELECT activation_receipt->>'sourceKind',(activation_receipt->>'sourceId')::uuid FROM human_tasks
    ),
    human_groups AS (SELECT DISTINCT conflict_id FROM crm_claim_conflict_members WHERE workspace_id=$1 AND anchor_id IN(SELECT id FROM human_selected)),
    human_anchors AS (
      SELECT a.* FROM crm_claim_review_anchors a WHERE a.workspace_id=$1 AND (a.id IN(SELECT id FROM human_selected)
        OR a.id IN(SELECT anchor_id FROM human_reviews)
        OR a.id IN(SELECT (activation_receipt->>'anchorId')::uuid FROM human_tasks)
        OR a.id IN(SELECT anchor_id FROM crm_claim_conflict_members WHERE workspace_id=$1 AND conflict_id IN(SELECT conflict_id FROM human_groups)))
    ),
    mail_selected AS (${CRM_MAIL_MESSAGE_IDS}),
    mail_locked AS (SELECT id FROM mail_selected UNION SELECT source_id FROM human_anchors WHERE source_kind='mail' UNION SELECT id FROM human_private_sources WHERE kind='mail'),
    mail_identities AS (${CRM_MAIL_CAPTURE_IDS} UNION SELECT capture_identity_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id IN(SELECT id FROM mail_locked)),
    affected_people AS (
      ${CRM_TARGET_PEOPLE}
      UNION SELECT captured.id::uuid FROM human_private_contexts c CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c.closure->'personIds','[]'::jsonb)) captured(id)
      UNION SELECT (snapshot->>'personId')::uuid FROM human_private_contexts WHERE snapshot->>'personId' IS NOT NULL
      UNION SELECT (captured->>'personId')::uuid FROM human_private_contexts c CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.snapshot->'mailContexts','[]'::jsonb)) captured WHERE captured->>'personId' IS NOT NULL
      UNION SELECT unnest(original_person_ids) FROM crm_mail_progress_receipts WHERE workspace_id=$1 AND id IN(SELECT id FROM progress_selected)
      UNION SELECT captured.id::uuid FROM human_anchors a CROSS JOIN LATERAL jsonb_array_elements_text(a.original_access_closure->'personIds') captured(id)
      UNION SELECT (context_snapshot->>'personId')::uuid FROM human_anchors WHERE context_snapshot->>'personId' IS NOT NULL
      UNION SELECT (captured->>'personId')::uuid FROM human_anchors a CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.context_snapshot->'mailContexts','[]'::jsonb)) captured WHERE captured->>'personId' IS NOT NULL
      UNION SELECT person_id FROM crm_selected_sources WHERE workspace_id=$1 AND id IN(SELECT source_id FROM human_anchors WHERE source_kind='selected_note') AND person_id IS NOT NULL
      UNION SELECT person_id FROM crm_mail_source_contexts WHERE workspace_id=$1 AND source_id IN(SELECT id FROM mail_locked) AND person_id IS NOT NULL
      UNION SELECT person_id FROM crm_selected_sources WHERE workspace_id=$1 AND id IN (SELECT id FROM selected) AND person_id IS NOT NULL
      UNION SELECT person_id FROM crm_relationships WHERE workspace_id=$1 AND source_id IN (SELECT id FROM selected)
      UNION SELECT person_id FROM crm_endpoint_claims WHERE workspace_id=$1 AND source_id IN (SELECT id FROM selected) AND person_id IS NOT NULL
      UNION SELECT person_id FROM crm_source_relationship_contexts WHERE workspace_id=$1 AND (
        source_id IN (SELECT id FROM selected) OR relationship_id IN (
          SELECT id FROM crm_relationships WHERE workspace_id=$1 AND source_id IN (SELECT id FROM selected)))
    ),
    sources AS (
      SELECT id FROM crm_selected_sources WHERE workspace_id=$1 AND (id IN (SELECT id FROM selected)
        OR id IN(SELECT source_id FROM human_anchors WHERE source_kind='selected_note')
        OR id IN(SELECT id FROM human_private_sources WHERE kind='selected_note')
        OR person_id IN (SELECT person_id FROM affected_people)
        OR id IN (SELECT source_id FROM crm_relationships WHERE workspace_id=$1 AND person_id IN (SELECT person_id FROM affected_people))
        OR id IN (SELECT source_id FROM crm_endpoint_claims WHERE workspace_id=$1 AND person_id IN (SELECT person_id FROM affected_people))
        OR id IN (SELECT source_id FROM crm_source_relationship_contexts WHERE workspace_id=$1 AND person_id IN (SELECT person_id FROM affected_people)))
    ),
    firms_to_lock AS (
      SELECT $3::uuid AS id
      UNION SELECT captured.id::uuid FROM human_private_contexts c CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c.closure->'firmIds','[]'::jsonb)) captured(id)
      UNION SELECT captured.id::uuid FROM human_private_contexts c CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c.snapshot->'firmIds','[]'::jsonb)) captured(id)
      UNION SELECT (captured->>'firmId')::uuid FROM human_private_contexts c CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.snapshot->'mailContexts','[]'::jsonb)) captured WHERE captured->>'firmId' IS NOT NULL
      UNION SELECT unnest(original_firm_ids) FROM crm_mail_progress_receipts WHERE workspace_id=$1 AND id IN(SELECT id FROM progress_selected)
      UNION SELECT captured.id::uuid FROM human_anchors a CROSS JOIN LATERAL jsonb_array_elements_text(a.original_access_closure->'firmIds') captured(id)
      UNION SELECT captured.id::uuid FROM human_anchors a CROSS JOIN LATERAL jsonb_array_elements_text(a.context_snapshot->'firmIds') captured(id)
      UNION SELECT (captured->>'firmId')::uuid FROM human_anchors a CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.context_snapshot->'mailContexts','[]'::jsonb)) captured WHERE captured->>'firmId' IS NOT NULL
      UNION SELECT s.firm_id FROM call_sessions s WHERE s.workspace_id=$1 AND s.id IN(SELECT source_id FROM human_anchors WHERE source_kind='call_transcript')
      UNION SELECT m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id IN(SELECT source_id FROM human_anchors WHERE source_kind='meeting_transcript') AND m.firm_id IS NOT NULL
      UNION SELECT t.firm_id FROM crm_claim_work_dependencies d JOIN call_tasks t ON t.workspace_id=d.workspace_id AND t.id=d.work_id WHERE d.workspace_id=$1 AND d.work_kind='call_task' AND d.anchor_id IN(SELECT id FROM human_anchors)
      UNION SELECT t.firm_id FROM crm_claim_work_dependencies d JOIN meeting_tasks t ON t.workspace_id=d.workspace_id AND t.id=d.work_id WHERE d.workspace_id=$1 AND d.work_kind='meeting_task' AND d.anchor_id IN(SELECT id FROM human_anchors)
      UNION SELECT cx.firm_id FROM crm_mail_source_contexts cx WHERE cx.workspace_id=$1 AND cx.source_id IN(SELECT id FROM mail_locked) AND cx.firm_id IS NOT NULL
      UNION SELECT (captured->>'firmId')::uuid FROM crm_mail_capture_identities i CROSS JOIN LATERAL jsonb_array_elements(i.context_snapshot) captured WHERE i.workspace_id=$1 AND i.id IN(SELECT id FROM mail_identities) AND captured->>'firmId' IS NOT NULL
      UNION SELECT m.firm_id FROM meetings m WHERE m.workspace_id=$1 AND ${MEETING_IN_SCOPE} AND m.firm_id IS NOT NULL
      UNION SELECT c.firm_id FROM crm_legacy_contact_people b JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id
        WHERE b.workspace_id=$1 AND b.person_id IN (SELECT person_id FROM affected_people)
      UNION SELECT firm_id FROM crm_selected_sources WHERE workspace_id=$1 AND id IN (SELECT id FROM sources) AND firm_id IS NOT NULL
      UNION SELECT original_firm.id::uuid FROM crm_selected_sources s CROSS JOIN LATERAL jsonb_array_elements_text(s.original_access_closure->'firmIds') original_firm(id) WHERE s.workspace_id=$1 AND s.id IN(SELECT id FROM sources)
      UNION SELECT firm_id FROM crm_relationships WHERE workspace_id=$1 AND person_id IN (SELECT person_id FROM affected_people)
      UNION SELECT firm_id FROM crm_endpoint_claims WHERE workspace_id=$1 AND source_id IN (SELECT id FROM sources) AND firm_id IS NOT NULL
      UNION SELECT firm_id FROM crm_source_relationship_contexts WHERE workspace_id=$1 AND source_id IN (SELECT id FROM sources)
    )
    SELECT ARRAY(SELECT id::text FROM firms_to_lock ORDER BY id) AS firms,
      ARRAY(SELECT person_id::text FROM affected_people ORDER BY person_id) AS people,
      ARRAY(SELECT id::text FROM sources ORDER BY id) AS sources,
      ARRAY(SELECT id::text FROM selected ORDER BY id) AS selected,
      ARRAY(SELECT id::text FROM mail_locked ORDER BY id) AS "mailSources",
      ARRAY(SELECT id::text FROM mail_selected ORDER BY id) AS "mailSelected",
      ARRAY(SELECT id::text FROM (${CRM_MAIL_CAPTURE_IDS}) selected_identities ORDER BY id) AS "mailIdentitiesSelected",
      ARRAY(SELECT id::text FROM mail_identities ORDER BY id) AS "mailIdentities",
      ARRAY(SELECT id::text FROM ask_actions_selected ORDER BY id) AS "askActions",
      ARRAY(SELECT id::text FROM ask_selected ORDER BY id) AS "askRequests",
      ARRAY(SELECT id::text FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id IN(SELECT id FROM ask_selected) ORDER BY id) AS "askWindows",
      ARRAY(SELECT id::text FROM progress_selected ORDER BY id) AS "progressReceipts",
      ARRAY(SELECT id::text FROM human_anchors ORDER BY id) AS "humanAnchors",
      ARRAY(SELECT id::text FROM human_reviews ORDER BY id) AS "humanReviews",
      ARRAY(SELECT id::text FROM human_tasks ORDER BY id) AS "humanTasks",
      ARRAY(SELECT concat(id::text,':',source_revision,':',source_hash,':',context_hash,':',original_access_closure::text,':',current_decision_revision,':',availability) FROM human_anchors ORDER BY id) ||
       ARRAY(SELECT concat(id::text,':',current_revision) FROM crm_claim_conflicts WHERE workspace_id=$1 AND id IN(SELECT conflict_id FROM human_groups) ORDER BY id) || ARRAY(SELECT concat(id::text,':',revision,':',projection_version,':',state,':',initial_context_snapshot::text,':',context_snapshot::text,':',original_access_closure::text,':',activation_key) FROM human_reviews ORDER BY id) || ARRAY(SELECT concat(t.id::text,':',t.version,':',t.review_id::text,':',t.activation_receipt::text) FROM human_tasks t ORDER BY t.id) AS "humanVersions"`,
      [context.scope.workspaceId, scope.contactId, scope.firmId],
    )
  ).rows[0];
}

/**
 * The meetings a deletion takes, as a predicate over `m` (call-to-booking 0028, review
 * fold 1, finding 10): those linked to the target, **and** every meeting in the
 * workspace whose attendee is one of the target's own addresses — an unmatched booking
 * has no firm or contact, and a domain-matched one has no contact, so the links alone
 * would leave the person's e-mail behind. `meetings.attendee_email` and
 * `email_addresses.address` are both stored lower-case. Evaluated while the addresses
 * still exist: the meetings go before the routes.
 */
const MEETING_IN_SCOPE = `(
  (m.firm_id = $3 AND ${contactPredicate("m.contact_id", "$2")})
  OR m.attendee_email IN (
    SELECT a.address FROM email_addresses a
     WHERE a.workspace_id = $1 AND a.firm_id = $3 AND ${contactPredicate("a.contact_id", "$2")}))`;

/**
 * The review items opened for one of those meetings, which name no firm when unmatched:
 * a booking's own (`meeting.booked`, keyed by its id), and an attendee conflict between
 * meetings (`meeting.attendee_conflict`, slice M1 review folds 3 and 4) when **any** of
 * its members is taken — found by the complete membership in `detail.meetingIds`, every
 * id comma-separated, never by its hashed key.
 */
const CRM_HUMAN_ANCHOR_IN_SCOPE = `(
 (a.original_access_closure->'firmIds' ? $3::uuid::text AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.original_access_closure->'personIds') original_person(id) WHERE original_person.id IN(SELECT person_id::text FROM (${CRM_TARGET_PEOPLE}) target_people)))) OR
 (($2::uuid IS NULL OR a.context_snapshot->>'personId' IN (SELECT person_id::text FROM (${CRM_TARGET_PEOPLE}) target_people))
   AND a.context_snapshot->'firmIds' ? $3::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.context_snapshot->'mailContexts','[]'::jsonb)) cx
   WHERE cx->>'firmId'=$3::text AND ($2::uuid IS NULL OR cx->>'personId' IN(SELECT person_id::text FROM (${CRM_TARGET_PEOPLE}) target_people)))
 OR (a.source_kind='selected_note' AND a.source_id IN (${CRM_SELECTED_SOURCE_IDS}))
 OR (a.source_kind='mail' AND a.source_id IN (${CRM_MAIL_MESSAGE_IDS}))
 OR (a.source_kind='call_transcript' AND a.source_id IN(SELECT id FROM call_sessions WHERE workspace_id=$1 AND firm_id=$3 AND ${contactPredicate("contact_id", "$2")}))
 OR (a.source_kind='meeting_transcript' AND a.source_id IN(SELECT t.id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND ${MEETING_IN_SCOPE}))
)`;
const CRM_HUMAN_ANCHOR_IDS = `SELECT a.id FROM crm_claim_review_anchors a WHERE a.workspace_id=$1 AND ${CRM_HUMAN_ANCHOR_IN_SCOPE}`;
/** A commitment keeps both its original attestation and explicitly reviewed current semantics. */
function commitmentAuthorityInScope(snapshot:string,closure:string){
 return `(
  (${closure}->'firmIds' ? $3::uuid::text AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(${closure}->'personIds','[]'::jsonb)) original_person(id) WHERE original_person.id IN(SELECT person_id::text FROM (${CRM_TARGET_PEOPLE}) target_people))))
  OR (($2::uuid IS NULL OR ${snapshot}->>'personId' IN(SELECT person_id::text FROM (${CRM_TARGET_PEOPLE}) target_people)) AND ${snapshot}->'firmIds' ? $3::uuid::text)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(${snapshot}->'mailContexts','[]'::jsonb)) cx WHERE cx->>'firmId'=$3::uuid::text AND ($2::uuid IS NULL OR cx->>'personId' IN(SELECT person_id::text FROM (${CRM_TARGET_PEOPLE}) target_people)))
 )`;
}
const CRM_ASK_REQUEST_IN_SCOPE=`(a.state<>'deleted' AND (
 ${commitmentAuthorityInScope("'{}'::jsonb",'a.initial_access_closure')}
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.initial_contexts,'[]'::jsonb)) cx WHERE ${commitmentAuthorityInScope('cx','a.initial_access_closure')})
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.scope->'sources','[]'::jsonb)) src WHERE
  (src->>'kind'='selected_note' AND (src->>'sourceId')::uuid IN(${CRM_SELECTED_SOURCE_IDS}))
  OR (src->>'kind'='mail' AND (src->>'sourceId')::uuid IN(${CRM_MAIL_MESSAGE_IDS})))
))`;
const CRM_ASK_REQUEST_IDS=`SELECT a.id FROM crm_ask_requests a WHERE a.workspace_id=$1 AND ${CRM_ASK_REQUEST_IN_SCOPE}`;
const CRM_ASK_ACTION_IN_SCOPE=`(a.private_state='available' AND (
 ${commitmentAuthorityInScope("'{}'::jsonb",'a.original_access_closure')}
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.initial_contexts,'[]'::jsonb)) cx WHERE ${commitmentAuthorityInScope('cx','a.original_access_closure')})
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.input_scope->'sources','[]'::jsonb)) src WHERE
  (src->>'kind'='selected_note' AND (src->>'sourceId')::uuid IN(${CRM_SELECTED_SOURCE_IDS}))
  OR (src->>'kind'='mail' AND (src->>'sourceId')::uuid IN(${CRM_MAIL_MESSAGE_IDS})))
))`;
const CRM_ASK_ACTION_IDS=`SELECT a.id FROM crm_ask_actions a WHERE a.workspace_id=$1 AND ${CRM_ASK_ACTION_IN_SCOPE}`;
const CRM_COMMITMENT_REVIEW_IN_SCOPE=`(r.state<>'redacted' AND (r.anchor_id IN(${CRM_HUMAN_ANCHOR_IDS}) OR ${commitmentAuthorityInScope('r.initial_context_snapshot','r.original_access_closure')} OR ${commitmentAuthorityInScope('r.context_snapshot','r.original_access_closure')}))`;
const CRM_COMMITMENT_TASK_IN_SCOPE=`(t.activation_receipt IS NOT NULL AND (
 (t.activation_receipt->>'anchorId')::uuid IN(${CRM_HUMAN_ANCHOR_IDS})
 OR EXISTS(SELECT 1 FROM crm_commitment_reviews r WHERE r.workspace_id=t.workspace_id AND r.id=t.review_id AND ${CRM_COMMITMENT_REVIEW_IN_SCOPE})
 OR ${commitmentAuthorityInScope("(t.activation_receipt->'initialContextSnapshot')","(t.activation_receipt->'originalAccessClosure')")}
 OR ${commitmentAuthorityInScope("(t.activation_receipt->'contextSnapshot')","(t.activation_receipt->'originalAccessClosure')")}
))`;
const CRM_HUMAN_CONFLICT_IN_SCOPE = `EXISTS(SELECT 1 FROM crm_claim_conflict_members members WHERE members.workspace_id=r.workspace_id AND members.conflict_id=r.conflict_id AND members.anchor_id IN (${CRM_HUMAN_ANCHOR_IDS}))`;

const MEETING_REVIEW_IN_SCOPE = `((evidence_kind = 'meeting.booked' AND evidence_id IN (
  SELECT m.id::text FROM meetings m WHERE m.workspace_id = $1 AND ${MEETING_IN_SCOPE}))
  OR (evidence_kind = 'meeting.attendee_conflict' AND EXISTS (
  SELECT 1 FROM meetings m WHERE m.workspace_id = $1 AND ${MEETING_IN_SCOPE}
     AND m.id::text = ANY (string_to_array(stage_review_items.detail ->> 'meetingIds', ',')))))`;

/**
 * The same rule for G7b's confirmations, which carry a firm but no contact.
 *
 * A confirmation belongs to a message, and which contact a message is about is the
 * match row's answer rather than the confirmation's. A firm deletion takes them all;
 * a contact deletion takes the ones whose message matched that contact. The alias
 * `c` is the caller's to supply, and both uses below do.
 */
const CONFIRMATION_IN_SCOPE = `($2::uuid IS NULL OR EXISTS (
      SELECT 1 FROM mail_message_matches x
       WHERE x.workspace_id = c.workspace_id AND x.mail_message_id = c.mail_message_id
         AND x.contact_id = $2::uuid))`;

async function countOf(
  context: RepositoryContext,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const { rows } = await context.db.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? "0");
}

/**
 * Everything a commit would touch, counted.
 *
 * A firm deletion has `contactId === null` and takes the firm's whole set; a contact
 * deletion narrows every table that has a `contact_id` and leaves the firm-level
 * rows — a receptionist's number is not the deleted person's handle.
 */
async function measure(
  context: RepositoryContext,
  scope: Scope,
): Promise<{
  readonly removes: Record<string, number>;
  readonly redacts: Record<string, number>;
  readonly stops: Record<string, number>;
  readonly retains: Record<string, number>;
  readonly handles: string[];
  readonly identityVersions: readonly {
    kind: string;
    id: string;
    revision: number;
    hash: string | null;
    state: string;
  }[];
  /** Meeting attendees the canonicalizer refuses, tombstoned under their fallback key. */
  readonly attendeeKeys: string[];
}> {
  const workspace = context.scope.workspaceId;
  const firm = scope.firmId;
  const contact = scope.contactId;
  const byContact = [workspace, contact, firm] as const;

  const removes: Record<string, number> = {
    crm_ask_request_windows:await countOf(context,`SELECT count(*) AS count FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id IN(${CRM_ASK_REQUEST_IDS})`,byContact),
    crm_mail_progress_receipts:await countOf(context,`SELECT count(*) AS count FROM crm_mail_progress_receipts r WHERE ${CRM_PROGRESS_IN_SCOPE}`,byContact),
    email_addresses: await countOf(
      context,
      `SELECT count(*) AS count FROM email_addresses
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    phone_routes: await countOf(
      context,
      `SELECT count(*) AS count FROM phone_routes
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    mail_messages: await countOf(
      context,
      `SELECT count(*) AS count FROM mail_messages WHERE workspace_id=$1 AND id IN (${CRM_MAIL_MESSAGE_IDS})`,
      byContact,
    ),
    mail_message_bodies: await countOf(
      context,
      `SELECT count(*) AS count FROM mail_message_bodies WHERE workspace_id=$1 AND mail_message_id IN (${CRM_MAIL_MESSAGE_IDS})`,
      byContact,
    ),
    crm_mail_sources: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_mail_sources WHERE workspace_id=$1 AND source_id IN (${CRM_MAIL_MESSAGE_IDS})`,
      byContact,
    ),
    crm_mail_source_contexts: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_mail_source_contexts WHERE workspace_id=$1 AND source_id IN (${CRM_MAIL_MESSAGE_IDS})`,
      byContact,
    ),
    evidence_items: await countOf(
      context,
      `SELECT count(*) AS count FROM evidence_items
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    // Lane R's four. They carry no `contact_id`: a fact is about the firm, not about
    // one person at it, so a contact-scoped deletion leaves them and a firm-scoped one
    // takes them all. `FIRM_SCOPED_ONLY` is that rule, written once.
    firm_judgments: await countOf(
      context,
      `SELECT count(*) AS count FROM firm_judgments
        WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
      byContact,
    ),
    firm_facts: await countOf(
      context,
      `SELECT count(*) AS count FROM firm_facts
        WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
      byContact,
    ),
    research_runs: await countOf(
      context,
      `SELECT count(*) AS count FROM research_runs
        WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
      byContact,
    ),
    // Lane PB (0038): one prepared brief per firm, about the firm; firm-scoped only.
    firm_prepared_briefs: await countOf(
      context,
      `SELECT count(*) AS count FROM firm_prepared_briefs
        WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
      byContact,
    ),
    firm_links: await countOf(
      context,
      `SELECT count(*) AS count FROM firm_links
        WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
      byContact,
    ),
    call_logs: await countOf(
      context,
      `SELECT count(*) AS count FROM call_logs
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    // Migration 0025. Previewed as well as removed, because the preview is what a
    // person approves and "one permission to write to this person" is exactly the kind
    // of row somebody would want to see named before it goes.
    human_reply_send_intents: await countOf(
      context,
      `SELECT count(*) AS count FROM human_reply_send_intents i JOIN outbound_messages o
       ON o.workspace_id=i.workspace_id AND o.id=i.outbound_message_id
       WHERE o.workspace_id=$1 AND o.firm_id=$3 AND ${contactPredicate("o.contact_id", "$2")}`,
      byContact,
    ),
    outreach_reply_deliveries: await countOf(
      context,
      `SELECT count(*) AS count FROM outreach_reply_deliveries d JOIN outreach_plans p ON p.workspace_id=d.workspace_id
       JOIN outreach_reply_requests r ON r.workspace_id=d.workspace_id AND r.id=d.request_id AND r.plan_id=p.id
       WHERE p.workspace_id=$1 AND p.firm_id=$3 AND ${contactPredicate("p.contact_id", "$2")}`,
      byContact,
    ),
    follow_up_permissions: await countOf(
      context,
      `SELECT count(*) AS count FROM follow_up_permissions
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    callbacks: await countOf(
      context,
      `SELECT count(*) AS count FROM callbacks
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    dial_tickets: await countOf(
      context,
      `SELECT count(*) AS count FROM dial_tickets
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    today_items: await countOf(
      context,
      `SELECT count(*) AS count FROM today_items
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    today_snoozes: await countOf(
      context,
      `SELECT count(*) AS count FROM today_snoozes
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    record_aliases: await countOf(
      context,
      `SELECT count(*) AS count FROM record_aliases
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    // Migration 0028: the Twilio sessions (a recording reference), the Cal.com meetings
    // (the attendee's e-mail) and their delivery digests, and the review items that name
    // the firm.
    call_sessions: await countOf(
      context,
      `SELECT count(*) AS count FROM call_sessions
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    // Slice C2 (0030): a call's transcript is what the prospect said; it goes with the
    // session (and would cascade with it), counted in its own right.
    call_transcripts: await countOf(
      context,
      `SELECT count(*) AS count FROM call_transcripts t
         JOIN call_sessions s ON s.workspace_id = t.workspace_id AND s.id = t.call_session_id
        WHERE t.workspace_id = $1 AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}`,
      byContact,
    ),
    // Slice 3a (0035): a call's analysis versions quote the prospect; counted in their own right.
    call_analyses: await countOf(
      context,
      `SELECT count(*) AS count FROM call_analyses a
         JOIN call_sessions s ON s.workspace_id = a.workspace_id AND s.id = a.call_session_id
        WHERE a.workspace_id = $1 AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}`,
      byContact,
    ),
    // Slice C3b (0032): a call's summary quotes the prospect; counted in its own right too.
    call_summaries: await countOf(
      context,
      `SELECT count(*) AS count FROM call_summaries x
         JOIN call_sessions s ON s.workspace_id = x.workspace_id AND s.id = x.call_session_id
        WHERE x.workspace_id = $1 AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}`,
      byContact,
    ),
    // Slice 3a (0036): a promise made on a call, quoting it; it outlives its session, so it
    // is matched by its own firm and contact.
    call_tasks: await countOf(
      context,
      `SELECT count(*) AS count FROM call_tasks
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    meetings: await countOf(
      context,
      `SELECT count(*) AS count FROM meetings m WHERE m.workspace_id = $1 AND ${MEETING_IN_SCOPE}`,
      byContact,
    ),
    calcom_events: await countOf(
      context,
      `SELECT count(*) AS count FROM calcom_events e
         JOIN meetings m ON m.workspace_id = e.workspace_id AND m.id = e.meeting_id
        WHERE e.workspace_id = $1 AND ${MEETING_IN_SCOPE}`,
      byContact,
    ),
    stage_review_items: await countOf(
      context,
      `SELECT count(*) AS count FROM stage_review_items
        WHERE workspace_id = $1 AND ((firm_id = $3 AND ${FIRM_SCOPED_ONLY}) OR ${MEETING_REVIEW_IN_SCOPE})`,
      byContact,
    ),
    // G7b. A confirmation would cascade with its message anyway, but it is counted
    // and deleted in its own right because it also references `callbacks`, which
    // this workflow removes: a survivor would refuse that delete.
    mail_reply_confirmations: await countOf(
      context,
      `SELECT count(*) AS count FROM mail_reply_confirmations c
        WHERE c.workspace_id = $1 AND c.firm_id = $3 AND ${CONFIRMATION_IN_SCOPE}`,
      byContact,
    ),
  };

  const redacts: Record<string, number> = {
    crm_commitment_reviews: await countOf(context,`SELECT count(*) AS count FROM crm_commitment_reviews r WHERE r.workspace_id=$1 AND ${CRM_COMMITMENT_REVIEW_IN_SCOPE}`,byContact),
    crm_internal_tasks: await countOf(context,`SELECT count(*) AS count FROM crm_internal_tasks t WHERE t.workspace_id=$1 AND ${CRM_COMMITMENT_TASK_IN_SCOPE}`,byContact),
    crm_mail_reply_resolutions:await countOf(context,`SELECT count(*) AS count FROM crm_mail_reply_resolutions WHERE ${CRM_COMPLETION_IN_SCOPE} AND (request_provider_at IS NOT NULL OR sent_receipt_id IS NOT NULL)`,byContact),
    crm_selected_file_receipts: await countOf(context,`SELECT count(*) AS count FROM crm_selected_file_receipts f WHERE f.workspace_id=$1 AND f.source_id IN (${CRM_SELECTED_SOURCE_IDS}) AND (f.file_name IS NOT NULL OR f.file_hash IS NOT NULL OR f.source_content_hash IS NOT NULL OR f.byte_length IS NOT NULL OR f.format IS NOT NULL OR f.origin IS NOT NULL OR f.parser_version IS NOT NULL)`,byContact),
    crm_claim_review_anchors: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_claim_review_anchors a WHERE a.workspace_id=$1 AND ${CRM_HUMAN_ANCHOR_IN_SCOPE} AND (a.availability<>'deleted' OR a.original_event_at IS NOT NULL OR a.original_observed_at IS NOT NULL)`,
      byContact,
    ),
    crm_claim_decision_revisions: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_claim_decision_revisions d WHERE d.workspace_id=$1 AND d.anchor_id IN (${CRM_HUMAN_ANCHOR_IDS}) AND (d.corrected_interpretation IS NOT NULL OR d.rationale IS NOT NULL OR d.redacted_at IS NULL)`,
      byContact,
    ),
    crm_claim_conflict_revisions: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_claim_conflict_revisions r WHERE r.workspace_id=$1 AND ${CRM_HUMAN_CONFLICT_IN_SCOPE} AND (r.rationale IS NOT NULL OR r.redacted_at IS NULL)`,
      byContact,
    ),
    opportunities:
      scope.contactId === null
        ? await countOf(
            context,
            "SELECT count(*) AS count FROM opportunities WHERE workspace_id=$1 AND firm_id=$2 AND display_name IS NOT NULL",
            [workspace, firm],
          )
        : 0,
    crm_selected_imports: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_selected_imports m WHERE m.workspace_id=$1 AND m.source_id IN (${CRM_SELECTED_SOURCE_IDS}) AND (m.label IS NOT NULL OR m.participants IS NOT NULL OR m.attachments IS NOT NULL OR m.direction IS NOT NULL OR m.attribution IS NOT NULL OR m.date_provenance IS NOT NULL)`,
      byContact,
    ),

    crm_identity_endpoints: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_identity_endpoints e WHERE e.workspace_id=$1 AND e.value IS NOT NULL
       AND e.id IN (SELECT endpoint_id FROM crm_endpoint_claims WHERE workspace_id=$1 AND source_id IN (${CRM_SELECTED_SOURCE_IDS}))
       AND NOT EXISTS (SELECT 1 FROM crm_endpoint_claims c JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id
         WHERE c.workspace_id=e.workspace_id AND c.endpoint_id=e.id AND NOT c.source_invalidated
           AND s.availability='available' AND s.revision=c.source_revision AND s.content_hash=c.source_hash
           AND s.id NOT IN (${CRM_SELECTED_SOURCE_IDS}))`,
      byContact,
    ),
    crm_mail_import_messages: await countOf(context,`SELECT count(*) AS count FROM crm_mail_import_messages x WHERE x.workspace_id=$1 AND ${IMPORT_METADATA_IN_SCOPE}`,byContact),
    crm_business_conversations: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_business_conversations b WHERE b.workspace_id=$1 AND ${BUSINESS_METADATA_IN_SCOPE}`,
      byContact,
    ),
    crm_people:
      (await countOf(
        context,
        `SELECT count(*) AS count FROM crm_people p
       WHERE p.workspace_id=$1 AND ${CRM_PERSON_IN_SCOPE} AND p.full_name <> $4`,
        [...byContact, REDACTED_NAME],
      )) +
      (
        await eligibleObservedMailLabelRedactions(
          context,
          (
            await context.db.query<{ id: string }>(
              CRM_MAIL_MESSAGE_IDS,
              byContact,
            )
          ).rows.map((row) => row.id),
        )
      ).length,
    crm_ask_actions:await countOf(context,`SELECT count(*) AS count FROM crm_ask_actions a WHERE a.workspace_id=$1 AND ${CRM_ASK_ACTION_IN_SCOPE}`,byContact),
    crm_ask_requests:await countOf(context,`SELECT count(*) AS count FROM crm_ask_requests a WHERE a.workspace_id=$1 AND ${CRM_ASK_REQUEST_IN_SCOPE}`,byContact),
    crm_selected_sources: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_selected_sources s
       WHERE s.workspace_id=$1 AND ${CRM_SOURCE_IN_SCOPE} AND s.availability <> 'deleted'`,
      byContact,
    ),
    // Outbound fences the trigger still lets us touch: `prepared` and `held`, which
    // are the ones with no attempt token and therefore provably unsent. A fence at or
    // past `dispatching` is a message that may have left, `DELETE` on the table is
    // revoked, and migration 0010's trigger refuses to change its envelope — so a
    // deletion cannot reach it and should not: it is correspondence.
    outbound_messages: await countOf(
      context,
      `SELECT count(*) AS count FROM outbound_messages
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
          AND attempt_token IS NULL AND subject <> $4`,
      [...byContact, REDACTED_NAME],
    ),
    contacts: await countOf(
      context,
      `SELECT count(*) AS count FROM contacts
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("id", "$2")}`,
      byContact,
    ),
    // The funnel (0022). A fact is a count, so the count stays: what a deletion
    // clears is `detail`, the small object of flags a slice recorded beside it. The
    // row cannot go — DELETE is revoked — and it should not: the ids in it point at
    // rows this same deletion redacted rather than removed, so the history stays
    // readable and nothing in it names anybody.
    funnel_facts: await countOf(
      context,
      `SELECT count(*) AS count FROM funnel_facts
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
      byContact,
    ),
    firms: contact === null ? 1 : 0,
  };

  /**
   * G8's terminal stops. Nothing is removed and nothing is blanked; what changes is
   * whether a worker will ever act on the row again.
   *
   * An enrollment left `active` against a firm whose handles have just been deleted
   * is a plan the scheduler keeps materializing work for, and every step of it would
   * hold on a missing route. 11.2's vocabulary already has the right word —
   * `admin_stop`, the end that is not a prospect signal — so deletion uses it rather
   * than inventing a reason of its own.
   */
  const stops: Record<string, number> = {
    crm_mail_capture_identities: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_mail_capture_identities WHERE workspace_id=$1 AND id IN (${CRM_MAIL_CAPTURE_IDS}) AND state<>'blocked'`,
      byContact,
    ),
    crm_mail_source_intents: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_mail_source_intents WHERE workspace_id=$1 AND source_id IN (${CRM_MAIL_MESSAGE_IDS}) AND state<>'invalidated'`,
      byContact,
    ),
    crm_relationships: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_relationships WHERE workspace_id=$1 AND source_id IN (${CRM_SELECTED_SOURCE_IDS})`,
      byContact,
    ),
    crm_source_relationship_contexts: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_source_relationship_contexts WHERE workspace_id=$1 AND
       (source_id IN (${CRM_SELECTED_SOURCE_IDS}) OR relationship_id IN
         (SELECT id FROM crm_relationships WHERE workspace_id=$1 AND source_id IN (${CRM_SELECTED_SOURCE_IDS})))`,
      byContact,
    ),
    crm_endpoint_claims: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_endpoint_claims WHERE workspace_id=$1 AND source_id IN (${CRM_SELECTED_SOURCE_IDS})`,
      byContact,
    ),
    sequence_enrollments: await countOf(
      context,
      `SELECT count(*) AS count FROM sequence_enrollments
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
          AND state = 'active'`,
      byContact,
    ),
    step_executions: await countOf(
      context,
      `SELECT count(*) AS count FROM step_executions
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
          AND state IN ('pending', 'held')`,
      byContact,
    ),
  };

  const retains: Record<string, number> = {
    crm_ask_actions:await countOf(context,`SELECT count(*) AS count FROM crm_ask_actions a WHERE a.workspace_id=$1 AND ${CRM_ASK_ACTION_IN_SCOPE}`,byContact),
    crm_ask_financial_receipts:await countOf(context,`SELECT count(*) AS count FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id IN(${CRM_ASK_REQUEST_IDS})`,byContact),
    crm_commitment_reviews: await countOf(context,`SELECT count(*) AS count FROM crm_commitment_reviews r WHERE r.workspace_id=$1 AND ${CRM_COMMITMENT_REVIEW_IN_SCOPE}`,byContact),
    crm_internal_tasks: await countOf(context,`SELECT count(*) AS count FROM crm_internal_tasks t WHERE t.workspace_id=$1 AND ${CRM_COMMITMENT_TASK_IN_SCOPE}`,byContact),
    crm_mail_reply_resolutions:await countOf(context,`SELECT count(*) AS count FROM crm_mail_reply_resolutions WHERE ${CRM_COMPLETION_IN_SCOPE}`,byContact),
    crm_claim_review_anchors: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_claim_review_anchors a WHERE a.workspace_id=$1 AND ${CRM_HUMAN_ANCHOR_IN_SCOPE}`,
      byContact,
    ),
    crm_claim_decision_revisions: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_claim_decision_revisions WHERE workspace_id=$1 AND anchor_id IN (${CRM_HUMAN_ANCHOR_IDS})`,
      byContact,
    ),
    crm_claim_conflict_revisions: await countOf(
      context,
      `SELECT count(*) AS count FROM crm_claim_conflict_revisions r WHERE r.workspace_id=$1 AND ${CRM_HUMAN_CONFLICT_IN_SCOPE}`,
      byContact,
    ),
    opportunity_stage_events: await countOf(
      context,
      "SELECT count(*) AS count FROM opportunity_stage_events WHERE workspace_id = $1 AND firm_id = $2",
      [workspace, firm],
    ),
    crm_domain_events: await countOf(
      context,
      "SELECT count(*) AS count FROM crm_domain_events WHERE workspace_id = $1 AND firm_id = $2",
      [workspace, firm],
    ),
    opportunities: await countOf(
      context,
      "SELECT count(*) AS count FROM opportunities WHERE workspace_id = $1 AND firm_id = $2",
      [workspace, firm],
    ),
    // The honest line in the report, and the one an approver would otherwise
    // discover afterwards. An address frozen into the envelope of a fence that has
    // dispatched cannot be removed: 0010 revokes `DELETE` on `outbound_messages`,
    // its trigger makes the envelope immutable from the instant an attempt token
    // exists, and `outbound_messages_route_fkey` has no `ON DELETE` clause — so the
    // route row is pinned by the same promise that lets Sent-folder reconciliation
    // find the message afterwards. The address is in the tombstones regardless, so
    // the handle is suppressed even where the row survives.
    email_addresses_pinned_by_a_sent_fence: await countOf(
      context,
      `SELECT count(DISTINCT a.id) AS count FROM email_addresses a
         JOIN outbound_messages o
           ON o.workspace_id = a.workspace_id AND o.recipient_route_id = a.id
        WHERE a.workspace_id = $1 AND a.firm_id = $3 AND ${contactPredicate("a.contact_id", "$2")}
          AND o.attempt_token IS NOT NULL`,
      byContact,
    ),
  };

  const { rows: handleRows } = await context.db.query<{ handle: string }>(
    `SELECT address AS handle FROM email_addresses
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
     UNION
     SELECT e164 AS handle FROM phone_routes
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
     UNION SELECT address AS handle FROM (${BUSINESS_TARGET_ADDRESSES}) business_addresses
     ORDER BY handle`,
    byContact,
  );

  // Slice M1 (review folds 1 and 2, finding 3): the attendee of every meeting this
  // deletion takes is tombstoned too. A domain-matched or unmatched booking's attendee
  // is often on no route, and without a tombstone Cal.com's reconciliation would read the
  // booking back an hour later and store the address again (`meetings/reconcile.ts`).
  // An address the suppression canonicalizer accepts is a handle like any other; one it
  // refuses (a non-ASCII local part) is tombstoned under its fallback key
  // (`meetings/attendee.ts`), which the reconciliation reads the same way. None is skipped.
  const { rows: attendeeRows } = await context.db.query<{ handle: string }>(
    `SELECT DISTINCT m.attendee_email AS handle FROM meetings m
      WHERE m.workspace_id = $1 AND m.attendee_email IS NOT NULL AND ${MEETING_IN_SCOPE}`,
    byContact,
  );
  const handles = new Set(handleRows.map((row) => row.handle));
  const attendeeKeys = new Set<string>();
  for (const row of attendeeRows) {
    const canonical = canonicalizeHandle(row.handle);
    if (canonical.ok) {
      handles.add(canonical.handle.value);
      continue;
    }
    const key = deletionTombstoneKeyOf(row.handle);
    if (key !== null && !handles.has(key)) attendeeKeys.add(key);
  }

  // Body-free versions bind approval to the evidence shown by this preview, even
  // when a correction leaves all table counts unchanged.
  const identityVersions = (
    await context.db.query<{
      kind: string;
      id: string;
      revision: number;
      hash: string | null;
      state: string;
    }>(
      `WITH selected AS (${CRM_SELECTED_SOURCE_IDS})
    SELECT 'source' AS kind,id::text,revision,content_hash AS hash,availability AS state
      FROM crm_selected_sources WHERE workspace_id=$1 AND id IN (SELECT id FROM selected)
    UNION ALL SELECT 'relationship',id::text,revision,source_hash,source_invalidated::text || ':' || context_review
      FROM crm_relationships WHERE workspace_id=$1 AND source_id IN (SELECT id FROM selected)
    UNION ALL SELECT 'context',id::text,source_revision,source_hash,review
      FROM crm_source_relationship_contexts WHERE workspace_id=$1 AND (source_id IN (SELECT id FROM selected)
        OR relationship_id IN (SELECT id FROM crm_relationships WHERE workspace_id=$1 AND source_id IN (SELECT id FROM selected)))
    UNION ALL SELECT 'claim',id::text,revision,source_hash,source_invalidated::text
      FROM crm_endpoint_claims WHERE workspace_id=$1 AND source_id IN (SELECT id FROM selected)
    UNION ALL SELECT 'selected_file',source_id::text,metadata_revision,encode(sha256(convert_to(to_jsonb(crm_selected_file_receipts)::text,'UTF8')),'hex'),state
      FROM crm_selected_file_receipts WHERE workspace_id=$1 AND source_id IN (SELECT id FROM selected)
    UNION ALL SELECT 'mail_progress',r.id::text,r.source_revision,encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'),r.state
      FROM crm_mail_progress_receipts r WHERE ${CRM_PROGRESS_IN_SCOPE}
    UNION ALL SELECT 'mail_completion',request_message_id::text,1,encode(sha256(convert_to(to_jsonb(crm_mail_reply_resolutions)::text,'UTF8')),'hex'),'completed'
      FROM crm_mail_reply_resolutions WHERE ${CRM_COMPLETION_IN_SCOPE}
    UNION ALL SELECT 'mail_source',source_id::text,source_revision,content_hash,availability
      FROM crm_mail_sources WHERE workspace_id=$1 AND source_id IN (${CRM_MAIL_MESSAGE_IDS})
    UNION ALL SELECT 'mail_capture',id::text,1,encode(sha256(convert_to(concat(source_id::text,context_snapshot::text,job_id::text,lease_fencing_token::text,account_binding),'UTF8')),'hex'),state
      FROM crm_mail_capture_identities WHERE workspace_id=$1 AND id IN (${CRM_MAIL_CAPTURE_IDS})
    UNION ALL SELECT 'business_metadata',b.id::text,b.metadata_revision,b.metadata_hash,b.metadata_availability
      FROM crm_business_conversations b WHERE b.workspace_id=$1 AND ${BUSINESS_METADATA_IN_SCOPE}
    UNION ALL SELECT 'mail_import_metadata',x.id::text,x.revision,encode(sha256(convert_to(concat_ws(':',x.message_hash,x.provider_message_id,x.provider_thread_id,x.provider_at::text,x.scope,x.reason),'UTF8')),'hex'),x.state FROM crm_mail_import_messages x WHERE x.workspace_id=$1 AND ${IMPORT_METADATA_IN_SCOPE}
    UNION ALL SELECT 'ask_request',a.id::text,a.version,encode(sha256(convert_to(concat_ws(':',a.epoch::text,a.scope::text,a.initial_contexts::text,a.initial_access_closure::text,a.question,a.result::text,jsonb_build_array(a.history_revision,a.history_title,a.history_pinned,a.history_updated_at)::text),'UTF8')),'hex'),a.state FROM crm_ask_requests a WHERE a.workspace_id=$1 AND ${CRM_ASK_REQUEST_IN_SCOPE}
    UNION ALL SELECT 'ask_action',a.id::text,a.version,encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),a.private_state FROM crm_ask_actions a WHERE a.workspace_id=$1 AND ${CRM_ASK_ACTION_IN_SCOPE}
    ORDER BY kind,id`,
      byContact,
    )
  ).rows;

  return {
    removes,
    redacts,
    stops,
    retains,
    identityVersions,
    handles: [...handles].sort(),
    attendeeKeys: [...attendeeKeys].filter((key) => !handles.has(key)).sort(),
  };
}

function hashOf(
  scope: Scope,
  measured: Awaited<ReturnType<typeof measure>>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        firmId: scope.firmId,
        contactId: scope.contactId,
        removes: measured.removes,
        redacts: measured.redacts,
        stops: measured.stops,
        identityVersions: measured.identityVersions,
        handles: measured.handles,
        attendeeKeys: measured.attendeeKeys,
      }),
    )
    .digest("hex");
}

async function resolveScope(
  context: RepositoryContext,
  input: {
    readonly targetKind: DeletionTargetKind;
    readonly firmId: string;
    readonly contactId?: string | undefined;
  },
): Promise<RetentionResult<Scope, DeletionRefusal>> {
  const { rows } = await context.db.query<{ id: string }>(
    "SELECT id FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [context.scope.workspaceId, input.firmId],
  );
  if (rows.length === 0) return refuse("firm_unknown");

  if (input.targetKind === "firm")
    return accept({ firmId: input.firmId, contactId: null });

  if (input.contactId === undefined) return refuse("contact_unknown");
  const contact = await context.db.query<{ id: string }>(
    "SELECT id FROM contacts WHERE workspace_id = $1 AND id = $2 AND firm_id = $3 FOR UPDATE",
    [context.scope.workspaceId, input.contactId, input.firmId],
  );
  if (contact.rows.length === 0) return refuse("contact_unknown");
  return accept({ firmId: input.firmId, contactId: input.contactId });
}

export interface PreviewDeletionInput {
  readonly targetKind: DeletionTargetKind;
  readonly firmId: string;
  readonly contactId?: string | undefined;
}

export async function previewDeletion(
  context: RepositoryContext,
  input: PreviewDeletionInput,
): Promise<RetentionResult<DeletionPreview, DeletionRefusal>> {
  if (!isAdminScope(context.scope)) return refuse("admin_only");
  const scoped = await resolveScope(context, input);
  if (!scoped.ok) return refuse(scoped.reason);
  const scope = scoped.value;

  await lockBusinessMetadataForDeletion(context, scope);
  const measured = await measure(context, scope);
  const previewHash = hashOf(scope, measured);

  const actor = context.scope.actor;
  const requestedBy = actor.kind === "user" ? actor.userId : null;
  if (requestedBy === null) return refuse("admin_only");

  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO deletion_requests
       (workspace_id, target_kind, firm_id, contact_id, requested_by_user_id, preview, preview_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.targetKind,
      scope.firmId,
      scope.contactId,
      requestedBy,
      // Counts only. The handles are returned to the caller and never written down.
      JSON.stringify({
        removes: measured.removes,
        redacts: measured.redacts,
        stops: measured.stops,
        retains: measured.retains,
      }),
      previewHash,
    ],
  );

  await recordCrmAuditEvent(context, {
    action: "deletion.previewed",
    subjectKind: input.targetKind,
    subjectId: scope.contactId ?? scope.firmId,
    detail: {
      requestId: rows[0]?.id ?? "",
      removes: measured.removes,
      redacts: measured.redacts,
      stops: measured.stops,
    },
  });

  return accept({
    requestId: rows[0]?.id ?? "",
    targetKind: input.targetKind,
    firmId: scope.firmId,
    contactId: scope.contactId,
    previewHash,
    removes: measured.removes,
    redacts: measured.redacts,
    stops: measured.stops,
    retains: measured.retains,
    tombstoneHandles: [...measured.handles, ...measured.attendeeKeys],
  });
}

export interface CommitDeletionInput {
  readonly requestId: string;
  readonly previewHash: string;
  readonly commandId: string;
  readonly journal: SuppressionJournal;
}

export async function commitDeletion(
  context: RepositoryContext,
  input: CommitDeletionInput,
): Promise<RetentionResult<DeletionOutcome, DeletionRefusal>> {
  if (!isAdminScope(context.scope)) return refuse("admin_only");
  const actor = context.scope.actor;
  if (actor.kind !== "user") return refuse("admin_only");

  // Ask recovery has no surviving source authority after erasure. Serialize its
  // bounded database stage before the existing deletion lock hierarchy.
  await lockAskLifecycle(context);
  // The send gate first, before the request row and before anything is measured (Cal.com
  // slice M1, review fold 2, finding 3 (ii)). Every stop-fact writer takes it first —
  // the tombstones below do too — and so does a Cal.com booking: a booking that commits
  // while this deletion runs is either measured (and tombstoned) or waits for it.
  await lockSendGateForStopFact(context);
  await lockTodayForFirmChange(context);

  const request = await context.db.query<{
    id: string;
    target_kind: DeletionTargetKind;
    firm_id: string;
    contact_id: string | null;
    preview_hash: string;
    state: "previewed" | "committed";
  }>(
    `SELECT id, target_kind, firm_id, contact_id, preview_hash, state
       FROM deletion_requests WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.requestId],
  );
  const row = request.rows[0];
  if (row === undefined) return refuse("request_unknown");
  if (row.state === "committed") return refuse("already_committed");

  const scope: Scope = { firmId: row.firm_id, contactId: row.contact_id };
  // Every identity writer takes sorted firms, then people, then copied sources. Include
  // independent people and surviving contexts so deletion cannot race a context change
  // or acquire a second firm's lock after already holding the person's row.
  const closure = await identityDeletionClosure(context, scope);
  if (closure === undefined) return refuse("preview_stale");
  for (const firmId of closure.firms) {
    await context.db.query(
      "SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [context.scope.workspaceId, firmId],
    );
  }
  if (scope.contactId !== null) {
    await context.db.query(
      "SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 FOR UPDATE",
      [context.scope.workspaceId, scope.contactId, scope.firmId],
    );
  }
  for (const personId of closure.people) {
    await context.db.query(
      "SELECT id FROM crm_people WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [context.scope.workspaceId, personId],
    );
  }
  for (const sourceId of closure.sources) {
    await context.db.query(
      "SELECT id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [context.scope.workspaceId, sourceId],
    );
  }
  // A writer may have completed while those locks waited. Never extend the closure
  // out of order; require a fresh preview instead.
  if (
    JSON.stringify(await identityDeletionClosure(context, scope)) !==
    JSON.stringify(closure)
  )
    return refuse("preview_stale");
  // Slice C2 (review fold 1, P1): every call session this deletion removes is locked now,
  // after the gate and before anything is measured — its transcription lock and its row —
  // and held to the commit. A transcription that has not begun waits and then finds the
  // session gone; one that is mid-call finishes first and its transcript is removed below.
  const { rows: targetedSessions } = await context.db.query<{ id: string }>(
    `SELECT id FROM call_sessions WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    [context.scope.workspaceId, scope.contactId, scope.firmId],
  );
  // Slice C3b: their summary locks first — a subject lock, after the firm and before the
  // sessions' own locks and rows, which a summary's chunk 3 takes in that order too.
  await lockSummariesForDeletion(
    context,
    targetedSessions.map((session) => session.id),
  );
  // Slice 3a: their analysis locks beside them, `call_analysis:<session>` in id order — after
  // the firm and before the sessions' own locks and rows, the order every analysis writer
  // takes them in (`lockCallAnalysisForSession`).
  await lockAnalysesForDeletion(
    context,
    targetedSessions.map((session) => session.id),
  );
  await lockSessionsForDeletion(
    context,
    targetedSessions.map((session) => session.id),
  );
  // And, for a firm, every active research run — running, or still holding an open
  // reservation — before the monthly lock and before any deletion (fix rounds 2 and 3). A run
  // lock waited for after the monthly lock would be a cycle with a chunk 3 settling its own
  // call; one waited for after a firm row was deleted, with a page-only chunk 3 writing
  // evidence. The finalisation further down takes them again.
  if (scope.contactId === null) {
    const { rows: runsToLock } = await context.db.query<{ id: string }>(
      `SELECT r.id FROM research_runs r
        WHERE r.workspace_id = $1 AND r.firm_id = $2
          AND (r.outcome = 'running'
               OR EXISTS (
                 SELECT 1 FROM provider_reservations p
                  WHERE p.workspace_id = r.workspace_id
                    AND p.subject_kind = 'research_run' AND p.subject_id = r.id
                    AND p.state IN ('reserved', 'calling')))
        ORDER BY r.started_at, r.id`,
      [context.scope.workspaceId, scope.firmId],
    );
    for (const run of runsToLock) await lockRun(context, run.id);
  }
  // Then the month: every settlement and every message deletion below comes after it.
  await lockMonthlySpend(context);
  await lockBusinessMetadataForDeletion(context, scope);
  for (const identityId of closure.mailIdentities)
    await context.db.query(
      "SELECT id FROM crm_mail_capture_identities WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [context.scope.workspaceId, identityId],
    );
  for (const sourceId of closure.mailSources) {
    await context.db.query(
      "SELECT id FROM mail_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [context.scope.workspaceId, sourceId],
    );
    await context.db.query(
      "SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE",
      [context.scope.workspaceId, sourceId],
    );
  }
  for (const anchorId of closure.humanAnchors)
    await context.db.query(
      "SELECT id FROM crm_claim_review_anchors WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [context.scope.workspaceId, anchorId],
    );
  for(const reviewId of closure.humanReviews)await context.db.query('SELECT id FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,reviewId]);
  for(const taskId of closure.humanTasks)await context.db.query('SELECT id FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,taskId]);
  if (
    JSON.stringify(await identityDeletionClosure(context, scope)) !==
    JSON.stringify(closure)
  )
    return refuse("preview_stale");
  for(const requestId of closure.askRequests)await context.db.query('SELECT id FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,requestId]);
  for(const actionId of closure.askActions)await context.db.query('SELECT id FROM crm_ask_actions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,actionId]);
  // Windows cannot be updated. Their insert guard locks the already-held parent;
  // parent serialization and the closure recheck fence their private erasure.
  for(const receiptId of closure.progressReceipts)await context.db.query('SELECT id FROM crm_mail_progress_receipts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,receiptId]);
  const measured = await measure(context, scope);
  const currentHash = hashOf(scope, measured);
  // Both comparisons. The presented hash catches a client approving somebody else's
  // preview; the stored one catches the world changing since it was shown.
  if (input.previewHash !== currentHash || row.preview_hash !== currentHash)
    return refuse("preview_stale");

  // The tombstones first, while the handles still exist to be read. Every one is
  // journalled before its row by `recordSuppression` (10.2), so a lost journal write
  // fails the command before anything has been deleted.
  // `tombstone_event_ids` on the request row is what makes these findable later.
  const tombstoneEventIds: string[] = [];
  for (const handle of measured.handles) {
    const recorded = await recordSuppression(context, {
      scope: "handle",
      value: handle,
      source: "deletion_tombstone",
      // A deleted person is never contacted again, on any channel.
      channel: "all",
      commandId: `${input.commandId}:${handle}`,
      journal: input.journal,
    });
    if (!recorded.ok) return refuse("handle_uncanonical");
    tombstoneEventIds.push(recorded.value.eventId);
  }
  for (const key of measured.attendeeKeys) {
    const recorded = await recordSuppression(context, {
      scope: "handle",
      fallbackKey: key,
      source: "deletion_tombstone",
      channel: "all",
      commandId: `${input.commandId}:${key}`,
      journal: input.journal,
    });
    if (!recorded.ok) return refuse("handle_uncanonical");
    tombstoneEventIds.push(recorded.value.eventId);
  }
  if (row.target_kind === "firm") {
    const recorded = await recordSuppression(context, {
      scope: "firm",
      firmId: scope.firmId,
      source: "deletion_tombstone",
      channel: "all",
      commandId: input.commandId,
      journal: input.journal,
    });
    if (!recorded.ok) return refuse("firm_unknown");
    tombstoneEventIds.push(recorded.value.eventId);
  }

  const workspace = context.scope.workspaceId;
  const byContact = [workspace, scope.contactId, scope.firmId] as const;
  const removed: Record<string, number> = {};
  const redacted: Record<string, number> = {};
  // Record private erasure before any canonical source lifecycle hook can clear it.
  removed['crm_ask_request_windows']=(await context.db.query(`DELETE FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id=ANY($2::uuid[])`,[workspace,closure.askRequests])).rowCount??0;
  const erasedAsk = await context.db.query(`UPDATE crm_ask_requests a SET question=NULL,scope=NULL,initial_contexts=NULL,initial_access_closure=NULL,result=NULL,result_at=NULL,state='deleted',reason='deleted',version=version+1,epoch=epoch+1,updated_at=now() WHERE a.workspace_id=$1 AND a.id=ANY($2::uuid[]) AND a.state<>'deleted'`,[workspace,closure.askRequests]);
  redacted['crm_ask_requests']=erasedAsk.rowCount??0;
  redacted['crm_ask_actions']=(await context.db.query(`UPDATE crm_ask_actions SET private_state='deleted',target_firm_id=NULL,target_person_id=NULL,human_text=NULL,due=NULL,input_scope=NULL,initial_contexts=NULL,original_access_closure=NULL,support_refs=NULL,review_required=(kind='task' AND status='open'),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND private_state='available'`,[workspace,closure.askActions])).rowCount??0;
  const affectedAnchorIds = (
    await context.db.query<{ id: string }>(
      `${CRM_HUMAN_ANCHOR_IDS} ORDER BY a.id`,
      byContact,
    )
  ).rows.map((value) => value.id);
  // Clear only each affected private attestation, before deleting leaf anchors.
  // Unrelated promises on the same retained copy keep their own exact proof.
  redacted["crm_internal_tasks"] = (await context.db.query("UPDATE crm_internal_tasks SET review_id=NULL,activation_receipt=NULL,review_required=true,version=version+1 WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND activation_receipt IS NOT NULL",[workspace,closure.humanTasks])).rowCount??0;
  redacted["crm_commitment_reviews"] = (await context.db.query("UPDATE crm_commitment_reviews SET anchor_id=NULL,target=NULL,activation_key=NULL,initial_context_snapshot=NULL,context_snapshot=NULL,original_access_closure=NULL,basis=NULL,classification=NULL,actor=NULL,action_label=NULL,due=NULL,source_zone_receipt=NULL,today_eligibility=NULL,projection_receipt=NULL,projection_version=projection_version+1,state='redacted' WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND state<>'redacted'",[workspace,closure.humanReviews])).rowCount??0;
  redacted["crm_claim_review_anchors"] =
    (
      await context.db.query(
        "UPDATE crm_claim_review_anchors SET availability='deleted',original_event_at=NULL,original_observed_at=NULL WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND (availability<>'deleted' OR original_event_at IS NOT NULL OR original_observed_at IS NOT NULL)",
        [workspace, affectedAnchorIds],
      )
    ).rowCount ?? 0;
  redacted["crm_claim_decision_revisions"] =
    (
      await context.db.query(
        "UPDATE crm_claim_decision_revisions SET corrected_interpretation=NULL,rationale=NULL,redacted_at=COALESCE(redacted_at,now()) WHERE workspace_id=$1 AND anchor_id=ANY($2::uuid[]) AND (corrected_interpretation IS NOT NULL OR rationale IS NOT NULL OR redacted_at IS NULL)",
        [workspace, affectedAnchorIds],
      )
    ).rowCount ?? 0;
  redacted["crm_claim_conflict_revisions"] =
    (
      await context.db.query(
        "UPDATE crm_claim_conflict_revisions r SET rationale=NULL,redacted_at=COALESCE(redacted_at,now()) WHERE r.workspace_id=$1 AND EXISTS(SELECT 1 FROM crm_claim_conflict_members m WHERE m.workspace_id=r.workspace_id AND m.conflict_id=r.conflict_id AND m.anchor_id=ANY($2::uuid[])) AND (r.rationale IS NOT NULL OR r.redacted_at IS NULL)",
        [workspace, affectedAnchorIds],
      )
    ).rowCount ?? 0;
  await context.db.query(
    "SELECT flag_crm_open_human_work($1,$2::uuid[],'source_deleted')",
    [workspace, affectedAnchorIds],
  );

  const remove = async (
    table: string,
    sql: string,
    values: readonly unknown[],
  ): Promise<void> => {
    const { rowCount } = await context.db.query(sql, values);
    removed[table] = rowCount ?? 0;
  };

  // The stops come first, and P1-3 of the GPT-6 review of PR 332 is why. `step_executions`
  // before its enrollment: an execution is the child, and a `pending` one under a
  // `stopped` enrollment is a row the scheduler still claims. The execution update clears
  // the column its new state forbids — `hold_reason_code` for a cancelled execution —
  // because 0012 writes that as an equivalence rather than as a nullable field.
  //
  // They used to come *after* the removals, which migration 0025 made impossible: a live
  // `follow_up` enrollment may not have a null `permission_id`, so clearing the pointer
  // on an active row is refused by
  // `sequence_enrollments_follow_up_has_permission` and the whole deletion fails. Ending
  // the enrollment first is also the only ordering that is true to what a deletion is:
  // the person's automation stops, and then their rows go.
  const stopped: Record<string, number> = {};
  const executions = await context.db.query(
    `UPDATE step_executions
        SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'deleted under 10.3',
            hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
        AND state IN ('pending', 'held')`,
    byContact,
  );
  stopped["step_executions"] = executions.rowCount ?? 0;
  const enrollments = await context.db.query(
    `UPDATE sequence_enrollments
        SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop', updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
        AND state = 'active'`,
    byContact,
  );
  stopped["sequence_enrollments"] = enrollments.rowCount ?? 0;
  const outreach = await context.db.query(
    `UPDATE outreach_plans SET state='stopped',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND firm_id=$3 AND ${contactPredicate("contact_id", "$2")} AND state NOT IN ('completed','stopped')`,
    byContact,
  );
  stopped["outreach_plans"] = outreach.rowCount ?? 0;

  // Then migration 0025's permissions, and before the evidence they rest on: a
  // permission's foreign keys onto `call_logs` and `mail_messages` are what make that
  // evidence undeletable while the permission lives, so a deletion that removed the
  // correspondence or the call history first would be refused by those keys — which is
  // the check working, and this is the one path allowed to satisfy it. The enrollment
  // that points at a permission is stopped rather than deleted, so its pointer is cleared
  // here; the row is ended by the statements above, `origin_kind` still says `follow_up`,
  // and nothing can send on the cleared column.
  await context.db.query(
    `UPDATE sequence_enrollments
        SET permission_id = NULL, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
        AND permission_id IS NOT NULL`,
    byContact,
  );
  // Remove envelope/thread approval metadata; the original draft fence retains only
  // the established outbound history and source identity for no-repeat readback.
  await remove(
    "human_reply_send_intents",
    `DELETE FROM human_reply_send_intents i USING outbound_messages o
     WHERE i.workspace_id=$1 AND o.workspace_id=i.workspace_id AND o.id=i.outbound_message_id
     AND o.firm_id=$3 AND ${contactPredicate("o.contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "outreach_reply_deliveries",
    `DELETE FROM outreach_reply_deliveries d USING outreach_reply_requests r,outreach_plans p
     WHERE d.workspace_id=$1 AND r.workspace_id=d.workspace_id AND r.id=d.request_id
     AND p.workspace_id=r.workspace_id AND p.id=r.plan_id AND p.firm_id=$3 AND ${contactPredicate("p.contact_id", "$2")}`,
    byContact,
  );
  await context.db.query(
    `UPDATE outreach_reply_requests r SET state='expired',decision=NULL,reason='deleted',revision=r.revision+1,updated_at=now()
    FROM outreach_plans p WHERE r.workspace_id=$1 AND p.workspace_id=r.workspace_id AND p.id=r.plan_id AND p.firm_id=$3 AND ${contactPredicate("p.contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "follow_up_permissions",
    `DELETE FROM follow_up_permissions
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );

  // G7b's confirmations before the messages that would cascade them, because a
  // confirmation also references a callback this workflow is about to remove.
  await remove(
    "mail_reply_confirmations",
    `DELETE FROM mail_reply_confirmations c
      WHERE c.workspace_id = $1 AND c.firm_id = $3 AND ${CONFIRMATION_IN_SCOPE}`,
    byContact,
  );
  // Correspondence next: the messages take their bodies, matches, classifications,
  // classifier calls and effects with them through the cascades of 0009 and 0011.
  // Opaque identity survives canonical-row cascades. No provider replay may create
  // a replacement UUID after deleting an approved copy or a pending matched capture.
  redacted['crm_mail_import_messages']=await redactBackfillMetadataRows(context,measured.identityVersions.filter(value=>value.kind==='mail_import_metadata').map(value=>value.id));
  const mailIds = closure.mailSelected;
  redacted['crm_mail_reply_resolutions']=(await context.db.query(`UPDATE crm_mail_reply_resolutions SET request_provider_at=NULL WHERE ${CRM_COMPLETION_IN_SCOPE} AND (request_provider_at IS NOT NULL OR sent_receipt_id IS NOT NULL)`,byContact)).rowCount??0;
  await remove('crm_mail_progress_receipts','DELETE FROM crm_mail_progress_receipts WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspace,closure.progressReceipts]);
  const observedMailNamesRedacted = await redactUnsupportedObservedMailLabels(
    context,
    mailIds,
  );
  await context.db.query(
    `INSERT INTO crm_mail_acquisition_tombstones
    (workspace_id,capture_identity_id,source_id,owner_user_id,source_revision,content_hash,availability)
    SELECT workspace_id,capture_identity_id,source_id,owner_user_id,source_revision+1,content_hash,'deleted'
    FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=ANY($2::uuid[])
    ON CONFLICT(workspace_id,source_id,source_revision) DO UPDATE SET availability='deleted'`,
    [workspace, mailIds],
  );
  stopped["crm_mail_capture_identities"] =
    (
      await context.db.query(
        "UPDATE crm_mail_capture_identities SET state='blocked' WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND state<>'blocked'",
        [workspace, closure.mailIdentitiesSelected],
      )
    ).rowCount ?? 0;
  stopped["crm_mail_source_intents"] =
    (
      await context.db.query(
        "UPDATE crm_mail_source_intents SET state='invalidated' WHERE workspace_id=$1 AND source_id=ANY($2::uuid[]) AND state<>'invalidated'",
        [workspace, mailIds],
      )
    ).rowCount ?? 0;
  removed["mail_message_bodies"] = measured.removes["mail_message_bodies"] ?? 0;
  removed["crm_mail_source_contexts"] =
    measured.removes["crm_mail_source_contexts"] ?? 0;
  await remove(
    "mail_messages",
    "DELETE FROM mail_messages WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
    [workspace, mailIds],
  );
  // Unavailable heads survive ordinary copy deletion but terminal scoped deletion removes them.
  await remove(
    "crm_mail_sources",
    "DELETE FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=ANY($2::uuid[])",
    [workspace, mailIds],
  );
  await remove(
    "outreach_email_sources",
    `DELETE FROM outreach_email_sources WHERE workspace_id=$1 AND firm_id=$3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  // Learning contains references only, but deleted interactions must stop contributing.
  await remove(
    "sourcing_interactions",
    `DELETE FROM sourcing_interactions i WHERE i.workspace_id=$1 AND (
   (i.kind='call' AND (i.subject_id IN (SELECT id FROM call_sessions s WHERE s.workspace_id=$1 AND s.firm_id=$3 AND ${contactPredicate("s.contact_id", "$2")})
    OR i.subject_id IN (SELECT id FROM call_logs l WHERE l.workspace_id=$1 AND l.firm_id=$3 AND ${contactPredicate("l.contact_id", "$2")})))
   OR (i.kind='meeting' AND i.subject_id IN (SELECT id FROM meetings m WHERE m.workspace_id=$1 AND m.firm_id=$3 AND ${contactPredicate("m.contact_id", "$2")})))`,
    byContact,
  );
  if (scope.contactId === null)
    await remove(
      "sourcing_attributions",
      "DELETE FROM sourcing_attributions WHERE workspace_id=$1 AND firm_id=$2",
      [workspace, scope.firmId],
    );

  // Migration 0028's rows before the tickets and call logs they point at. A session's
  // open reservation is closed first, as the research sweep closes a run's: `reserved`
  // is released (no call can have happened), `calling` is estimated (one may have).
  const { rows: openSessions } = await context.db.query<{
    reservation_id: string;
    state: string;
  }>(
    `SELECT s.reservation_id, r.state FROM call_sessions s
       JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id
      WHERE s.workspace_id = $1 AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}
        AND r.state IN ('reserved', 'calling')`,
    byContact,
  );
  if (openSessions.length > 0) {
    const at = await databaseNow(context);
    for (const open of openSessions) {
      await settleAttempt(context, {
        reservationId: open.reservation_id,
        at,
        outcome:
          open.state === "calling"
            ? { kind: "estimated" }
            : { kind: "released" },
      });
    }
  }
  // Slice C2: each session's transcription, under its lock (a claim calling the provider
  // finishes first), has its open attempts finalised as the sweep does it — `reserved`
  // released, `calling` estimated — and then its transcript is removed.
  const { rows: transcribedSessions } = await context.db.query<{ id: string }>(
    `SELECT s.id FROM call_sessions s
      WHERE s.workspace_id = $1 AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}
        AND EXISTS (SELECT 1 FROM provider_reservations p
                     WHERE p.workspace_id = s.workspace_id AND p.subject_kind = 'call_transcription'
                       AND p.subject_id = s.id AND p.state IN ('reserved', 'calling'))`,
    byContact,
  );
  if (transcribedSessions.length > 0) {
    await finaliseTranscriptionsOfSessions(
      context,
      transcribedSessions.map((row) => row.id),
      await databaseNow(context),
    );
  }
  // Slice C3b: each session's open summary attempts finalised as the sweep does it
  // (`reserved` released, `calling` estimated), then its summary removed. Its summary lock
  // was taken above, so a claim finishing its request waits for this deletion and then
  // finds the session gone.
  const { rows: summarizedSessions } = await context.db.query<{ id: string }>(
    `SELECT s.id FROM call_sessions s
      WHERE s.workspace_id = $1 AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}
        AND EXISTS (SELECT 1 FROM provider_reservations p
                     WHERE p.workspace_id = s.workspace_id AND p.subject_kind = 'call_summary'
                       AND p.subject_id = s.id AND p.state IN ('reserved', 'calling'))`,
    byContact,
  );
  if (summarizedSessions.length > 0) {
    await finaliseSummariesOfSessions(
      context,
      summarizedSessions.map((row) => row.id),
      await databaseNow(context),
    );
  }
  await remove(
    "call_summaries",
    `DELETE FROM call_summaries x USING call_sessions s
      WHERE x.workspace_id = $1 AND s.workspace_id = x.workspace_id AND s.id = x.call_session_id
        AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}`,
    byContact,
  );
  // Slice 3a: each session's open analysis attempts finalised as the sweep does it, under
  // the analysis locks taken above and the monthly lock, then its versions removed (they
  // would also go with the session, ON DELETE CASCADE; removed here so they are counted).
  await finaliseAnalysesOfSessions(
    context,
    targetedSessions.map((session) => session.id),
    await databaseNow(context),
  );
  await remove(
    "call_analyses",
    `DELETE FROM call_analyses a USING call_sessions s
      WHERE a.workspace_id = $1 AND s.workspace_id = a.workspace_id AND s.id = a.call_session_id
        AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "call_transcripts",
    `DELETE FROM call_transcripts t USING call_sessions s
      WHERE t.workspace_id = $1 AND s.workspace_id = t.workspace_id AND s.id = t.call_session_id
        AND s.firm_id = $3 AND ${contactPredicate("s.contact_id", "$2")}`,
    byContact,
  );
  // Slice 3a (0036): a pending-review hold names its session; the session going takes the
  // hold's recovery (log it, or Dismiss) with it, so the hold is released here, in this
  // transaction, after the gate, the firm and the sessions' locks above — never left
  // blocking e-mail at a firm that survives (review S3B, finding 2). The hold row is kept:
  // `active_holds` is retained, released or not.
  const { rows: releasedPendingHolds } = await context.db.query<{ id: string }>(
    `UPDATE active_holds SET released_at = now()
      WHERE workspace_id = $1 AND source_event_kind = $2 AND released_at IS NULL
        AND source_event_id = ANY($3::text[])
      RETURNING id`,
    [
      context.scope.workspaceId,
      CALL_ANALYSIS_PENDING_SOURCE,
      targetedSessions.map((session) => session.id),
    ],
  );
  // Before the sessions, whose deletion would only clear the task's link.
  await remove(
    "call_tasks",
    `DELETE FROM call_tasks WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "call_sessions",
    `DELETE FROM call_sessions WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  // The review items first: their meeting predicate reads the meetings about to go.
  await remove(
    "stage_review_items",
    `DELETE FROM stage_review_items
      WHERE workspace_id = $1 AND ((firm_id = $3 AND ${FIRM_SCOPED_ONLY}) OR ${MEETING_REVIEW_IN_SCOPE})`,
    byContact,
  );
  await remove(
    "calcom_events",
    `DELETE FROM calcom_events e USING meetings m
      WHERE e.workspace_id = $1 AND m.workspace_id = e.workspace_id AND m.id = e.meeting_id
        AND ${MEETING_IN_SCOPE}`,
    byContact,
  );
  const outcomeMeetings = (
    await context.db.query<{ id: string }>(
      `SELECT m.id FROM meetings m WHERE m.workspace_id=$1 AND ${MEETING_IN_SCOPE}`,
      byContact,
    )
  ).rows;
  await deleteMeetingOutcomeContent(context, {
    meetingIds: outcomeMeetings.map((m) => m.id),
  });
  await remove(
    "meetings",
    `DELETE FROM meetings m WHERE m.workspace_id = $1 AND ${MEETING_IN_SCOPE}`,
    byContact,
  );
  // Then the things that point at a route, then the routes.
  await remove(
    "dial_tickets",
    `DELETE FROM dial_tickets WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "call_logs",
    `DELETE FROM call_logs WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "callbacks",
    `DELETE FROM callbacks WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "today_snoozes",
    `DELETE FROM today_snoozes WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "today_items",
    `DELETE FROM today_items WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  // Detach the unsent fences from the routes that are about to go. 0010's trigger
  // permits it while there is no attempt token — that is exactly the window in which
  // an envelope is still editable — and without it the delete below would fail on
  // `outbound_messages_route_fkey` for any firm that had a draft prepared.
  await context.db.query(
    `UPDATE outbound_messages
        SET recipient_route_id = NULL, recipient_route_version = NULL, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
        AND attempt_token IS NULL AND recipient_route_id IS NOT NULL`,
    byContact,
  );
  await remove(
    "phone_routes",
    `DELETE FROM phone_routes WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "email_addresses",
    `DELETE FROM email_addresses a
      WHERE a.workspace_id = $1 AND a.firm_id = $3 AND ${contactPredicate("a.contact_id", "$2")}
        AND NOT EXISTS (
          SELECT 1 FROM outbound_messages o
           WHERE o.workspace_id = a.workspace_id AND o.recipient_route_id = a.id)`,
    byContact,
  );
  // Lane R's money, before Lane R's rows.
  //
  // `provider_reservations` has no foreign key to `research_runs` — a reservation is an
  // authorization of cents and outlives the thing it was authorized for, which is the
  // reason it is `operational` in the retention catalog and not `deletion_removes`. So
  // deleting a run cannot cascade to one and did not close one either: a firm deleted
  // between chunk 2 and chunk 3 left a `calling` row open, counting against the day's
  // and the month's budget in `readSpend` for ever, with no run left for the sweep to
  // find it by.
  //
  // Each affected run is therefore locked and its open reservations finalised first,
  // exactly as the abandoned-run sweep does it: `reserved` is `released`, because no
  // call could have happened, and `calling` is `estimated`, because a call may have
  // been made and zero is the one answer that is certainly wrong. The lock is the run
  // row's, which the `DELETE` two statements below would take anyway — this takes it
  // slightly earlier, so the order (firm row, then run row) is unchanged.
  //
  // Only a firm deletion reaches this: a contact deletion leaves the firm's research
  // alone, and `FIRM_SCOPED_ONLY` below says so for the rows.
  if (scope.contactId === null) {
    const { rows: openRuns } = await context.db.query<{ id: string }>(
      `SELECT r.id FROM research_runs r
        WHERE r.workspace_id = $1 AND r.firm_id = $2
          AND EXISTS (
            SELECT 1 FROM provider_reservations p
             WHERE p.workspace_id = r.workspace_id
               AND p.subject_kind = 'research_run' AND p.subject_id = r.id
               AND p.state IN ('reserved', 'calling'))
        ORDER BY r.started_at`,
      [workspace, scope.firmId],
    );
    if (openRuns.length > 0) {
      const at = await databaseNow(context);
      for (const run of openRuns) {
        // The lock, and then the settlement: a claim that is mid-chunk finishes first
        // and its reservation is closed by the time this reads it.
        if ((await lockRun(context, run.id)) === null) continue;
        await finaliseSubjectReservations(context, {
          subjectKind: "research_run",
          subjectId: run.id,
          at,
        });
      }
    }
  }
  // Lane R, in foreign-key order and before the evidence a fact points at: the
  // judgment references the run, the facts reference the run *and* the evidence item,
  // so both go before `research_runs` and before `evidence_items` below.
  await remove(
    "firm_judgments",
    `DELETE FROM firm_judgments WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
    byContact,
  );
  await remove(
    "firm_facts",
    `DELETE FROM firm_facts WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
    byContact,
  );
  await remove(
    "research_runs",
    `DELETE FROM research_runs WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
    byContact,
  );
  await remove(
    "firm_prepared_briefs",
    `DELETE FROM firm_prepared_briefs WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
    byContact,
  );
  await remove(
    "firm_links",
    `DELETE FROM firm_links WHERE workspace_id = $1 AND firm_id = $3 AND ${FIRM_SCOPED_ONLY}`,
    byContact,
  );
  await remove(
    "evidence_items",
    `DELETE FROM evidence_items WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  await remove(
    "record_aliases",
    `DELETE FROM record_aliases WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  redacted['crm_selected_file_receipts'] = await countOf(context,`SELECT count(*) AS count FROM crm_selected_file_receipts f WHERE f.workspace_id=$1 AND f.source_id IN (${CRM_SELECTED_SOURCE_IDS}) AND (f.file_name IS NOT NULL OR f.file_hash IS NOT NULL OR f.source_content_hash IS NOT NULL OR f.byte_length IS NOT NULL OR f.format IS NOT NULL OR f.origin IS NOT NULL OR f.parser_version IS NOT NULL)`,byContact);
  redacted["crm_selected_imports"] = await countOf(
    context,
    `SELECT count(*) AS count FROM crm_selected_imports m WHERE m.workspace_id=$1 AND m.source_id IN (${CRM_SELECTED_SOURCE_IDS}) AND (m.label IS NOT NULL OR m.participants IS NOT NULL OR m.attachments IS NOT NULL OR m.direction IS NOT NULL OR m.attribution IS NOT NULL OR m.date_provenance IS NOT NULL)`,
    byContact,
  );
  const metadataIds = measured.identityVersions
    .filter((value) => value.kind === "business_metadata")
    .map((value) => value.id);
  redacted["crm_business_conversations"] = 0;
  for (let offset = 0; offset < metadataIds.length; offset += 100) {
    const result = await redactBusinessMetadata(context, {
      conversationIds: metadataIds.slice(offset, offset + 100),
    });
    if (!result.ok)
      throw new Error("Scoped business metadata deletion refused");
    redacted["crm_business_conversations"] += result.value.redacted;
  }

  const people = await context.db.query(
    `UPDATE crm_people p SET full_name=$4,revision=revision+1
      WHERE p.workspace_id=$1 AND p.full_name <> $4 AND ${CRM_PERSON_IN_SCOPE}`,
    [...byContact, REDACTED_NAME],
  );
  redacted["crm_people"] = (people.rowCount ?? 0) + observedMailNamesRedacted;
  const selectedSources = await context.db.query<{ id: string }>(
    `UPDATE crm_selected_sources s SET availability='deleted',excerpt=NULL,content_hash=NULL,occurred_at=NULL,revision=revision+1
      WHERE s.workspace_id=$1 AND s.availability <> 'deleted' AND ${CRM_SOURCE_IN_SCOPE} RETURNING s.id`,
    byContact,
  );
  redacted["crm_selected_sources"] = selectedSources.rowCount ?? 0;
  const invalidated = await invalidateSelectedIdentitySources(
    context,
    selectedSources.rows.map((source) => source.id),
  );
  stopped["crm_relationships"] = invalidated.relationships;
  stopped["crm_source_relationship_contexts"] = invalidated.contexts;
  stopped["crm_endpoint_claims"] = invalidated.claims;
  redacted["crm_identity_endpoints"] = invalidated.endpoints;
  const fences = await context.db.query(
    `UPDATE outbound_messages
        SET subject = $4, body = $4, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}
        AND attempt_token IS NULL AND subject <> $4`,
    [...byContact, REDACTED_NAME],
  );
  redacted["outbound_messages"] = fences.rowCount ?? 0;

  const facts = await context.db.query(
    `UPDATE funnel_facts
        SET detail = '{}'::jsonb
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("contact_id", "$2")}`,
    byContact,
  );
  redacted["funnel_facts"] = facts.rowCount ?? 0;

  const contacts = await context.db.query(
    `UPDATE contacts
        SET full_name = $4, title = NULL, status = 'inactive', is_primary = false,
            updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate("id", "$2")} AND status <> 'merged'`,
    [...byContact, REDACTED_NAME],
  );
  redacted["contacts"] = contacts.rowCount ?? 0;

  if (scope.contactId === null) {
    const opportunityLabels = await context.db.query(
      "UPDATE opportunities SET display_name=NULL,updated_at=now() WHERE workspace_id=$1 AND firm_id=$2 AND display_name IS NOT NULL",
      [workspace, scope.firmId],
    );
    redacted["opportunities"] = opportunityLabels.rowCount ?? 0;
    const firms = await context.db.query(
      `UPDATE firms
          SET name = $3, website = NULL, address_line = NULL, locality = NULL, postal_code = NULL,
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspace, scope.firmId, REDACTED_NAME],
    );
    redacted["firms"] = firms.rowCount ?? 0;
  }

  await context.db.query(
    `UPDATE deletion_requests
        SET state = 'committed', committed_at = now(), committed_by_user_id = $3, command_id = $4,
            outcome = $5::jsonb, tombstone_event_ids = $6::text[]
      WHERE workspace_id = $1 AND id = $2`,
    [
      workspace,
      row.id,
      actor.userId,
      input.commandId,
      JSON.stringify({ removed, redacted, stopped }),
      tombstoneEventIds,
    ],
  );

  await recordCrmAuditEvent(context, {
    action: "deletion.committed",
    subjectKind: row.target_kind,
    subjectId: scope.contactId ?? scope.firmId,
    detail: {
      requestId: row.id,
      removed,
      redacted,
      stopped,
      tombstones: tombstoneEventIds.length,
      // The pending-review holds released with their sessions (slice 3a): ids, not personal data.
      releasedPendingHoldIds: releasedPendingHolds.map((hold) => hold.id),
    },
  });

  return accept({
    requestId: row.id,
    removed,
    redacted,
    stopped,
    tombstoneEventIds,
  });
}
