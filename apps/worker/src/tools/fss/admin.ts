import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { reconcileOutboundMessage } from '@fss/domain/outbound/reconcile.ts';
import { scanSentFolder } from '@fss/domain/outbound/sentFolder.ts';
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
import { HOLD_REASON_CODES, releaseRecordSource, type HoldReasonCode } from '@fss/contracts';
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
        }),
      );
      outcomes[recovery.outcome] += 1;
      const line = missingFenceLine(workspaceId, mailbox.id, redactedMessageId(message.rfcMessageId), recovery);
      missingFences.push(line);
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
