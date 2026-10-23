import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { reserveLocalBrowserDatabase } from './database.ts';
export async function reserveCompositionLane() {
  assert(process.env['FSS_LOCAL_BROWSER_EXECUTABLE'], 'Select installed Chrome explicitly');
  const roots = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').filter(row => /(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/u.test(row) && !row.includes('postgres: '));
  assert.equal(roots.length, 1, 'Refuse unknown disposable PostgreSQL resource');
  assert(roots[0]!.includes('1412 /opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17'));
  const release = await reserveLocalBrowserDatabase();
  const url = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);
  console.log('COMPOSITION_CLUSTER', JSON.stringify({ host: url.hostname, port: Number(url.port), template: process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE] }));
  return release;
}
export async function compositionStorageAbsent(storagePath: string, postgresPid: number) {
  await access(storagePath).then(() => { throw new Error('Owned cluster directory remains'); }, error => assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'));
  assert.throws(() => process.kill(postgresPid, 0), { code: 'ESRCH' });
  assert.equal(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], undefined);
}
