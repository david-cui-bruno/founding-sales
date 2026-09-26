import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { listConnectedMailboxes } from '@fss/domain/mail/mailboxes.ts';
import { type MailboxRow } from '@fss/domain/mail/types.ts';
import { reconcileOutboundMessage } from '@fss/domain/outbound/reconcile.ts';
import { scanSentFolder } from '@fss/domain/outbound/sentFolder.ts';
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
// The Sent-folder reconciliation (runbook step 5).
// ---------------------------------------------------------------------------

/** Which mailboxes the command acts on: every connected one, or the one named. */
async function chosenMailboxes(
  invocation: AdminInvocation,
): Promise<readonly { readonly workspaceId: string; readonly mailbox: MailboxRow }[]> {
  const named = invocation.options['--mailbox'];
  const found: { workspaceId: string; mailbox: MailboxRow }[] = [];
  for (const workspaceId of await listWorkspaceIds(invocation.session)) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), invocation.session);
    for (const mailbox of await listConnectedMailboxes(context)) {
      if (named !== undefined && mailbox.id !== named) continue;
      found.push({ workspaceId, mailbox });
    }
  }
  return found;
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
 * `fss admin mailbox reconcile-sent --since <instant> (--all-mailboxes | --mailbox <id>)`.
 *
 * After a point-in-time restore, against the restored copy, with both services stopped
 * (`docs/greenfield/runbooks/restore.md`). A send made after the restore point is a
 * message in Gmail with no fence in the copy, and nothing in the sender would stop it
 * going again; this puts the fences back.
 *
 * **The fences the copy holds.** Every fence in `dispatching` or `reconciling` started
 * since `--since` goes through `reconcileOutboundMessage`, the sweep's own function: a
 * Message-ID the Sent folder holds makes it `sent` (`fences_reconciled`).
 *
 * **The fences it lost (lane g73).** Then each mailbox's Sent folder is listed from
 * `--since` to now, and every message carrying FSS's marker for that mailbox is answered by
 * `recoverSentFolderMessage`, one transaction each: a lost fence is inserted as a `sent`
 * tombstone on the step it was the send of (`missing_fences_tombstoned`); a fence left
 * `prepared` or `held` is recorded sent (`pre_dispatch_fences_marked_sent`); a send nothing
 * in the copy could repeat is reported (`missing_fences_unmatched`); and a send that cannot
 * be tied to one step is **unattached**.
 *
 * **It refuses to finish** (exit 20, the report still printed) while any send is
 * unattached or any mailbox's Sent folder was not read to the end (`grant_revoked`,
 * `rate_limited`, `truncated`): either is a send the copy may repeat. `unresolved` lists
 * each one. The runbook does not start the services until a run exits 0.
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
  const chosen = await chosenMailboxes(invocation);
  const named = invocation.options['--mailbox'];
  if (named !== undefined && chosen.length === 0) {
    return refuse('mailbox_unknown', 'no connected mailbox has that id in this database');
  }
  const until = new Date().toISOString();
  const deps = { gmail: readOnlyGmail(mail.gmail), oauth: mail.oauth, cipher: mail.cipher, actor: 'fss-admin' };

  let fencesReconciled = 0;
  const outcomes = { tombstoned: 0, pre_dispatch_marked_sent: 0, present: 0, unmatched: 0, unattached: 0 };
  let listed = 0;
  const missingFences: Record<string, unknown>[] = [];
  const mailboxes: Record<string, unknown>[] = [];
  const unresolved: Record<string, unknown>[] = [];
  for (const { workspaceId, mailbox } of chosen) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), invocation.session);
    // `--since` bounds which fences are looked at; the Sent search's own window is the
    // fence's 24 hours (Appendix B). `reconcileMailbox` has no lower bound, so the bound
    // is applied here and each fence still goes through the one function that observes it.
    const { rows } = await invocation.session.query<{ id: string }>(
      `SELECT id FROM outbound_messages
        WHERE workspace_id = $1 AND mailbox_id = $2
          AND state IN ('reconciling', 'dispatching')
          AND (dispatch_started_at IS NULL OR dispatch_started_at >= $3::timestamptz)
        ORDER BY dispatch_started_at
        LIMIT 200`,
      [workspaceId, mailbox.id, since],
    );
    const fenceOutcomes: string[] = [];
    for (const row of rows) {
      const report = await withTransaction(invocation.session, async () =>
        reconcileOutboundMessage(context, deps, { outboundMessageId: row.id }),
      );
      fenceOutcomes.push(report.outcome);
      if (report.outcome === 'sent') fencesReconciled += 1;
    }

    const scan = await scanSentFolder(context, deps, { mailboxId: mailbox.id, since, until });
    listed += scan.listed;
    if (scan.outcome !== 'scanned') {
      unresolved.push({ kind: 'sent_folder_unscanned', workspaceId, mailboxId: mailbox.id, outcome: scan.outcome });
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
        unresolved.push({ kind: 'unattached_sent_message', ...line, sentAt: message.sentAt });
      }
    }
    mailboxes.push({
      workspaceId,
      mailboxId: mailbox.id,
      fences: rows.length,
      outcomes: fenceOutcomes,
      sentFolder: { outcome: scan.outcome, listed: scan.listed, fssMessages: scan.messages.length },
    });
  }

  const report = {
    since,
    until,
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
    missing_fences: missingFences,
    mailboxes,
  };
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: 'reconcile_unresolved',
      detail: `${String(report.missing_fences_unattached)} send(s) could not be tied to one step and ${String(report.mailboxes_unscanned)} Sent folder(s) were not read to the end; settle each item in "unresolved" and run again before starting the services`,
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
