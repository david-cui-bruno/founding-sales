import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSystemGeneration, type SessionQueryable } from '@fss/domain/db';
import { recordedGmailClient, type GmailClient, type GmailFixtureMessage } from '@fss/domain/mail';
import { SENT_TOMBSTONE_PROVENANCE } from '@fss/domain/outbound';
import { RESTORE_SENT_SCAN_SKEW_SECONDS } from '@fss/domain/restore';
import { REHEARSAL_MAILBOX_ADDRESS } from '../../bootstrap/deployment.ts';
import { enforceRestoreGeneration } from '../../bootstrap/restoreGeneration.ts';
import { createLogger, type Logger } from '../../bootstrap/log.ts';
import {
  countsCommand,
  holdsListCommand,
  jobsDiscardRunnableCommand,
  mailboxCoverageCommand,
  mailboxReconcileSentCommand,
  mailboxRecoverCommand,
  mailboxWatchRenewCommand,
  restoreHoldsOpenCommand,
  restoreReportCommand,
  schedulerRunOnceCommand,
  suppressionJournalReplayCommand,
  systemGenerationAdvanceCommand,
  type AdminInvocation,
  type AdminOutcome,
  dialAuthorizeCommand,
} from './admin.ts';
import { runMigrate, readSchemaVersionReport } from './migrate.ts';

/**
 * `fss drill` (David's condition 4, 21 September): Appendix E steps 1 to 9 in one
 * process. Step 1a, the generation check that opens the restore holds, and the
 * reconciliation after step 9 are lane g56's.
 *
 * The runner keeps the control-plane steps — the point-in-time restore, the service
 * redeployment, the alarm reads, the snapshots and the teardown — because those need
 * AWS credentials and nothing else can do them. Everything from the baseline counts to
 * the generation advance is database and Gmail work against one connection, and running
 * it in one process buys three things a shell cannot:
 *
 *   * **one report per step, written as the step finishes**, so a drill that stops has
 *     already recorded everything up to the stop;
 *   * **the stop itself.** The shell version asserts with `python3 -c` after each step
 *     and `set -e` takes it down with an exit code and no statement of which step
 *     failed. This names the step, the assertion and the value it saw;
 *   * **the assertions live beside the commands that produce them**, so a report shape
 *     that changes breaks the type rather than a quoted JSON path in a heredoc.
 *
 * The assertions are the drill's own, unchanged, and each one is a refusal to call a
 * step successful when it reconstructed nothing: "a restore drill against an empty
 * database proves nothing" applies step by step and not only to the baseline.
 *
 * ## One exception to stopping, and it is not a pass (lane g59)
 *
 * The drill stops at the first step that fails, with one exception: a probe that
 * *refused to answer* because its own prerequisite is absent. Step 1's dial probe is
 * the only one, and its prerequisite is a verified, enabled calling identity owned by an
 * assignee. When g59 wrote this nothing could create one; lane g60 gave it a creator,
 * and the rehearsal's seed now attests one for the rehearsal admin, so a rehearsal's
 * probe has a subject. A database without one — a production restore where nobody has
 * attested a number, or a seed that did not run — still gets the same treatment: the
 * step is recorded as failed and `unanswered`, the drill runs the steps after it so they
 * are measured, and the drill still fails: `ok` is false and the runner refuses it. A
 * dial that was *authorized* stops the drill where it happens, as it always did.
 *
 * ## What step 1's dial refusal has to show (lane g60)
 *
 * `allowed: false` alone is not the answer to "a dial is refused during a restore".
 * `authorizeDial` stops at its first refusal and the restore hold is its eighth step, so
 * a probe refused `posture_missing` or `outside_calling_window` — which a rehearsal with
 * no posture, or at three in the morning, always is — was refused for a reason that has
 * nothing to do with the restore. So the step also requires `restore_in_progress` among
 * the holds that apply to that very dial, which `dial-authorize` reports beside the
 * decision: the refusal is then one the restore would have made on its own.
 */

export interface DrillStepReport {
  readonly step: string;
  readonly ok: boolean;
  /** The assertion that failed, in the drill's own words. Null when the step passed. */
  readonly failure: string | null;
  /**
   * True when the step's command refused to answer because a prerequisite of the probe
   * itself is absent — never because an invariant failed (lane g59). The step is still
   * failed, and so is the drill; the drill carries on past it so the steps after it are
   * measured, because a probe with nothing to probe says nothing about them.
   */
  readonly unanswered?: boolean;
  readonly report: unknown;
}

export interface DrillReport {
  readonly ok: boolean;
  readonly baselineAt: string;
  readonly replayFrom: string;
  readonly since: string;
  readonly steps: readonly DrillStepReport[];
  /**
   * The step it stopped at: the first one that failed and was not merely unanswered.
   * Null when it ran to the end, which with an unanswered step is still a failed drill.
   */
  readonly stoppedAt: string | null;
  /** The steps that could not be answered (lane g59), in order. Empty when there are none. */
  readonly unanswered: readonly string[];
}

export interface DrillInput {
  readonly session: SessionQueryable;
  /** The migration credential's session. Step 7 refuses without it. */
  readonly migrationSession?: SessionQueryable | undefined;
  readonly invocation: Omit<AdminInvocation, 'options' | 'switches'>;
  /**
   * The baseline `fss admin counts --as-of <restore target>` wrote before the restore.
   * When neither this nor `baselineJson` is given, `asOf` is, and the drill measures the
   * baseline itself.
   */
  readonly baselinePath?: string | undefined;
  /**
   * The same baseline as a JSON value rather than a file (lane g53, `--baseline-json`).
   *
   * This is how the rehearsal hands the drill task the counts it measured on the
   * *source* before the restore. The drill runs as a one-off Fargate task: its
   * filesystem is created with it, there is no shared volume and its role has no S3,
   * so a file on the runner cannot be named here. The value is written to
   * `<reports>/step0-baseline.json` and that file is the baseline from then on, so
   * step 8's `--before` reads exactly what was handed over.
   */
  readonly baselineJson?: string | undefined;
  /** The instant RDS restored to. Required when no baseline, as a file or a value, is given. */
  readonly asOf?: string | undefined;
  readonly reportsDirectory: string;
  /** Appendix E.2's "restore point minus one hour". Derived from the baseline when absent. */
  readonly replayFrom?: string | undefined;
  /** Appendix E.3 and E.4's "minus ten minutes". Derived from the baseline when absent. */
  readonly since?: string | undefined;
  readonly adminUserId?: string | undefined;
  /**
   * The counts at the moment of failure, as a JSON value (lane g59, `--at-failure-json`).
   *
   * Measured by the runner on the source after the work the restore loses, which is the
   * rehearsal's instant of failure, and handed over as the baseline is. Written to
   * `<reports>/step0-at-failure.json` and read by step 8 as `--at-failure`, where it is
   * what "no suppression was lost" is finally measured against: a suppression recorded
   * after the restore target and before the failure is exactly the one the journal
   * exists to bring back.
   */
  readonly atFailureJson?: string | undefined;
  /**
   * What the rehearsal's recorded mailbox holds, as a JSON value (lane g59,
   * `--mailbox-recording-json`): its Sent folder and the inbound messages the seed
   * delivered. The drill's mail steps are then run against a recorded client built from
   * it, rather than against the empty fixture the deployment hands every recorded
   * process. Without it steps 3 and 4 have an empty mailbox to reconcile and recover.
   */
  readonly mailboxRecordingJson?: string | undefined;
  /**
   * Lane g56: the generation the operator expects, as the flag's text. The rehearsal
   * passes the source baseline's `systemGeneration` plus one, which is what an operator
   * pins production to after a restore. With it, step 1a runs
   * `admin restore-holds open` — the worker's own startup check — against the restored
   * copy, and step 9 is followed by the reconciliation. Without it the drill asserts
   * step 1 against whatever holds a worker pinned ahead of this database opened.
   */
  readonly expectedGeneration?: string | undefined;
}

const minus = (instant: string, seconds: number): string =>
  new Date(Date.parse(instant) - seconds * 1000).toISOString();

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

export type DrillResult =
  | { readonly ok: true; readonly value: DrillReport }
  | { readonly ok: false; readonly reason: string; readonly detail: string; readonly value?: DrillReport };

/**
 * Run one step, write its report, and check the drill's assertion about it.
 *
 * `assertion` returns the failure in the drill's own words, or null. A step whose
 * command refused is a failed step; a step whose command succeeded and whose assertion
 * failed is also a failed step, and the difference is in the message rather than in the
 * control flow.
 */
async function step(
  name: string,
  directory: string,
  run: () => Promise<AdminOutcome>,
  assertion: (report: Readonly<Record<string, unknown>>) => string | null,
  /**
   * Refusal reasons that mean the probe had nothing to probe (lane g59). Only a
   * *refusal* can be unanswered: a command that answered and failed its assertion is a
   * failed step, whatever it said.
   */
  unanswerable: readonly string[] = [],
): Promise<DrillStepReport> {
  let outcome: AdminOutcome;
  try {
    outcome = await run();
  } catch (error) {
    // A step that throws is a failed step, and the drill stops at it — but with its
    // report written (lane g59). Uncaught, it took the whole drill down with exit 21 and
    // no report at all, which in a one-off task is no record of any step. The error's
    // name and code only: a message can carry a statement or a value.
    const name = error instanceof Error ? error.name : 'unknown';
    const code = (error as { code?: unknown } | null)?.code;
    outcome = {
      ok: false,
      reason: 'step_threw',
      detail: `${name}${typeof code === 'string' || typeof code === 'number' ? ` (${String(code)})` : ''}`,
    };
  }
  const report = outcome.ok ? outcome.value : { refused: outcome.reason, detail: outcome.detail };
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (!outcome.ok) {
    const failure = `${outcome.reason}: ${outcome.detail}`;
    return unanswerable.includes(outcome.reason)
      ? { step: name, ok: false, failure, unanswered: true, report }
      : { step: name, ok: false, failure, report };
  }
  const failure = assertion(outcome.value);
  return { step: name, ok: failure === null, failure, report };
}

/**
 * Step 1's dial assertion, in the drill's own words, or null (lanes g59 and g60).
 *
 * Refused, and refused *because of the restore*: the restore hold is among the holds
 * that apply to this very dial, which `dial-authorize` reports beside its decision. A
 * dial refused at an earlier step of 9.2 for a reason of its own — no posture, outside
 * the window — with no restore hold behind it says nothing about the restore (see the
 * header). Exported so the rule can be tested on its own, since no real database has a
 * restore hold that does not apply to a dial in the same workspace.
 */
export function dialProbeFailure(report: Readonly<Record<string, unknown>>): string | null {
  if (report['allowed'] !== false) {
    return `a dial was authorized while a restore was in progress: ${JSON.stringify(report)}`;
  }
  const holds = Array.isArray(report['holds']) ? (report['holds'] as readonly unknown[]) : [];
  return holds.includes('restore_in_progress')
    ? null
    : `the dial was refused (${String(report['reason'])}) but no restore hold applies to it, so the refusal says nothing about the restore: ${JSON.stringify(report)}`;
}

/** Whether the drill carries on: every step so far passed, or could only not be answered. */
const proceeding = (steps: readonly DrillStepReport[]): boolean =>
  steps.every(entry => entry.ok || entry.unanswered === true);

/**
 * A handed JSON object (lane g59): the at-failure counts or the mailbox recording.
 * Null when it is not one object, which the caller turns into a named refusal.
 */
function handedObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The recorded mailbox the drill's mail steps run against, from the handed recording.
 *
 * Strict about shape, because a recording that silently dropped its Sent folder would
 * make step 3 fail for a reason that looks like the restore's: every message needs the
 * fields the recorded client answers from, and every Sent entry is an RFC Message-ID.
 */
function mailboxFromRecording(recording: Record<string, unknown>): Parameters<typeof recordedGmailClient>[0] | string {
  const sent = recording['sentMessageIds'];
  const messages = recording['messages'];
  // Lane g73: the Sent folder's messages, which step 3 lists for the sends whose fence
  // the restore lost. Optional, so a recording from before this lane still reads; a
  // recording that carries it malformed is refused like any other.
  const sentMessages = recording['sentMessages'] ?? [];
  if (!Array.isArray(sent) || !sent.every(entry => typeof entry === 'string' && entry.length > 0)) {
    return 'sentMessageIds is a list of RFC Message-IDs';
  }
  if (!Array.isArray(messages)) return 'messages is a list of recorded messages';
  if (!Array.isArray(sentMessages)) return 'sentMessages is a list of recorded messages';
  for (const message of [...(messages as unknown[]), ...(sentMessages as unknown[])]) {
    const entry = message as Record<string, unknown> | null;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry['id'] !== 'string' ||
      typeof entry['threadId'] !== 'string' ||
      typeof entry['internalDateEpochMilliseconds'] !== 'number' ||
      typeof entry['historyId'] !== 'string' ||
      typeof entry['headers'] !== 'object' ||
      entry['headers'] === null
    ) {
      return 'each recorded message carries id, threadId, internalDateEpochMilliseconds, historyId and headers';
    }
  }
  const address = recording['emailAddress'];
  const historyId = recording['historyId'];
  return {
    emailAddress: typeof address === 'string' && address.length > 0 ? address : REHEARSAL_MAILBOX_ADDRESS,
    historyId: typeof historyId === 'string' && historyId.length > 0 ? historyId : '1',
    messages: messages as GmailFixtureMessage[],
    sentMessageIds: sent as string[],
    sentMessages: sentMessages as GmailFixtureMessage[],
  };
}

/**
 * The mail client every drill step runs through, counting the sends made through it
 * (lane g73).
 *
 * `step5-no-second-send` asserts that nothing the drill did sent anything. Step 3's own
 * count covers step 3; this one covers the whole run, so a later step that sent a
 * tombstoned step again — the failure Appendix E.3 exists to prevent — is a number
 * rather than a silence.
 */
function countingDrillGmail(gmail: GmailClient): { readonly client: GmailClient; sends(): number } {
  let sends = 0;
  return {
    client: {
      ...gmail,
      sendMessage: async (access, request) => {
        sends += 1;
        return await gmail.sendMessage(access, request);
      },
    },
    sends: () => sends,
  };
}

/** One tombstone step 3 reported, as the database holds it now (lane g73). */
interface TombstoneCheck {
  readonly outboundMessageId: string;
  readonly stepExecutionId: string;
  readonly state: string | null;
  readonly reconciledFrom: string | null;
  readonly fencesForStep: number;
  readonly fencesToRecipient: number;
}

/**
 * Read back each tombstone the step 3 report claims, from the database (lane g73).
 *
 * The report is the command's word; the row, its ledger event and the count of fences for
 * its step are the database's. The count to the recipient is measured here and again
 * after the scheduler has run, which is how `step5-no-second-send` tells "no second
 * fence" from "no fence yet". The recipient itself is never written into the report.
 */
async function readTombstones(session: SessionQueryable, step3: Readonly<Record<string, unknown>>): Promise<TombstoneCheck[]> {
  const lines = Array.isArray(step3['missing_fences']) ? (step3['missing_fences'] as Record<string, unknown>[]) : [];
  const checks: TombstoneCheck[] = [];
  for (const line of lines.filter(entry => entry['outcome'] === 'tombstoned')) {
    const outboundMessageId = String(line['outboundMessageId'] ?? '');
    const stepExecutionId = String(line['stepExecutionId'] ?? '');
    const { rows } = await session.query<{
      state: string;
      reconciled_from: string | null;
      fences_for_step: string;
      fences_to_recipient: string;
    }>(
      `SELECT o.state,
              (SELECT e.detail ->> 'reconciled_from' FROM outbound_message_events e
                WHERE e.workspace_id = o.workspace_id AND e.outbound_message_id = o.id
                ORDER BY e.sequence_number LIMIT 1) AS reconciled_from,
              (SELECT count(*) FROM outbound_messages x
                WHERE x.workspace_id = o.workspace_id AND x.step_execution_id = o.step_execution_id)::text
                AS fences_for_step,
              (SELECT count(*) FROM outbound_messages x
                WHERE x.workspace_id = o.workspace_id AND x.recipient_address = o.recipient_address)::text
                AS fences_to_recipient
         FROM outbound_messages o
        WHERE o.id = $1::uuid AND o.step_execution_id = $2::uuid`,
      [outboundMessageId, stepExecutionId],
    );
    const row = rows[0];
    checks.push({
      outboundMessageId,
      stepExecutionId,
      state: row?.state ?? null,
      reconciledFrom: row?.reconciled_from ?? null,
      fencesForStep: Number(row?.fences_for_step ?? '0'),
      fencesToRecipient: Number(row?.fences_to_recipient ?? '0'),
    });
  }
  return checks;
}

export interface GenerationReconciliation {
  readonly generation: number | null;
  readonly expectedGeneration: number;
  /** False when the database is not on the pin, in which case the check was not run. */
  readonly reconciled: boolean;
  readonly mismatch?: boolean;
  readonly holdsOpened?: number;
  readonly restoreHoldsInForce?: number;
}

/**
 * After step 9 (lane g56): is the database on the pin step 1a used, and does the
 * worker's own startup check, run with that pin, now hold nothing?
 *
 * That is the steady state an operator leaves production in after a restore. When the
 * database is on another generation the check is deliberately *not* run: it would open
 * the restore holds again on a database step 9 has just released, which is the loop a
 * pin that disagrees with step 9 would put production in.
 */
export async function reconcileGenerationAfterAdvance(
  session: SessionQueryable,
  expectedGeneration: number,
  log: Logger,
): Promise<GenerationReconciliation> {
  const generation = await readSystemGeneration(session);
  if (generation !== expectedGeneration) return { generation, expectedGeneration, reconciled: false };
  const check = await enforceRestoreGeneration(session, {
    expectedGeneration,
    observedGeneration: generation,
    openedBy: 'fss',
    log,
  });
  return {
    generation,
    expectedGeneration,
    reconciled: true,
    mismatch: check.mismatch,
    holdsOpened: check.holdsOpened,
    restoreHoldsInForce: check.restoreHoldsInForce,
  };
}

export async function runDrill(input: DrillInput): Promise<DrillResult> {
  const directory = input.reportsDirectory;
  const steps: DrillStepReport[] = [];

  // The recorded mailbox the mail steps run against (lane g59). Refused before anything
  // is written, like an unreadable baseline: a malformed recording would make steps 3
  // and 4 fail for a reason that reads like the restore's rather than the runner's.
  let invocation = input.invocation;
  if (input.mailboxRecordingJson !== undefined) {
    const recording = handedObject(input.mailboxRecordingJson);
    const fixture = recording === null ? 'the recording is one JSON object' : mailboxFromRecording(recording);
    if (typeof fixture === 'string') {
      return {
        ok: false,
        reason: 'mailbox_recording_unreadable',
        detail: `--mailbox-recording-json carries what the rehearsal's recorded mailbox holds: ${fixture}`,
      };
    }
    if (invocation.mail === undefined) {
      return {
        ok: false,
        reason: 'mailbox_recording_unusable',
        detail: 'this deployment composed no mail client for the recording to stand in for; the drill runs with FSS_DEPENDENCIES=recorded and a journal bucket',
      };
    }
    invocation = { ...invocation, mail: { ...invocation.mail, gmail: recordedGmailClient(fixture) } };
  }
  // Lane g73: every send any step makes is counted, whatever client the steps run on.
  let drillSends: () => number = () => 0;
  if (invocation.mail !== undefined) {
    const counting = countingDrillGmail(invocation.mail.gmail);
    drillSends = counting.sends;
    invocation = { ...invocation, mail: { ...invocation.mail, gmail: counting.client } };
  }

  const invoke = (options: Record<string, string>, switches: readonly string[] = []): AdminInvocation => ({
    ...invocation,
    session: input.session,
    options,
    switches: new Set(switches),
  });

  // The reports directory, before the first write (lane g53). Nothing else creates it:
  // the worker image makes `/tmp` and nothing under it and the drill task definition
  // mounts nothing, so `--reports /tmp/fss-drill` did not exist and the thirteenth full
  // run (24 September 2026) died on its first write with an uncaught ENOENT and exit
  // 21. A directory that cannot be made is a refusal naming it, not a thrown error.
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      reason: 'reports_unwritable',
      detail: `--reports names the directory each step's report is written into, and '${directory}' could not be created (${typeof code === 'string' ? code : 'unknown error'})`,
    };
  }

  // Step 0. The baseline: handed over, read from a file, or measured here.
  //
  // Three forms, because three callers exist, and exactly one is given (the grammar's
  // `oneOf`; here a value wins over a file and a file over an instant):
  //
  //   * `--baseline-json` is the rehearsal's. The baseline is measured on the *source*
  //     before the restore, by a separate one-off task, and comes back to the runner
  //     through that task's log stream; the runner hands it to this task as a value in
  //     the task override, because nothing else reaches a Fargate task. It is an
  //     instant and five counts, all public.
  //   * `--baseline <path>` is an operator's with the file on the same machine.
  //   * `--as-of <instant>` is an operator's against an already-restored instance with
  //     only the instant. The drill measures step 0 itself — on the database it is
  //     connected to, which is the restored copy, so it is the weaker form and never the
  //     rehearsal's. The rehearsal used to pass it and so compared "no suppression
  //     lost" against the restored database's own counts (lane g53).
  //
  // `--as-of` is not needed beside either baseline form. It is only the instant a
  // measured baseline is taken at: `replayFrom` and `since` derive from the baseline's
  // own `asOf` when not given, and step 8's recovery point is measured from it too.
  let baselinePath: string;
  let baseline: Record<string, unknown>;
  if (input.baselineJson !== undefined) {
    let handed: unknown;
    try {
      handed = JSON.parse(input.baselineJson);
    } catch {
      handed = undefined;
    }
    if (typeof handed !== 'object' || handed === null || Array.isArray(handed)) {
      return {
        ok: false,
        reason: 'baseline_unreadable',
        detail: '--baseline-json carries the counts measured on the source before the restore, as one JSON object',
      };
    }
    baseline = handed as Record<string, unknown>;
    baselinePath = join(directory, 'step0-baseline.json');
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  } else if (input.baselinePath !== undefined) {
    baselinePath = input.baselinePath;
    try {
      baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        reason: 'baseline_unreadable',
        detail: '--baseline names the counts written before the restore, at the instant it restored to',
      };
    }
  } else {
    if (input.asOf === undefined) {
      return {
        ok: false,
        reason: 'baseline_unreadable',
        detail:
          'hand over the baseline with --baseline-json, name its file with --baseline, or name the instant RDS restored to with --as-of',
      };
    }
    const measuredPath = join(directory, 'step0-baseline.json');
    baselinePath = measuredPath;
    const measured = await step(
      'step0-baseline',
      directory,
      async () => await countsCommand(invoke({ '--as-of': input.asOf ?? '', '--report': measuredPath })),
      () => null,
    );
    steps.push(measured);
    if (!measured.ok) {
      return { ok: false, reason: 'baseline_unreadable', detail: measured.failure ?? 'the baseline could not be measured' };
    }
    baseline = measured.report as Record<string, unknown>;
  }
  const baselineAt = typeof baseline['asOf'] === 'string' ? baseline['asOf'] : '';
  if (baselineAt === '') {
    return { ok: false, reason: 'baseline_unreadable', detail: 'the baseline carries no asOf instant' };
  }
  // The same refusal the shell drill makes, for the same reason: a drill against a
  // baseline with nothing in it reconstructs nothing and would report a pass.
  for (const kind of ['sends', 'replies', 'suppressions', 'crm_edits', 'migrations']) {
    if (number(baseline[kind]) < 1) {
      return {
        ok: false,
        reason: 'baseline_empty',
        detail: `the baseline has no ${kind}, so reconstructing it would prove nothing`,
      };
    }
  }

  // The counts at the moment of failure (lane g59): handed over like the baseline and
  // written beside it, so step 8's `--at-failure` reads exactly what the runner measured.
  let atFailurePath: string | undefined;
  if (input.atFailureJson !== undefined) {
    const atFailure = handedObject(input.atFailureJson);
    const failedAt = typeof atFailure?.['asOf'] === 'string' ? atFailure['asOf'] : '';
    if (atFailure === null || failedAt === '' || !(Date.parse(failedAt) >= Date.parse(baselineAt))) {
      return {
        ok: false,
        reason: 'at_failure_unreadable',
        detail:
          '--at-failure-json carries the counts measured on the source at the moment of failure, as one JSON object whose asOf instant is not before the restore target',
      };
    }
    atFailurePath = join(directory, 'step0-at-failure.json');
    await writeFile(atFailurePath, `${JSON.stringify(atFailure, null, 2)}\n`, { mode: 0o600 });
  }

  const replayFrom = input.replayFrom ?? minus(baselineAt, 3600);
  const since = input.since ?? minus(baselineAt, RESTORE_SENT_SCAN_SKEW_SECONDS);

  const holdsCount = async (filter: Record<string, string>): Promise<number> => {
    const outcome = await holdsListCommand(invoke(filter, ['--count']));
    return outcome.ok ? number(outcome.value['count']) : Number.NaN;
  };

  // Step 1a (lane g56): the generation check the worker runs at startup, against the
  // restored copy, with the generation the operator would pin. It opens the restore
  // holds and logs `restore_generation_mismatch` into this task's stream in the worker
  // log group, which is what raises the immediately-critical alarm. Until this lane
  // nothing opened a restore hold anywhere, and the drill stopped at step 1 on the
  // first run that reached it (36062337914, 24 September 2026).
  const expectedGeneration = input.expectedGeneration;
  if (expectedGeneration !== undefined) {
    steps.push(
      await step(
        'step1a-generation-check',
        directory,
        async () => await restoreHoldsOpenCommand(invoke({ '--expected-generation': expectedGeneration })),
        report => {
          if (report['mismatch'] !== true) return `the generation check found no mismatch: ${JSON.stringify(report)}`;
          if (number(report['restoreHoldsInForce']) < 1) {
            return `the generation check held no workspace: ${JSON.stringify(report)}`;
          }
          return null;
        },
      ),
    );
  }

  // Step 1's assertion, which is the one that makes every step after it mean
  // something: the restored database holds sending and dialing.
  if (proceeding(steps)) {
    steps.push(
      await step(
        'step1-restore-holds',
        directory,
        async () => await holdsListCommand(invoke({ '--reason': 'restore_in_progress' })),
        report =>
          number(report['count']) >= 1
            ? null
            : `the restored database did not open a restore hold. Stop the drill and fail the release.${
                expectedGeneration === undefined
                  ? ' No --expected-generation was given, so nothing in this drill checked the generation: pass the source baseline\'s systemGeneration plus one, or point a worker pinned ahead at this database.'
                  : ''
              }`,
      ),
    );
  }
  if (proceeding(steps)) {
    steps.push(
      await step(
        'step1-dial-refused',
        directory,
        async () => await dialAuthorizeCommand(invoke({}, ['--any'])),
        dialProbeFailure,
        // Lane g59. `no_dialable_subject` is the probe declining to answer, not a dial
        // that was allowed: no firm with a usable phone route has an assignee who owns a
        // verified, enabled calling identity. The step stays failed, and so does the
        // drill, but the steps after it are measured rather than skipped, because this
        // probe says nothing about them. A dial that *was* authorized stops the drill
        // here, as it always did.
        ['no_dialable_subject'],
      ),
    );
  }

  if (!proceeding(steps)) {
    const failed = steps.find(entry => !entry.ok && entry.unanswered !== true);
    const stopped: DrillReport = {
      ok: false,
      baselineAt,
      replayFrom,
      since,
      steps,
      stoppedAt: failed?.step ?? null,
      unanswered: steps.filter(entry => entry.unanswered === true).map(entry => entry.step),
    };
    await writeFile(join(directory, 'drill.json'), `${JSON.stringify(stopped, null, 2)}\n`, { mode: 0o600 });
    return {
      ok: false,
      reason: `stopped_at_${failed?.step ?? 'unknown'}`,
      detail: failed?.failure ?? 'the step failed',
      value: stopped,
    };
  }

  steps.push(
    await step(
      'step2-journal-replay',
      directory,
      async () => await suppressionJournalReplayCommand(invoke({ '--from': replayFrom })),
      report => (number(report['inserted']) >= 1 ? null : `the journal replay reinserted nothing: ${JSON.stringify(report)}`),
    ),
  );
  if (proceeding(steps)) {
    steps.push(
      await step(
        'step2-journal-replay-second',
        directory,
        async () => await suppressionJournalReplayCommand(invoke({ '--from': replayFrom })),
        report => (number(report['inserted']) === 0 ? null : `the second replay was not idempotent: ${JSON.stringify(report)}`),
      ),
    );
  }

  if (proceeding(steps)) {
    steps.push(
      await step(
        'step3-reconcile-sent',
        directory,
        async () => await mailboxReconcileSentCommand(invoke({ '--since': since }, ['--all-mailboxes'])),
        report => {
          if (number(report['resent']) !== 0) return `a send repeated: ${JSON.stringify(report)}`;
          if (number(report['tombstones']) < 1) return `no send was reconstructed, so nothing was proved: ${JSON.stringify(report)}`;
          return null;
        },
      ),
    );
  }

  // Lane g73: Appendix E.3's missing fences, as a check of their own. `step3-reconcile-sent`
  // can pass on the in-flight fence alone — a fence the restored copy still had — which is
  // exactly how the gap stayed green. This one needs a tombstone for a send whose fence
  // the copy never had, read back from the database: its row, its ledger provenance, and
  // one fence for its step. And every mailbox's Sent folder read to the end, because a
  // folder half read proves nothing about the half that was not.
  let tombstones: TombstoneCheck[] = [];
  if (proceeding(steps)) {
    const step3 = (steps[steps.length - 1]?.report ?? {}) as Readonly<Record<string, unknown>>;
    steps.push(
      await step(
        'step3-missing-fence-tombstoned',
        directory,
        async () => {
          tombstones = await readTombstones(input.session, step3);
          return {
            ok: true,
            value: {
              missing_fences_tombstoned: number(step3['missing_fences_tombstoned']),
              missing_fences_unattached: number(step3['missing_fences_unattached']),
              mailboxes_unscanned: number(step3['mailboxes_unscanned']),
              tombstones,
            },
          };
        },
        report => {
          if (number(report['mailboxes_unscanned']) !== 0) {
            return `a mailbox's Sent folder was not read to the end, so a lost send may be unrecorded: ${JSON.stringify(report)}`;
          }
          if (!(number(report['missing_fences_tombstoned']) >= 1) || tombstones.length === 0) {
            return `no send whose fence the restore lost was tombstoned, so Appendix E.3's missing fences were not proved: ${JSON.stringify(report)}`;
          }
          const wrong = tombstones.filter(
            check => check.state !== 'sent' || check.reconciledFrom !== SENT_TOMBSTONE_PROVENANCE || check.fencesForStep !== 1,
          );
          return wrong.length === 0
            ? null
            : `a reported tombstone is not one sent fence, from the Sent folder, alone on its step: ${JSON.stringify(wrong)}`;
        },
      ),
    );
  }

  if (proceeding(steps)) {
    steps.push(
      await step(
        'step4-inbox-recover',
        directory,
        async () => await mailboxRecoverCommand(invoke({ '--since': since }, ['--all-mailboxes'])),
        report => {
          if (number(report['replies']) < 1) return `no reply reapplied its effect: ${JSON.stringify(report)}`;
          if (number(report['opt_outs']) < 1) return `no opt-out reapplied: ${JSON.stringify(report)}`;
          return null;
        },
      ),
    );
  }

  if (proceeding(steps)) {
    steps.push(
      await step('step5-jobs-discard', directory, async () => await jobsDiscardRunnableCommand(invoke({})), () => null),
    );
  }
  if (proceeding(steps)) {
    steps.push(
      await step(
        'step5-scheduler-run-once',
        directory,
        async () => await schedulerRunOnceCommand(invoke({})),
        report => (report['outcome'] === 'ran' ? null : `the scheduler pass did not run: ${JSON.stringify(report)}`),
      ),
    );
  }
  // Lane g73: the tombstoned steps were not sent again. The jobs were rematerialized from
  // business state a moment ago, so this is the point at which restored sequence work
  // would have produced a second fence: each tombstoned step still has exactly its one
  // fence, its recipient no more fences than step 3 left, and no step of this drill has
  // sent anything through the mail client.
  if (proceeding(steps)) {
    steps.push(
      await step(
        'step5-no-second-send',
        directory,
        async () => {
          const after = await readTombstones(input.session, (steps.find(entry => entry.step === 'step3-reconcile-sent')?.report ?? {}) as Readonly<Record<string, unknown>>);
          return {
            ok: true,
            value: {
              sends: drillSends(),
              tombstones: after.map(check => ({
                ...check,
                fencesToRecipientAtStep3: tombstones.find(entry => entry.outboundMessageId === check.outboundMessageId)?.fencesToRecipient ?? null,
              })),
            },
          };
        },
        report => {
          if (number(report['sends']) !== 0) return `the drill sent mail: ${JSON.stringify(report)}`;
          const checks = Array.isArray(report['tombstones']) ? (report['tombstones'] as Record<string, unknown>[]) : [];
          if (checks.length === 0) return 'no tombstoned step to check, so a second send was not ruled out';
          const repeated = checks.filter(
            check =>
              number(check['fencesForStep']) !== 1 ||
              check['state'] !== 'sent' ||
              number(check['fencesToRecipient']) !== number(check['fencesToRecipientAtStep3']),
          );
          return repeated.length === 0 ? null : `a tombstoned step gained a second fence: ${JSON.stringify(repeated)}`;
        },
      ),
    );
  }

  if (proceeding(steps)) {
    steps.push(
      await step(
        'step6-watch-renew',
        directory,
        async () => await mailboxWatchRenewCommand(invoke({}, ['--all-mailboxes'])),
        () => null,
      ),
    );
  }
  if (proceeding(steps)) {
    steps.push(
      await step(
        'step6-coverage',
        directory,
        async () => await mailboxCoverageCommand(invoke({}, ['--all-mailboxes'])),
        report => {
          const mailboxes = Array.isArray(report['mailboxes']) ? (report['mailboxes'] as Record<string, unknown>[]) : [];
          if (mailboxes.length === 0) return `no mailbox reported coverage at all: ${JSON.stringify(report)}`;
          return mailboxes.every(mailbox => mailbox['complete'] === true)
            ? null
            : `coverage is incomplete: ${JSON.stringify(report)}`;
        },
      ),
    );
  }

  if (proceeding(steps)) {
    steps.push(
      await step(
        'step7-migrate',
        directory,
        async () => {
          const migrationSession = input.migrationSession;
          if (migrationSession === undefined) {
            return {
              ok: false,
              reason: 'migration_credential_missing',
              detail: 'step 7 reapplies migrations forward and needs the migration credential',
            };
          }
          const outcome = await runMigrate(migrationSession);
          if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome.detail };
          const schema = await readSchemaVersionReport(input.session);
          return { ok: true, value: { ...outcome.value, schema: { ...schema } } };
        },
        report => {
          const schema = report['schema'] as Record<string, unknown> | undefined;
          if (schema?.['apiAccepts'] !== true || schema['workerAccepts'] !== true) {
            return `a declared schema range does not accept the restored version: ${JSON.stringify(schema)}`;
          }
          return null;
        },
      ),
    );
  }

  const restoreReportPath = join(directory, 'step8-restore-report.json');
  if (proceeding(steps)) {
    steps.push(
      await step(
        'step8-restore-report',
        directory,
        async () =>
          await restoreReportCommand(
            invoke({
              '--before': baselinePath,
              ...(atFailurePath === undefined ? {} : { '--at-failure': atFailurePath }),
              '--journal': join(directory, 'step2-journal-replay.json'),
              '--sent': join(directory, 'step3-reconcile-sent.json'),
              '--inbox': join(directory, 'step4-inbox-recover.json'),
              '--out': restoreReportPath,
            }),
          ),
        report => {
          if (number(report['sends_repeated']) !== 0) return `a send repeated: ${JSON.stringify(report)}`;
          if (number(report['suppressions_after']) < number(report['suppressions_before'])) {
            return `a suppression was lost: ${JSON.stringify(report)}`;
          }
          // Lane g59. With the moment of failure known, "never fewer" is measured against
          // it: a suppression acknowledged after the restore target and before the
          // failure is the one the journal exists to bring back.
          if (
            atFailurePath !== undefined &&
            number(report['suppressions_after']) < number(report['suppressions_at_failure'])
          ) {
            return `a suppression acknowledged before the failure was lost: ${JSON.stringify(report)}`;
          }
          if (!Number.isInteger(number(report['crm_rpo_seconds']))) {
            return 'the CRM recovery point objective was not reported';
          }
          return null;
        },
      ),
    );
  }

  if (proceeding(steps)) {
    steps.push(
      await step(
        'step9-system-generation-advance',
        directory,
        async () => {
          // Measured immediately before the advance (lane g59), which is the only instant
          // "clearing one hold never clears another" (4.3) is about. It used to be read
          // before step 1, so a hold steps 2 to 8 legitimately released — step 3 ends the
          // in-doubt send's `send_unknown_reconciling` hold once the Sent folder proves
          // delivery — was counted as one the advance had cleared.
          const otherHoldsBefore = await holdsCount({ '--exclude-reason': 'restore_in_progress' });
          // 4.3: a drill with no other hold cannot show that clearing one hold never
          // clears another, so its absence is a failed setup rather than a pass.
          if (!(otherHoldsBefore >= 1)) {
            return {
              ok: false,
              reason: 'selectivity_untestable',
              detail: 'no hold other than the restore holds existed, so selectivity was not tested',
            };
          }
          const options: Record<string, string> = { '--report': restoreReportPath };
          if (input.adminUserId !== undefined) options['--admin-user'] = input.adminUserId;
          const outcome = await systemGenerationAdvanceCommand(invoke(options));
          if (!outcome.ok) return outcome;
          const restoreAfter = await holdsCount({ '--reason': 'restore_in_progress' });
          const otherAfter = await holdsCount({ '--exclude-reason': 'restore_in_progress' });
          return {
            ok: true,
            value: { ...outcome.value, otherHoldsBefore, restoreHoldsAfter: restoreAfter, otherHoldsAfter: otherAfter },
          };
        },
        report => {
          if (number(report['restoreHoldsAfter']) !== 0) return 'a restore hold survived step 9';
          const otherHoldsBefore = number(report['otherHoldsBefore']);
          if (number(report['otherHoldsAfter']) !== otherHoldsBefore) {
            return `advancing the generation cleared ${String(otherHoldsBefore - number(report['otherHoldsAfter']))} unrelated holds`;
          }
          return null;
        },
      ),
    );
  }

  // Step 9's consequence (lane g56). Step 9 moved the database's generation, so the
  // pin step 1a used must now *be* the database's generation: that is the steady state
  // an operator leaves production in after a restore, and a worker restarted with it
  // must hold nothing. If step 9 landed anywhere else, a worker restarted with the pin
  // would reopen the restore holds the moment it started, and releasing those would
  // need another advance — so that is a failed drill, stated with both numbers, and
  // the check is not run against a database it would hold again.
  if (expectedGeneration !== undefined && proceeding(steps)) {
    steps.push(
      await step(
        'step9-generation-reconciled',
        directory,
        async () => ({
          ok: true,
          value: {
            ...(await reconcileGenerationAfterAdvance(
              input.session,
              Number(expectedGeneration),
              input.invocation.log ??
                createLogger({ component: 'fss', instanceKey: 'drill', write: line => void process.stderr.write(`${line}\n`) }),
            )),
          },
        }),
        report => {
          if (report['reconciled'] !== true) {
            return `step 9 advanced the generation to ${String(report['generation'])} and the pin is ${String(report['expectedGeneration'])}: a worker restarted with that pin would reopen the restore holds`;
          }
          if (report['mismatch'] !== false || number(report['holdsOpened']) !== 0) {
            return `the generation check with the step 1a pin still found a restore: ${JSON.stringify(report)}`;
          }
          if (number(report['restoreHoldsInForce']) !== 0) return 'a restore hold is in force after step 9';
          return null;
        },
      ),
    );
  }

  const stopped = steps.find(entry => !entry.ok && entry.unanswered !== true);
  const unanswered = steps.filter(entry => entry.unanswered === true);
  const value: DrillReport = {
    ok: steps.every(entry => entry.ok),
    baselineAt,
    replayFrom,
    since,
    steps,
    stoppedAt: stopped?.step ?? null,
    unanswered: unanswered.map(entry => entry.step),
  };
  await writeFile(join(directory, 'drill.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (stopped !== undefined) {
    return { ok: false, reason: `stopped_at_${stopped.step}`, detail: stopped.failure ?? 'the step failed', value };
  }
  const first = unanswered[0];
  if (first !== undefined) {
    // Ran to the end, and is still a failed drill: a step that could not be answered is
    // not a step that passed (lane g59).
    return {
      ok: false,
      reason: `unanswered_${first.step}`,
      detail: `${first.failure ?? 'the step could not be answered'}; every later step ran and is in the report`,
      value,
    };
  }
  return { ok: true, value };
}
