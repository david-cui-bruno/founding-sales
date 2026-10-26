import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import pg from 'pg';
import { startPostgresCluster } from '../../db/testing/embeddedPostgres.ts';
import { createTemplateDatabase, CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '../../db/testing/testDatabase.ts';
import { createOwnedTeardown } from '../../db/testing/globalSetup.ts';
import type { AuthFixture } from '../../../../apps/api/test/support/authFixture.ts';

const homebrew = () => execFileSync('ps', ['-p', '1106', '-o', 'pid=,lstart=,command='], { encoding: 'utf8' }).trim();
const children = (pid: number) => execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').filter(line => Number(line.trim().split(/\s+/u)[1]) === pid);
async function absentPort(port: number) {
  for (const host of ['127.0.0.1', '::1']) await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Opening runtime absence timeout')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Opening listener remains ${port}`)); });
    socket.once('error', error => { try { assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED'); resolve(); } catch (failure) { reject(failure); } });
  });
}
async function withAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] });
  await client.connect(); try { return await work(client); } finally { await client.end(); }
}
export async function registerOpeningDatabases() {
  await withAdmin(async client => {
    const rows = (await client.query("SELECT d.datname,a.pid,a.application_name FROM pg_database d LEFT JOIN pg_stat_activity a ON a.datname=d.datname WHERE d.datname LIKE 'fss_test_%' ORDER BY d.datname,a.pid")).rows;
    console.log('EMAIL_OPENING_CASE_DATABASES_REGISTERED', JSON.stringify({ parentPid: process.pid, databasesAndBackends: rows }));
  });
}
export async function verifyOpeningDatabaseAbsent(name: string) {
  if (process.env['FSS_EMAIL_OPENING_PG_GRANT'] !== '800-ci1-repair-20261026T145406') return;
  await withAdmin(async client => { assert.equal((await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0); });
  console.log('EMAIL_OPENING_DATABASE_ABSENT', JSON.stringify({ database: name }));
}
export async function registerOpeningCompatibilityDatabases() {
  if (process.env['FSS_EMAIL_OPENING_PG_GRANT'] === '800-ci1-repair-20261026T145406') await registerOpeningDatabases();
}
/** Exact fixture resources are registered before the first domain journey step.
 * The canonical auth owner retains database/stub teardown and secret custody. */
export async function registerOpeningFixture(fixture: AuthFixture) {
  const port = Number(new URL(fixture.google.issuer).port), name = fixture.database.name;
  console.log('EMAIL_OPENING_FIXTURE_REGISTERED', JSON.stringify({ parentPid: process.pid, database: name, template: process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], oidcPort: port }));
  return async () => {
    await fixture.stop();
    await withAdmin(async client => { assert.equal((await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0); });
    await absentPort(port);
    console.log('EMAIL_OPENING_FIXTURE_ABSENT', JSON.stringify({ database: name, oidcPort: port, ipv4: 'ECONNREFUSED', ipv6: 'ECONNREFUSED' }));
  };
}
/** Isolated root-granted PG16 owner, reusing canonical start/template/teardown.
 * No browser, HTTPS, provider, external URL adoption or shared harness edits. */
export default async function setup() {
  const grant = process.env['FSS_EMAIL_OPENING_PG_GRANT'];
  assert(['783-root-corrections-20261026T1329', '800-ci1-repair-20261026T145406'].includes(grant ?? ''));
  assert.equal(process.env['FSS_TEST_POSTGRES_URL'], undefined, 'Never adopt another PostgreSQL service');
  const before = homebrew(); assert.match(before, /postgres/u);
  console.log('EMAIL_OPENING_PARENT_REGISTERED', JSON.stringify({ pid: process.pid, parentPid: process.ppid, homebrew1106: before, grant, scope: grant?.startsWith('800-') ? 'CI1-failed-cases-and-new-guards-only' : 'new-correction-cases-only' }));
  const cluster = await startPostgresCluster();
  try {
    assert.equal(cluster.source, 'embedded'); assert(cluster.storagePath);
    const postgresPid = Number((await readFile(`${cluster.storagePath}/postmaster.pid`, 'utf8')).split('\n')[0]);
    const port = Number(new URL(cluster.adminUrl).port);
    process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] = cluster.adminUrl;
    console.log('EMAIL_OPENING_CLUSTER_REGISTERED', JSON.stringify({ parentPid: process.pid, postgresPid, children: children(postgresPid), storagePath: cluster.storagePath, postgresPort: port }));
    await withAdmin(async client => {
      const row = (await client.query('SELECT current_setting(\'server_version_num\') AS version,current_setting(\'server_encoding\') AS encoding')).rows[0];
      assert.match(row.version, /^16/u); assert.equal(row.encoding, 'UTF8');
    });
    const template = await createTemplateDatabase(cluster.adminUrl);
    process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE] = template.name;
    console.log('EMAIL_OPENING_TEMPLATE_REGISTERED', JSON.stringify({ template: template.name, postgresPid, postgresPort: port }));
    const release = createOwnedTeardown([
      async () => {
        await withAdmin(async client => {
          const rows = (await client.query("SELECT datname FROM pg_database WHERE datname LIKE 'fss_test_%' ORDER BY datname")).rows;
          console.log('EMAIL_OPENING_CHILD_DATABASES_AT_TEARDOWN', JSON.stringify(rows)); assert.equal(rows.length, 0);
        });
      },
      () => template.drop(),
      async () => { await withAdmin(async client => { assert.equal((await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [template.name])).rowCount, 0); }); },
      () => cluster.stop(),
      async () => {
        await absentPort(port);
        await access(cluster.storagePath!).then(() => { throw new Error('Owned opening PG storage remains'); }, error => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); });
        assert.throws(() => process.kill(postgresPid, 0), { code: 'ESRCH' }); assert.equal(homebrew(), before);
        console.log('EMAIL_OPENING_INDEPENDENT_ABSENCE', JSON.stringify({ postgresPid, postgresPort: port, storagePath: cluster.storagePath, template: template.name, homebrew1106Unchanged: true }));
      },
    ]);
    return async () => { try { await release(); } finally { delete process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]; delete process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]; } };
  } catch (error) { await cluster.stop(); assert.equal(homebrew(), before); throw error; }
}
