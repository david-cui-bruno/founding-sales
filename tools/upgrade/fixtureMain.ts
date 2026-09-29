import pg from 'pg';
import type { QueryOutcome, QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { loadFixture } from './fixture.ts';
import { FIXTURE_JSON_PREFIX } from './fixtureProtocol.ts';

/**
 * The fixture loader, as a process of its own.
 *
 * It is run with its working directory inside the checkout at schema N, so the
 * `packages/domain` it imports is that commit's (`baseCheckout.ts`). The parent reads
 * one line of JSON off stdout; anything else this process prints is diagnostic and is
 * shown with the failure.
 *
 * The connection URL arrives in the environment, not in `argv`: an argument list is
 * visible in `ps` and in a shell history file, and it carries the runtime role's
 * password.
 */

const URL_VARIABLE = 'FSS_UPGRADE_DATABASE_URL';
const SCHEMA_VARIABLE = 'FSS_UPGRADE_SCHEMA';

async function main(): Promise<number> {
  const url = process.env[URL_VARIABLE];
  const schema = Number(process.env[SCHEMA_VARIABLE]);
  if (url === undefined || url.trim().length === 0) {
    process.stderr.write(`${URL_VARIABLE} is unset\n`);
    return 2;
  }
  if (!Number.isInteger(schema) || schema < 1) {
    process.stderr.write(`${SCHEMA_VARIABLE} is not a schema version\n`);
    return 2;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // The same narrow adapter `db/testing/testDatabase.ts` exposes, written out here so
    // this entry point imports nothing of the migration runner it is not going to run.
    const session: SessionQueryable = {
      async query<Row extends QueryResultRowLike = QueryResultRowLike>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryOutcome<Row>> {
        const result = await client.query(text, values === undefined ? undefined : [...values]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    };
    const loaded = await loadFixture(session, { schemaVersion: schema });
    process.stdout.write(
      `${FIXTURE_JSON_PREFIX}${JSON.stringify({
        handles: loaded.handles,
        parts: loaded.parts,
        emptyTables: [...loaded.emptyTables],
      })}\n`,
    );
    return 0;
  } finally {
    await client.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : 'the fixture failed'}\n`);
  return 1;
});
