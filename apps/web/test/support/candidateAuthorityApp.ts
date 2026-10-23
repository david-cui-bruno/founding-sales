import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { inventoryProductSnapshot } from './candidateInventorySeed.ts';
import { startQualifiedResearchApp } from './qualifiedResearchApp.ts';
import type { ThinHostApp } from './thinHostApp.ts';

async function portAbsent(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Absence probe timed out')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Owned port remains on ${host}:${port}`)); });
    socket.once('error', error => {
      try { assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED'); resolve(); }
      catch (failure) { reject(failure); }
    });
  });
}

/** Collection/static checks cannot acquire PG. This lane has its own root opt-in,
 * never the issue749 grant. Canonical owners retain DB/TLS/browser teardown. */
export async function startCandidateAuthorityApp() {
  assert.equal(process.env['FSS_CANDIDATE_AUTHORITY_EXCLUSIVE_LANE'], '752-frozen-server-ui-root-granted', 'Root frozen server/UI sole-lane grant required');
  const executable = process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];
  assert(executable, 'Explicit installed headless Chrome required, no browser download');
  await access(executable);
  const before = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' });
  const unrelated = before.split('\n').filter(line => /postgresql@17\/bin\/postgres|--user-data-dir=/u.test(line));
  const owned = await startQualifiedResearchApp();
  try {
    const postgresPort = Number((await owned.app.fixture.db.query<{ port: string }>('SHOW port')).rows[0]!.port);
    const httpsPort = Number(new URL(owned.app.origin).port);
    console.log('CANDIDATE_AUTHORITY_EXACT_RESOURCES', JSON.stringify({ database: owned.app.fixture.database.name, template: process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], postgresPid: owned.app.postgresPid, postgresPort, httpsPort, storagePath: owned.app.storagePath, unrelated }));
    return { app: owned.app, stop: async () => {
      try { await owned.stop(); }
      finally {
        for (const port of [postgresPort, httpsPort]) for (const host of ['127.0.0.1', '::1']) await portAbsent(host, port);
        const after = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' });
        for (const line of unrelated) assert(after.includes(line), 'Unrelated PostgreSQL/browser process changed');
        console.log('CANDIDATE_AUTHORITY_INDEPENDENT_ABSENCE', JSON.stringify({ postgresPort, httpsPort, ipv4: 'ECONNREFUSED', ipv6: 'ECONNREFUSED', unrelatedPreserved: true }));
      }
    } };
  } catch (error) { await owned.stop(); throw error; }
}

/** Taken after controlled fixture writes, immediately around READ operations.
 * Auth bookkeeping is excluded, product jobs, commands, counters and ledgers are not. */
export async function candidateAuthoritySnapshot(app: ThinHostApp) {
  const snapshot = await inventoryProductSnapshot(app);
  for (const table of ['daily_counters', 'provider_ledger', 'research_runs', 'research_settings', 'sourcing_search_account', 'sourcing_discovery_settings', 'sourcing_discovery_attempts', 'sourcing_discovery_hits', 'sourcing_automatic_research_firms', 'active_holds']) {
    snapshot[table] = (await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return snapshot;
}
