import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import pg from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../db/testing/embeddedPostgres.ts';
import { startTestDatabaseEnvironment } from '../../db/testing/globalSetup.ts';
import { createTemplateDatabase } from '../../db/testing/testDatabase.ts';
const homebrew = () => execFileSync('ps', ['-p', '1106', '-o', 'pid=,lstart=,command='], { encoding: 'utf8' }).trim();
async function absent(port: number) {
  for (const host of ['127.0.0.1', '::1']) await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port }); socket.setTimeout(2000, () => { socket.destroy(); reject(Error('Control runtime absence timeout')); });
    socket.once('connect', () => { socket.destroy(); reject(Error('Control runtime listener remains')); });
    socket.once('error', error => { try { assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED'); resolve(); } catch (failure) { reject(failure); } });
  });
}
/** Authored only. This token is not a grant. Root must explicitly allocate this
 * sole runtime before invocation. Reuses canonical cluster/template ownership. */
export default async function setup() {
  assert.equal(process.env['FSS_CAMPAIGN_OPENING_CONTROL_RUNTIME_GRANT'], 'opening-control-20261027');
  assert.equal(process.env['FSS_TEST_POSTGRES_URL'], undefined);
  const before = homebrew(); let cluster: PostgresCluster | undefined, pid = 0, port = 0, templateName = '';
  const release = await startTestDatabaseEnvironment(async () => {
    cluster = await startPostgresCluster();
    try {
    assert.equal(cluster.source, 'embedded'); assert(cluster.storagePath);
    pid = Number((await readFile(`${cluster.storagePath}/postmaster.pid`, 'utf8')).split('\n')[0]); port = Number(new URL(cluster.adminUrl).port);
    const client = new pg.Client({ connectionString: cluster.adminUrl }); await client.connect();
    try { const row = (await client.query("SELECT current_setting('server_version_num') AS version,current_setting('server_encoding') AS encoding")).rows[0]; assert.match(row.version, /^16/u); assert.equal(row.encoding, 'UTF8'); } finally { await client.end(); }
    console.log('CAMPAIGN_OPENING_CONTROL_CLUSTER_REGISTERED', JSON.stringify({ parentPid: process.pid, postgresPid: pid, storagePath: cluster.storagePath, port, homebrew1106: before }));
    return cluster;
    } catch (error) { await cluster.stop(); assert.equal(homebrew(), before); throw error; }
  }, async adminUrl => {
    const template = await createTemplateDatabase(adminUrl); templateName = template.name;
    console.log('CAMPAIGN_OPENING_CONTROL_TEMPLATE_REGISTERED', JSON.stringify({ template: templateName, parentPid: process.pid })); return template;
  });
  return async () => {
    await release(); assert(cluster?.storagePath); await absent(port);
    await access(cluster.storagePath).then(() => { throw Error('Control runtime storage remains'); }, error => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.equal(homebrew(), before);
    console.log('CAMPAIGN_OPENING_CONTROL_INDEPENDENT_ABSENCE', JSON.stringify({ postgresPid: pid, port, template: templateName, storagePath: cluster.storagePath, ipv4: 'ECONNREFUSED', ipv6: 'ECONNREFUSED', homebrew1106Unchanged: true }));
  };
}
