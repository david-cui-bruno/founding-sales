import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionQueryable } from '@fss/domain/db';
import {
  countsCommand,
  holdsListCommand,
  jobsDiscardRunnableCommand,
  mailboxCoverageCommand,
  mailboxReconcileSentCommand,
  mailboxRecoverCommand,
  mailboxWatchRenewCommand,
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
 * `fss drill` (David's condition 4, 21 September): Appendix E steps 2 to 9 in one
 * process.
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
 */

export interface DrillStepReport {
  readonly step: string;
  readonly ok: boolean;
  /** The assertion that failed, in the drill's own words. Null when the step passed. */
  readonly failure: string | null;
  readonly report: unknown;
}

export interface DrillReport {
  readonly ok: boolean;
  readonly baselineAt: string;
  readonly replayFrom: string;
  readonly since: string;
  readonly steps: readonly DrillStepReport[];
  /** The step it stopped at, or null when every step passed. */
  readonly stoppedAt: string | null;
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
): Promise<DrillStepReport> {
  const outcome = await run();
  const report = outcome.ok ? outcome.value : { refused: outcome.reason, detail: outcome.detail };
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (!outcome.ok) return { step: name, ok: false, failure: `${outcome.reason}: ${outcome.detail}`, report };
  const failure = assertion(outcome.value);
  return { step: name, ok: failure === null, failure, report };
}

export async function runDrill(input: DrillInput): Promise<DrillResult> {
  const directory = input.reportsDirectory;
  const steps: DrillStepReport[] = [];

  const invoke = (options: Record<string, string>, switches: readonly string[] = []): AdminInvocation => ({
    ...input.invocation,
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

  const replayFrom = input.replayFrom ?? minus(baselineAt, 3600);
  const since = input.since ?? minus(baselineAt, 600);

  const holdsCount = async (filter: Record<string, string>): Promise<number> => {
    const outcome = await holdsListCommand(invoke(filter, ['--count']));
    return outcome.ok ? number(outcome.value['count']) : Number.NaN;
  };

  // Step 9's selectivity is measured before anything is released (4.3).
  const otherHoldsBefore = await holdsCount({ '--exclude-reason': 'restore_in_progress' });

  // Step 1's assertion, which is the one that makes every step after it mean
  // something: the restored database holds sending and dialing.
  steps.push(
    await step(
      'step1-restore-holds',
      directory,
      async () => await holdsListCommand(invoke({ '--reason': 'restore_in_progress' })),
      report =>
        number(report['count']) >= 1
          ? null
          : 'the restored database did not open a restore hold. Stop the drill and fail the release.',
    ),
  );
  if (steps.every(entry => entry.ok)) {
    steps.push(
      await step(
        'step1-dial-refused',
        directory,
        async () => await dialAuthorizeCommand(invoke({}, ['--any'])),
        report =>
          report['allowed'] === false
            ? null
            : `a dial was authorized while a restore was in progress: ${JSON.stringify(report)}`,
      ),
    );
  }

  if (!steps.every(entry => entry.ok)) {
    const failed = steps.find(entry => !entry.ok);
    const stopped: DrillReport = {
      ok: false,
      baselineAt,
      replayFrom,
      since,
      steps,
      stoppedAt: failed?.step ?? null,
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
  if (steps.every(entry => entry.ok)) {
    steps.push(
      await step(
        'step2-journal-replay-second',
        directory,
        async () => await suppressionJournalReplayCommand(invoke({ '--from': replayFrom })),
        report => (number(report['inserted']) === 0 ? null : `the second replay was not idempotent: ${JSON.stringify(report)}`),
      ),
    );
  }

  if (steps.every(entry => entry.ok)) {
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

  if (steps.every(entry => entry.ok)) {
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

  if (steps.every(entry => entry.ok)) {
    steps.push(
      await step('step5-jobs-discard', directory, async () => await jobsDiscardRunnableCommand(invoke({})), () => null),
    );
  }
  if (steps.every(entry => entry.ok)) {
    steps.push(
      await step(
        'step5-scheduler-run-once',
        directory,
        async () => await schedulerRunOnceCommand(invoke({})),
        report => (report['outcome'] === 'ran' ? null : `the scheduler pass did not run: ${JSON.stringify(report)}`),
      ),
    );
  }

  if (steps.every(entry => entry.ok)) {
    steps.push(
      await step(
        'step6-watch-renew',
        directory,
        async () => await mailboxWatchRenewCommand(invoke({}, ['--all-mailboxes'])),
        () => null,
      ),
    );
  }
  if (steps.every(entry => entry.ok)) {
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

  if (steps.every(entry => entry.ok)) {
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
  if (steps.every(entry => entry.ok)) {
    steps.push(
      await step(
        'step8-restore-report',
        directory,
        async () =>
          await restoreReportCommand(
            invoke({
              '--before': baselinePath,
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
          if (!Number.isInteger(number(report['crm_rpo_seconds']))) {
            return 'the CRM recovery point objective was not reported';
          }
          return null;
        },
      ),
    );
  }

  if (steps.every(entry => entry.ok)) {
    steps.push(
      await step(
        'step9-system-generation-advance',
        directory,
        async () => {
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
          if (number(report['otherHoldsAfter']) !== otherHoldsBefore) {
            return `advancing the generation cleared ${String(otherHoldsBefore - number(report['otherHoldsAfter']))} unrelated holds`;
          }
          return null;
        },
      ),
    );
  }

  const failed = steps.find(entry => !entry.ok);
  const value: DrillReport = {
    ok: failed === undefined,
    baselineAt,
    replayFrom,
    since,
    steps,
    stoppedAt: failed?.step ?? null,
  };
  await writeFile(join(directory, 'drill.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (failed !== undefined) {
    return { ok: false, reason: `stopped_at_${failed.step}`, detail: failed.failure ?? 'the step failed', value };
  }
  return { ok: true, value };
}
