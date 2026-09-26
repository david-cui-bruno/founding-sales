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
import { releaseRecordSource, type HoldReasonCode } from '@fss/contracts';
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

// ---------------------------------------------------------------------------
// The holds.
// ---------------------------------------------------------------------------

export async function holdsListCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const reason = invocation.options['--reason'] as HoldReasonCode | undefined;
  const excludeReason = invocation.options['--exclude-reason'] as HoldReasonCode | undefined;
  const holds = await listOpenHolds(invocation.session, { reason, excludeReason });
  return accept({ count: holds.length, reason: reason ?? null, excludeReason: excludeReason ?? null, holds });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `fss admin holds release-restore --admin-user <uuid> --note <text> [--hold <id>]`.
 *
 * The audited clearance of a `restore_in_progress` hold (lane W3-S8). Nothing opens one
 * since the generation check went, and the generation advance that released them went
 * with it, so a hold left from before would otherwise block sending and dialing in its
 * workspace for good. This releases the open ones (or the one `--hold` names) through
 * the domain's own `releaseHold` and writes one `audit_events` row per hold, as the admin
 * named, with the note, in the same transaction. It refuses a user who is not an active
 * admin of the hold's workspace, an empty note, and a `--hold` that is not an open
 * restore hold; it touches no hold of any other reason. Run `fss admin holds list
 * --reason restore_in_progress` first and read what it would release.
 */
export async function holdsReleaseRestoreCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const adminUserId = (invocation.options['--admin-user'] ?? '').trim();
  const note = (invocation.options['--note'] ?? '').trim();
  if (!UUID.test(adminUserId)) return refuse('admin_invalid', '--admin-user is the id of the admin this release is attributed to');
  if (note.length === 0 || note.length > 500) {
    return refuse('note_invalid', '--note says why the hold is released, in at most 500 characters');
  }
  const named = invocation.options['--hold'];
  const open = await listOpenHolds(invocation.session, { reason: 'restore_in_progress' });
  const chosen = named === undefined ? open : open.filter(hold => hold.id === named);
  if (named !== undefined && chosen.length === 0) {
    return refuse('hold_unknown', 'no open restore_in_progress hold has that id');
  }
  for (const workspaceId of new Set(chosen.map(hold => hold.workspaceId))) {
    const { rows } = await invocation.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`,
      [workspaceId, adminUserId],
    );
    if (Number(rows[0]?.count ?? '0') < 1) {
      return refuse('not_admin', `${adminUserId} is not an active admin of workspace ${workspaceId}`);
    }
  }

  const released: Record<string, unknown>[] = [];
  for (const hold of chosen) {
    const context = repositoryContext(workspaceScope(hold.workspaceId, RESTORE_ACTOR), invocation.session);
    const outcome = await withTransaction(invocation.session, async () => {
      const done = await releaseHold(context, hold.id);
      if (done === null) return null;
      await invocation.session.query(
        `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
         VALUES ($1, 'admin', $2, 'hold.restore_released', 'hold', $3, $4::jsonb)`,
        [
          hold.workspaceId,
          adminUserId,
          hold.id,
          JSON.stringify({ note, startedAt: done.startedAt, releasedAt: done.releasedAt, via: 'fss admin holds release-restore' }),
        ],
      );
      return done;
    });
    if (outcome !== null) {
      released.push({ workspaceId: hold.workspaceId, holdId: hold.id, startedAt: outcome.startedAt, releasedAt: outcome.releasedAt });
    }
  }
  const others = await listOpenHolds(invocation.session, { excludeReason: 'restore_in_progress' });
  return accept({ released: released.length, holds: released, otherHoldsStillOpen: others.length, adminUserId, note });
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
 * `fss admin mailbox list`. Read-only: every mailbox with its address and status.
 *
 * The restore runbook runs it against the instance being replaced, before anything
 * points at the copy, so the inventory `reconcile-sent` demands comes from the database
 * that knows every mailbox connected up to the failure, not from the copy, which knows
 * only those connected before the restore point.
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

/**
 * `--inventory a@example.com,b@example.com`: every mailbox address that could have sent
 * since the restore point, as the operator established it. Lower-cased, each one an
 * address, none repeated, and at least one.
 */
export function parseInventory(value: string | undefined): readonly string[] | null {
  const entries = (value ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);
  if (entries.length === 0) return null;
  if (new Set(entries).size !== entries.length) return null;
  if (!entries.every(entry => /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/u.test(entry))) return null;
  return entries;
}

/** What a hold opened for an unattached send names as its source (`--hold-unattached`). */
export const UNATTACHED_SEND_HOLD_SOURCE = 'restore.unattached_send';

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
  message: string,
  firmIds: readonly string[],
): Promise<readonly string[]> {
  const scopes: readonly (string | null)[] = firmIds.length === 0 ? [null] : firmIds;
  const holdIds: string[] = [];
  for (const firmId of scopes) {
    const { rows } = await context.db.query<{ id: string }>(
      `SELECT id FROM active_holds
        WHERE workspace_id = $1 AND reason_code = 'restore_in_progress' AND released_at IS NULL
          AND source_event_kind = $2 AND source_event_id = $3 AND scope_key IS NOT DISTINCT FROM $4`,
      [context.scope.workspaceId, UNATTACHED_SEND_HOLD_SOURCE, message, firmId],
    );
    const existing = rows[0]?.id;
    holdIds.push(
      existing ??
        (await openHold(context, {
          scopeKind: firmId === null ? 'workspace' : 'firm',
          ...(firmId === null ? {} : { scopeKey: firmId }),
          reasonCode: 'restore_in_progress',
          blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
          sourceEventKind: UNATTACHED_SEND_HOLD_SOURCE,
          sourceEventId: message,
          // Settled by a person who can see the Sent message; released afterwards with
          // `fss admin holds release-restore`, which audits it.
          recoveryAction: 'resolve_ambiguity',
        })),
    );
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
      return { ...base, reason: recovery.reason, firmIds: recovery.firmIds };
  }
}

/**
 * `fss admin mailbox reconcile-sent --since <instant> --inventory <address>[,<address>...]`.
 *
 * After a point-in-time restore, against the restored copy, with both services stopped
 * (`docs/greenfield/runbooks/restore.md`). A send made after the restore point is a
 * message in Gmail with no fence in the copy, and nothing in the sender would stop it
 * going again; this puts the fences back.
 *
 * **Which mailboxes.** The operator's `--inventory`: every address that could have sent
 * since the restore point, established from the instance being replaced (`fss admin
 * mailbox list`) and not from the copy, which cannot know a mailbox connected after the
 * restore point. Each inventory address is read in whatever status the copy has it; an
 * address the copy has no mailbox for is `mailbox_not_in_copy`. A mailbox the copy has
 * connected that the inventory does not name is read too, and is
 * `mailbox_not_in_inventory`, because the inventory was then not the whole list.
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
  const inventory = parseInventory(invocation.options['--inventory']);
  if (inventory === null) {
    return refuse(
      'inventory_invalid',
      '--inventory is every mailbox address that could have sent since the restore point, comma-separated, at least one, none repeated',
    );
  }

  const holdUnattached = invocation.switches.has('--hold-unattached');
  const unresolved: Record<string, unknown>[] = [];
  const unattachedHeld: Record<string, unknown>[] = [];
  const known = await everyMailbox(invocation.session);
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
          const firmIds = recovery.firmIds;
          const holdIds = await withTransaction(invocation.session, async () =>
            holdUnattachedSend(context, redactedMessageId(message.rfcMessageId), firmIds),
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
 * Stores the `fss.release-record.v1` the CI gate (`release-record-from-ci.sh`, lane g96)
 * or a green rehearsal wrote, so that an admin's
 * `sending_enabled` attestation can name it and both rules can read it: the API
 * compares its own digest with the record's `api` when the enable is saved, and the
 * worker compares its own with the record's `worker` before every dispatch. Putting a
 * record enables nothing — the record says `enablesSending: false` and the admin's act
 * is still the switch.
 *
 * `--json-base64` is the form `release-deploy.sh` uses, because a one-off task can be
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
