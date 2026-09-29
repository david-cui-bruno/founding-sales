import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { QueryOutcome, QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { apiStartupHere, buildWorkerRegistry, workerStartupHere } from './startup.ts';
import { CHECKS_JSON_PREFIX, type ChecksMode, type ChecksReport } from './checksProtocol.ts';
import type { FixtureHandles } from './fixture.ts';

/**
 * The post-upgrade checks, as a process of its own, inside the tree being tested.
 *
 * GPT-6 review, P1-4: `--tree` used to supply the schema number and the constraint run
 * while startup and the workflows imported *this tool checkout's* domain, API and
 * worker modules — so the 22→23 demonstration never ran a line of schema-23
 * application code. Every check below now runs where the code under test is: in HEAD
 * for the accept case, and in the base checkout for the rollback refusal, whose
 * declared range is the previous image's own.
 *
 * The connection URL arrives in the environment, never in `argv`: an argument list is
 * visible in `ps` and in a shell history file, and it carries the runtime password.
 *
 * `startup` is the mode the base checkout is asked for, and it loads nothing but that
 * checkout's own readiness and startup checks. The workflows are imported only in
 * `startup+workflows`, because they reach for modules an older tree does not have.
 */

const URL_VARIABLE = 'FSS_UPGRADE_DATABASE_URL';
const MODE_VARIABLE = 'FSS_UPGRADE_CHECKS_MODE';
const HANDLES_VARIABLE = 'FSS_UPGRADE_HANDLES_FILE';

async function main(): Promise<number> {
  const url = process.env[URL_VARIABLE];
  const mode = process.env[MODE_VARIABLE] as ChecksMode | undefined;
  if (url === undefined || url.trim().length === 0) {
    process.stderr.write(`${URL_VARIABLE} is unset\n`);
    return 2;
  }
  if (mode !== 'startup' && mode !== 'startup+workflows') {
    process.stderr.write(`${MODE_VARIABLE} must be 'startup' or 'startup+workflows'\n`);
    return 2;
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const session: SessionQueryable = {
      async query<Row extends QueryResultRowLike = QueryResultRowLike>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryOutcome<Row>> {
        const result = await client.query(text, values === undefined ? undefined : [...values]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    };

    const startup = [await apiStartupHere(session), await workerStartupHere(session)];
    let registry = null;
    let workflows = null;
    if (mode === 'startup+workflows') {
      registry = await buildWorkerRegistry();
      const handlesFile = process.env[HANDLES_VARIABLE];
      if (handlesFile === undefined) {
        process.stderr.write(`${HANDLES_VARIABLE} is unset\n`);
        return 2;
      }
      const handles = JSON.parse(readFileSync(handlesFile, 'utf8')) as FixtureHandles;
      // Imported here, not at the top: the base checkout runs this file in `startup`
      // mode, and `workflows.ts` names modules that do not exist at schema N — reading
      // a funnel fact is not a thing the previous release could do. A static import
      // would fail the whole module rather than the mode that needs it.
      const { runWorkflows } = await import('./workflows.ts');
      workflows = await runWorkflows(session, handles);
    }

    const report: ChecksReport = { tree: process.cwd(), mode, startup, registry, workflows };
    process.stdout.write(`${CHECKS_JSON_PREFIX}${JSON.stringify(report)}\n`);
    return 0;
  } finally {
    await client.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : 'the checks failed'}\n`,
  );
  return 1;
});
