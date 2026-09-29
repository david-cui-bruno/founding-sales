import { rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import { ensureRuntimeDatabaseUser } from '../../apps/worker/src/tools/fss/databaseUsers.ts';
import { createUpgradeDatabase, MIGRATOR_LOGIN_ROLE, RUNTIME_LOGIN_ROLE } from './cluster.ts';
import { applyAs, ensureMigrationMembershipInherits, withFailingMigration } from './migrate.ts';
import { prepareBaseCheckout, schemaVersionOf } from './baseCheckout.ts';
import { ALLOWED_MISSING_OBJECTS, loadFixtureInBaseCheckout, unexcusedSkips } from './fixtureRun.ts';
import { addedTables, columnNames, differences, snapshot, tableNames } from './snapshot.ts';
import { backendPidOf, sampleLocks, SAMPLE_INTERVAL_MS } from './locks.ts';
import { actualGrants, compareGrants, declaredGrants } from './grants.ts';
import { changeBudget } from './changes.ts';
import { classifyMigration, type Classification } from './classify.ts';
import { runConstraintCases } from './constraints.ts';
import { apiStartup, buildWorkerRegistry, workerStartup } from './startup.ts';
import { runWorkflows } from './workflows.ts';
import { Report, secondsSince } from './report.ts';

/**
 * `npm run upgrade:test -- --from N --to M`
 *
 * The automated upgrade test that replaces the schema rehearsal (David, 29 September
 * 2026): *"The reported 48-minute rehearsal starts from an empty database, so it does
 * not test the actual upgrade. Replace that routine work with an automated upgrade test
 * from the deployed schema, using representative existing data and actual application-role
 * permissions. Verify startup, relevant workflows, and recovery."*
 *
 * Eleven steps, each printing its wall-clock seconds, against the cluster the greenfield
 * gate already uses. It makes no cloud call of any kind and needs no credential: the
 * whole point is that the thing a release is frightened of can be answered before the
 * release, by a job.
 *
 * ## The one sentence the last step prints
 *
 * "rollback of the application image to schema N is refused by the pin; recovery is a
 * forward fix or a restore." Step 9 is what makes it a demonstration rather than a
 * claim: the previous release's range is asked of the upgraded database and refuses it.
 */

const RECOVERY_SENTENCE = (from: number): string =>
  `rollback of the application image to schema ${String(from)} is refused by the pin; recovery is a forward fix or a restore`;

interface Options {
  readonly from: number;
  readonly to: number;
  /** The checkout at schema N, whose code writes the fixture. */
  readonly base: string;
  /** The tree whose migrations and constraint cases are used. Defaults to this one. */
  readonly tree: string;
  readonly migrations: string;
  readonly evidence: string | null;
}

class UsageError extends Error {}

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const inline = /^--([a-z-]+)=(.*)$/u.exec(argument);
    if (inline?.[1] !== undefined) {
      values.set(inline[1], inline[2] ?? '');
      continue;
    }
    const flag = /^--([a-z-]+)$/u.exec(argument);
    if (flag?.[1] === undefined) throw new UsageError(`unexpected argument: ${argument}`);
    const next = argv[index + 1];
    if (next === undefined) throw new UsageError(`--${flag[1]} needs a value`);
    values.set(flag[1], next);
    index += 1;
  }
  const number = (name: string): number => {
    const raw = values.get(name);
    if (raw === undefined) throw new UsageError(`--${name} is required`);
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--${name} must be a positive integer`);
    return parsed;
  };
  const from = number('from');
  const to = number('to');
  if (to <= from) throw new UsageError(`--to (${String(to)}) must be greater than --from (${String(from)})`);

  const treeValue = values.get('tree');
  const tree = treeValue === undefined ? REPOSITORY_ROOT : resolve(treeValue);
  const migrationsValue = values.get('migrations');
  const migrations =
    migrationsValue === undefined
      ? join(tree, 'packages', 'domain', 'db', 'migrations')
      : isAbsolute(migrationsValue)
        ? migrationsValue
        : resolve(migrationsValue);
  if (!existsSync(migrations)) throw new UsageError(`no migrations directory at ${migrations}`);
  const baseValue = values.get('base');
  if (baseValue === undefined) {
    throw new UsageError(
      '--base <path> is required: the checkout at schema N, whose own code writes the fixture. HEAD knows schema M and would write a fixture the old code could never have produced.',
    );
  }
  const evidenceValue = values.get('evidence');
  return {
    from,
    to,
    base: resolve(baseValue),
    tree,
    migrations,
    evidence: evidenceValue === undefined ? null : resolve(evidenceValue),
  };
}

/** A step that failed, with the number the exit message names. */
class StepFailure extends Error {
  constructor(readonly step: number, what: string, detail: string) {
    super(`step ${String(step)} (${what}): ${detail}`);
    this.name = 'StepFailure';
  }
}

async function run(options: Options, report: Report): Promise<void> {
  report.line(`upgrade test: schema ${String(options.from)} → ${String(options.to)}`);
  report.line(`  migrations   ${options.migrations}`);
  report.line(`  head         ${options.tree}`);
  report.line(`  base         ${options.base}`);

  // The base checkout's own declaration, not an argument: a `--from` that disagrees
  // with the code that is about to write the fixture is the mistake this test exists to
  // make impossible, so it is refused rather than reconciled.
  const baseSchema = await schemaVersionOf(options.base);
  if (baseSchema !== options.from) {
    throw new UsageError(
      `--from is ${String(options.from)} but ${options.base} declares REQUIRED_SCHEMA ${String(baseSchema)}`,
    );
  }
  const headSchema = await schemaVersionOf(options.tree);
  if (headSchema !== options.to) {
    throw new UsageError(
      `--to is ${String(options.to)} but ${options.tree} declares REQUIRED_SCHEMA ${String(headSchema)}`,
    );
  }

  // ------------------------------------------------------------------ what is applied
  const classifications: Classification[] = [];
  for (let version = options.from + 1; version <= options.to; version += 1) {
    const fileName = migrationFileName(options.migrations, version);
    if (fileName === null) throw new UsageError(`no migration ${String(version)} in ${options.migrations}`);
    classifications.push(classifyMigration(join(options.migrations, fileName), { appliedOn: version - 1 }));
  }
  report.line();
  report.line('migrations this upgrade applies');
  report.table(
    ['file', 'class', 'deciding statements'],
    classifications.map(entry => [
      entry.file,
      entry.kind,
      entry.decisions.filter(decision => decision.kind === entry.kind).map(decision => decision.why).join('; ') || '—',
    ]),
  );

  const cluster = await createUpgradeDatabase();
  report.line();
  report.line(`  cluster      ${cluster.source}`);
  report.line(`  database     ${cluster.databaseName}`);
  report.line();

  const failures: string[] = [];
  try {
    // ------------------------------------------------------------------------ step 1
    let started = process.hrtime.bigint();
    const migrator = await cluster.connect(MIGRATOR_LOGIN_ROLE);
    const owner = await cluster.connect('owner');
    report.step(1, `fresh database, ${MIGRATOR_LOGIN_ROLE} owns it`, secondsSince(started));

    // ------------------------------------------------------------------------ step 2
    started = process.hrtime.bigint();
    const baseline = await applyAs(migrator.session, { directory: options.migrations, throughVersion: options.from });
    if (baseline.after !== options.from) {
      throw new StepFailure(2, 'migrations 1..N', `schema is ${String(baseline.after)}, expected ${String(options.from)}`);
    }
    // `fss admin database-users ensure`, in the order a release runs it: after the
    // first migration, because 0001 is what creates the `app_runtime` and `migration`
    // group roles this command needs, and there is no login user until it makes one.
    const users = await ensureRuntimeDatabaseUser(migrator.session, { secretValue: cluster.runtimeSecretValue });
    if (!users.ok) throw new StepFailure(2, 'database-users ensure', `${users.reason}: ${users.detail}`);
    const membership = await ensureMigrationMembershipInherits(owner.session, migrator.session);
    report.step(
      2,
      `migrations 1..${String(options.from)} as ${MIGRATOR_LOGIN_ROLE}`,
      secondsSince(started),
      `${String(baseline.applied.length)} applied; runtime user ${users.value.user.outcome}, migration membership ${users.value.migrationMembership}`,
    );
    if (membership.repaired) {
      report.line(
        `        finding: ${membership.detail}. This test granted it WITH INHERIT TRUE so the upgrade could proceed; \`fss admin database-users ensure\` does not, because it tests MEMBER where \`fss migrate\` tests USAGE.`,
      );
    }

    const runtime = await cluster.connect(RUNTIME_LOGIN_ROLE);
    const sampler = await cluster.connect('owner');

    // ------------------------------------------------------------------------ step 3
    started = process.hrtime.bigint();
    const base = await prepareBaseCheckout(options.base, REPOSITORY_ROOT);
    const fixture = await (async () => {
      try {
        return await loadFixtureInBaseCheckout(base, {
          databaseUrl: cluster.runtimeUrl,
          schemaVersion: options.from,
        });
      } finally {
        // The copied loader and the link farm go whichever way the load ended; the
        // base checkout is somebody else's commit and must be left as it was found.
        await base.cleanup().catch(() => undefined);
      }
    })();
    const loaded = fixture.parts.filter(part => part.outcome === 'loaded').length;
    report.step(
      3,
      `fixture at ${String(options.from)} by the base checkout's own code, as ${RUNTIME_LOGIN_ROLE}`,
      secondsSince(started),
      `${String(loaded)}/${String(fixture.parts.length)} parts loaded`,
    );
    report.line(
      `        loader: ${base.copiedLoader ? "HEAD's, copied into the base checkout for this run and removed afterwards" : "the base checkout's own"}; third-party modules: ${base.linkedModules ? "linked from HEAD's node_modules, @fss repointed at the base tree" : 'the base checkout already had its own'}`,
    );
    // The verdict on a skipped part is reached in step 6, once the catalogue says what
    // this upgrade added: a part that could not write `funnel_facts` at 21 is excused
    // by 0022 having created it, and a part missing anything else is not.

    // ------------------------------------------------------------------------ step 4
    started = process.hrtime.bigint();
    const before = await snapshot(owner.session);
    const beforeColumns = await columnNames(owner.session);
    const beforeRows = [...before.values()].reduce((total, table) => total + table.rows, 0);
    report.step(
      4,
      `snapshot at ${String(options.from)}`,
      secondsSince(started),
      `${String(before.size)} tables, ${String(beforeRows)} rows`,
    );

    // ------------------------------------------------------------------------ step 5
    started = process.hrtime.bigint();
    const pid = await backendPidOf(migrator.session);
    const locks = sampleLocks(sampler.session, pid);
    const upgrade = await applyAs(migrator.session, { directory: options.migrations, throughVersion: options.to });
    const applySeconds = secondsSince(started);
    const lockReport = await locks.stop();
    if (upgrade.after !== options.to) {
      throw new StepFailure(5, 'the upgrade', `schema is ${String(upgrade.after)}, expected ${String(options.to)}`);
    }
    report.step(
      5,
      `migrations ${String(options.from + 1)}..${String(options.to)} as ${MIGRATOR_LOGIN_ROLE}`,
      applySeconds,
      `${String(upgrade.applied.length)} applied`,
    );

    // ------------------------------------------------------------------------ step 6
    started = process.hrtime.bigint();
    const after = await snapshot(owner.session);
    const afterColumns = await columnNames(owner.session);
    const added = new Set<string>([
      ...addedTables(before, after),
      ...[...afterColumns].filter(column => !beforeColumns.has(column)),
    ]);
    const skipped = unexcusedSkips(fixture.parts, added);
    if (skipped.length > 0) {
      failures.push(
        `step 3: ${String(skipped.length)} fixture part(s) did not load and nothing excuses it — ${skipped.map(part => `${part.name} (missing ${part.missing.join(', ') || 'nothing nameable'}: ${part.reason})`).join('; ')}`,
      );
    }
    const changed = differences(before, after);
    const budget = changeBudget(options.migrations, options.from, options.to);
    const undeclared = changed.filter(difference => !budget.permitted.has(difference.table));
    report.step(
      6,
      'data preservation',
      secondsSince(started),
      `${String(changed.length)} table(s) changed, ${String(undeclared.length)} undeclared, ${String(addedTables(before, after).length)} added`,
    );
    if (undeclared.length > 0) {
      failures.push(
        `step 6: ${undeclared.map(difference => difference.table).join(', ')} changed and no migration in ${String(options.from + 1)}..${String(options.to)} names ${undeclared.length === 1 ? 'it' : 'them'} in a \`-- changes:\` header`,
      );
    }

    // ------------------------------------------------------------------------ step 7
    started = process.hrtime.bigint();
    const tables = await tableNames(owner.session);
    const grantDifferences = compareGrants(
      declaredGrants(options.migrations, options.to),
      await actualGrants(owner.session),
      tables,
    );
    report.step(
      7,
      `privileges at ${String(options.to)}`,
      secondsSince(started),
      `${String(tables.length)} table(s), ${String(grantDifferences.length)} disagreement(s)`,
    );
    if (grantDifferences.length > 0) {
      failures.push(`step 7: ${String(grantDifferences.length)} table(s) hold privileges the migration files do not declare`);
    }

    // ------------------------------------------------------------------------ step 8
    started = process.hrtime.bigint();
    const constraints = await runConstraintCases(options.tree, cluster.adminUrl);
    report.step(8, `constraint cases at ${String(options.to)}`, secondsSince(started), constraints.detail);
    if (!constraints.ok) {
      failures.push(`step 8: the constraint cases failed — ${constraints.detail}`);
      report.line();
      report.line('  constraint case output (tail)');
      for (const line of constraints.output.split('\n').slice(-40)) report.line(`    ${line}`);
    }

    // ------------------------------------------------------------------------ step 9
    started = process.hrtime.bigint();
    const current = { minimum: options.to, maximum: options.to };
    const previous = { minimum: options.from, maximum: options.from };
    const startups = [
      await apiStartup(runtime.session, current),
      await workerStartup(runtime.session, current),
      await apiStartup(runtime.session, previous),
      await workerStartup(runtime.session, previous),
    ];
    const registry = await buildWorkerRegistry();
    report.step(9, 'startup', secondsSince(started), `${String(registry.kinds.length)} handler kind(s) registered`);
    for (const outcome of startups) {
      const expected = outcome.range.minimum === options.to;
      if (outcome.accepted !== expected) {
        failures.push(
          `step 9: the ${outcome.component} ${outcome.accepted ? 'accepted' : 'refused'} schema ${String(outcome.databaseVersion)} with range {${String(outcome.range.minimum)},${String(outcome.range.maximum)}}`,
        );
      }
    }
    if (registry.unavailable === '' && !registry.refusesKindWithoutClass) {
      failures.push('step 9: the handler registry accepted a kind with no job class');
    }
    if (registry.unavailable !== '') {
      report.line(`        note: ${registry.unavailable}`);
    }

    // ----------------------------------------------------------------------- step 10
    started = process.hrtime.bigint();
    const workflows = await runWorkflows(runtime.session, fixture.handles);
    const failedWorkflows = workflows.filter(workflow => !workflow.ok);
    report.step(
      10,
      `workflows as ${RUNTIME_LOGIN_ROLE}`,
      secondsSince(started),
      `${String(workflows.length - failedWorkflows.length)}/${String(workflows.length)} passed`,
    );
    if (failedWorkflows.length > 0) {
      failures.push(`step 10: ${failedWorkflows.map(workflow => workflow.name).join(', ')}`);
    }

    // ----------------------------------------------------------------------- step 11
    started = process.hrtime.bigint();
    const recovery = await runRecovery(migrator.session, owner.session, options);
    report.step(11, 'recovery', secondsSince(started), recovery.summary);
    failures.push(...recovery.failures);

    // ------------------------------------------------------------------------ detail
    report.line();
    report.line('step 3 — fixture parts');
    report.table(
      ['part', 'outcome', 'ms', 'missing at N', 'reason'],
      fixture.parts.map(part => [
        part.name,
        part.outcome,
        part.ms.toFixed(0),
        part.missing.join(', ') || '—',
        part.reason,
      ]),
    );
    const addedTableNames = addedTables(before, after);
    const addedColumns = added.size - addedTableNames.length;
    report.line(
      `  a skipped part fails this test unless everything it is missing is an object this upgrade adds (${addedTableNames.join(', ') || 'no new table'}${addedColumns === 0 ? '' : `, and ${String(addedColumns)} new column(s)`}) or one of: ${ALLOWED_MISSING_OBJECTS.join(', ')}`,
    );
    report.line();
    report.line(`step 3 — tables with no row at schema ${String(options.from)}`);
    report.table(['table', 'reason'], [...fixture.emptyTables].map(([table, reason]) => [table, reason]));

    report.line();
    report.line(`step 5 — relations locked during the apply (sampled every ${String(SAMPLE_INTERVAL_MS)} ms, ${String(lockReport.samples)} samples)`);
    report.table(
      ['relation', 'strongest mode', 'held at least (ms)'],
      lockReport.relations.map(entry => [entry.relation, entry.mode, String(entry.heldMs)]),
    );
    report.line(
      `  longest ACCESS EXCLUSIVE: ${lockReport.longestAccessExclusive === null ? 'none observed' : `${lockReport.longestAccessExclusive.relation} for at least ${String(lockReport.longestAccessExclusive.heldMs)} ms`}`,
    );
    report.line(
      `  sampling, not tracing: a lock taken and released inside one ${String(SAMPLE_INTERVAL_MS)} ms window is invisible here, so an empty table means no relation was held long enough to be seen, never that none was taken.`,
    );
    report.line();
    report.line("step 5 — backends whose wait_event_type was 'Lock'");
    report.table(
      ['relation', 'mode', 'wait event', 'samples'],
      lockReport.waits.map(wait => [wait.relation, wait.mode, wait.waitEvent, String(wait.samples)]),
    );

    report.line();
    report.line('step 6 — tables the upgrade changed');
    report.table(
      ['table', 'rows before', 'rows after', 'hash', 'declared by'],
      changed.map(difference => [
        difference.table,
        String(difference.before.rows),
        difference.after === undefined ? 'dropped' : String(difference.after.rows),
        difference.after !== undefined && difference.after.hash === difference.before.hash ? 'same' : 'changed',
        budget.perMigration
          .filter(migration => migration.tables.includes(difference.table))
          .map(migration => migration.fileName)
          .join(', ') || 'NOT DECLARED',
      ]),
    );
    report.line(`  tables added: ${addedTables(before, after).join(', ') || 'none'}`);
    report.line('  declared changes, per migration:');
    report.table(
      ['file', '-- changes: header', 'tables'],
      budget.perMigration.map(migration => [
        migration.fileName,
        migration.declared ? 'present' : 'absent (read as none)',
        migration.tables.join(', ') || 'none',
      ]),
      '    ',
    );

    report.line();
    report.line(`step 7 — privileges the migrations declare vs the database's own, at ${String(options.to)}`);
    report.table(
      ['role', 'table', 'declared but missing', 'held but not declared'],
      grantDifferences.map(difference => [
        difference.role,
        difference.table,
        difference.missing.join(', ') || '—',
        difference.extra.join(', ') || '—',
      ]),
    );

    report.line();
    report.line('step 9 — startup');
    report.table(
      ['component', 'declared range', 'database', 'accepted', 'effect', 'reason'],
      startups.map(outcome => [
        outcome.component,
        `{${String(outcome.range.minimum)},${String(outcome.range.maximum)}}`,
        String(outcome.databaseVersion),
        outcome.accepted ? 'yes' : 'no',
        outcome.effect,
        outcome.reason ?? '—',
      ]),
    );
    report.line(
      registry.unavailable === ''
        ? `  handler registry: ${String(registry.kinds.length)} kind(s) — ${Object.entries(registry.classes).map(([name, count]) => `${name} ${String(count)}`).join(', ')}; a kind with no class is refused: ${registry.refusesKindWithoutClass ? 'yes' : 'NO'}`
        : `  handler registry: not built — ${registry.unavailable}`,
    );

    report.line();
    report.line('step 10 — workflows');
    report.table(
      ['workflow', 'ok', 'ms', 'decision'],
      workflows.map(workflow => [workflow.name, workflow.ok ? 'yes' : 'NO', workflow.ms.toFixed(0), workflow.detail]),
    );

    report.line();
    report.line('step 11 — recovery');
    for (const line of recovery.lines) report.line(`  ${line}`);
    report.line();
    report.line(`  ${RECOVERY_SENTENCE(options.from)}`);
  } finally {
    await cluster.drop().catch(() => undefined);
    await cluster.stop().catch(() => undefined);
  }

  report.line();
  if (failures.length === 0) {
    report.line(`PASS  schema ${String(options.from)} → ${String(options.to)}`);
    return;
  }
  report.line(`FAIL  schema ${String(options.from)} → ${String(options.to)}`);
  for (const failure of failures) report.line(`  ${failure}`);
  throw new Error(failures[0] ?? 'the upgrade test failed');
}

interface RecoveryReport {
  readonly summary: string;
  readonly lines: readonly string[];
  readonly failures: readonly string[];
}

/**
 * (a) the migrator again at M is a no-op; (b) a migration that fails halfway leaves the
 * schema and the data exactly where they were; (c) the sentence a release record carries.
 *
 * The snapshot (b) compares against is taken here, immediately before the injection,
 * and not the step-4 one. Step 4's snapshot is of the database *before* the upgrade and
 * before step 10, and step 10's workflows change rows on purpose — a Today snapshot is
 * built, a contact is deleted, a job is completed. Comparing with it would fail the
 * recovery case for the workflows' own work, which is the opposite of what the case is
 * about: what has to be true is that the *failed migration* changed nothing.
 */
async function runRecovery(
  migrator: SessionQueryable,
  owner: SessionQueryable,
  options: Options,
): Promise<RecoveryReport> {
  const lines: string[] = [];
  const failures: string[] = [];

  const again = await applyAs(migrator, { directory: options.migrations, throughVersion: options.to });
  lines.push(
    `(a) the migrator ran again at ${String(options.to)}: ${String(again.applied.length)} migration(s) applied, schema ${String(again.after)}`,
  );
  if (again.applied.length !== 0 || again.after !== options.to) {
    failures.push('step 11a: a second run of the migrator was not a no-op');
  }

  const before = await snapshot(owner);
  const injected = await withFailingMigration(options.migrations, options.to + 1);
  try {
    let refused: string | null = null;
    try {
      await applyAs(migrator, { directory: injected.directory });
    } catch (error) {
      refused = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0] ?? ''}` : 'failed';
    }
    const version = await readAppliedSchemaVersion(owner);
    const stillThere = differences(before, await snapshot(owner));
    lines.push(`(b) ${injected.fileName} was applied and failed on its second statement: ${refused ?? 'IT DID NOT FAIL'}`);
    lines.push(`    schema after the failure: ${String(version)}; tables changed by it: ${String(stillThere.length)}`);
    if (refused === null) failures.push('step 11b: the synthetic failing migration was accepted');
    if (version !== options.to) failures.push(`step 11b: the schema moved to ${String(version)} after a failed migration`);
    if (stillThere.length > 0) {
      failures.push(`step 11b: a failed migration changed ${stillThere.map(difference => difference.table).join(', ')}`);
    }
    const probe = await owner.query<{ present: boolean }>(
      "SELECT to_regclass('public.upgrade_test_failure_probe') IS NOT NULL AS present",
    );
    if (probe.rows[0]?.present === true) {
      failures.push("step 11b: the failed migration's first statement was committed");
    }
    lines.push(
      `    the first statement's table exists afterwards: ${probe.rows[0]?.present === true ? 'YES — the migration was not transactional' : 'no'}`,
    );
  } finally {
    await rm(injected.directory, { recursive: true, force: true });
  }

  lines.push(`(c) ${RECOVERY_SENTENCE(options.from)}`);
  return {
    summary: failures.length === 0 ? 'no-op re-run and transactional failure both held' : `${String(failures.length)} problem(s)`,
    lines,
    failures,
  };
}

function migrationFileName(directory: string, version: number): string | null {
  const prefix = String(version).padStart(4, '0');
  for (const fileName of readdirSync(directory).sort()) {
    if (fileName.startsWith(`${prefix}_`) && fileName.endsWith('.sql')) return fileName;
  }
  return null;
}

const report = new Report();
let evidence: string | null = null;
try {
  const options = parseOptions(process.argv.slice(2));
  evidence = options.evidence;
  await run(options, report);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'the upgrade test failed'}\n`);
  process.exitCode = 1;
} finally {
  process.stdout.write(report.toString());
  // The evidence file is written whichever way the run ended: a failed upgrade is the
  // run whose artifact somebody actually needs.
  if (evidence !== null) await writeFile(evidence, report.toString(), 'utf8');
}
