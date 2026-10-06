import {revokeProspectingAfterRestore} from '@fss/domain/outreach/authorization.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { authenticationPasses, readPrimarySendingDomain } from '@fss/domain/outbound/domainGuard.ts';
import { readFence, type OutboundFenceRow } from '@fss/domain/outbound/fence.ts';
import { effectiveDailyCap, readRamp, scheduledCap } from '@fss/domain/outbound/ramp.ts';
import {
  coldOutreachDispatchRefusal,
  decideStepPermission,
  dispatchHolidayCalendar,
  insideSendingWindow,
} from '@fss/domain/outbound/stepPermission.ts';
import { footerSourceFor } from '@fss/domain/outbound/footer.ts';
import type { SendRefusalCode } from '@fss/domain/outbound/types.ts';
import { directSendWithinQuietWindow } from '@fss/domain/mail/directSendRecency.ts';
import { readFollowUpPermission } from '@fss/domain/sequences/followUpPermissions.ts';
import { composeSendBody, SEND_FOOTER_POLICY, sendBodyIssue } from '@fss/domain/src/rules/templates.ts';
import {
  CHANNEL_ACTION_KINDS,
  assignmentSource,
  coldOutreachTransportSource,
  composeEligibility,
  controlModeSource,
  emailRouteSource,
  enrollmentSource,
  firmExclusivitySource,
  followUpPermissionSource,
  holdSource,
  mailboxSource,
  suppressionSource,
  templateApprovalSource,
  type StepEligibilityInput,
  type StepEligibilityOutcome,
} from '@fss/domain/sequences/eligibility.ts';
import { readEnrollment, readStepExecution } from '@fss/domain/sequences/rows.ts';
import type { EnrollmentRow } from '@fss/domain/sequences/types.ts';
import { readSetting } from '@fss/domain/settings/store.ts';
import { firstSuppressed } from '@fss/domain/suppression/effective.ts';
import { REACHED_OUTCOMES } from '@fss/domain/dial/outcomes.ts';
import { businessDateOf } from '@fss/domain/today/snapshots.ts';
import { reconcileOutboundMessage } from '@fss/domain/outbound/reconcile.ts';
import { readSentMessageBytes, scanSentFolder } from '@fss/domain/outbound/sentFolder.ts';
import { openHold, releaseHold } from '@fss/domain/policy/holds.ts';
import { ALL_BLOCKED_ACTION_KINDS } from '@fss/domain/policy/types.ts';
import { putReleaseRecord, readReleaseRecord, type StoredReleaseRecord } from '@fss/domain/release/records.ts';
import { replaySuppressionJournal, type SuppressionJournalSource } from '@fss/domain/suppression/replay.ts';
import {
  RESTORE_ACTOR,
  listOpenHolds,
  listWorkspaceIds,
  recoverSentFolderMessage,
  type SentMessageRecovery,
} from '@fss/domain/restore';
import { HOLD_REASON_CODES, releaseRecordSource, sendingEnabledSettingSchema, type HoldReasonCode } from '@fss/contracts';
import type { MailWorkerOptions } from '../../handlers/mail.ts';
import type { ToolConfig } from './config.ts';
import { readOnlyGmail } from './readOnlyGmail.ts';

/**
 * The `fss admin` commands (lane G12g).
 *
 * Every one of them wraps a function that already exists and adds three things and
 * nothing else: the scope, the transaction, and the JSON shape it prints. No command
 * here decides anything the domain has not already decided — a restore
 * (`docs/greenfield/runbooks/restore.md`) and a release run the same code the worker
 * runs, from a command line, once.
 */

export interface AdminInvocation {
  readonly session: SessionQueryable;
  readonly config: ToolConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly options: Readonly<Record<string, string>>;
  readonly switches: ReadonlySet<string>;
  /** Injected by the tests; resolved from the deployment in production. */
  readonly journalSource?: SuppressionJournalSource | undefined;
  readonly mail?: MailWorkerOptions | undefined;
  /**
   * A session on another database host with this task's own runtime credential: the
   * instance being replaced, which `mailbox reconcile-sent` reads its inventory from.
   * The caller closes it.
   */
  readonly connectElsewhere?: ((host: string) => Promise<ElsewhereSession>) | undefined;
  /**
   * Who launched this one-off task, as the launcher's shell verified it (`aws sts
   * get-caller-identity`, passed as FSS_LAUNCHED_BY), and the task's own ARN from the ECS
   * metadata endpoint. CloudTrail's RunTask event for that ARN names the same caller and
   * the same override, which is what makes the pair checkable. Null outside ECS.
   */
  readonly launch?: LaunchIdentity | undefined;
}

export interface ElsewhereSession {
  readonly session: SessionQueryable;
  close(): Promise<void>;
}

export interface LaunchIdentity {
  readonly launchedBy: string | null;
  readonly taskArn: string | null;
}

export type AdminOutcome =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly detail: string;
      /**
       * What the command got as far as, when a refusal still has a report worth reading
       * (`mailbox reconcile-sent`, whose refusal lists the sends an operator must settle).
       * Printed on stdout like an answer, and the exit code still says refused.
       */
      readonly report?: Readonly<Record<string, unknown>>;
    };

const accept = (value: Readonly<Record<string, unknown>>): AdminOutcome => ({ ok: true, value });
const refuse = (reason: string, detail: string): AdminOutcome => ({ ok: false, reason, detail });

/** What a hold opened for an unattached send names as its source (`--hold-unattached`). */
export const UNATTACHED_SEND_HOLD_SOURCE = 'restore.unattached_send';

// ---------------------------------------------------------------------------
// The holds.
// ---------------------------------------------------------------------------

const isHoldReason = (value: string): value is HoldReasonCode => (HOLD_REASON_CODES as readonly string[]).includes(value);

export async function holdsListCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const reason = invocation.options['--reason'];
  const excludeReason = invocation.options['--exclude-reason'];
  // A misspelt reason is a refusal, not an empty list that reads as "none are open".
  for (const value of [reason, excludeReason]) {
    if (value !== undefined && !isHoldReason(value)) {
      return refuse('reason_unknown', `${value} is not a hold reason code; the codes are ${HOLD_REASON_CODES.join(', ')}`);
    }
  }
  const holds = await listOpenHolds(invocation.session, {
    reason: reason as HoldReasonCode | undefined,
    excludeReason: excludeReason as HoldReasonCode | undefined,
  });
  return accept({ count: holds.length, reason: reason ?? null, excludeReason: excludeReason ?? null, holds });
}

/** An IAM or STS principal ARN: what `aws sts get-caller-identity` answers. */
const PRINCIPAL_ARN = /^arn:aws:(sts|iam)::\d{12}:(assumed-role|user|role)\/[\w+=,.@/-]+$/u;

/** An ECS task ARN: what the task metadata endpoint's `TaskARN` is. */
const TASK_ARN = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/[\w-]+\/[A-Za-z0-9]+$/u;

/**
 * How an unattached-send hold may be settled, as `holds release-restore --resolution`
 * says: by a person, and only by a person (lane W3-S8 fourth review).
 *
 * `ended-every-candidate` went. Ending the enrollments recorded when the hold opened is
 * not a lasting fence: they are only those whose routes matched at reconciliation, and a
 * new enrollment of the same contact is allowed once none is live (the one-live-enrollment
 * index covers live rows only), and would start the sequence again. A durable
 * recipient-level "never send this step again" record needs a table the send gate and the
 * enrollment path both consult, and none exists without a migration: a fence belongs to
 * one step execution, a suppression or an inactive contact stops every future email to
 * the person, and a hold has no contact scope. So the release is a human decision,
 * recorded as `basis: human_attestation`, with what the runbook says to verify.
 */
export const UNATTACHED_RESOLUTIONS = ['checked-no-duplicate'] as const;

/** What the opening audit row of an unattached-send hold recorded (`holdUnattachedSend`). */
async function unattachedHoldOpening(
  session: SessionQueryable,
  hold: { readonly workspaceId: string; readonly id: string },
): Promise<{ readonly enrollmentIds: readonly string[] } | null> {
  const { rows } = await session.query<{ detail: { enrollmentIds?: unknown } }>(
    `SELECT detail FROM audit_events
      WHERE workspace_id = $1 AND action = 'hold.restore_opened' AND subject_kind = 'hold' AND subject_id = $2
      ORDER BY occurred_at LIMIT 1`,
    [hold.workspaceId, hold.id],
  );
  const detail = rows[0]?.detail;
  if (detail === undefined) return null;
  const ids = Array.isArray(detail.enrollmentIds) ? detail.enrollmentIds.filter((id): id is string => typeof id === 'string') : [];
  return { enrollmentIds: ids };
}

/** The enrollments recorded when an unattached-send hold opened, and whether each has ended now. */
async function candidateStates(
  session: SessionQueryable,
  hold: { readonly workspaceId: string; readonly id: string },
): Promise<readonly { readonly enrollmentId: string; readonly ended: boolean }[]> {
  const ids = (await unattachedHoldOpening(session, hold))?.enrollmentIds ?? [];
  if (ids.length === 0) return [];
  const { rows } = await session.query<{ id: string; ended: boolean }>(
    `SELECT c.id::text AS id, COALESCE(e.ended_at IS NOT NULL, false) AS ended
       FROM unnest($2::uuid[]) AS c(id)
       LEFT JOIN sequence_enrollments e ON e.workspace_id = $1 AND e.id = c.id
      ORDER BY c.id`,
    [hold.workspaceId, [...ids]],
  );
  return rows.map(row => ({ enrollmentId: row.id, ended: row.ended }));
}

/**
 * `fss admin holds release-restore --note <text> [--hold <id>] [--resolution <how>]`.
 *
 * The audited clearance of a `restore_in_progress` hold (lane W3-S8). Nothing opens one
 * since the generation check went except `reconcile-sent --hold-unattached`, and the
 * generation advance that released them went with it. So without this, a hold left from
 * before, or one a restore opened, would block sending and dialing for good.
 *
 * **Who.** The principal the launcher claims (`FSS_LAUNCHED_BY`, which the runbook's
 * `fss_task` takes from `aws sts get-caller-identity`) and the task ARN from the ECS
 * metadata endpoint (`AdminInvocation.launch`), never a user id the caller types. The
 * principal is checked for ARN syntax only: it is an auditable claim, not a verified
 * identity, and what makes it auditable is the task ARN, whose CloudTrail RunTask event
 * names the real caller (the runbook's `audit_launch` compares the two). It refuses
 * without a principal, and without a task ARN. Each audit row names both in its detail, with
 * `actor_kind = 'system'`, because the tool is never a user.
 *
 * **Which.** Without `--hold`, every open restore hold from before, but never one a
 * restore opened for an unattached send: those are released one at a time, by id, with
 * `--resolution`, and they are reported under `needsResolution` otherwise.
 * The only resolution is `checked-no-duplicate` (`UNATTACHED_RESOLUTIONS` says why): a
 * human attestation, not a checked fact, whose note says what was verified. The audit row
 * records it as `basis: human_attestation`, with the enrollments recorded when the hold
 * opened and whether each had ended at release.
 *
 * **How.** `releaseHold` with the reason in the UPDATE itself, and one `audit_events` row
 * (`hold.restore_released`) per hold in the same transaction. A named hold already
 * released answers `outcome: 'already_released'`, exit 0, and releases nothing.
 */
export async function holdsReleaseRestoreCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const launchedBy = invocation.launch?.launchedBy ?? null;
  const taskArn = invocation.launch?.taskArn ?? null;
  if (launchedBy === null || !PRINCIPAL_ARN.test(launchedBy)) {
    return refuse(
      'launcher_unknown',
      'the task names no verified launcher: fss_task passes FSS_LAUNCHED_BY from `aws sts get-caller-identity`, and a release is attributed to nobody else',
    );
  }
  // Every release is tied to the task that made it (fourth review): without the task ARN
  // nothing can check the launcher's claim against CloudTrail, so a run outside ECS, or
  // one whose metadata endpoint named no task, releases nothing.
  if (taskArn === null || !TASK_ARN.test(taskArn)) {
    return refuse(
      'task_unknown',
      'the release names no ECS task, so its launcher cannot be checked against CloudTrail: run it as a one-off task (fss_task), where the metadata endpoint names the task',
    );
  }
  const note = (invocation.options['--note'] ?? '').trim();
  if (note.length === 0 || note.length > 500) {
    return refuse('note_invalid', '--note says why the hold is released, in at most 500 characters');
  }
  const resolution = invocation.options['--resolution'];
  if (resolution !== undefined && !(UNATTACHED_RESOLUTIONS as readonly string[]).includes(resolution)) {
    return refuse('resolution_unknown', `--resolution is one of ${UNATTACHED_RESOLUTIONS.join(', ')}`);
  }
  const named = invocation.options['--hold'];
  let candidatesAtRelease: readonly { readonly enrollmentId: string; readonly ended: boolean }[] = [];

  const open = await listOpenHolds(invocation.session, { reason: 'restore_in_progress' });
  let chosen: readonly (typeof open)[number][];
  if (named === undefined) {
    chosen = open.filter(hold => hold.sourceEventKind !== UNATTACHED_SEND_HOLD_SOURCE);
  } else {
    chosen = open.filter(hold => hold.id === named);
    if (chosen.length === 0) {
      const { rows } = await invocation.session.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM active_holds
          WHERE id::text = $1 AND reason_code = 'restore_in_progress' AND released_at IS NOT NULL`,
        [named],
      );
      if (rows.length > 0) {
        return accept({ outcome: 'already_released', released: 0, alreadyReleased: [named], holds: [], needsResolution: [], launchedBy, taskArn });
      }
      return refuse('hold_unknown', 'no restore_in_progress hold has that id');
    }
    const hold = chosen[0];
    if (hold !== undefined && hold.sourceEventKind === UNATTACHED_SEND_HOLD_SOURCE) {
      if (resolution === undefined) {
        return refuse('resolution_missing', `a hold opened for an unattached send is released with --resolution ${UNATTACHED_RESOLUTIONS.join(' | ')}, once the send is settled`);
      }
      candidatesAtRelease = await candidateStates(invocation.session, hold);
    }
  }
  const needsResolution =
    named === undefined ? open.filter(hold => hold.sourceEventKind === UNATTACHED_SEND_HOLD_SOURCE).map(hold => hold.id) : [];

  const released: Record<string, unknown>[] = [];
  for (const hold of chosen) {
    const context = repositoryContext(workspaceScope(hold.workspaceId, RESTORE_ACTOR), invocation.session);
    const outcome = await withTransaction(invocation.session, async () => {
      const done = await releaseHold(context, hold.id, 'restore_in_progress');
      if (done === null) return null;
      await invocation.session.query(
        `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
         VALUES ($1, 'system', NULL, 'hold.restore_released', 'hold', $2, $3::jsonb)`,
        [
          hold.workspaceId,
          hold.id,
          JSON.stringify({
            note,
            launchedBy,
            taskArn,
            source: hold.sourceEventKind,
            // What the release rests on: a person's word, and what they had in front of them.
            ...(hold.sourceEventKind === UNATTACHED_SEND_HOLD_SOURCE
              ? { resolution, basis: 'human_attestation', candidatesAtRelease }
              : {}),
            startedAt: done.startedAt,
            releasedAt: done.releasedAt,
            via: 'fss admin holds release-restore',
          }),
        ],
      );
      return done;
    });
    if (outcome !== null) {
      released.push({ workspaceId: hold.workspaceId, holdId: hold.id, startedAt: outcome.startedAt, releasedAt: outcome.releasedAt });
    }
  }
  const others = await listOpenHolds(invocation.session, { excludeReason: 'restore_in_progress' });
  return accept({
    outcome: released.length > 0 ? 'released' : 'nothing_to_release',
    released: released.length,
    holds: released,
    alreadyReleased: [],
    needsResolution,
    otherHoldsStillOpen: others.length,
    launchedBy,
    taskArn,
  });
}

// ---------------------------------------------------------------------------
// The suppression journal replay (runbook step 5).
// ---------------------------------------------------------------------------

export async function suppressionJournalReplayCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const source = invocation.journalSource;
  if (source === undefined) {
    return refuse(
      'journal_unconfigured',
      'FSS_JOURNAL_BUCKET and AWS_REGION are what a replay reads; without them there is nothing to replay from',
    );
  }
  const from = invocation.options['--from'] ?? '';
  const to = invocation.options['--to'];
  const records = await source.read(from, to);

  const byWorkspace = new Map<string, typeof records>();
  for (const record of records) {
    byWorkspace.set(record.workspaceId, [...(byWorkspace.get(record.workspaceId) ?? []), record]);
  }

  let inserted = 0;
  let alreadyPresent = 0;
  let foreign = 0;
  let finalized = 0;
  let windowsReopened = 0;
  let released = 0;
  // Brief RF: the journal objects a replay skipped, by id only (no key, no address).
  const competingSupersessions: string[] = [];
  const orphanSupersessions: string[] = [];
  const staleCorrections: string[] = [];
  const unreconstructedHolds: string[] = [];
  const unverifiedLegacyReleases: string[] = [];
  for (const [workspaceId, forWorkspace] of byWorkspace) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), invocation.session);
    const report = await withTransaction(invocation.session, async () =>
      replaySuppressionJournal(context, { records: forWorkspace }),
    );
    inserted += report.inserted;
    alreadyPresent += report.alreadyPresent;
    foreign += report.foreign;
    finalized += report.finalized;
    windowsReopened += report.windowsReopened;
    released += report.released;
    competingSupersessions.push(...report.competingSupersessions);
    orphanSupersessions.push(...report.orphanSupersessions);
    staleCorrections.push(...report.staleCorrections);
    unreconstructedHolds.push(...report.unreconstructedHolds);
    unverifiedLegacyReleases.push(...report.unverifiedLegacyReleases);
  }

  return accept({
    from,
    to: to ?? null,
    read: records.length,
    inserted,
    alreadyPresent,
    foreign,
    finalized,
    windowsReopened,
    released,
    competingSupersessions,
    orphanSupersessions,
    staleCorrections,
    // Review P3: manual handle stops whose review hold the journal cannot say. The count is
    // the line an operator reads; the ids are the stops to look at.
    unreconstructedHoldCount: unreconstructedHolds.length,
    unreconstructedHolds,
    // RF reset, J3: releases journalled before the reset, not applied. David lifts again.
    unverifiedLegacyReleaseCount: unverifiedLegacyReleases.length,
    unverifiedLegacyReleases,
    workspaces: byWorkspace.size,
  });
}

// ---------------------------------------------------------------------------
// The mailboxes, and the Sent-folder reconciliation (runbook step d).
// ---------------------------------------------------------------------------

/** One mailbox row as the restore commands read it, in any status. */
interface RestoreMailbox {
  readonly workspaceId: string;
  readonly id: string;
  readonly ownerUserId: string;
  readonly address: string;
  readonly status: string;
}

/** Every mailbox this database has, whatever its status, oldest workspace first. */
async function everyMailbox(session: SessionQueryable): Promise<readonly RestoreMailbox[]> {
  const found: RestoreMailbox[] = [];
  for (const workspaceId of await listWorkspaceIds(session)) {
    const { rows } = await session.query<{ id: string; owner_user_id: string; email_address: string; status: string }>(
      `SELECT id, owner_user_id, email_address, status FROM mailboxes WHERE workspace_id = $1 ORDER BY email_address, id`,
      [workspaceId],
    );
    for (const row of rows) {
      found.push({
        workspaceId,
        id: row.id,
        ownerUserId: row.owner_user_id,
        address: row.email_address.trim().toLowerCase(),
        status: row.status,
      });
    }
  }
  return found;
}

/**
 * `fss admin mailbox list`. Read-only: every mailbox with its address and status, on
 * whichever instance the task points at. `reconcile-sent` no longer takes its output:
 * it reads the instance being replaced itself (`--inventory-host`).
 */
export async function mailboxListCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const mailboxes = await everyMailbox(invocation.session);
  return accept({
    count: mailboxes.length,
    mailboxes: mailboxes.map(mailbox => ({
      workspaceId: mailbox.workspaceId,
      mailboxId: mailbox.id,
      address: mailbox.address,
      status: mailbox.status,
    })),
  });
}

/** What a restore marker is audited as (`restore-marker put`). */
const RESTORE_MARKER_ACTION = 'restore.inventory_marker';
const MARKER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** An RDS instance's `DbiResourceId`, which a rename does not change. */
const DBI_RESOURCE_ID = /^db-[A-Z0-9]{8,}$/u;

/** What a restore marker binds: the restore point and the instance it was written to. */
interface MarkerBinding {
  readonly restorePoint: string;
  readonly instance: string;
}

/** Every audit row on this instance carrying the marker, with what it was bound to and when. */
async function markerRows(
  session: SessionQueryable,
  marker: string,
): Promise<readonly { readonly restorePoint: unknown; readonly instance: unknown; readonly occurredAt: string }[]> {
  const { rows } = await session.query<{ detail: { restorePoint?: unknown; instance?: unknown }; occurred_at: Date | string }>(
    `SELECT detail, occurred_at FROM audit_events WHERE action = $1 AND subject_kind = 'restore' AND subject_id = $2`,
    [RESTORE_MARKER_ACTION, marker],
  );
  return rows.map(row => ({
    restorePoint: row.detail.restorePoint,
    instance: row.detail.instance,
    occurredAt: new Date(row.occurred_at).toISOString(),
  }));
}

/** The binding options of `restore-marker put` and `reconcile-sent`, checked; or why not. */
function readBinding(
  restorePoint: string | undefined,
  instance: string | undefined,
): { readonly ok: true; readonly binding: MarkerBinding } | { readonly ok: false; readonly detail: string } {
  const at = Date.parse(restorePoint ?? '');
  if (!Number.isFinite(at)) return { ok: false, detail: '--restore-point is the restore point T, an ISO instant' };
  if (!DBI_RESOURCE_ID.test(instance ?? '')) {
    return { ok: false, detail: 'the instance is the DbiResourceId (db-...) the runbook pinned for the instance being replaced' };
  }
  return { ok: true, binding: { restorePoint: new Date(at).toISOString(), instance: instance ?? '' } };
}

/**
 * `fss admin restore-marker put --marker <uuid> --restore-point <T> --instance <dbi>`
 * (lane W3-S8 third and fourth reviews).
 *
 * A text hostname does not say which RDS instance answers it, and a restored copy is a
 * physical copy with the same system identifier and the same roles. What tells the
 * instance being replaced from the copy is a write made to it after the restore point:
 * the runbook runs this in (a), on the operations task, against the instance production
 * still points at and whose `DbiResourceId` it pinned, before anything stops (so it is
 * also the proof that the runtime login works there). It inserts one audit row per
 * workspace, `restore.inventory_marker`, bound to this restore's point and that
 * `DbiResourceId`; a rerun adds nothing, and a marker already bound to another restore is
 * refused (`marker_reused`), so every restore writes its own.
 *
 * It is a state witness, not an identity: anything holding the runtime credential could
 * write such a row. The identity is the runbook's, which pins both instances through the
 * RDS API; the marker is what lets this command tell, from inside the database, that the
 * inventory host received a write after the restore point and the copy did not.
 */
export async function restoreMarkerPutCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const marker = (invocation.options['--marker'] ?? '').trim().toLowerCase();
  if (!MARKER.test(marker)) return refuse('marker_invalid', '--marker is a UUID the runbook generated for this restore');
  const bound = readBinding(invocation.options['--restore-point'], invocation.options['--instance']);
  if (!bound.ok) return refuse('marker_invalid', bound.detail);
  const { binding } = bound;
  const prior = await markerRows(invocation.session, marker);
  if (prior.some(row => row.restorePoint !== binding.restorePoint || row.instance !== binding.instance)) {
    return refuse('marker_reused', 'this marker is already bound to another restore point or instance: every restore writes a fresh one');
  }
  let written = 0;
  let existing = 0;
  const workspaces = await listWorkspaceIds(invocation.session);
  if (workspaces.length === 0) return refuse('marker_nowhere', 'this instance has no workspace, so it is not the instance being replaced');
  for (const workspaceId of workspaces) {
    const inserted = await invocation.session.query(
      `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
       SELECT $1, 'system', NULL, $2, 'restore', $3, $4::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_events WHERE workspace_id = $1 AND action = $2 AND subject_kind = 'restore' AND subject_id = $3)`,
      [workspaceId, RESTORE_MARKER_ACTION, marker, JSON.stringify({ marker, ...binding, via: 'fss admin restore-marker put' })],
    );
    if ((inserted.rowCount ?? 0) > 0) written += 1;
    else existing += 1;
  }
  const { rows } = await invocation.session.query<{ at: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`);
  return accept({ marker, ...binding, workspaces: workspaces.length, written, existing, at: rows[0]?.at ?? null });
}

/** A DNS hostname as `active_database_host` takes one: lower case, at least one dot, no port. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** The host this invocation's own session connects to: the copy, during a restore. */
function ownHost(config: ToolConfig): string | null {
  if (config.database === null) return null;
  try {
    return new URL(config.database.connectionString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

type InventoryRead =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly outcome: AdminOutcome };

/**
 * Every mailbox connection an instance's audit trail records (`mailbox.connected`, written
 * by `connectMailbox` in the same transaction as the mailbox row). `audit_events` is
 * append-only for both application roles, so what the application damaged there it
 * could only have added to.
 */
async function auditedConnections(
  session: SessionQueryable,
): Promise<readonly { readonly workspaceId: string; readonly mailboxId: string; readonly address: string }[]> {
  const { rows } = await session.query<{ workspace_id: string; subject_id: string | null; address: string | null }>(
    `SELECT DISTINCT workspace_id, subject_id, lower(btrim(detail->>'emailAddress')) AS address
       FROM audit_events
      WHERE action = 'mailbox.connected' AND subject_kind = 'mailbox'
      ORDER BY workspace_id, subject_id, address`,
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, mailboxId: row.subject_id ?? '', address: row.address ?? '' }));
}

/**
 * The inventory: every mailbox address the instance being replaced has, in any status,
 * and every address its audit trail says was ever connected, read by this command itself
 * from `--inventory-host` with this task's runtime credential. Nobody types it (lane
 * W3-S8 review). A hostname does not say which instance answers it, so the instance is
 * identified by `--inventory-marker` (third review): the copy must not have the marker
 * the runbook wrote in (a) (`inventory_marker_in_copy`) and the inventory host must
 * (`inventory_marker_missing`). It refuses the copy's own host; a host it cannot read,
 * which is the deleted-source case (`inventory_unreadable`); an instance with no mailbox; and an
 * instance whose mailbox rows were damaged (`inventory_source_incomplete`): one that lacks
 * a mailbox the copy has, or one its own audit trail records connecting. The application
 * never deletes a mailbox row, so either means its list cannot be the whole list.
 */
async function readInventory(
  invocation: AdminInvocation,
  copy: readonly RestoreMailbox[],
): Promise<InventoryRead> {
  const host = (invocation.options['--inventory-host'] ?? '').trim().toLowerCase();
  if (!HOSTNAME.test(host)) {
    return {
      ok: false,
      outcome: refuse('inventory_host_invalid', '--inventory-host is the address of the instance being replaced: a hostname, no port'),
    };
  }
  if (host === ownHost(invocation.config)) {
    return {
      ok: false,
      outcome: refuse(
        'inventory_host_is_the_copy',
        'the inventory comes from the instance being replaced, never from the copy being reconciled, which cannot know a mailbox connected after the restore point',
      ),
    };
  }
  // Which instance, not which name (lane W3-S8 third and fourth reviews): the copy must
  // lack the marker (a) wrote, and the inventory host must have it, bound to this
  // restore's point and the pinned instance, and written after that point.
  const marker = (invocation.options['--inventory-marker'] ?? '').trim().toLowerCase();
  if (!MARKER.test(marker)) {
    return { ok: false, outcome: refuse('inventory_marker_invalid', '--inventory-marker is the UUID (a) wrote with restore-marker put') };
  }
  const bound = readBinding(invocation.options['--restore-point'], invocation.options['--inventory-instance']);
  if (!bound.ok) return { ok: false, outcome: refuse('inventory_marker_invalid', bound.detail) };
  const { binding } = bound;
  if (Date.parse(invocation.options['--since'] ?? '') > Date.parse(binding.restorePoint)) {
    return { ok: false, outcome: refuse('since_after_restore_point', '--since is the restore point less ten minutes, never after it') };
  }
  if ((await markerRows(invocation.session, marker)).length > 0) {
    return {
      ok: false,
      outcome: refuse(
        'inventory_marker_in_copy',
        'the database this task reaches already has the marker (a) wrote to the instance being replaced, so it is not a copy from before (a): it may be that instance itself',
      ),
    };
  }
  const unreadable = (why: string): InventoryRead => ({
    ok: false,
    outcome: refuse(
      'inventory_unreadable',
      `the instance being replaced at ${host} could not be read (${why}): without it nothing establishes which mailboxes could have sent since the restore point, and nothing starts`,
    ),
  });
  if (invocation.connectElsewhere === undefined) return unreadable('this invocation cannot reach another host');
  let source: readonly RestoreMailbox[];
  let audited: Awaited<ReturnType<typeof auditedConnections>>;
  let marked: Awaited<ReturnType<typeof markerRows>>;
  try {
    const elsewhere = await invocation.connectElsewhere(host);
    try {
      marked = await markerRows(elsewhere.session, marker);
      source = await everyMailbox(elsewhere.session);
      audited = await auditedConnections(elsewhere.session);
    } finally {
      await elsewhere.close();
    }
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return unreadable(typeof code === 'string' ? code : error instanceof Error ? error.name : 'error');
  }
  if (marked.length === 0) {
    return {
      ok: false,
      outcome: refuse(
        'inventory_marker_missing',
        `the instance at ${host} does not have the marker (a) wrote to the instance being replaced, so it is not that instance`,
      ),
    };
  }
  const matching = marked.filter(
    row =>
      row.restorePoint === binding.restorePoint &&
      row.instance === binding.instance &&
      Date.parse(row.occurredAt) > Date.parse(binding.restorePoint),
  );
  if (matching.length === 0) {
    return {
      ok: false,
      outcome: refuse(
        'inventory_marker_mismatch',
        `the marker at ${host} is not bound to restore point ${binding.restorePoint} and instance ${binding.instance}, or was written before that point`,
      ),
    };
  }
  if (source.length === 0) {
    return { ok: false, outcome: refuse('inventory_empty', `the instance at ${host} has no mailbox at all, so it is not the instance being replaced`) };
  }
  const sourceIds = new Set(source.map(mailbox => mailbox.id));
  const missing = [
    ...new Set([
      ...copy.filter(mailbox => !sourceIds.has(mailbox.id)).map(mailbox => mailbox.id),
      ...audited.filter(entry => !sourceIds.has(entry.mailboxId)).map(entry => entry.mailboxId || '(no id)'),
    ]),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      outcome: refuse(
        'inventory_source_incomplete',
        `the instance at ${host} lacks mailbox(es) the copy has or its own audit trail records connecting (${missing.join(', ')}): the application never deletes a mailbox row, so its list cannot be the whole list`,
      ),
    };
  }
  const addresses = [...source.map(mailbox => mailbox.address), ...audited.map(entry => entry.address)].filter(a => a.length > 0);
  return { ok: true, addresses: [...new Set(addresses)].sort() };
}

/**
 * `--hold-unattached`: a send no single step can be named for holds what it could belong
 * to instead of stopping the restore. One `restore_in_progress` hold per firm it names,
 * or one on the workspace when it names none (`recipient_unreadable`), each blocking
 * every action kind, keyed by the message's hash so a rerun opens nothing twice. The
 * holds outlive the restore until an admin has checked the Sent message, ended the
 * duplicate, and released them with `fss admin holds release-restore`.
 */
async function holdUnattachedSend(
  context: ReturnType<typeof repositoryContext>,
  input: {
    readonly message: string;
    readonly mailboxId: string;
    readonly sentAt: string;
    readonly reason: string;
    readonly firmIds: readonly string[];
    readonly enrollmentIds: readonly string[];
  },
): Promise<readonly string[]> {
  const { message } = input;
  const scopes: readonly (string | null)[] = input.firmIds.length === 0 ? [null] : input.firmIds;
  const holdIds: string[] = [];
  for (const firmId of scopes) {
    const { rows } = await context.db.query<{ id: string }>(
      `SELECT id FROM active_holds
        WHERE workspace_id = $1 AND reason_code = 'restore_in_progress' AND released_at IS NULL
          AND source_event_kind = $2 AND source_event_id = $3 AND scope_key IS NOT DISTINCT FROM $4`,
      [context.scope.workspaceId, UNATTACHED_SEND_HOLD_SOURCE, message, firmId],
    );
    const existing = rows[0]?.id;
    if (existing !== undefined) {
      holdIds.push(existing);
      continue;
    }
    const holdId = await openHold(context, {
      scopeKind: firmId === null ? 'workspace' : 'firm',
      ...(firmId === null ? {} : { scopeKey: firmId }),
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: UNATTACHED_SEND_HOLD_SOURCE,
      sourceEventId: message,
      // Settled by a person who can see the Sent message; released afterwards with
      // `fss admin holds release-restore --resolution`, which audits it.
      recoveryAction: 'resolve_ambiguity',
    });
    // The opening is audited like the release: what was held, why, and among which
    // enrollments a person settles it (`holds release-restore` reads them back).
    await context.db.query(
      `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
       VALUES ($1, 'system', NULL, 'hold.restore_opened', 'hold', $2, $3::jsonb)`,
      [
        context.scope.workspaceId,
        holdId,
        JSON.stringify({
          source: UNATTACHED_SEND_HOLD_SOURCE,
          message,
          mailboxId: input.mailboxId,
          sentAt: input.sentAt,
          reason: input.reason,
          scope: firmId === null ? 'workspace' : 'firm',
          firmId,
          enrollmentIds: input.enrollmentIds,
          via: 'fss admin mailbox reconcile-sent --hold-unattached',
        }),
      ],
    );
    holdIds.push(holdId);
  }
  return holdIds;
}

/** How many in-doubt fences one query reads before asking for the next page. */
export const RECONCILE_FENCE_PAGE_SIZE = 200;

/**
 * Every fence of one mailbox left `dispatching` or `reconciling` since `since`, however
 * many there are: read a page at a time in id order, never capped.
 */
export async function inDoubtFenceIds(
  session: SessionQueryable,
  input: { readonly workspaceId: string; readonly mailboxId: string; readonly since: string },
  pageSize: number = RECONCILE_FENCE_PAGE_SIZE,
): Promise<readonly string[]> {
  const ids: string[] = [];
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await session.query<{ id: string }>(
      `SELECT id FROM outbound_messages
        WHERE workspace_id = $1 AND mailbox_id = $2
          AND state IN ('reconciling', 'dispatching')
          AND (dispatch_started_at IS NULL OR dispatch_started_at >= $3::timestamptz)
          AND id > $4::uuid
        ORDER BY id
        LIMIT $5`,
      [input.workspaceId, input.mailboxId, input.since, after, pageSize],
    );
    ids.push(...rows.map(row => row.id));
    const last = rows[rows.length - 1];
    if (rows.length < pageSize || last === undefined) return ids;
    after = last.id;
  }
}

/**
 * A Message-ID as a report may keep it (lane g73): the first sixteen hex digits of its
 * SHA-256. The report outlives the one-off task in its log, and an id that names a
 * mailbox's domain and a fence has no business there; the hash still lets an operator
 * holding the Sent message match it to a line.
 */
export function redactedMessageId(rfcMessageId: string): string {
  return createHash('sha256').update(rfcMessageId, 'utf8').digest('hex').slice(0, 16);
}

/** One Sent-folder send in the report: its hash, what it became, and why. */
function missingFenceLine(workspaceId: string, mailboxId: string, message: string, recovery: SentMessageRecovery): Record<string, unknown> {
  const base = { workspaceId, mailboxId, message, outcome: recovery.outcome };
  switch (recovery.outcome) {
    case 'present':
      return { ...base, outboundMessageId: recovery.outboundMessageId, state: recovery.state };
    case 'pre_dispatch_marked_sent':
      return {
        ...base,
        outboundMessageId: recovery.outboundMessageId,
        stepExecutionId: recovery.stepExecutionId,
        stepCompleted: recovery.stepCompleted,
        sentBytesVerified: recovery.sentBytesVerified,
        ...(recovery.sentBytesUnverifiedReason === undefined
          ? {}
          : { sentBytesUnverifiedReason: recovery.sentBytesUnverifiedReason }),
      };
    case 'tombstoned':
      return {
        ...base,
        outboundMessageId: recovery.outboundMessageId,
        stepExecutionId: recovery.stepExecutionId,
        enrollmentId: recovery.enrollmentId,
        stepCompleted: recovery.stepCompleted,
      };
    case 'unmatched':
      return { ...base, reason: recovery.reason };
    case 'unattached':
      return { ...base, reason: recovery.reason, firmIds: recovery.firmIds, enrollmentIds: recovery.enrollmentIds };
  }
}

/**
 * `fss admin mailbox reconcile-sent --since <instant> --restore-point <T> --inventory-host <host> --inventory-marker <uuid> --inventory-instance <dbi> [--hold-unattached]`.
 *
 * After a point-in-time restore, against the restored copy, with both services stopped
 * (`docs/greenfield/runbooks/restore.md`). A send made after the restore point is a
 * message in Gmail with no fence in the copy, and nothing in the sender would stop it
 * going again; this puts the fences back.
 *
 * **Which mailboxes.** Every address the instance being replaced has, or its audit trail
 * says was ever connected (`readInventory`, from `--inventory-host`, identified as that
 * instance by `--inventory-marker` rather than by its name), never only the
 * copy's, which cannot know a mailbox connected after the restore point; nobody types the
 * list, and a source that cannot be read stops everything. Each inventory address is read
 * in whatever status the copy has it; an address the copy has no mailbox for is
 * `mailbox_not_in_copy`. A connected mailbox of the copy whose address the inventory lacks
 * is read and reported `mailbox_not_in_inventory`.
 *
 * **The fences the copy holds.** Every fence in `dispatching` or `reconciling` started
 * since `--since` goes through `reconcileOutboundMessage`, the sweep's own function, a
 * page at a time and never capped: a Message-ID the Sent folder holds makes it `sent`.
 *
 * **The fences it lost (lane g73).** Then each mailbox's Sent folder is listed from
 * `--since` to now, and every message carrying FSS's marker for that mailbox is answered by
 * `recoverSentFolderMessage`, one transaction each: a lost fence is inserted as a `sent`
 * tombstone (`missing_fences_tombstoned`); a fence left `prepared` or `held` is recorded
 * sent (`pre_dispatch_fences_marked_sent`); a send nothing in the copy could repeat is
 * reported (`missing_fences_unmatched`); and a send that cannot be tied to one step is
 * **unattached**. With `--hold-unattached`, each unattached send instead holds the firms
 * it could belong to (`holdUnattachedSend`) and is reported under `unattached_held`.
 *
 * **It refuses to finish** (exit 20, the report still printed) while anything could let
 * a send repeat: an unattached send; a Sent folder not read to the end (`grant_revoked`,
 * `rate_limited`, `truncated`, `message_vanished`); an inventory address the copy lacks;
 * a connected mailbox the inventory lacks. `unresolved` lists each one, and a run that
 * read no mailbox at all is refused as `reconcile_no_coverage`. The runbook starts
 * nothing until a run exits 0.
 *
 * Gmail is only ever read: the client is `readOnlyGmail`, whatever the deployment built.
 * `--since` is the restore point minus ten minutes (`RESTORE_SENT_SCAN_SKEW_SECONDS`); the
 * folder's upper bound is this command's clock, because Gmail stamps the folder with real
 * time. Running it twice is running it once: each tombstone is `present` the second time.
 */
export async function mailboxReconcileSentCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const mail = invocation.mail;
  if (mail === undefined) return refuse('gmail_unconfigured', 'this deployment composed no Gmail client');
  const since = invocation.options['--since'] ?? '';
  if (!Number.isFinite(Date.parse(since))) {
    return refuse('since_invalid', '--since is the instant the Sent folder is read from: the restore point minus ten minutes');
  }
  const known = await everyMailbox(invocation.session);
  const read = await readInventory(invocation, known);
  if (!read.ok) return read.outcome;
  const inventory = read.addresses;
  // Inventory validation proves this is the restored copy. Revoke before any
  // external reconciliation; partial recovery must leave cold authority closed.
  for(const workspaceId of await listWorkspaceIds(invocation.session)) {
    await withTransaction(invocation.session,()=>revokeProspectingAfterRestore(repositoryContext(workspaceScope(workspaceId,RESTORE_ACTOR),invocation.session)));
  }

  const holdUnattached = invocation.switches.has('--hold-unattached');
  const unresolved: Record<string, unknown>[] = [];
  const unattachedHeld: Record<string, unknown>[] = [];
  const chosen = new Map<string, RestoreMailbox>();
  for (const address of inventory) {
    const matches = known.filter(mailbox => mailbox.address === address);
    if (matches.length === 0) unresolved.push({ kind: 'mailbox_not_in_copy', address });
    for (const mailbox of matches) chosen.set(mailbox.id, mailbox);
  }
  for (const mailbox of known) {
    if (mailbox.status !== 'connected' || inventory.includes(mailbox.address)) continue;
    unresolved.push({ kind: 'mailbox_not_in_inventory', workspaceId: mailbox.workspaceId, mailboxId: mailbox.id });
    chosen.set(mailbox.id, mailbox);
  }

  const until = new Date().toISOString();
  const deps = { gmail: readOnlyGmail(mail.gmail), oauth: mail.oauth, cipher: mail.cipher, actor: 'fss-admin' };

  let fencesReconciled = 0;
  const outcomes = { tombstoned: 0, pre_dispatch_marked_sent: 0, present: 0, unmatched: 0, unattached: 0 };
  let listed = 0;
  const missingFences: Record<string, unknown>[] = [];
  const mailboxes: Record<string, unknown>[] = [];
  for (const mailbox of chosen.values()) {
    const workspaceId = mailbox.workspaceId;
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), invocation.session);
    // `--since` bounds which fences are looked at; the Sent search's own window is the
    // fence's 24 hours (Appendix B). `reconcileMailbox` has no lower bound, so the bound
    // is applied here and each fence still goes through the one function that observes it.
    const fences = await inDoubtFenceIds(invocation.session, { workspaceId, mailboxId: mailbox.id, since });
    const fenceOutcomes: string[] = [];
    for (const id of fences) {
      const report = await withTransaction(invocation.session, async () =>
        reconcileOutboundMessage(context, deps, { outboundMessageId: id }),
      );
      fenceOutcomes.push(report.outcome);
      if (report.outcome === 'sent') fencesReconciled += 1;
    }

    const scan = await scanSentFolder(context, deps, { mailboxId: mailbox.id, since, until });
    listed += scan.listed;
    if (scan.outcome !== 'scanned') {
      unresolved.push({
        kind: 'sent_folder_unscanned',
        workspaceId,
        mailboxId: mailbox.id,
        outcome: scan.outcome,
        ...(scan.vanished > 0 ? { vanished: scan.vanished } : {}),
      });
    }
    for (const message of scan.messages) {
      const recovery = await withTransaction(invocation.session, async () =>
        recoverSentFolderMessage(context, {
          mailbox: { id: mailbox.id, ownerUserId: mailbox.ownerUserId },
          message,
          actor: deps.actor,
          // Only a fence this copy still holds as pre-dispatch reaches this reader, and
          // only then: the bytes it records must be the bytes Gmail has, because the
          // footer is composed at the claim and the restored body can predate it.
          readSentBytes: async sent =>
            await readSentMessageBytes(context, deps, {
              mailboxId: mailbox.id,
              providerMessageId: sent.providerMessageId,
            }),
        }),
      );
      outcomes[recovery.outcome] += 1;
      const line = missingFenceLine(workspaceId, mailbox.id, redactedMessageId(message.rfcMessageId), recovery);
      missingFences.push(line);
      if (recovery.outcome === 'pre_dispatch_marked_sent' && !recovery.sentBytesVerified) {
        // Recorded `sent` — never twice — but what it said is not proven. The runbook's
        // human step reads this list before the services start.
        unresolved.push({
          kind: 'sent_bytes_unverified',
          workspaceId,
          mailboxId: mailbox.id,
          outboundMessageId: recovery.outboundMessageId,
          message: redactedMessageId(message.rfcMessageId),
          ...(recovery.sentBytesUnverifiedReason === undefined
            ? {}
            : { reason: recovery.sentBytesUnverifiedReason }),
        });
      }
      if (recovery.outcome === 'unattached') {
        if (holdUnattached) {
          const { firmIds, enrollmentIds, reason } = recovery;
          const holdIds = await withTransaction(invocation.session, async () =>
            holdUnattachedSend(context, {
              message: redactedMessageId(message.rfcMessageId),
              mailboxId: mailbox.id,
              sentAt: message.sentAt,
              reason,
              firmIds,
              enrollmentIds,
            }),
          );
          unattachedHeld.push({ ...line, sentAt: message.sentAt, holdIds });
        } else {
          unresolved.push({ kind: 'unattached_sent_message', ...line, sentAt: message.sentAt });
        }
      }
    }
    mailboxes.push({
      workspaceId,
      mailboxId: mailbox.id,
      status: mailbox.status,
      fences: fences.length,
      outcomes: fenceOutcomes,
      sentFolder: { outcome: scan.outcome, listed: scan.listed, fssMessages: scan.messages.length, vanished: scan.vanished },
    });
  }

  const report = {
    since,
    until,
    inventory_host: (invocation.options['--inventory-host'] ?? '').trim().toLowerCase(),
    inventory_marker: (invocation.options['--inventory-marker'] ?? '').trim().toLowerCase(),
    inventory_instance: invocation.options['--inventory-instance'] ?? '',
    restore_point: invocation.options['--restore-point'] ?? '',
    inventory,
    mailboxes_scanned: mailboxes.length,
    fences_reconciled: fencesReconciled,
    missing_fences_tombstoned: outcomes.tombstoned,
    pre_dispatch_fences_marked_sent: outcomes.pre_dispatch_marked_sent,
    missing_fences_unmatched: outcomes.unmatched,
    missing_fences_unattached: outcomes.unattached,
    sent_folder_listed: listed,
    sent_folder_fss_messages: missingFences.length,
    sent_folder_present: outcomes.present,
    mailboxes_unscanned: unresolved.filter(item => item['kind'] === 'sent_folder_unscanned').length,
    unresolved,
    unattached_held: unattachedHeld,
    missing_fences: missingFences,
    mailboxes,
  };
  if (mailboxes.length === 0) {
    return {
      ok: false,
      reason: 'reconcile_no_coverage',
      detail: 'no mailbox was read: none of the inventory is in this database; a run that covered nothing proves nothing',
      report,
    };
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: 'reconcile_unresolved',
      detail: `${String(unresolved.length)} item(s) could let a send repeat: settle each one in "unresolved" and run again before starting the services`,
      report,
    };
  }
  return accept(report);
}

// ---------------------------------------------------------------------------
// The release record (lane g71; specification 16.2, Appendix G 42).
// ---------------------------------------------------------------------------

/** What an operator reads back: the fields the two rules compare, and when it was stored. */
function describeRecord(record: StoredReleaseRecord): Readonly<Record<string, unknown>> {
  return {
    reference: record.reference,
    // Lane g96: `ci-gate` or `rehearsal`, so the operator reads which gate certified it.
    source: releaseRecordSource(record.record),
    suite: record.suite,
    apiDigest: record.apiDigest,
    workerDigest: record.workerDigest,
    desktopCommitStamp: record.desktopCommitStamp,
    recordedAt: record.recordedAt,
    putAt: record.putAt,
    enablesSending: record.enablesSending,
  };
}

/**
 * `fss admin release-record put --json <file> | --json-base64 <value>`.
 *
 * Stores the `fss.release-record.v1` the CI gate (`record.sh from-ci`, lane g96)
 * or a green rehearsal wrote, so that an admin's
 * `sending_enabled` attestation can name it and both rules can read it: the API
 * compares its own digest with the record's `api` when the enable is saved, and the
 * worker compares its own with the record's `worker` before every dispatch. Putting a
 * record enables nothing — the record says `enablesSending: false` and the admin's act
 * is still the switch.
 *
 * `--json-base64` is the form `deploy.sh release` uses, because a one-off task can be
 * handed nothing but arguments and the record's JSON is braces, quotes and newlines.
 * Idempotent: the same record twice is `existing`; a different one under a reference
 * already stored is refused `release_record_conflict`, and nothing is ever replaced.
 */
export async function releaseRecordPutCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const path = invocation.options['--json'];
  const encoded = invocation.options['--json-base64'];
  let text: string;
  if (path !== undefined) {
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return refuse('release_record_unreadable', '--json names the release-record.json to store, and it could not be read');
    }
  } else if (encoded !== undefined && /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    text = Buffer.from(encoded, 'base64').toString('utf8');
  } else {
    return refuse('release_record_unreadable', '--json-base64 carries the release record as standard base64, and this is not');
  }

  const stored = await withTransaction(invocation.session, async () => await putReleaseRecord({ db: invocation.session }, text));
  if (!stored.ok) return refuse(stored.reason, stored.detail);
  return accept({ outcome: stored.value.outcome, ...describeRecord(stored.value.record) });
}

/** `fss admin release-record show --reference <reference>`. Reads only. */
export async function releaseRecordShowCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const reference = invocation.options['--reference'] ?? '';
  const record = await readReleaseRecord({ db: invocation.session }, reference);
  if (record === null) {
    return refuse('release_record_unknown', 'no release record is stored under that reference; put it first with fss admin release-record put');
  }
  return accept({ ...describeRecord(record), record: record.record });
}

// ---------------------------------------------------------------------------
// The send path, read before the pause is lifted.
// ---------------------------------------------------------------------------

/**
 * `fss admin send-path report` (lane RB).
 *
 * `docs/greenfield/send-path-verification-20260929.md` ends with eight SQL reads an
 * operator is told to make on production before the sending pause is lifted, "as the
 * read-only reporting role". **There is no such role and no way to reach the database
 * to use one:** production's instance is private — no bastion, no NAT — and the only
 * sanctioned in-VPC execution is a one-off run of the OPERATIONS task definition, whose
 * command override runs `fss <words>` and nothing else. So the reads are this command:
 * the same SQL, scoped to one workspace, run inside one `READ ONLY` transaction that is
 * rolled back, printed as one JSON object.
 *
 * **It decides nothing.** There is no "safe to lift" boolean, no refusal on a bad
 * number and no exit code that means "go". Every expectation lives in the document's
 * "How to read the answer" list, where a person reads it. The command's whole job is to
 * make the nine reads possible at all, identically each time.
 *
 * ## Read-only, and how
 *
 * `BEGIN TRANSACTION READ ONLY` is the first statement, so a write attempted by any
 * section — a typo in a CTE, a function with a side effect — is refused by PostgreSQL
 * itself with `25006`, which fails the command rather than being reported as a number.
 * `ROLLBACK` in a `finally`. Every section reads the transaction's one snapshot, so the
 * nine answers are the same instant's answers and `readAt` is that instant.
 *
 * ## What it does not print
 *
 * No e-mail address of a prospect and no person's name. `liveEnrollmentRows` carries
 * firm names (the operator has to recognise the firm) and contact **ids**, and the test
 * asserts the section's JSON contains no `@` at all. The mailbox section prints the
 * owner's own mailbox address, exactly as `fss admin mailbox list` already does.
 *
 * ## Schema 25, not the schema the document was written against
 *
 * The document is a read of `23ec4338`, before migration 0025. Where 0025 replaced a
 * proxy with a real column the section reads the real column and keeps the proxy beside
 * it, and where the document's SQL no longer matches the schema at all the difference
 * is stated in the report's own `deviations` array rather than left for a reader to
 * notice. Nothing is silently adjusted.
 */

/** The three origins 0025 gave an enrollment (`sequence_enrollments_origin_kind_known`). */
type OriginKind = 'cold_legacy' | 'prospecting' | 'follow_up';

/** The settings keys the document's read 1 names (schema 20 narrowed the vocabulary to these three). */
const SWITCH_SETTING_KEYS = ['sending_enabled', 'business_time_zone', 'postal_address'] as const;

/** `--sample`'s default and ceiling. A report is a log line; the per-row sections are bounded. */
export const SEND_PATH_SAMPLE_DEFAULT = 50;
export const SEND_PATH_SAMPLE_MAX = 500;

/**
 * How the report describes each place its SQL is not the document's SQL, one sentence
 * each. They are constants rather than prose written at the call site so that the test
 * can name them and a reviewer can diff them against the document.
 */
export const SEND_PATH_DEVIATIONS: readonly string[] = Object.freeze([
  'Every section is scoped to one workspace (workspace_id = $1); the document\'s SQL is unscoped because it assumed production holds exactly one workspace, and this command refuses rather than guess when it holds more.',
  'Section 1 reads only the version of each setting still in force (superseded_at IS NULL); the document\'s SQL has no such predicate and would also list every retired version.',
  'Section 2 groups the document\'s read 2 by sequence_enrollments.origin_kind, which did not exist at 23ec4338, and reports total - cold_legacy - heldForColdOutreach as wouldLeaveOnFirstTick because listStepWakes now excludes cold_legacy outright and, since send-path v2, a due prospecting e-mail step is held with cold_outreach_mailbox_required rather than sent.',
  'Section 4 reads sequence_enrollments.permission_id and opportunities.control_mode_origin, which 0025 added, beside the document\'s two proxies (hadConversation, hadInbound) rather than instead of them.',
  'Section 4\'s hadInbound reads mail_messages.direction = \'incoming\'. The document\'s SQL says \'inbound\', which is not in mail_messages_direction_known (incoming, outgoing) and so answered false for every row it was ever run against.',
  'Section 7 does not read mailbox_send_days.direct_sent: migration 0019 dropped the column, so the document\'s read 7 would fail outright on schema 25.',
  'Section 8 splits the fences by their enrollment\'s origin_kind through outbound_messages.enrollment_id; a fence with no enrollment (a draft) is reported under a null origin kind.',
  'Section 9 has no counterpart in the document: follow_up_permissions did not exist at 23ec4338.',
]);

/** A count column, which `pg` hands back as a string for bigint. */
const asCount = (value: unknown): number => Number((value as string | number | null) ?? 0);

/** A timestamp column as an ISO instant, or null. */
const asInstant = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as string | Date).toISOString();

/** A `date` column as `YYYY-MM-DD`, which is how `pg` hands it back for a bare date. */
const asDate = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
};

/** An empty tally of the three origin kinds, so a missing group reads 0 rather than undefined. */
function emptyOriginTally(): Record<OriginKind, number> {
  return { cold_legacy: 0, prospecting: 0, follow_up: 0 };
}

interface SendPathScope {
  readonly workspaceId: string;
  readonly sample: number;
}

/**
 * The workspace this report is about, and the row cap.
 *
 * `--workspace` is optional when the database holds exactly one workspace, which is
 * production's shape today. Anything else refuses and says the count: a report that
 * silently picked the first of two would be read as the whole answer.
 */
function readSendPathScope(
  options: Readonly<Record<string, string>>,
  workspaceIds: readonly string[],
): { readonly ok: true; readonly scope: SendPathScope } | { readonly ok: false; readonly outcome: AdminOutcome } {
  const named = options['--workspace'];
  let workspaceId: string;
  if (named === undefined) {
    if (workspaceIds.length !== 1) {
      return {
        ok: false,
        outcome: refuse(
          'workspace_ambiguous',
          `this database holds ${String(workspaceIds.length)} workspaces; name one with --workspace`,
        ),
      };
    }
    workspaceId = workspaceIds[0] ?? '';
  } else {
    if (!workspaceIds.includes(named)) {
      return { ok: false, outcome: refuse('workspace_unknown', 'no workspace on this database has that id') };
    }
    workspaceId = named;
  }

  const rawSample = options['--sample'];
  let sample = SEND_PATH_SAMPLE_DEFAULT;
  if (rawSample !== undefined) {
    const parsed = Number(rawSample);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > SEND_PATH_SAMPLE_MAX) {
      return {
        ok: false,
        outcome: refuse(
          'sample_out_of_range',
          `--sample caps the per-row sections and is a whole number between 1 and ${String(SEND_PATH_SAMPLE_MAX)}`,
        ),
      };
    }
    sample = parsed;
  }
  return { ok: true, scope: { workspaceId, sample } };
}

/** Section 1: the three switches, as they actually stand (the document's read 1). */
async function sendPathSwitches(session: SessionQueryable, workspaceId: string): Promise<Record<string, unknown>> {
  const settings = await session.query(
    `SELECT setting_key, version, value, changed_at
       FROM workspace_settings
      WHERE workspace_id = $1 AND superseded_at IS NULL AND setting_key = ANY($2::text[])
      ORDER BY setting_key`,
    [workspaceId, [...SWITCH_SETTING_KEYS]],
  );
  const domains = await session.query(
    `SELECT domain, is_primary, automated_sending_enabled, spf_pass, dkim_pass, dmarc_pass
       FROM sending_domains
      WHERE workspace_id = $1
      ORDER BY is_primary DESC, domain`,
    [workspaceId],
  );
  return {
    // The owner's own settings, as stored: `sending_enabled` carries the
    // releaseGateReference the worker's image digest has to match, and nothing here is
    // a prospect's anything.
    settings: settings.rows.map(row => ({
      settingKey: row['setting_key'],
      version: asCount(row['version']),
      value: row['value'],
      changedAt: asInstant(row['changed_at']),
    })),
    domains: domains.rows.map(row => ({
      domain: row['domain'],
      isPrimary: row['is_primary'],
      automatedSendingEnabled: row['automated_sending_enabled'],
      spfPass: row['spf_pass'],
      dkimPass: row['dkim_pass'],
      dmarcPass: row['dmarc_pass'],
    })),
  };
}

/** Section 2: how much would leave on the first tick (the document's read 2). */
async function sendPathDueNow(session: SessionQueryable, workspaceId: string): Promise<Record<string, unknown>> {
  const { rows } = await session.query(
    `SELECT n.origin_kind,
            count(*) AS due_now,
            count(*) FILTER (WHERE e.channel = 'email') AS due_email,
            count(*) FILTER (WHERE e.channel = 'email' AND n.origin_kind = 'prospecting') AS held_for_cold_outreach
       FROM step_executions e
       JOIN sequence_enrollments n
         ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
      WHERE e.workspace_id = $1
        AND n.ended_at IS NULL
        AND n.state = 'active'
        AND e.state IN ('pending', 'held')
        AND e.due_at <= now()
        AND e.not_before <= now()
      GROUP BY n.origin_kind`,
    [workspaceId],
  );
  const byOriginKind = emptyOriginTally();
  const emailByOriginKind = emptyOriginTally();
  let total = 0;
  let email = 0;
  let heldForColdOutreach = 0;
  for (const row of rows) {
    const kind = String(row['origin_kind']) as OriginKind;
    const due = asCount(row['due_now']);
    const dueEmail = asCount(row['due_email']);
    total += due;
    email += dueEmail;
    heldForColdOutreach += asCount(row['held_for_cold_outreach']);
    if (kind in byOriginKind) {
      byOriginKind[kind] = due;
      emailByOriginKind[kind] = dueEmail;
    }
  }
  return {
    total,
    email,
    byOriginKind,
    emailByOriginKind,
    // Send-path v2 (slice S4): every due prospecting e-mail step, whether it already
    // carries the hold or will be given it the first time it is asked. `listStepWakes`
    // still wakes these, so the hold is visible; nothing about them leaves.
    heldForColdOutreach,
    // The number that matters: what would actually go on the first tick.
    wouldLeaveOnFirstTick: total - byOriginKind.cold_legacy - heldForColdOutreach,
    note:
      'cold_legacy rows are excluded twice over — listStepWakes will not wake one (sequences/wake.ts) and followUpPermissionSource refuses it at the step — so they are listed here for completeness only. heldForColdOutreach counts the due prospecting e-mail steps: listStepWakes wakes them, and coldOutreachTransportSource holds each with cold_outreach_mailbox_required (the dispatch claim refuses a prepared one again), because a prospecting e-mail may not leave through the Gmail dispatch path. wouldLeaveOnFirstTick is total minus byOriginKind.cold_legacy minus heldForColdOutreach.',
  };
}

/** Section 3: what those enrollments are, and how old (the document's read 3, plus origin). */
async function sendPathLiveEnrollments(
  session: SessionQueryable,
  workspaceId: string,
): Promise<readonly Record<string, unknown>[]> {
  const { rows } = await session.query(
    `SELECT s.name AS sequence_name,
            sv.version,
            date_trunc('day', n.started_at) AS started_day,
            n.origin_kind,
            count(*) AS enrollments,
            min(n.started_at) AS oldest,
            max(n.started_at) AS newest
       FROM sequence_enrollments n
       JOIN sequence_versions sv ON sv.workspace_id = n.workspace_id AND sv.id = n.sequence_version_id
       JOIN sequences s ON s.workspace_id = sv.workspace_id AND s.id = sv.sequence_id
      WHERE n.workspace_id = $1 AND n.ended_at IS NULL
      GROUP BY 1, 2, 3, 4
      ORDER BY oldest, sequence_name, version, origin_kind`,
    [workspaceId],
  );
  return rows.map(row => ({
    sequenceName: row['sequence_name'],
    version: asCount(row['version']),
    startedDay: asInstant(row['started_day']),
    originKind: row['origin_kind'],
    enrollments: asCount(row['enrollments']),
    oldest: asInstant(row['oldest']),
    newest: asInstant(row['newest']),
  }));
}

/**
 * Section 4: the origin each live enrollment does or does not have (the document's read
 * 4), now with 0025's real columns beside the two proxies it had to infer from.
 *
 * No e-mail address and no person's name: the firm's name so the operator recognises
 * the row, and ids for everything else.
 */
async function sendPathLiveEnrollmentRows(
  session: SessionQueryable,
  workspaceId: string,
  sample: number,
): Promise<Record<string, unknown>> {
  const counted = await session.query(
    'SELECT count(*) AS total FROM sequence_enrollments WHERE workspace_id = $1 AND ended_at IS NULL',
    [workspaceId],
  );
  const { rows } = await session.query(
    `SELECT n.id AS enrollment_id,
            n.firm_id,
            f.name AS firm_name,
            n.contact_id,
            n.started_at,
            n.origin_kind,
            n.permission_id,
            (p.id IS NOT NULL
              AND p.consumed_at IS NULL
              AND p.revoked_at IS NULL
              AND p.expires_at > now()) AS permission_live,
            o.control_mode,
            o.control_mode_origin,
            -- A conversation is a reached outcome, the list consent reads (REACHED_OUTCOMES
            -- in dial/outcomes.ts): not_interested was missing here (DESIGN-S3X 0.4).
            EXISTS (SELECT 1 FROM call_logs c
                     WHERE c.workspace_id = n.workspace_id AND c.firm_id = n.firm_id
                       AND c.outcome = ANY($3::text[])
                       AND c.occurred_at < n.started_at) AS had_conversation,
            EXISTS (SELECT 1 FROM mail_message_matches m
                      JOIN mail_messages mm ON mm.workspace_id = m.workspace_id AND mm.id = m.mail_message_id
                     WHERE m.workspace_id = n.workspace_id AND m.firm_id = n.firm_id
                       AND mm.direction = 'incoming'
                       AND mm.internal_date < n.started_at) AS had_inbound
       FROM sequence_enrollments n
       JOIN firms f ON f.workspace_id = n.workspace_id AND f.id = n.firm_id
       JOIN opportunities o ON o.workspace_id = n.workspace_id AND o.id = n.opportunity_id
       LEFT JOIN follow_up_permissions p ON p.workspace_id = n.workspace_id AND p.id = n.permission_id
      WHERE n.workspace_id = $1 AND n.ended_at IS NULL
      ORDER BY n.started_at, n.id
      LIMIT $2`,
    [workspaceId, sample, [...REACHED_OUTCOMES]],
  );
  const total = asCount(counted.rows[0]?.['total']);
  return {
    total,
    sample,
    truncated: total > rows.length,
    rows: rows.map(row => ({
      enrollmentId: row['enrollment_id'],
      firmId: row['firm_id'],
      firmName: row['firm_name'],
      contactId: row['contact_id'],
      startedAt: asInstant(row['started_at']),
      originKind: row['origin_kind'],
      permissionId: row['permission_id'],
      // Null rather than false when there is no permission at all: "no permission" and
      // "a permission that is spent" are different answers.
      permissionLive: row['permission_id'] === null ? null : row['permission_live'],
      controlMode: row['control_mode'],
      controlModeOrigin: row['control_mode_origin'],
      hadConversation: row['had_conversation'],
      hadInbound: row['had_inbound'],
    })),
  };
}

/** Section 5: parallel threads at one firm (the document's read 5), twice. */
async function sendPathParallelThreads(
  session: SessionQueryable,
  workspaceId: string,
  prospectingOnly: boolean,
): Promise<readonly Record<string, unknown>[]> {
  const { rows } = await session.query(
    `SELECT n.firm_id, f.name AS firm_name, count(DISTINCT n.contact_id) AS live_contacts
       FROM sequence_enrollments n
       JOIN firms f ON f.workspace_id = n.workspace_id AND f.id = n.firm_id
      WHERE n.workspace_id = $1
        AND n.ended_at IS NULL
        AND ($2::boolean IS FALSE OR n.origin_kind = 'prospecting')
      GROUP BY 1, 2
     HAVING count(DISTINCT n.contact_id) > 1
      ORDER BY live_contacts DESC, firm_name`,
    [workspaceId, prospectingOnly],
  );
  return rows.map(row => ({
    firmId: row['firm_id'],
    firmName: row['firm_name'],
    liveContacts: asCount(row['live_contacts']),
  }));
}

/**
 * Section 6: suppression is present and readable (the document's read 6).
 *
 * Since migration 0037 the view holds one row per (key, channel), so `byScope` counts
 * (key, channel) rows and `byScopeAndChannel` says which. The live-enrollment count asks
 * about e-mail-stopping rows only (`email` or `all`): a phone-only stop leaves an
 * enrollment running by design, and its call-task steps are held at eligibility.
 */
async function sendPathSuppression(session: SessionQueryable, workspaceId: string): Promise<Record<string, unknown>> {
  const byScope = await session.query(
    'SELECT scope, count(*) AS count FROM effective_suppressions WHERE workspace_id = $1 GROUP BY scope ORDER BY scope',
    [workspaceId],
  );
  const byScopeAndChannel = await session.query(
    `SELECT scope, channel, count(*) AS count FROM effective_suppressions
      WHERE workspace_id = $1 GROUP BY scope, channel ORDER BY scope, channel`,
    [workspaceId],
  );
  const live = await session.query(
    `SELECT count(*) AS live_enrollments_of_suppressed_people
       FROM sequence_enrollments n
      WHERE n.workspace_id = $1
        AND n.ended_at IS NULL
        AND (EXISTS (SELECT 1 FROM effective_suppressions s
                      WHERE s.workspace_id = n.workspace_id
                        AND s.channel IN ('email', 'all')
                        AND s.scope = 'firm' AND s.canonical_key = n.firm_id::text)
             OR EXISTS (SELECT 1 FROM effective_suppressions s
                         JOIN email_addresses a
                           ON a.workspace_id = s.workspace_id AND a.address = s.canonical_key
                        WHERE s.workspace_id = n.workspace_id
                          AND s.channel IN ('email', 'all')
                          AND s.scope = 'handle' AND a.contact_id = n.contact_id))`,
    [workspaceId],
  );
  return {
    byScope: byScope.rows.map(row => ({ scope: row['scope'], count: asCount(row['count']) })),
    byScopeAndChannel: byScopeAndChannel.rows.map(row => ({
      scope: row['scope'],
      channel: row['channel'],
      count: asCount(row['count']),
    })),
    liveEnrollmentsOfSuppressedPeople: asCount(live.rows[0]?.['live_enrollments_of_suppressed_people']),
  };
}

/** Section 7: the mailbox's cap and ramp (the document's read 7), less the column 0019 dropped. */
async function sendPathMailboxRamp(session: SessionQueryable, workspaceId: string): Promise<Record<string, unknown>> {
  const ramp = await session.query(
    `SELECT r.mailbox_id, m.email_address, r.healthy_sending_days, r.admin_daily_cap, r.raised_daily_cap,
            r.last_advanced_on, r.last_health_failure
       FROM mailbox_send_ramp r
       JOIN mailboxes m ON m.workspace_id = r.workspace_id AND m.id = r.mailbox_id
      WHERE r.workspace_id = $1
      ORDER BY m.email_address`,
    [workspaceId],
  );
  const days = await session.query(
    `SELECT mailbox_id, business_date, automated_sent, cap_granted, closed_at, healthy
       FROM mailbox_send_days
      WHERE workspace_id = $1
      ORDER BY business_date DESC
      LIMIT 10`,
    [workspaceId],
  );
  return {
    ramp: ramp.rows.map(row => ({
      mailboxId: row['mailbox_id'],
      // The owner's own mailbox, exactly as `fss admin mailbox list` prints it.
      address: String(row['email_address']).trim().toLowerCase(),
      healthySendingDays: asCount(row['healthy_sending_days']),
      adminDailyCap: row['admin_daily_cap'] === null ? null : asCount(row['admin_daily_cap']),
      raisedDailyCap: row['raised_daily_cap'] === null ? null : asCount(row['raised_daily_cap']),
      lastAdvancedOn: asDate(row['last_advanced_on']),
      lastHealthFailure: row['last_health_failure'],
    })),
    recentDays: days.rows.map(row => ({
      mailboxId: row['mailbox_id'],
      businessDate: asDate(row['business_date']),
      automatedSent: asCount(row['automated_sent']),
      capGranted: asCount(row['cap_granted']),
      closedAt: asInstant(row['closed_at']),
      healthy: row['healthy'],
    })),
  };
}

/** Section 8: any fence already prepared and waiting (the document's read 8), split by origin. */
async function sendPathPreparedFences(session: SessionQueryable, workspaceId: string): Promise<Record<string, unknown>> {
  const byState = await session.query(
    `SELECT state, count(*) AS count, min(created_at) AS oldest
       FROM outbound_messages
      WHERE workspace_id = $1 AND state IN ('prepared', 'held')
      GROUP BY state
      ORDER BY state`,
    [workspaceId],
  );
  const byOrigin = await session.query(
    `SELECT o.state, n.origin_kind, count(*) AS count, min(o.created_at) AS oldest
       FROM outbound_messages o
       LEFT JOIN sequence_enrollments n ON n.workspace_id = o.workspace_id AND n.id = o.enrollment_id
      WHERE o.workspace_id = $1 AND o.state IN ('prepared', 'held')
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [workspaceId],
  );
  return {
    byState: byState.rows.map(row => ({
      state: row['state'],
      count: asCount(row['count']),
      oldest: asInstant(row['oldest']),
    })),
    // A fence with no enrollment is a draft: the join is a LEFT JOIN and the origin
    // kind is null rather than the row being dropped from the split.
    byEnrollmentOriginKind: byOrigin.rows.map(row => ({
      state: row['state'],
      enrollmentOriginKind: row['origin_kind'],
      count: asCount(row['count']),
      oldest: asInstant(row['oldest']),
    })),
  };
}

/**
 * Section 9: the permissions themselves, which the document could not read because
 * `follow_up_permissions` did not exist when it was written.
 *
 * `defects` is the one number here that is a defect rather than a fact: migration
 * 0025's CHECK makes a live `follow_up` enrollment with a null `permission_id`
 * unrepresentable, so a non-zero count means the constraint was dropped or the
 * permission was deleted out from under a live run.
 */
async function sendPathFollowUpPermissions(
  session: SessionQueryable,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  // One mutually exclusive state per permission, in the order a reader would ask:
  // revoked beats consumed beats expired.
  const STATE = `CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                      WHEN consumed_at IS NOT NULL THEN 'consumed'
                      WHEN expires_at <= now() THEN 'expired'
                      ELSE 'live' END`;
  const byScope = await session.query(
    `SELECT scope, ${STATE} AS state, count(*) AS count
       FROM follow_up_permissions WHERE workspace_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
    [workspaceId],
  );
  const byKind = await session.query(
    `SELECT kind, ${STATE} AS state, count(*) AS count
       FROM follow_up_permissions WHERE workspace_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
    [workspaceId],
  );
  const defects = await session.query(
    `SELECT count(*) AS defects
       FROM sequence_enrollments n
       LEFT JOIN follow_up_permissions p ON p.workspace_id = n.workspace_id AND p.id = n.permission_id
      WHERE n.workspace_id = $1
        AND n.ended_at IS NULL
        AND n.origin_kind = 'follow_up'
        AND (n.permission_id IS NULL OR p.id IS NULL OR p.revoked_at IS NOT NULL OR p.expires_at <= now())`,
    [workspaceId],
  );
  return {
    byScope: byScope.rows.map(row => ({ scope: row['scope'], state: row['state'], count: asCount(row['count']) })),
    byKind: byKind.rows.map(row => ({ kind: row['kind'], state: row['state'], count: asCount(row['count']) })),
    liveFollowUpsWithoutLivePermission: asCount(defects.rows[0]?.['defects']),
    note:
      'liveFollowUpsWithoutLivePermission must be 0: sequence_enrollments_follow_up_has_permission allows a null permission only on an ended row, so a non-zero count is a defect, not a state to interpret. A consumed permission is not counted here — consumption is what single_email means.',
  };
}

/**
 * `fss admin send-path report [--workspace <id>] [--sample <n>]`.
 *
 * The nine reads, in one `READ ONLY` transaction that is rolled back. Decides nothing.
 */
export async function sendPathReportCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const workspaceIds = await listWorkspaceIds(session);
    const scoped = readSendPathScope(invocation.options, workspaceIds);
    if (!scoped.ok) return scoped.outcome;
    const { workspaceId, sample } = scoped.scope;

    const schemaVersion = await readAppliedSchemaVersion(session);
    // The transaction's own clock, so `readAt` is the instant every `now()` above saw.
    const clock = await session.query<{ now: Date | string }>('SELECT now() AS now');

    const sections = {
      switches: await sendPathSwitches(session, workspaceId),
      dueNow: await sendPathDueNow(session, workspaceId),
      liveEnrollments: await sendPathLiveEnrollments(session, workspaceId),
      liveEnrollmentRows: await sendPathLiveEnrollmentRows(session, workspaceId, sample),
      firmsWithParallelThreads: {
        anyOrigin: await sendPathParallelThreads(session, workspaceId, false),
        prospectingOnly: await sendPathParallelThreads(session, workspaceId, true),
      },
      suppression: await sendPathSuppression(session, workspaceId),
      mailboxRamp: await sendPathMailboxRamp(session, workspaceId),
      preparedFences: await sendPathPreparedFences(session, workspaceId),
      followUpPermissions: await sendPathFollowUpPermissions(session, workspaceId),
    };

    return accept({
      ok: true,
      report: {
        schemaVersion,
        readAt: asInstant(clock.rows[0]?.now),
        workspaceId,
        sample,
        deviations: [...SEND_PATH_DEVIATIONS],
        sections,
      },
    });
  } finally {
    await session.query('ROLLBACK');
  }
}

// ---------------------------------------------------------------------------
// Call-to-booking A2: the mailbox switch's two read-only commands.
// ---------------------------------------------------------------------------

/** How recently the old account must have synced before a switch, in seconds. */
export const SWITCH_PREFLIGHT_SYNC_SECONDS = 120;

/** The fence states a switch waits for: `NON_TERMINAL_FENCE_STATES` in `mail/oauth.ts`. */
const NON_TERMINAL_FENCES = ['prepared', 'held', 'dispatching', 'reconciling'] as const;

/**
 * The mailbox a switch command is about: `--mailbox`, or the workspace's only mailbox.
 * Refuses rather than pick when the workspace has several.
 */
async function readSwitchMailbox(
  session: SessionQueryable,
  workspaceId: string,
  named: string | undefined,
): Promise<{ readonly ok: true; readonly mailboxId: string } | { readonly ok: false; readonly outcome: AdminOutcome }> {
  const { rows } = await session.query<{ id: string }>(
    'SELECT id FROM mailboxes WHERE workspace_id = $1 ORDER BY id',
    [workspaceId],
  );
  const ids = rows.map(row => row.id);
  if (named !== undefined) {
    if (!ids.includes(named)) return { ok: false, outcome: refuse('mailbox_unknown', 'no mailbox in that workspace has that id') };
    return { ok: true, mailboxId: named };
  }
  if (ids.length !== 1) {
    return {
      ok: false,
      outcome: refuse('mailbox_ambiguous', `this workspace has ${String(ids.length)} mailboxes; name one with --mailbox`),
    };
  }
  return { ok: true, mailboxId: ids[0] ?? '' };
}

/**
 * `fss admin mailbox switch-preflight [--workspace <id>] [--mailbox <id>]`.
 *
 * What an operator reads before David consents to the new account
 * (`docs/greenfield/mail.md`, "Switching the mailbox"): the mailbox as it stands, what
 * references it, and `wouldRefuse` — the conditions under which the switch should not be
 * started now. One `READ ONLY` transaction, rolled back; it decides nothing and changes
 * nothing. `wouldRefuse` is a list for a person, not a gate: the switch's own refusals
 * are the API's (`mailbox_switch_pending_sends` among them).
 */
export async function mailboxSwitchPreflightCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const scoped = readSendPathScope(
      invocation.options['--workspace'] === undefined ? {} : { '--workspace': invocation.options['--workspace'] },
      await listWorkspaceIds(session),
    );
    if (!scoped.ok) return scoped.outcome;
    const { workspaceId } = scoped.scope;
    const chosen = await readSwitchMailbox(session, workspaceId, invocation.options['--mailbox']);
    if (!chosen.ok) return chosen.outcome;
    const { mailboxId } = chosen;
    const values = [workspaceId, mailboxId];

    const clock = await session.query<{ now: Date | string }>('SELECT now() AS now');
    const { rows: mailboxRows } = await session.query(
      `SELECT id, owner_user_id, email_address, status, sync_state, generation, last_synced_at, last_sync_error,
              (last_synced_at IS NOT NULL AND last_synced_at >= now() - make_interval(secs => $3)) AS synced_recently
         FROM mailboxes WHERE workspace_id = $1 AND id = $2`,
      [...values, SWITCH_PREFLIGHT_SYNC_SECONDS],
    );
    const mailbox = mailboxRows[0] ?? {};
    const ownerUserId = String(mailbox['owner_user_id'] ?? '');

    const messages = await session.query(
      `SELECT direction, count(*) AS count, min(internal_date) AS first_at, max(internal_date) AS last_at
         FROM mail_messages WHERE workspace_id = $1 AND mailbox_id = $2 GROUP BY direction ORDER BY direction`,
      values,
    );
    const fencesByState = await session.query(
      `SELECT state, count(*) AS count FROM outbound_messages
        WHERE workspace_id = $1 AND mailbox_id = $2 GROUP BY state ORDER BY state`,
      values,
    );
    const lastSent = await session.query(
      'SELECT max(sent_at) AS last_sent_at FROM outbound_messages WHERE workspace_id = $1 AND mailbox_id = $2',
      values,
    );
    const pending = await session.query(
      `SELECT id, state, created_at FROM outbound_messages
        WHERE workspace_id = $1 AND mailbox_id = $2 AND state = ANY ($3::text[])
        ORDER BY created_at, id`,
      [...values, [...NON_TERMINAL_FENCES]],
    );
    const permissions = await session.query(
      `SELECT scope, count(*) AS count FROM follow_up_permissions
        WHERE workspace_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > now()
        GROUP BY scope ORDER BY scope`,
      [workspaceId],
    );
    const enrollments = await session.query(
      `SELECT origin_kind, count(*) AS count FROM sequence_enrollments
        WHERE workspace_id = $1 AND assigned_user_id = $2 AND ended_at IS NULL
        GROUP BY origin_kind ORDER BY origin_kind`,
      [workspaceId, ownerUserId],
    );
    const holds = await session.query(
      `SELECT reason_code, count(*) AS count FROM active_holds
        WHERE workspace_id = $1 AND released_at IS NULL
          AND (owner_user_id = $2 OR (scope_kind = 'owner' AND scope_key = $2::text)
               OR (scope_kind = 'mailbox' AND scope_key = $3::text) OR source_event_id = $3::text)
        GROUP BY reason_code ORDER BY reason_code`,
      [workspaceId, ownerUserId, mailboxId],
    );
    const watches = await session.query(
      `SELECT generation, registered_at, expires_at, cancelled_at, cancelled_reason
         FROM mailbox_watches WHERE workspace_id = $1 AND mailbox_id = $2 ORDER BY generation`,
      values,
    );
    // Both key formats (lane A1): `mail-sync:{mailbox}:{generation}` and
    // `watch:{mailbox}:{mailboxGeneration}:{renewal}` now, `mail-sync:{mailbox}` and
    // `watch:{mailbox}:{renewal}` before. A pre-generation row is never claimed again
    // under the new keys, so it is reported as orphaned rather than as live work. The
    // mailbox is the key's second field in every format.
    const jobs = await session.query(
      `SELECT kind,
              CASE
                WHEN kind = 'mail.sync' AND array_length(string_to_array(idempotency_key, ':'), 1) = 2 THEN 'orphaned_pre_generation'
                WHEN kind = 'mail.watch_renew' AND array_length(string_to_array(idempotency_key, ':'), 1) = 3 THEN 'orphaned_pre_generation'
                ELSE 'current'
              END AS key_format,
              count(*) FILTER (WHERE state IN ('queued', 'retryable')) AS queued,
              count(*) FILTER (WHERE state = 'running') AS running,
              count(*) FILTER (WHERE state = 'dead') AS dead
         FROM jobs
        WHERE workspace_id = $1 AND kind LIKE 'mail.%' AND split_part(idempotency_key, ':', 2) = $2::text
        GROUP BY 1, 2 ORDER BY 1, 2`,
      values,
    );
    const sendDays = await session.query(
      `SELECT count(*) AS days, coalesce(sum(automated_sent), 0) AS automated_sent, max(business_date) AS last_day
         FROM mailbox_send_days WHERE workspace_id = $1 AND mailbox_id = $2`,
      values,
    );
    const accounts = await session.query(
      `SELECT email_address, active_from, active_until, generation_from
         FROM mailbox_accounts WHERE workspace_id = $1 AND mailbox_id = $2 ORDER BY active_from`,
      values,
    );

    const wouldRefuse: string[] = [];
    if (mailbox['status'] !== 'connected') wouldRefuse.push('mailbox_not_connected');
    if (mailbox['synced_recently'] !== true || mailbox['sync_state'] !== 'ready') {
      wouldRefuse.push('old_account_not_synced_within_2_minutes');
    }
    if (pending.rows.length > 0) wouldRefuse.push('non_terminal_fences');

    return accept({
      ok: true,
      report: {
        readAt: asInstant(clock.rows[0]?.now),
        workspaceId,
        mailbox: {
          id: mailbox['id'],
          address: String(mailbox['email_address'] ?? '').trim().toLowerCase(),
          status: mailbox['status'],
          syncState: mailbox['sync_state'],
          generation: asCount(mailbox['generation']),
          lastSyncedAt: asInstant(mailbox['last_synced_at']),
          lastSyncError: mailbox['last_sync_error'],
        },
        messages: messages.rows.map(row => ({
          direction: row['direction'],
          count: asCount(row['count']),
          firstInternalDate: asInstant(row['first_at']),
          lastInternalDate: asInstant(row['last_at']),
        })),
        fences: {
          byState: fencesByState.rows.map(row => ({ state: row['state'], count: asCount(row['count']) })),
          lastSentAt: asInstant(lastSent.rows[0]?.['last_sent_at']),
          nonTerminal: pending.rows.map(row => ({
            id: row['id'],
            state: row['state'],
            createdAt: asInstant(row['created_at']),
          })),
        },
        liveFollowUpPermissions: permissions.rows.map(row => ({ scope: row['scope'], count: asCount(row['count']) })),
        liveEnrollments: enrollments.rows.map(row => ({ originKind: row['origin_kind'], count: asCount(row['count']) })),
        openHolds: holds.rows.map(row => ({ reasonCode: row['reason_code'], count: asCount(row['count']) })),
        watches: watches.rows.map(row => ({
          generation: asCount(row['generation']),
          registeredAt: asInstant(row['registered_at']),
          expiresAt: asInstant(row['expires_at']),
          cancelledAt: asInstant(row['cancelled_at']),
          cancelledReason: row['cancelled_reason'],
        })),
        mailJobs: jobs.rows.map(row => ({
          kind: row['kind'],
          keyFormat: row['key_format'],
          queued: asCount(row['queued']),
          running: asCount(row['running']),
          dead: asCount(row['dead']),
        })),
        sendDays: {
          days: asCount(sendDays.rows[0]?.['days']),
          automatedSent: asCount(sendDays.rows[0]?.['automated_sent']),
          lastBusinessDate: asDate(sendDays.rows[0]?.['last_day']),
        },
        accounts: accounts.rows.map(row => ({
          emailAddress: row['email_address'],
          activeFrom: asInstant(row['active_from']),
          activeUntil: asInstant(row['active_until']),
          generationFrom: asCount(row['generation_from']),
        })),
        wouldRefuse,
      },
    });
  } finally {
    await session.query('ROLLBACK');
  }
}

/** One condition of the send path, evaluated on its own. */
interface PreviewCondition {
  readonly pass: boolean;
  readonly reason: string | null;
}

const passed: PreviewCondition = Object.freeze({ pass: true, reason: null });
const failed = (reason: string): PreviewCondition => ({ pass: false, reason });
const fromOutcome = (outcome: StepEligibilityOutcome): PreviewCondition =>
  outcome.ok ? passed : failed(outcome.detail === undefined ? outcome.reasonCode : `${outcome.reasonCode}:${outcome.detail}`);

/**
 * Every condition the preview reports, in the order a reader goes down them.
 *
 * `workspaceAttestation` is the **stored half only** of 16.2: the deployment flag and the
 * binding of the release record to the running worker's digest are that process's own
 * facts, which the operations task cannot know.
 */
export const SEND_PATH_PREVIEW_CONDITIONS = [
  'fenceState',
  'mailbox',
  'suppression',
  'permission',
  'coldOutreach',
  'firmExclusivity',
  'controlMode',
  'enrollment',
  'holds',
  'assignment',
  'route',
  'mailboxCoverage',
  'templateApproval',
  'stepPermission',
  'workspaceAttestation',
  'domainSwitch',
  'sendingWindow',
  'cap',
  'quietWindow',
  'notYetDue',
  'footer',
] as const;
export type SendPathPreviewCondition = (typeof SEND_PATH_PREVIEW_CONDITIONS)[number];

/**
 * Which preview condition answers each refusal the send path has (review of 5015abd8,
 * finding 8). Typed over every `SendRefusalCode`, so a new code does not compile until it
 * is placed; `fssMailboxSwitch.test.ts` holds each named condition to the report.
 *
 * `step_ineligible` is the claim's catch-all for the step's own eligibility, so it names
 * `stepPermission` — the claim's own composition, asked whole — and each source is also
 * reported on its own. The three `not_claim_decided` codes are Gmail's answers to the
 * send itself, and `template_mismatch` is refused when a fence is prepared
 * (`outbound/fence.ts`), never at a claim: none of the four is a condition to preview.
 */
export const PREVIEW_CONDITION_FOR_REFUSAL: Readonly<
  Record<SendRefusalCode, SendPathPreviewCondition | { readonly notClaimDecided: string }>
> = Object.freeze({
  fence_unknown: 'fenceState',
  fence_not_ready: 'fenceState',
  mailbox_unknown: 'mailbox',
  mailbox_inactive: 'mailbox',
  grant_revoked: 'holds',
  coverage_incomplete: 'mailboxCoverage',
  automated_sending_disabled: 'domainSwitch',
  workspace_sending_not_attested: 'workspaceAttestation',
  sending_domain_unknown: 'domainSwitch',
  template_unapproved: 'templateApproval',
  template_mismatch: { notClaimDecided: 'refused by prepareOutboundMessage when the fence is prepared' },
  footer_not_composed: 'footer',
  postal_address_required: 'footer',
  route_invalid: 'route',
  firm_suppressed: 'suppression',
  handle_suppressed: 'suppression',
  outside_email_window: 'sendingWindow',
  daily_cap: 'cap',
  rate_limited: { notClaimDecided: 'Gmail’s answer to the send' },
  recipient_rejected: { notClaimDecided: 'Gmail’s answer to the send' },
  provider_refusal: { notClaimDecided: 'Gmail’s answer to the send' },
  step_ineligible: 'stepPermission',
});

/**
 * The same connection with row locks removed from every statement. The claim's sources
 * lock the rows they read (`firmExclusivitySource` locks the firm, the footer takes the
 * template `FOR SHARE`); a `READ ONLY` transaction refuses those clauses, and in a
 * rolled-back snapshot a lock changes no answer. Nothing else about the SQL changes.
 */
function withoutRowLocks(context: RepositoryContext): RepositoryContext {
  const LOCK_CLAUSE =
    /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)(?:\s+OF\s+[a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)?(?:\s+NOWAIT|\s+SKIP\s+LOCKED)?/giu;
  return {
    scope: context.scope,
    db: {
      query: async (text, values) => await context.db.query(text.replace(LOCK_CLAUSE, ''), values),
    },
  };
}

/** The conditions that belong to the workspace and the mailbox: read once per sender. */
async function senderConditions(
  context: RepositoryContext,
  mailboxId: string | null,
  now: Date,
): Promise<Pick<Record<SendPathPreviewCondition, PreviewCondition>, 'mailbox' | 'domainSwitch' | 'workspaceAttestation' | 'cap'>> {
  let mailbox: PreviewCondition = failed('mailbox_unknown');
  if (mailboxId !== null) {
    const { rows } = await context.db.query<{ status: string }>(
      'SELECT status FROM mailboxes WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, mailboxId],
    );
    const status = rows[0]?.status;
    mailbox = status === undefined ? failed('mailbox_unknown') : status !== 'connected' ? failed(`mailbox_inactive:${status}`) : passed;
  }
  const domain = await readPrimarySendingDomain(context);
  const domainSwitch =
    domain === null
      ? failed('sending_domain_unknown')
      : !authenticationPasses(domain) || !domain.automatedSendingEnabled
        ? failed('automated_sending_disabled')
        : passed;
  const attestation = sendingEnabledSettingSchema.safeParse((await readSetting(context, 'sending_enabled')).value);
  const workspaceAttestation = !attestation.success
    ? failed('workspace_sending_not_attested:unreadable')
    : !attestation.data.enabled
      ? failed('workspace_sending_not_attested:disabled')
      : attestation.data.releaseGateReference === null
        ? failed('workspace_sending_not_attested:no_reference')
        : passed;
  let cap: PreviewCondition = failed('mailbox_unknown');
  if (mailboxId !== null) {
    const ramp = await readRamp(context, mailboxId);
    const limit = ramp === null ? scheduledCap(0) : effectiveDailyCap(ramp);
    const businessDate = await businessDateOf(context, now.toISOString());
    const { rows } = await context.db.query<{ automated_sent: number }>(
      `SELECT automated_sent FROM mailbox_send_days
        WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
      [context.scope.workspaceId, mailboxId, businessDate],
    );
    const sent = Number(rows[0]?.automated_sent ?? 0);
    cap = sent >= limit ? failed(`daily_cap:automated ${String(sent)}/${String(limit)}`) : passed;
  }
  return { mailbox, domainSwitch, workspaceAttestation, cap };
}

/** Every step-owned source, each asked on its own. */
async function sourceConditions(
  context: RepositoryContext,
  input: StepEligibilityInput,
  enrollment: EnrollmentRow,
  zone: string,
  now: Date,
): Promise<Pick<
  Record<SendPathPreviewCondition, PreviewCondition>,
  | 'suppression'
  | 'permission'
  | 'coldOutreach'
  | 'firmExclusivity'
  | 'controlMode'
  | 'enrollment'
  | 'holds'
  | 'assignment'
  | 'route'
  | 'mailboxCoverage'
  | 'templateApproval'
  | 'sendingWindow'
  | 'notYetDue'
>> {
  const calendar = await dispatchHolidayCalendar(context, enrollment);
  return {
    suppression: fromOutcome(await suppressionSource().evaluate(context, input)),
    permission: fromOutcome(await followUpPermissionSource().evaluate(context, input)),
    coldOutreach: fromOutcome(await coldOutreachTransportSource().evaluate(context, input)),
    firmExclusivity: fromOutcome(await firmExclusivitySource().evaluate(context, input)),
    controlMode: fromOutcome(await controlModeSource().evaluate(context, input)),
    enrollment: fromOutcome(await enrollmentSource().evaluate(context, input)),
    holds: fromOutcome(await holdSource().evaluate(context, input)),
    assignment: fromOutcome(await assignmentSource().evaluate(context, input)),
    route: fromOutcome(await emailRouteSource().evaluate(context, input)),
    mailboxCoverage: fromOutcome(await mailboxSource().evaluate(context, input)),
    templateApproval: fromOutcome(await templateApprovalSource().evaluate(context, input)),
    sendingWindow: insideSendingWindow(now, zone, calendar) ? passed : failed(`outside_email_window:${zone}`),
    notYetDue: Date.parse(input.execution.notBefore) > now.getTime() ? failed('step_ineligible:not_yet_due') : passed,
  };
}

/** What the claim's footer reconciliation would decide about this fence, without writing. */
async function footerCondition(context: RepositoryContext, fence: OutboundFenceRow): Promise<PreviewCondition> {
  const source = await footerSourceFor(context, fence.templateVersionId);
  if (source === null) {
    const issue = sendBodyIssue(fence.body);
    return issue === null ? passed : failed(`footer_not_composed:template_version_unknown:${issue}`);
  }
  const decision = composeSendBody(fence.body, source, SEND_FOOTER_POLICY);
  if (!decision.composed) {
    return failed(
      `${decision.reason === 'postal_address_required' ? 'postal_address_required' : 'footer_not_composed'}:${decision.detail ?? decision.reason}`,
    );
  }
  const issue = sendBodyIssue(decision.changed ? decision.body : fence.body);
  return issue === null ? passed : failed(`footer_not_composed:${issue}`);
}

async function mailboxAddress(context: RepositoryContext, mailboxId: string | null): Promise<string | null> {
  if (mailboxId === null) return null;
  const { rows } = await context.db.query<{ email_address: string }>(
    'SELECT email_address FROM mailboxes WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, mailboxId],
  );
  return rows[0]?.email_address ?? null;
}

const notApplicable = (why: string): PreviewCondition => ({ pass: true, reason: `not_applicable:${why}` });

/**
 * `fss admin send-path preview [--workspace <id>] [--sample <n>]`.
 *
 * For every prepared or held fence, and every due e-mail step, **every** condition the
 * dispatch claim can refuse on (`PREVIEW_CONDITION_FOR_REFUSAL`), each asked of its own
 * source, with its pass or fail and reason, and the sender the send would leave from (the
 * fence's mailbox address, as `outbound/send.ts` uses it; for a step, the owner's mailbox
 * a fence would be prepared on). The gate short-circuits at its first refusal — the
 * disabled domain, while sending is paused — so it cannot say what else would stop a
 * send; `stepPermission` is the claim's own composition asked whole, beside its sources.
 * One `READ ONLY` transaction, rolled back, with the sources' row locks removed
 * (`withoutRowLocks`); `ensureRamp`, `openSendDay` and the footer rewrite, which the
 * claim performs, are replaced by reads.
 */
export async function sendPathPreviewCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const scoped = readSendPathScope(invocation.options, await listWorkspaceIds(session));
    if (!scoped.ok) return scoped.outcome;
    const { workspaceId, sample } = scoped.scope;
    const context = withoutRowLocks(
      repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), session),
    );
    const { rows: clock } = await session.query<{ now: Date }>('SELECT now() AS now');
    const now = clock[0]?.now ?? new Date();

    const senders = new Map<string, Awaited<ReturnType<typeof senderConditions>>>();
    const forSender = async (mailboxId: string | null): Promise<Awaited<ReturnType<typeof senderConditions>>> => {
      const key = mailboxId ?? '';
      const known = senders.get(key);
      if (known !== undefined) return known;
      const computed = await senderConditions(context, mailboxId, now);
      senders.set(key, computed);
      return computed;
    };

    const { rows: fenceIds } = await session.query<{ id: string }>(
      `SELECT id FROM outbound_messages WHERE workspace_id = $1 AND state IN ('prepared', 'held')
        ORDER BY created_at, id LIMIT $2`,
      [workspaceId, sample],
    );
    const fences: Record<string, unknown>[] = [];
    for (const { id } of fenceIds) {
      const fence = await readFence(context, id);
      if (fence === null) continue;
      const shared = await forSender(fence.mailboxId);
      const execution = fence.stepExecutionId === null ? null : await readStepExecution(context, fence.stepExecutionId);
      const enrollment = execution === null ? null : await readEnrollment(context, { enrollmentId: execution.enrollmentId });
      const fenceState =
        fence.state === 'prepared' ? passed : failed(`fence_not_ready:${fence.state}${fence.heldReason === null ? '' : `:${fence.heldReason}`}`);
      const { rows: kind } = await session.query<{ kind: string; owner_user_id: string }>(
        'SELECT kind, owner_user_id FROM mailboxes WHERE workspace_id = $1 AND id = $2',
        [workspaceId, fence.mailboxId],
      );
      const mailboxKind = kind[0]?.kind ?? 'personal';
      let conditions: Record<SendPathPreviewCondition, PreviewCondition>;
      if (execution === null || enrollment === null) {
        const missing = failed('step_ineligible:no_step_execution');
        conditions = Object.fromEntries(SEND_PATH_PREVIEW_CONDITIONS.map(name => [name, missing])) as Record<
          SendPathPreviewCondition,
          PreviewCondition
        >;
        conditions = { ...conditions, fenceState, ...shared, footer: await footerCondition(context, fence) };
      } else {
        const input: StepEligibilityInput = {
          execution,
          opportunityId: enrollment.opportunityId,
          firmId: fence.firmId,
          contactId: fence.contactId ?? enrollment.contactId,
          ownerUserId: enrollment.assignedUserId,
          channel: 'email',
          actionKind: CHANNEL_ACTION_KINDS.email,
          now: now.toISOString(),
          frozen: {
            routeId: fence.recipientRouteId,
            routeVersion: fence.recipientRouteVersion,
            templateVersionId: fence.templateVersionId,
          },
        };
        const sources = await sourceConditions(context, input, enrollment, fence.sourceZone, now);
        // The gate's own suppression read, on the fence's firm and recipient, beside the
        // source's contact-wide one.
        const fenceSuppressed = await firstSuppressed(
          context,
          [
            { scope: 'firm', canonicalKey: fence.firmId },
            { scope: 'handle', canonicalKey: fence.recipientAddress },
          ],
          'email',
        );
        const cold = await coldOutreachDispatchRefusal(context, fence.id, enrollment, { id:fence.mailboxId, kind: mailboxKind });
        const decided = await decideStepPermission(
          context,
          fence,
          { id: fence.mailboxId, ownerUserId: kind[0]?.owner_user_id ?? '', kind: mailboxKind },
          now,
        );
        const permission = enrollment.permissionId === null ? null : await readFollowUpPermission(context, enrollment.permissionId);
        const quiet =
          permission !== null &&
          permission.scope === 'agreed_sequence' &&
          (await directSendWithinQuietWindow(context, { firmId: fence.firmId, contactId: permission.contactId }));
        conditions = {
          fenceState,
          ...shared,
          ...sources,
          suppression:
            fenceSuppressed !== null
              ? failed(fenceSuppressed.scope === 'firm' ? 'firm_suppressed' : 'handle_suppressed')
              : sources.suppression,
          coldOutreach: cold === null ? sources.coldOutreach : failed(cold),
          stepPermission: decided.ok ? passed : failed(decided.detail === undefined ? decided.reason : `${decided.reason}:${decided.detail}`),
          quietWindow: quiet ? failed('step_ineligible:direct_send_quiet_window') : passed,
          footer: await footerCondition(context, fence),
        };
      }
      fences.push({
        outboundMessageId: fence.id,
        state: fence.state,
        firmId: fence.firmId,
        enrollmentId: fence.enrollmentId,
        resolvedSender: await mailboxAddress(context, fence.mailboxId),
        conditions,
      });
    }

    const { rows: dueIds } = await session.query<{ id: string }>(
      `SELECT e.id FROM step_executions e
         JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
        WHERE e.workspace_id = $1 AND e.channel = 'email' AND e.state IN ('pending', 'held')
          AND e.due_at <= now() AND e.not_before <= now()
          AND n.ended_at IS NULL AND n.state = 'active'
          AND NOT EXISTS (SELECT 1 FROM outbound_messages o
                           WHERE o.workspace_id = e.workspace_id AND o.step_execution_id = e.id)
        ORDER BY e.due_at, e.id LIMIT $2`,
      [workspaceId, sample],
    );
    const steps: Record<string, unknown>[] = [];
    for (const { id } of dueIds) {
      const execution = await readStepExecution(context, id);
      if (execution === null) continue;
      const enrollment = await readEnrollment(context, { enrollmentId: execution.enrollmentId });
      if (enrollment === null) continue;
      const { rows: owned } = await session.query<{ id: string }>(
        'SELECT id FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2',
        [workspaceId, enrollment.assignedUserId],
      );
      const mailboxId = owned[0]?.id ?? null;
      const input: StepEligibilityInput = {
        execution,
        opportunityId: enrollment.opportunityId,
        firmId: enrollment.firmId,
        contactId: enrollment.contactId,
        ownerUserId: enrollment.assignedUserId,
        channel: 'email',
        actionKind: CHANNEL_ACTION_KINDS.email,
        now: now.toISOString(),
      };
      const conditions: Record<SendPathPreviewCondition, PreviewCondition> = {
        fenceState: notApplicable('no_fence_yet'),
        ...(await forSender(mailboxId)),
        ...(await sourceConditions(context, input, enrollment, enrollment.firmTimeZone, now)),
        stepPermission: fromOutcome(await composeEligibility().evaluate(context, input)),
        quietWindow: notApplicable('asked_of_a_prepared_fence'),
        footer: notApplicable('composed_when_the_fence_is_prepared'),
      };
      steps.push({
        stepExecutionId: execution.id,
        enrollmentId: enrollment.id,
        firmId: enrollment.firmId,
        originKind: enrollment.originKind,
        resolvedSender: await mailboxAddress(context, mailboxId),
        conditions,
      });
    }

    return accept({
      ok: true,
      report: {
        readAt: now.toISOString(),
        workspaceId,
        sample,
        conditionFor: PREVIEW_CONDITION_FOR_REFUSAL,
        note: 'Each condition is asked of its own source, so every one that would refuse is shown, not only the first. workspaceAttestation is the stored half only: the deployment flag and the binding of the release record to the running worker digest are the worker process\'s own facts and are not evaluated here. stepPermission is the claim\'s own composition, asked whole (its first refusal).',
        fences,
        dueEmailSteps: steps,
      },
    });
  } finally {
    await session.query('ROLLBACK');
  }
}

// ---------------------------------------------------------------------------
// The stop-channels report (slice S3X, migration 0037; contract check CC2b).
// ---------------------------------------------------------------------------

/** The migration that gave every stop a channel. The report needs it applied. */
const STOP_CHANNELS_MIGRATION = 37;

/**
 * `fss admin stop-channels report`: the contacts migration 0037 made undialable (DESIGN-S3X
 * §0.1, CC2b), measured after the release because production has no read path before it.
 *
 * Before 0037 the dial keys were phone-only, so a stop on a person's e-mail address never
 * stopped a call. 0037 made every earlier stop `all` and put the person's addresses into the
 * dial keys, so such a stop now does. A contact is counted when, in one workspace:
 *
 *   * an effective handle stop on one of their addresses is `all` and was recorded before
 *     0037 was applied (`schema_versions.applied_at` for version 37) — a stop of before;
 *   * they have a phone route at their firm — there is somebody one could dial;
 *   * nothing else stops dialling them: no effective `phone`/`all` stop on any of their
 *     numbers, and none on their firm — those were undialable before 0037 as well.
 *
 * An address stop recorded after 0037 is not counted: an opt-out since then is `email` and
 * stops no call, and an `all` one was chosen as all. The output is ids and counts only — no
 * name, address or number — because it is printed to the operations task's log. One READ
 * ONLY transaction, rolled back; it writes nothing and decides nothing. Refused below 0037.
 */
export async function stopChannelsReportCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const schemaVersion = await readAppliedSchemaVersion(session);
    if (schemaVersion < STOP_CHANNELS_MIGRATION) {
      return refuse('schema_too_old', `the stop channels arrive with migration 0037; this database is at schema ${String(schemaVersion)}`);
    }
    const applied = await session.query<{ applied_at: Date | string }>(
      'SELECT applied_at FROM schema_versions WHERE version = $1',
      [STOP_CHANNELS_MIGRATION],
    );
    const appliedAt = asInstant(applied.rows[0]?.applied_at);
    const { rows } = await session.query<{ workspace_id: string; firm_id: string; contact_id: string }>(
      `SELECT DISTINCT a.workspace_id, a.firm_id::text AS firm_id, a.contact_id::text AS contact_id
         FROM effective_suppressions s
         JOIN email_addresses a
           ON a.workspace_id = s.workspace_id AND a.address = s.canonical_key
        WHERE s.scope = 'handle'
          AND position('@' in s.canonical_key) > 0
          AND s.channel = 'all'
          AND s.recorded_at < $1::timestamptz
          AND a.contact_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM phone_routes p
                       WHERE p.workspace_id = a.workspace_id AND p.firm_id = a.firm_id AND p.contact_id = a.contact_id)
          AND NOT EXISTS (SELECT 1 FROM effective_suppressions f
                           WHERE f.workspace_id = a.workspace_id AND f.scope = 'firm'
                             AND f.canonical_key = a.firm_id::text AND f.channel IN ('phone', 'all'))
          AND NOT EXISTS (SELECT 1 FROM effective_suppressions h
                            JOIN phone_routes p ON p.workspace_id = h.workspace_id AND p.e164 = h.canonical_key
                           WHERE h.workspace_id = a.workspace_id AND h.scope = 'handle' AND h.channel IN ('phone', 'all')
                             AND p.firm_id = a.firm_id AND p.contact_id = a.contact_id)
        ORDER BY a.workspace_id, firm_id, contact_id`,
      [appliedAt],
    );
    const workspaceIds = await listWorkspaceIds(session);
    const workspaces = workspaceIds.map(workspaceId => {
      const mine = rows.filter(row => row.workspace_id === workspaceId);
      return {
        workspaceId,
        newlyUndialableContacts: mine.length,
        atFirms: new Set(mine.map(row => row.firm_id)).size,
        contacts: mine.map(row => ({ contactId: row.contact_id, firmId: row.firm_id })),
      };
    });
    return accept({ ok: true, report: { schemaVersion, migration0037AppliedAt: appliedAt, workspaces } });
  } finally {
    await session.query('ROLLBACK');
  }
}

// ---------------------------------------------------------------------------
// The pipeline remap report (call-to-booking slice W, migration 0028).
// ---------------------------------------------------------------------------

/**
 * `fss admin pipeline stage-counts`: every workspace's stages in board order, with how
 * many open, won and lost opportunities sit in each, how many pins there are, and how
 * many opportunities 0028's remap moved (`stage_remap_20260930`). The before-and-after
 * read for the release that applies 0028: run before, the counts are in the old stages;
 * run after, `contacting`, `engaged` and `proposal` hold no open opportunity and the
 * remap count equals what they held. One READ ONLY transaction; it writes nothing.
 */
export async function pipelineStageCountsCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const schemaVersion = await readAppliedSchemaVersion(session);
    const { rows: stages } = await session.query<{
      workspace_id: string;
      key: string;
      display_name: string;
      position: number;
      retired: boolean;
      open: string;
      won: string;
      lost: string;
    }>(
      `SELECT s.workspace_id, s.key, s.display_name, s.position, s.retired,
              count(o.id) FILTER (WHERE o.status = 'open')::text AS open,
              count(o.id) FILTER (WHERE o.status = 'won')::text AS won,
              count(o.id) FILTER (WHERE o.status = 'lost')::text AS lost
         FROM pipeline_stages s
         LEFT JOIN opportunities o ON o.workspace_id = s.workspace_id AND o.stage_id = s.id
        GROUP BY s.workspace_id, s.id, s.key, s.display_name, s.position, s.retired
        ORDER BY s.workspace_id, s.position`,
    );
    // The two 0028 reads only exist at schema 28; before it the counts alone are the report.
    const at28 = schemaVersion >= 28;
    const remapped = at28
      ? await session.query<{ workspace_id: string; count: string }>(
          `SELECT workspace_id, count(*)::text AS count FROM opportunity_stage_events
            WHERE reason = 'stage_remap_20260930' GROUP BY workspace_id`,
        )
      : { rows: [] };
    const pins = at28
      ? await session.query<{ workspace_id: string; count: string }>(
          'SELECT workspace_id, count(*)::text AS count FROM opportunity_stage_pins GROUP BY workspace_id',
        )
      : { rows: [] };
    const byWorkspace = new Map<string, { stages: Record<string, unknown>[]; remapped: number; pins: number }>();
    for (const row of stages) {
      const entry = byWorkspace.get(row.workspace_id) ?? { stages: [], remapped: 0, pins: 0 };
      entry.stages.push({
        key: row.key,
        displayName: row.display_name,
        position: Number(row.position),
        retired: row.retired,
        open: Number(row.open),
        won: Number(row.won),
        lost: Number(row.lost),
      });
      byWorkspace.set(row.workspace_id, entry);
    }
    for (const row of remapped.rows) {
      const entry = byWorkspace.get(row.workspace_id);
      if (entry !== undefined) entry.remapped = Number(row.count);
    }
    for (const row of pins.rows) {
      const entry = byWorkspace.get(row.workspace_id);
      if (entry !== undefined) entry.pins = Number(row.count);
    }
    return accept({
      ok: true,
      report: {
        schemaVersion,
        workspaces: [...byWorkspace.entries()].map(([workspaceId, entry]) => ({ workspaceId, ...entry })),
      },
    });
  } finally {
    await session.query('ROLLBACK');
  }
}
