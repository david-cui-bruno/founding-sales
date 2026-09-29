import { readdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import { ensureRuntimeDatabaseUser } from '../../apps/worker/src/tools/fss/databaseUsers.ts';
import { createUpgradeDatabase, MIGRATOR_LOGIN_ROLE, RUNTIME_LOGIN_ROLE } from './cluster.ts';
import { applyAs, compareDeployedMigrations, withFailingMigration } from './migrate.ts';
import { prepareCheckout, schemaVersionOf } from './baseCheckout.ts';
import { ALLOWED_MISSING_OBJECTS, loadFixtureInBaseCheckout, unexcusedSkips } from './fixtureRun.ts';
import { REQUIRED_FIXTURE_PARTS } from './fixtureManifest.ts';
import {
  addedTables,
  columnNames,
  differences,
  shapeDifferences,
  shapeSnapshot,
  viewDifferences,
  viewSnapshot,
  snapshot,
} from './snapshot.ts';
import { backendPidOf, sampleLocks, SAMPLE_INTERVAL_MS } from './locks.ts';
import { checkPrivileges, loadAccessExceptions, loadGrantsBaseline } from './grants.ts';
import { changeBudget } from './changes.ts';
import { classifyMigration, type Classification } from './classify.ts';
import { runConstraintCases } from './constraints.ts';
import { runChecksIn } from './checksRun.ts';
import { enableRoutineTracking, routineCalls } from './routines.ts';
import { parseOptions, UsageError, type Options } from './options.ts';
import { Report, secondsSince } from './report.ts';

/**
 * `npm run upgrade:test -- --from N --to M --base <checkout>`
 *
 * The automated upgrade test that replaces the schema rehearsal (David, 29 September
 * 2026): *"The reported 48-minute rehearsal starts from an empty database, so it does
 * not test the actual upgrade. Replace that routine work with an automated upgrade test
 * from the deployed schema, using representative existing data and actual
 * application-role permissions. Verify startup, relevant workflows, and recovery."*
 *
 * Eleven steps, each printing its wall-clock seconds, against the cluster the greenfield
 * gate already uses. It makes no cloud call and needs no credential.
 *
 * ## Three checkouts' worth of code, and which runs what
 *
 * **The base checkout** (`--base`) is the commit whose `REQUIRED_SCHEMA` is N — in CI,
 * the commit production's images were built from. Migrations 1..N are applied from *its*
 * directory, the fixture is written by *its* domain code, and the rollback refusal is
 * *its* images' own startup check. Nothing about the deployed schema is taken from HEAD.
 *
 * **HEAD** (`--tree`, this checkout by default) supplies migrations N+1..M and every
 * post-upgrade check: the constraint cases, the startup acceptance, the workflows. They
 * run as child processes inside it, never as imports into this process, so `--tree`
 * really does test that tree's application code.
 *
 * **This process** owns the database, the snapshots, the locks, the privileges and the
 * arithmetic. It imports no application module beyond the migration runner and the two
 * `fss` commands a release runs.
 *
 * ## The sentence the last step prints
 *
 * "rollback of the application image to schema N is refused by the pin; recovery is a
 * forward fix or a restore." Step 9 is what makes it a demonstration rather than a
 * claim: the base checkout's own images are asked about the upgraded database and
 * refuse it.
 */

const RECOVERY_SENTENCE = (from: number): string =>
  `rollback of the application image to schema ${String(from)} is refused by the pin; recovery is a forward fix or a restore`;

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** A step that failed, with the number the exit message names. */
class StepFailure extends Error {
  constructor(readonly step: number, what: string, detail: string) {
    super(`step ${String(step)} (${what}): ${detail}`);
    this.name = 'StepFailure';
  }
}

function migrationFileName(directory: string, version: number): string | null {
  const prefix = String(version).padStart(4, '0');
  for (const fileName of readdirSync(directory).sort()) {
    if (fileName.startsWith(`${prefix}_`) && fileName.endsWith('.sql')) return fileName;
  }
  return null;
}

async function run(options: Options, report: Report): Promise<void> {
  report.line(`upgrade test: schema ${String(options.from)} → ${String(options.to)}`);
  report.line(`  base         ${options.base}`);
  report.line(`  head         ${options.tree}`);
  report.line(`  migrations   1..${String(options.from)} from the base checkout, ${String(options.from + 1)}..${String(options.to)} from head`);

  // ------------------------------------------------- the deployed files are immutable
  // Before anything is created: production's runner records a sha256 of every applied
  // file and refuses a changed one, so a branch that edits a deployed migration would be
  // refused by production and must be refused here.
  const edited = compareDeployedMigrations(options.baseMigrations, options.migrations, options.from);
  if (edited.length > 0) {
    throw new StepFailure(
      0,
      'the deployed migrations',
      `${String(edited.length)} file(s) differ between the base checkout and head at or below schema ${String(options.from)}: ${edited
        .map(difference => `${difference.fileName} (${difference.reason})`)
        .join(', ')}. Migrations are immutable once applied; production's runner would refuse this with MIGRATION_CHECKSUM_MISMATCH.`,
    );
  }
  report.line(`  deployed     ${String(options.from)} file(s) byte-identical in both checkouts`);

  // Each checkout's own declaration, not an argument. A `--from` that disagrees with the
  // code that is about to write the fixture is the mistake this whole arrangement exists
  // to make impossible, so it is refused rather than reconciled.
  const baseSchema = await schemaVersionOf(options.base);
  if (baseSchema !== options.from) {
    throw new UsageError(`--from is ${String(options.from)} but ${options.base} declares REQUIRED_SCHEMA ${String(baseSchema)}`);
  }
  const headSchema = await schemaVersionOf(options.tree);
  if (headSchema !== options.to) {
    throw new UsageError(`--to is ${String(options.to)} but ${options.tree} declares REQUIRED_SCHEMA ${String(headSchema)}`);
  }

  // ------------------------------------------------------------------ what is applied
  const classifications: Classification[] = [];
  for (let version = options.from + 1; version <= options.to; version += 1) {
    const fileName = migrationFileName(options.migrations, version);
    if (fileName === null) throw new UsageError(`no migration ${String(version)} in ${options.migrations}`);
    classifications.push(classifyMigration(join(options.migrations, fileName), { appliedOn: version - 1 }));
  }
  const replacedRoutines = [...new Set(classifications.flatMap(entry => entry.routinesReplaced))];
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
  if (replacedRoutines.length > 0) {
    report.line(`  routines replaced: ${replacedRoutines.join(', ')} — each must be called by a workflow in step 10`);
  }

  const cluster = await createUpgradeDatabase({ allowRemoteCluster: options.allowRemoteCluster });
  report.line();
  report.line(`  cluster      ${cluster.source} on ${cluster.host}`);
  report.line(`  database     ${cluster.databaseName}`);
  report.line();

  const failures: string[] = [];
  // Prepared inside the try only so that a failure has somewhere to be reported, but
  // torn down in the outer `finally`: a copied loader left in the base checkout would
  // be silently preferred by the next run, which is how a stale tool gets tested.
  let base: Awaited<ReturnType<typeof prepareCheckout>> | null = null;
  let target: Awaited<ReturnType<typeof prepareCheckout>> | null = null;
  try {
    // ------------------------------------------------------------------------ step 1
    let started = process.hrtime.bigint();
    const migrator = await cluster.connect(MIGRATOR_LOGIN_ROLE);
    const owner = await cluster.connect('owner');
    report.step(1, `fresh database, ${MIGRATOR_LOGIN_ROLE} owns it`, secondsSince(started));

    // ------------------------------------------------------------------------ step 2
    started = process.hrtime.bigint();
    const baseline = await applyAs(migrator.session, {
      directory: options.baseMigrations,
      throughVersion: options.from,
    });
    if (baseline.after !== options.from) {
      throw new StepFailure(2, 'migrations 1..N', `schema is ${String(baseline.after)}, expected ${String(options.from)}`);
    }
    // `fss admin database-users ensure`, in the order a release runs it: after the first
    // migration, because 0001 is what creates the `app_runtime` and `migration` group
    // roles this command needs, and there is no login user until it makes one. Nothing
    // repairs the membership here any more — the command itself now grants the
    // inheritance `fss migrate` requires, and if it did not, step 5 would be refused.
    const users = await ensureRuntimeDatabaseUser(migrator.session, { secretValue: cluster.runtimeSecretValue });
    if (!users.ok) throw new StepFailure(2, 'database-users ensure', `${users.reason}: ${users.detail}`);
    report.step(
      2,
      `migrations 1..${String(options.from)} from the base checkout, as ${MIGRATOR_LOGIN_ROLE}`,
      secondsSince(started),
      `${String(baseline.applied.length)} applied; runtime user ${users.value.user.outcome}, migration membership ${users.value.migrationMembership}`,
    );

    // No runtime connection in this process: every statement the application would make
    // is made by a child inside the checkout under test (P1-4). What this process holds
    // is the owner, for the catalogue, and the migrator, for the applies.
    const sampler = await cluster.connect('owner');

    // ------------------------------------------------------------------------ step 3
    started = process.hrtime.bigint();
    base = await prepareCheckout(options.base, REPOSITORY_ROOT);
    const fixture = await loadFixtureInBaseCheckout(base, {
      databaseUrl: cluster.runtimeUrl,
      schemaVersion: options.from,
    });
    const loaded = fixture.parts.filter(part => part.outcome === 'loaded').length;
    report.step(
      3,
      `fixture at ${String(options.from)} by the base checkout's own code, as ${RUNTIME_LOGIN_ROLE}`,
      secondsSince(started),
      `${String(loaded)}/${String(fixture.parts.length)} parts loaded`,
    );
    report.line(
      `        loader: ${base.copiedLoader ? "head's, copied into the base checkout for this run and removed afterwards" : "the base checkout's own"}; modules: ${base.modules}`,
    );
    // The manifest, so an older or shorter loader cannot quietly reduce coverage.
    const reported = new Set(fixture.parts.map(part => part.name));
    const absent = REQUIRED_FIXTURE_PARTS.filter(name => !reported.has(name));
    if (absent.length > 0) {
      failures.push(`step 3: the loader in ${options.base} does not carry the part(s): ${absent.join(', ')}`);
    }

    // ------------------------------------------------------------------------ step 4
    started = process.hrtime.bigint();
    const before = await snapshot(owner.session);
    const beforeColumns = await columnNames(owner.session);
    const beforeShape = await shapeSnapshot(owner.session);
    // Views carry no rows of their own, so neither the content hash nor the table shape
    // can see one being replaced. `effective_suppressions` is the view the suppression
    // system answers "is this handle suppressed?" from: a replacement returning nothing
    // would leave every hash and every shape identical (GPT-6 review of PR 314, P0-4).
    const beforeViews = await viewSnapshot(owner.session);
    const beforeRows = [...before.values()].reduce((total, table) => total + table.rows, 0);
    report.step(
      4,
      `snapshot at ${String(options.from)}`,
      secondsSince(started),
      `${String(before.size)} tables, ${String(beforeRows)} rows, shapes recorded`,
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
      `migrations ${String(options.from + 1)}..${String(options.to)} from head, as ${MIGRATOR_LOGIN_ROLE}`,
      applySeconds,
      `${String(upgrade.applied.length)} applied`,
    );

    // ------------------------------------------------------------------------ step 6
    started = process.hrtime.bigint();
    const after = await snapshot(owner.session);
    const afterColumns = await columnNames(owner.session);
    const afterShape = await shapeSnapshot(owner.session);
    const afterViews = await viewSnapshot(owner.session);
    const added = new Set<string>([
      ...addedTables(before, after),
      ...[...afterColumns].filter(column => !beforeColumns.has(column)),
    ]);
    const skipped = unexcusedSkips(fixture.parts, added);
    if (skipped.length > 0) {
      failures.push(
        `step 3: ${String(skipped.length)} fixture part(s) did not load and nothing excuses it — ${skipped
          .map(part => `${part.name} (missing ${part.missing.join(', ') || 'nothing nameable'}: ${part.reason})`)
          .join('; ')}`,
      );
    }
    const changed = differences(before, after);
    const budget = changeBudget(options.migrations, options.from, options.to);
    const undeclaredRows = changed.filter(difference => !budget.permitted.has(difference.table));
    // A zero-row table's hash cannot move, so rows alone are not enough: the catalogue
    // shape of every table the migrations did not name must be identical too.
    const shapes = shapeDifferences(beforeShape, afterShape);
    const undeclaredShapes = shapes.filter(difference => !budget.permitted.has(difference.table));
    // A new view is as much a declarable change as a new table: `-- changes:` is cheap
    // to write and a view appearing unannounced is worth a sentence from its author.
    const views = viewDifferences(beforeViews, afterViews);
    const undeclaredViews = views.filter(difference => !budget.permitted.has(difference.view));
    report.step(
      6,
      'data preservation, catalogue shape and view definitions',
      secondsSince(started),
      `${String(changed.length)} table(s) changed rows, ${String(shapes.length)} changed shape, ${String(views.length)} view(s) changed, ${String(undeclaredRows.length + undeclaredShapes.length + undeclaredViews.length)} undeclared, ${String(addedTables(before, after).length)} added`,
    );
    if (undeclaredRows.length > 0) {
      failures.push(
        `step 6: ${undeclaredRows.map(difference => difference.table).join(', ')} changed rows and no migration in ${String(options.from + 1)}..${String(options.to)} names ${undeclaredRows.length === 1 ? 'it' : 'them'} in a \`-- changes:\` header`,
      );
    }
    if (undeclaredShapes.length > 0) {
      failures.push(
        `step 6: ${undeclaredShapes.map(difference => difference.table).join(', ')} changed shape and no migration in ${String(options.from + 1)}..${String(options.to)} names ${undeclaredShapes.length === 1 ? 'it' : 'them'} in a \`-- changes:\` header`,
      );
    }

    if (undeclaredViews.length > 0) {
      failures.push(
        `step 6: ${undeclaredViews.map(difference => `${difference.view} (${difference.change})`).join(', ')} — no migration in ${String(options.from + 1)}..${String(options.to)} names ${undeclaredViews.length === 1 ? 'it' : 'them'} in a \`-- changes:\` header`,
      );
    }

    // ------------------------------------------------------------------------ step 7
    started = process.hrtime.bigint();
    const privileges = await checkPrivileges(owner.session, {
      migrations: options.migrations,
      toVersion: options.to,
      baseline: loadGrantsBaseline(),
      // Out of the migration text and into a committed file a reviewer has to touch
      // separately: a migration that writes its own exemption reviews itself (GPT-6
      // review of PR 314, P0-3). A malformed or unexplained entry throws here.
      exceptions: loadAccessExceptions(),
    });
    report.step(
      7,
      `privileges at ${String(options.to)}`,
      secondsSince(started),
      `${String(privileges.tablesChecked)} table(s), ${String(privileges.effectiveChecks)} effective check(s), ${String(privileges.findings.length)} finding(s)`,
    );
    if (privileges.findings.length > 0) {
      failures.push(
        `step 7: ${String(privileges.findings.length)} privilege finding(s) — ${[...new Set(privileges.findings.map(finding => finding.kind))].join(', ')}`,
      );
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

    // ------------------------------------------------------------------- steps 9 & 10
    // One child in head (its startup, its registry, its workflows) and one in the base
    // checkout (its startup, which is the rollback refusal). Function call counting is
    // turned on first, so a replaced routine can be shown to have been called.
    started = process.hrtime.bigint();
    await enableRoutineTracking(owner.session, cluster.databaseName);
    target = await prepareCheckout(options.tree, REPOSITORY_ROOT);
    const head = await runChecksIn(target.directory, target.checks, {
      databaseUrl: cluster.runtimeUrl,
      mode: 'startup+workflows',
      handles: fixture.handles,
    });
    const previous = await runChecksIn(base.directory, base.checks, {
      databaseUrl: cluster.runtimeUrl,
      mode: 'startup',
    });
    const startupSeconds = secondsSince(started);

    for (const outcome of head.report.startup) {
      if (!outcome.ready) {
        failures.push(
          `step 9: head's ${outcome.component} refused the upgraded database (${outcome.reason ?? 'no reason'}), declaring {${String(outcome.declaredRange.minimum)},${String(outcome.declaredRange.maximum)}}`,
        );
      }
      if (outcome.declaredRange.minimum !== options.to || outcome.declaredRange.maximum !== options.to) {
        failures.push(
          `step 9: head's ${outcome.component} declares {${String(outcome.declaredRange.minimum)},${String(outcome.declaredRange.maximum)}}, not {${String(options.to)},${String(options.to)}}`,
        );
      }
    }
    for (const outcome of previous.report.startup) {
      if (outcome.ready) {
        failures.push(
          `step 9: the base checkout's ${outcome.component} ACCEPTED schema ${String(options.to)}; the pin is what makes a rollback impossible and it did not hold`,
        );
      }
      if (outcome.declaredRange.minimum !== options.from || outcome.declaredRange.maximum !== options.from) {
        failures.push(
          `step 9: the base checkout's ${outcome.component} declares {${String(outcome.declaredRange.minimum)},${String(outcome.declaredRange.maximum)}}, not {${String(options.from)},${String(options.from)}}`,
        );
      }
    }
    const registry = head.report.registry;
    if (registry === null || !registry.built) {
      failures.push(`step 9: the handler registry was not built — ${registry?.detail ?? 'no answer'}`);
    } else if (!registry.refusesKindWithoutClass) {
      failures.push('step 9: the handler registry accepted a kind with no job class');
    }
    report.step(
      9,
      'startup, in both checkouts',
      startupSeconds,
      registry?.built === true ? `${String(registry.kinds.length)} handler kind(s) registered` : 'registry NOT built',
    );

    const workflows = head.report.workflows ?? [];
    const failedWorkflows = workflows.filter(workflow => !workflow.ok);
    report.step(
      10,
      `workflows in head, as ${RUNTIME_LOGIN_ROLE}`,
      workflows.reduce((total, workflow) => total + workflow.ms, 0) / 1000,
      `${String(workflows.length - failedWorkflows.length)}/${String(workflows.length)} passed`,
    );
    if (workflows.length === 0) failures.push('step 10: the checks child reported no workflows at all');
    if (failedWorkflows.length > 0) {
      failures.push(`step 10: ${failedWorkflows.map(workflow => `${workflow.name} — ${workflow.detail}`).join('; ')}`);
    }

    // A `replaces-routine` migration releases without a rehearsal, so the replaced body
    // has to have been run by something. The server counts the calls; nothing here takes
    // a list of which workflow was supposed to do it on trust.
    const calls = await routineCalls(owner.session, replacedRoutines);
    const uncalled = calls.filter(entry => entry.calls === 0);
    if (uncalled.length > 0) {
      failures.push(
        `step 10: ${uncalled.map(entry => entry.routine).join(', ')} ${uncalled.length === 1 ? 'was' : 'were'} replaced by this upgrade and no workflow called ${uncalled.length === 1 ? 'it' : 'them'}`,
      );
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
    report.line(
      `  a skipped part fails this test unless everything it is missing is an object this upgrade adds (${addedTableNames.join(', ') || 'no new table'}${added.size - addedTableNames.length === 0 ? '' : `, and ${String(added.size - addedTableNames.length)} new column(s)`}) or one of: ${ALLOWED_MISSING_OBJECTS.join(', ')}`,
    );
    report.line();
    report.line(`step 3 — tables with no row at schema ${String(options.from)}`);
    report.table(['table', 'reason'], [...fixture.emptyTables].map(([table, reason]) => [table, reason]));

    report.line();
    report.line(`step 5 — relations locked during the apply (sampled every ${String(SAMPLE_INTERVAL_MS)} ms, ${String(lockReport.samples)} samples)`);
    report.table(
      ['relation', 'strongest mode', 'what the samples support'],
      lockReport.relations.map(entry => [entry.relation, entry.mode, entry.duration]),
    );
    report.line(
      `  longest ACCESS EXCLUSIVE: ${lockReport.longestAccessExclusive === null ? 'none observed' : `${lockReport.longestAccessExclusive.relation}, ${lockReport.longestAccessExclusive.duration}`}`,
    );
    report.line(
      `  sampling, not tracing: a lock taken and released inside one ${String(SAMPLE_INTERVAL_MS)} ms window is invisible here, so an empty table means no relation was held long enough to be seen, never that none was taken.`,
    );
    report.line(
      '  fixture-sized data, no concurrent reader; not a production duration estimate. The same statement against a table with a hundred million rows holds its lock for as long as the rewrite takes.',
    );
    report.line();
    report.line("step 5 — backends whose wait_event_type was 'Lock'");
    report.table(
      ['relation', 'mode', 'wait event', 'samples'],
      lockReport.waits.map(wait => [wait.relation, wait.mode, wait.waitEvent, String(wait.samples)]),
    );

    report.line();
    report.line('step 6 — view definitions the upgrade changed');
    report.table(
      ['view', 'change'],
      views.map(difference => [difference.view, difference.change]),
    );
    report.line();
    report.line('step 6 — tables the upgrade changed');
    report.table(
      ['table', 'rows before', 'rows after', 'rows', 'shape', 'declared by'],
      [...new Set([...changed.map(difference => difference.table), ...shapes.map(difference => difference.table)])]
        .sort()
        .map(table => {
          const rows = changed.find(difference => difference.table === table);
          const shape = shapes.find(difference => difference.table === table);
          return [
            table,
            rows === undefined ? String(before.get(table)?.rows ?? 0) : String(rows.before.rows),
            rows === undefined ? String(after.get(table)?.rows ?? 0) : rows.after === undefined ? 'dropped' : String(rows.after.rows),
            rows === undefined ? 'same' : 'changed',
            shape === undefined ? 'same' : shape.changes.join('; '),
            budget.perMigration
              .filter(migration => migration.tables.includes(table))
              .map(migration => migration.fileName)
              .join(', ') || 'NOT DECLARED',
          ];
        }),
    );
    report.line(`  tables added: ${addedTableNames.join(', ') || 'none'}`);
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
    report.line(`step 7 — privileges at ${String(options.to)}, against the committed baseline at ${String(privileges.baselineSchemaVersion)} plus the declared delta`);
    report.table(
      ['kind', 'role', 'object', 'detail'],
      privileges.findings.map(finding => [finding.kind, finding.role, finding.object, finding.detail]),
    );
    report.line(`  new tables: ${privileges.newTables.join(', ') || 'none'}`);
    report.line(
      `  tables reviewed as unreachable by app_runtime (access-exceptions.json): ${privileges.exceptions.join(', ') || 'none'}`,
    );

    report.line();
    report.line('step 9 — startup, each checkout declaring its own range');
    report.table(
      ['checkout', 'component', 'declared range', 'database', 'ready', 'effect', 'reason'],
      [
        ...head.report.startup.map(outcome => ['head', outcome, ''] as const),
        ...previous.report.startup.map(outcome => ['base', outcome, ''] as const),
      ].map(([where, outcome]) => [
        where,
        outcome.component,
        `{${String(outcome.declaredRange.minimum)},${String(outcome.declaredRange.maximum)}}`,
        String(outcome.databaseVersion),
        outcome.ready ? 'yes' : 'no',
        outcome.effect,
        outcome.reason ?? '—',
      ]),
    );
    report.line(
      registry?.built === true
        ? `  handler registry: ${String(registry.kinds.length)} kind(s) — ${Object.entries(registry.classes).map(([name, count]) => `${name} ${String(count)}`).join(', ')}; a kind with no class is refused: ${registry.refusesKindWithoutClass ? 'yes' : 'NO'}`
        : `  handler registry: NOT BUILT — ${registry?.detail ?? 'no answer'}`,
    );

    report.line();
    report.line('step 10 — workflows');
    report.table(
      ['workflow', 'ok', 'ms', 'decision'],
      workflows.map(workflow => [workflow.name, workflow.ok ? 'yes' : 'NO', workflow.ms.toFixed(0), workflow.detail]),
    );
    report.line(
      '  domain calls as the runtime role. The API’s sign-in, its command receipts and its HTTP routes are not exercised, and neither is the worker’s job runner around a real handler.',
    );
    if (replacedRoutines.length > 0) {
      report.line();
      report.line('step 10 — routines this upgrade replaced, and whether a workflow called them');
      report.table(
        ['routine', 'calls'],
        calls.map(entry => [entry.routine, String(entry.calls)]),
      );
    }

    report.line();
    report.line('step 11 — recovery');
    for (const line of recovery.lines) report.line(`  ${line}`);
    report.line();
    report.line(`  ${RECOVERY_SENTENCE(options.from)}`);
  } finally {
    if (target !== null) await target.cleanup().catch(() => undefined);
    if (base !== null) await base.cleanup().catch(() => undefined);
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
 * schema, the version rows and the data exactly where they were; (c) the sentence.
 *
 * The snapshot (b) compares against is taken here, immediately before the injection, and
 * not the step-4 one: step 4 is of the database *before* the upgrade and before step 10,
 * and step 10's workflows change rows on purpose. What has to be true is that the failed
 * migration changed nothing, and that is what this compares (GPT-6 review, P2-1). The
 * complete `schema_versions` rows are compared too, not only their maximum, and one row
 * written before the failure is read back afterwards.
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

  const versionRows = async (): Promise<string> => {
    const { rows } = await owner.query<{ digest: string }>(
      "SELECT coalesce(string_agg(version || ':' || name || ':' || checksum, '|' ORDER BY version), '') AS digest FROM schema_versions",
    );
    return rows[0]?.digest ?? '';
  };
  // One ordinary row, written before the failure and read back after it: the DDL is not
  // the only thing a failed migration could have left behind (GPT-6 review, P2-1).
  // `audit_events` is append-only, so the row cannot be quietly rewritten either.
  const probeKey = `upgrade-test-recovery-${String(options.to)}`;
  const inserted = await owner.query<{ id: string }>(
    `INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind, subject_id)
       SELECT w.id, 'system', 'today.built', 'workspace', $1 FROM workspaces w ORDER BY w.slug LIMIT 1
     RETURNING id`,
    [probeKey],
  );
  const probeId = inserted.rows[0]?.id ?? '';
  const probeBefore = await owner.query<{ digest: string }>(
    "SELECT coalesce(action || ':' || coalesce(subject_id, ''), '') AS digest FROM audit_events WHERE id = $1",
    [probeId],
  );
  const versionsBefore = await versionRows();
  const before = await snapshot(owner);
  const shapeBefore = await shapeSnapshot(owner);

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
    const shapeStillThere = shapeDifferences(shapeBefore, await shapeSnapshot(owner));
    const versionsAfter = await versionRows();
    const probeAfter = await owner.query<{ digest: string }>(
      "SELECT coalesce(action || ':' || coalesce(subject_id, ''), '') AS digest FROM audit_events WHERE id = $1",
      [probeId],
    );

    lines.push(`(b) ${injected.fileName} was applied and failed on its second statement: ${refused ?? 'IT DID NOT FAIL'}`);
    lines.push(
      `    schema after the failure: ${String(version)}; tables whose rows changed: ${String(stillThere.length)}; whose shape changed: ${String(shapeStillThere.length)}`,
    );
    lines.push(
      `    every schema_versions row identical: ${versionsBefore === versionsAfter ? 'yes' : 'NO'}; the row written before the failure is still there: ${probeAfter.rows[0]?.digest !== undefined && probeAfter.rows[0]?.digest === probeBefore.rows[0]?.digest ? 'yes' : 'NO'}`,
    );
    if (refused === null) failures.push('step 11b: the synthetic failing migration was accepted');
    if (version !== options.to) failures.push(`step 11b: the schema moved to ${String(version)} after a failed migration`);
    if (stillThere.length > 0) {
      failures.push(`step 11b: a failed migration changed rows in ${stillThere.map(difference => difference.table).join(', ')}`);
    }
    if (shapeStillThere.length > 0) {
      failures.push(`step 11b: a failed migration changed the shape of ${shapeStillThere.map(difference => difference.table).join(', ')}`);
    }
    if (versionsBefore !== versionsAfter) failures.push('step 11b: schema_versions is not what it was before the failure');
    if (probeAfter.rows[0]?.digest === undefined || probeAfter.rows[0]?.digest !== probeBefore.rows[0]?.digest) {
      failures.push('step 11b: a row written before the failed migration did not survive it');
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

// ---------------------------------------------------------------------------- entry
const report = new Report();
let evidence: string | null = null;
try {
  const options = parseOptions(process.argv.slice(2), REPOSITORY_ROOT);
  evidence = options.evidence;
  // A stub first, so that *every* attempted run leaves an artifact — including one that
  // dies in the install or the worktree before a single step ran (GPT-6 review, P2-2).
  // The `always()` upload step is only as good as the file being there.
  //
  // `wx`: create it, never open an existing one. Evidence that silently replaced an
  // earlier run's evidence is worse than no evidence, because nothing says which run
  // wrote it (GPT-6 review of PR 314, P2). A second run wants a second path.
  if (evidence !== null) {
    try {
      await writeFile(
        evidence,
        `upgrade test: schema ${String(options.from)} → ${String(options.to)}\nthe run did not reach the point of writing its report\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`${evidence} already exists; give this run an evidence path of its own rather than overwriting another run's`);
      }
      throw error;
    }
  }
  await run(options, report);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'the upgrade test failed'}\n`);
  report.line();
  report.line(error instanceof Error ? error.message : 'the upgrade test failed');
  process.exitCode = 1;
} finally {
  process.stdout.write(report.toString());
  if (evidence !== null) await writeFile(evidence, report.toString(), 'utf8');
}
