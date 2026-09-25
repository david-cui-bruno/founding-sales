import { readFile } from 'node:fs/promises';
import {
  readSystemGeneration,
  repositoryContext,
  withTransaction,
  workspaceScope,
  type SessionQueryable,
} from '@fss/domain/db';
import { databaseNow, listApplicableHolds } from '@fss/domain/policy';
import { authorizeDial } from '@fss/domain/dial';
import {
  listConnectedMailboxes,
  nextWatchGeneration,
  renewWatch,
  runMailRecovery,
  startRecovery,
  listIncompleteRecoveries,
  type GmailClient,
  type MailboxRow,
} from '@fss/domain/mail';
import { reconcileOutboundMessage } from '@fss/domain/outbound';
import { replaySuppressionJournal, type SuppressionJournalSource } from '@fss/domain/suppression';
import {
  RESTORE_ACTOR,
  advanceSystemGeneration,
  composeRestoreReport,
  countRecoveryEffects,
  countRepeatedSends,
  crmRecoveryPointSeconds,
  discardRunnableJobs,
  listOpenHolds,
  listWorkspaceIds,
  newestCrmEditAt,
  readRestoreCounts,
  readUnresolvedExceptions,
  verifyRestoreReport,
} from '@fss/domain/restore';
import type { HoldReasonCode } from '@fss/contracts';
import { runSchedulerPass } from '../../scheduler/schedulerPass.ts';
import { workerDueWorkSources } from '../../bootstrap/main.ts';
import type { MailWorkerOptions } from '../../handlers/mail.ts';
import { createLogger, type Logger } from '../../bootstrap/log.ts';
import { enforceRestoreGeneration } from '../../bootstrap/restoreGeneration.ts';
import type { ToolConfig } from './config.ts';

/**
 * The `fss admin` commands (lane G12g), one per step of
 * `infra/scripts/rehearsal-restore-drill.sh`.
 *
 * Every one of them wraps a function that already exists and adds three things and
 * nothing else: the scope, the transaction, and the JSON shape the drill parses. No
 * command here decides anything the domain has not already decided — the point of the
 * tool is that a restore drill and a production incident run the same code the worker
 * runs, from a command line, once.
 *
 * ## Why the mail commands run the handler bodies rather than enqueue jobs
 *
 * Enqueueing `mail.recover` would be the smaller change and the wrong one. Appendix E
 * is a sequence: step 3 must be finished before step 4 begins, and step 4's report is
 * what step 8 reconciles against. A command that queued the work would report that it
 * had queued it, and the drill would then assert on counts nobody had produced yet.
 * So the deps come from the worker's own bootstrap (`FSS_DEPENDENCIES=live|recorded`,
 * never a third way) and the bodies run here, synchronously, inside their own
 * transactions.
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
   * The tool's logger (stderr, the metric filters' shape). `restore-holds open` writes
   * the line `RestoreGenerationMismatches` counts through it; absent, a stderr logger
   * of the same shape is used, so the line is never silently dropped.
   */
  readonly log?: Logger | undefined;
}

export type AdminOutcome =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>>; readonly print?: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

const accept = (
  value: Readonly<Record<string, unknown>>,
  print?: string,
): AdminOutcome => (print === undefined ? { ok: true, value } : { ok: true, value, print });
const refuse = (reason: string, detail: string): AdminOutcome => ({ ok: false, reason, detail });

/** Every workspace, as a scope the tool acts for. The tool is never a user. */
async function scopes(session: SessionQueryable): Promise<readonly { id: string; context: ReturnType<typeof repositoryContext> }[]> {
  const found: { id: string; context: ReturnType<typeof repositoryContext> }[] = [];
  for (const id of await listWorkspaceIds(session)) {
    found.push({ id, context: repositoryContext(workspaceScope(id, RESTORE_ACTOR), session) });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Step 0 and step 8: the counts.
// ---------------------------------------------------------------------------

export async function countsCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const asOf = invocation.options['--as-of'];
  const counts = await readRestoreCounts(invocation.session, asOf === undefined ? {} : { asOf });
  // Lane g56. The generation the database reports *now*, not as of `--as-of`: it is not
  // a count, only step 9 moves it, and what the restore drill needs from the baseline is
  // the generation a copy restored from this database will carry, so that it can pin the
  // expected generation one ahead of it. It is also how an operator reads the value to
  // pin production at (docs/greenfield/release.md).
  return accept({ ...counts, systemGeneration: await readSystemGeneration(invocation.session) });
}

// ---------------------------------------------------------------------------
// Step 1: the restore holds, opened by the generation check (lane g56).
// ---------------------------------------------------------------------------

const toolStderrLogger = (): Logger =>
  createLogger({ component: 'fss', instanceKey: 'admin', write: line => void process.stderr.write(`${line}\n`) });

/**
 * `fss admin restore-holds open --expected-generation <n>`: Appendix E step 1 by hand.
 *
 * The same function the worker runs at startup (`enforceRestoreGeneration`), against
 * whatever database this task was pointed at. In production an operator runs it
 * against the restored endpoint *before* any service is pointed there, so that neither
 * the API's dial gate nor a worker that restarts early ever sees that database unheld;
 * `fss drill` runs it as step 1a.
 *
 * It refuses when the database is already on the expected generation, because then it
 * holds nothing and an operator reading a zero exit code at three in the morning would
 * believe the restore was held. Any other difference is a mismatch, including a pin
 * *behind* the database: that is a service pointed at a database it was not deployed
 * against, and holding it is the safe answer.
 */
export async function restoreHoldsOpenCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const raw = invocation.options['--expected-generation'] ?? '';
  if (!/^[1-9][0-9]{0,8}$/u.test(raw)) {
    return refuse('expected_generation_invalid', '--expected-generation is the positive integer the operator expects the database to be on');
  }
  const expectedGeneration = Number(raw);
  const observedGeneration = await readSystemGeneration(invocation.session);
  if (observedGeneration === null) {
    return refuse('generation_absent', 'this database reports no system_generation, so there is nothing to compare');
  }
  if (observedGeneration === expectedGeneration) {
    return refuse(
      'generation_matches',
      `this database is on generation ${String(observedGeneration)}, which is the expected one, so nothing was held; after a restore, pass the restored copy's generation plus one`,
    );
  }
  const check = await enforceRestoreGeneration(invocation.session, {
    expectedGeneration,
    observedGeneration,
    openedBy: 'fss',
    log: invocation.log ?? toolStderrLogger(),
  });
  return accept({
    systemGeneration: check.observedGeneration,
    expectedGeneration: check.expectedGeneration,
    mismatch: check.mismatch,
    holdsOpened: check.holdsOpened,
    holdsAlreadyOpen: check.holdsAlreadyOpen,
    restoreHoldsInForce: check.restoreHoldsInForce,
  });
}

// ---------------------------------------------------------------------------
// Steps 1 and 9: the holds.
// ---------------------------------------------------------------------------

export async function holdsListCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const reason = invocation.options['--reason'] as HoldReasonCode | undefined;
  const excludeReason = invocation.options['--exclude-reason'] as HoldReasonCode | undefined;
  const holds = await listOpenHolds(invocation.session, { reason, excludeReason });
  const value = { count: holds.length, reason: reason ?? null, excludeReason: excludeReason ?? null, holds };
  // `--count` prints the integer and nothing else: the drill does
  // `held="$(fss admin holds list --reason restore_in_progress --count)"` and compares
  // it with `-lt 1`, which a JSON object would turn into a shell error.
  return accept(value, invocation.switches.has('--count') ? String(holds.length) : undefined);
}

// ---------------------------------------------------------------------------
// Step 1: the dial that must be refused while a restore is in progress.
// ---------------------------------------------------------------------------

interface DialSubject {
  readonly workspaceId: string;
  readonly firmId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly callingIdentityId: string;
  readonly assignedUserId: string;
}

/**
 * A subject a dial could be authorized for, if nothing refused it.
 *
 * `--any` means "any subject this database actually has", so the triple is read rather
 * than invented: an assigned firm, a usable route of that firm, and a verified enabled
 * identity owned by the firm's assignee. A database with no such triple gets a refusal
 * to answer rather than a refusal to dial — "refused" from a probe that had nothing to
 * probe is the vacuous pass this whole drill is built to prevent.
 */
async function anyDialSubject(session: SessionQueryable): Promise<DialSubject | null> {
  const { rows } = await session.query<{
    workspace_id: string;
    firm_id: string;
    route_id: string;
    version: number;
    identity_id: string;
    assigned_user_id: string;
  }>(
    `SELECT f.workspace_id, f.id AS firm_id, r.id AS route_id, r.version,
            i.id AS identity_id, f.assigned_user_id
       FROM firms f
       JOIN phone_routes r
         ON r.workspace_id = f.workspace_id AND r.firm_id = f.id AND r.eligibility = 'usable'
       JOIN calling_identities i
         ON i.workspace_id = f.workspace_id AND i.owner_user_id = f.assigned_user_id
        AND i.verification_status = 'verified' AND i.enabled
      WHERE f.assigned_user_id IS NOT NULL AND f.status <> 'merged'
      ORDER BY f.workspace_id, f.id
      LIMIT 1`,
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        workspaceId: row.workspace_id,
        firmId: row.firm_id,
        routeId: row.route_id,
        routeVersion: row.version,
        callingIdentityId: row.identity_id,
        assignedUserId: row.assigned_user_id,
      };
}

export async function dialAuthorizeCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const { session } = invocation;
  let subject: DialSubject | null;
  if (invocation.switches.has('--any')) {
    subject = await anyDialSubject(session);
    if (subject === null) {
      return refuse(
        'no_dialable_subject',
        'this database has no assigned firm with a usable route and a verified identity, so a refusal would prove nothing',
      );
    }
  } else {
    const firmId = invocation.options['--firm'];
    const routeId = invocation.options['--route'];
    const identityId = invocation.options['--identity'];
    if (firmId === undefined || routeId === undefined || identityId === undefined) {
      return refuse('selection_missing', 'name --firm, --route and --identity, or pass --any');
    }
    const { rows } = await session.query<{ workspace_id: string; version: number; assigned_user_id: string | null }>(
      `SELECT r.workspace_id, r.version, f.assigned_user_id
         FROM phone_routes r JOIN firms f ON f.workspace_id = r.workspace_id AND f.id = r.firm_id
        WHERE r.id = $1 AND r.firm_id = $2`,
      [routeId, firmId],
    );
    const row = rows[0];
    if (row === undefined || row.assigned_user_id === null) {
      return refuse('subject_unknown', 'no such route on an assigned firm');
    }
    subject = {
      workspaceId: row.workspace_id,
      firmId,
      routeId,
      routeVersion: row.version,
      callingIdentityId: identityId,
      assignedUserId: row.assigned_user_id,
    };
  }

  // The decision is made as the assignee, because 9.1 requires an identity "owned by
  // the acting salesperson" and a system actor could never satisfy step 2. The tool
  // impersonates nobody: it reads who the firm is assigned to and asks the question
  // that person's card would ask.
  const context = repositoryContext(
    workspaceScope(subject.workspaceId, { kind: 'user', userId: subject.assignedUserId, role: 'salesperson' }),
    session,
  );
  const at = await databaseNow(context);
  const decision = await authorizeDial(context, {
    firmId: subject.firmId,
    routeId: subject.routeId,
    routeVersion: subject.routeVersion,
    callingIdentityId: subject.callingIdentityId,
    at,
  });
  // The holds are reported beside the decision because `authorizeDial` stops at the
  // first refusal and the restore pause is step 8 of eight: a drill at three in the
  // morning can be refused for being outside the calling window, and an operator still
  // has to be able to see that the restore hold is what will refuse it at ten.
  const holds = await listApplicableHolds(context, {
    actionKind: 'dial_authorization',
    firmId: subject.firmId,
    ownerUserId: subject.assignedUserId,
    channel: 'call',
  });
  return accept({
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
    at,
    subject: {
      workspaceId: subject.workspaceId,
      firmId: subject.firmId,
      routeId: subject.routeId,
      callingIdentityId: subject.callingIdentityId,
    },
    holds: holds.map(hold => hold.reasonCode),
  });
}

// ---------------------------------------------------------------------------
// Step 2: the suppression journal replay.
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
// Steps 3, 4 and 6: the mailbox commands.
// ---------------------------------------------------------------------------

function mailOptions(invocation: AdminInvocation): MailWorkerOptions | null {
  return invocation.mail ?? null;
}

/** Which mailboxes a command acts on: every connected one, or the one named. */
async function chosenMailboxes(
  invocation: AdminInvocation,
): Promise<readonly { readonly workspaceId: string; readonly mailbox: MailboxRow }[]> {
  const named = invocation.options['--mailbox'];
  const found: { workspaceId: string; mailbox: MailboxRow }[] = [];
  for (const { id, context } of await scopes(invocation.session)) {
    for (const mailbox of await listConnectedMailboxes(context)) {
      if (named !== undefined && mailbox.id !== named) continue;
      found.push({ workspaceId: id, mailbox });
    }
  }
  return found;
}

/**
 * A Gmail client that counts the sends made through it.
 *
 * Step 3's assertion is `report["resent"] == 0`, and a literal zero in the report
 * would assert nothing. The reconciliation path observes and never sends, so the count
 * is structurally zero — and if a later change made it send, this is what would say so
 * rather than the drill passing and a prospect getting the same email twice.
 */
function countingGmail(gmail: GmailClient): { readonly client: GmailClient; sends(): number } {
  let sends = 0;
  const client: GmailClient = {
    ...gmail,
    sendMessage: async (access, request) => {
      sends += 1;
      return await gmail.sendMessage(access, request);
    },
  };
  return { client, sends: () => sends };
}

export async function mailboxReconcileSentCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const options = mailOptions(invocation);
  if (options === null) return refuse('gmail_unconfigured', 'this deployment was given no Gmail client');
  const since = invocation.options['--since'] ?? '';
  const counting = countingGmail(options.gmail);
  const deps = { gmail: counting.client, oauth: options.oauth, cipher: options.cipher, actor: 'fss-admin' };

  let tombstones = 0;
  const mailboxes: Record<string, unknown>[] = [];
  for (const { workspaceId, mailbox } of await chosenMailboxes(invocation)) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), invocation.session);
    // `--since` is Appendix E.3's "restore point minus ten minutes" and bounds which
    // fences are looked at; the Sent search's own window is the fence's 24 hours
    // (Appendix B). `reconcileMailbox` has no lower bound, so the bound is applied here
    // and each fence still goes through the one function that observes it.
    const { rows } = await invocation.session.query<{ id: string }>(
      `SELECT id FROM outbound_messages
        WHERE workspace_id = $1 AND mailbox_id = $2
          AND state IN ('reconciling', 'dispatching')
          AND (dispatch_started_at IS NULL OR dispatch_started_at >= $3::timestamptz)
        ORDER BY dispatch_started_at
        LIMIT 200`,
      [workspaceId, mailbox.id, since],
    );
    const outcomes: string[] = [];
    for (const row of rows) {
      const report = await withTransaction(invocation.session, async () =>
        reconcileOutboundMessage(context, deps, { outboundMessageId: row.id }),
      );
      outcomes.push(report.outcome);
      if (report.outcome === 'sent') tombstones += 1;
    }
    mailboxes.push({ workspaceId, mailboxId: mailbox.id, fences: rows.length, outcomes });
  }

  return accept({ since, tombstones, resent: counting.sends(), mailboxes });
}

/** How many times one recovery is continued before the command gives up on it. */
export const RECOVERY_PASS_LIMIT = 40;

export async function mailboxRecoverCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const options = mailOptions(invocation);
  if (options === null) return refuse('gmail_unconfigured', 'this deployment was given no Gmail client');
  const since = invocation.options['--since'] ?? '';
  const deps = {
    gmail: options.gmail,
    oauth: options.oauth,
    cipher: options.cipher,
    journal: options.journal,
    replyPromoter: options.replyPromoter,
  };

  const mailboxes: Record<string, unknown>[] = [];
  for (const { workspaceId, mailbox } of await chosenMailboxes(invocation)) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), invocation.session);
    const recovery = await withTransaction(invocation.session, async () =>
      startRecovery(context, { mailbox, reason: 'restore', fromAt: since }),
    );
    let outcome = 'continued';
    let passes = 0;
    let coverageProved = false;
    // A recovery is bounded per run — a page of five hundred ids — and the scheduler
    // re-arms it every minute. The drill has no minute to spare between steps, so the
    // command runs the pages itself, bounded, and reports how far it got.
    while (outcome === 'continued' && passes < RECOVERY_PASS_LIMIT) {
      const report = await withTransaction(invocation.session, async () =>
        runMailRecovery(context, deps, { mailboxId: mailbox.id, generation: mailbox.generation }),
      );
      outcome = report.outcome;
      coverageProved = report.coverageProved;
      passes += 1;
    }
    mailboxes.push({
      workspaceId,
      mailboxId: mailbox.id,
      generation: recovery.generation,
      fromAt: recovery.fromAt,
      toAt: recovery.toAt,
      outcome,
      passes,
      coverageProved,
    });
  }

  // The four names the drill parses, read from the effects that were actually applied
  // rather than from what this command believes it did.
  const effects = await countRecoveryEffects(invocation.session, { since });
  return accept({ since, ...effects, mailboxes });
}

export async function mailboxWatchRenewCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const options = mailOptions(invocation);
  if (options === null) return refuse('gmail_unconfigured', 'this deployment was given no Gmail client');
  const deps = {
    gmail: options.gmail,
    oauth: options.oauth,
    cipher: options.cipher,
    topicName: options.pushTopicName,
  };

  let renewed = 0;
  const mailboxes: Record<string, unknown>[] = [];
  for (const { workspaceId, mailbox } of await chosenMailboxes(invocation)) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), invocation.session);
    const report = await withTransaction(invocation.session, async () => {
      const generation = await nextWatchGeneration(context, mailbox.id);
      return await renewWatch(context, deps, { mailboxId: mailbox.id, generation });
    });
    if (report.outcome === 'renewed') renewed += 1;
    mailboxes.push({
      workspaceId,
      mailboxId: mailbox.id,
      outcome: report.outcome,
      generation: report.generation,
      expiresAt: report.expiresAt,
    });
  }
  return accept({ renewed, mailboxes });
}

export async function mailboxCoverageCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const incomplete = await listIncompleteRecoveries(invocation.session);
  const outstanding = new Set(incomplete.map(recovery => `${recovery.workspaceId}:${recovery.mailboxId}`));
  const named = invocation.options['--mailbox'];

  const mailboxes: Record<string, unknown>[] = [];
  for (const { id, context } of await scopes(invocation.session)) {
    for (const mailbox of await listConnectedMailboxes(context)) {
      if (named !== undefined && mailbox.id !== named) continue;
      // 4.2 and 12.3: coverage is proven, never assumed. A mailbox is complete when its
      // baseline finished, its watermark exists, and no recovery is still owed pages.
      const complete =
        mailbox.baselineCompletedAt !== null &&
        mailbox.coverageWatermarkAt !== null &&
        !outstanding.has(`${id}:${mailbox.id}`);
      mailboxes.push({
        workspaceId: id,
        mailboxId: mailbox.id,
        complete,
        status: mailbox.status,
        coverageWatermarkAt: mailbox.coverageWatermarkAt,
        baselineCompletedAt: mailbox.baselineCompletedAt,
        recoveryOutstanding: outstanding.has(`${id}:${mailbox.id}`),
      });
    }
  }
  return accept({ mailboxes });
}

// ---------------------------------------------------------------------------
// Step 5: job state.
// ---------------------------------------------------------------------------

export async function jobsDiscardRunnableCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const report = await withTransaction(invocation.session, async () => discardRunnableJobs(invocation.session));
  return accept({ ...report });
}

export async function schedulerRunOnceCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const report = await runSchedulerPass(invocation.session, {
    sources: workerDueWorkSources(),
    now: new Date().toISOString(),
    instanceKey: 'fss-admin',
  });
  return accept({ ...report });
}

// ---------------------------------------------------------------------------
// Step 8: the reconciliation report.
// ---------------------------------------------------------------------------

interface CountsFile {
  readonly asOf?: string;
  readonly sends?: number;
  readonly replies?: number;
  readonly suppressions?: number;
  readonly crm_edits?: number;
  readonly migrations?: number;
}

async function readJson(path: string | undefined): Promise<Record<string, unknown> | null> {
  if (path === undefined) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function restoreReportCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const before = (await readJson(invocation.options['--before'])) as CountsFile | null;
  if (before === null || typeof before.asOf !== 'string') {
    return refuse(
      'baseline_missing',
      '--before names the baseline `fss admin counts --as-of <restore target>` wrote, and it carries the instant it was measured at',
    );
  }
  const journal = await readJson(invocation.options['--journal']);
  const sent = await readJson(invocation.options['--sent']);
  const inbox = await readJson(invocation.options['--inbox']);

  const after = await readRestoreCounts(invocation.session, {});
  const unresolved = await readUnresolvedExceptions(invocation.session);
  const resent = typeof sent?.['resent'] === 'number' ? (sent['resent'] as number) : 0;
  const report = composeRestoreReport({
    before: {
      asOf: before.asOf,
      sends: before.sends ?? 0,
      replies: before.replies ?? 0,
      suppressions: before.suppressions ?? 0,
      crm_edits: before.crm_edits ?? 0,
      migrations: before.migrations ?? 0,
    },
    after,
    // Both halves: a step execution with two accepted sends, and a send this drill's
    // own reconciliation made. Either one is a repeated send and fails the release.
    sendsRepeated: (await countRepeatedSends(invocation.session)) + resent,
    crmRpoSeconds: crmRecoveryPointSeconds(before.asOf, await newestCrmEditAt(invocation.session)),
    unresolved,
  });

  return accept({
    ...report,
    journal_inserted: journal?.['inserted'] ?? null,
    inbox_replies: inbox?.['replies'] ?? null,
    inbox_opt_outs: inbox?.['opt_outs'] ?? null,
    sent_tombstones: sent?.['tombstones'] ?? null,
  });
}

// ---------------------------------------------------------------------------
// Step 9: the generation.
// ---------------------------------------------------------------------------

/** Where the admin's identity comes from when the command line does not carry it. */
export const ADMIN_USER_VARIABLE = 'FSS_ADMIN_USER_ID';

export async function systemGenerationAdvanceCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const path = invocation.options['--report'];
  const parsed = await readJson(path);
  if (parsed === null) {
    return refuse('report_missing', 'step 9 refuses unless the step 8 report exists; --report names it');
  }
  const verdict = verifyRestoreReport(parsed);
  if (!verdict.ok) {
    return refuse(`report_${verdict.reason}`, 'the step 8 report does not permit the generation to advance');
  }

  const adminUserId =
    invocation.options['--admin-user'] ?? invocation.environment[ADMIN_USER_VARIABLE]?.trim() ?? '';
  const outcome = await withTransaction(invocation.session, async () =>
    advanceSystemGeneration(invocation.session, {
      adminUserId,
      notes: invocation.options['--notes'] ?? 'Appendix E step 9, through fss admin',
    }),
  );
  if (!outcome.ok) {
    return refuse(
      outcome.reason,
      outcome.reason === 'admin_missing'
        ? `name the admin this act is attributed to with --admin-user, or set ${ADMIN_USER_VARIABLE}`
        : 'the named user is not an active admin of any workspace',
    );
  }
  return accept({ ...outcome.value });
}
