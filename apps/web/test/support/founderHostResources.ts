import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { startPostgresCluster } from '@fss/domain/db/testing/embeddedPostgres.ts';
import { createTemplateDatabase, CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';

export async function absent(path: string) {
  await access(path).then(() => { throw new Error('Owned storage remains'); }, error => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); });
}
export async function listenerAbsent(port: number, host = '127.0.0.1') {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Owned listener remains')); });
    socket.once('error', error => { if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(); else reject(error); });
  });
}
export async function founderHostDatabase() {
  assert.equal(process.env['FSS_TEST_POSTGRES_URL'], undefined);
  assert.equal(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE], undefined);
  assert.equal(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], undefined);
  const cluster = await startPostgresCluster();
  assert.equal(cluster.source, 'embedded');
  assert.ok(cluster.storagePath);
  const pid = Number((await readFile(join(cluster.storagePath, 'postmaster.pid'), 'utf8')).split('\n')[0]);
  const port = Number(new URL(cluster.adminUrl).port);
  console.log('FOUNDER_HOST_CLUSTER_OWNED', JSON.stringify({ pid, port, storage: cluster.storagePath }));
  try {
    const template = await createTemplateDatabase(cluster.adminUrl);
    process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] = cluster.adminUrl;
    process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE] = template.name;
    return { cluster, template, async stop() {
      try { await template.drop(); console.log('FOUNDER_HOST_TEMPLATE_DROPPED', template.name); }
      finally {
        delete process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
        delete process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE];
        await cluster.stop();
        await absent(cluster.storagePath!);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        await listenerAbsent(port);
        console.log('FOUNDER_HOST_CLUSTER_ABSENT: PID listener storage and environment');
      }
    } };
  } catch (error) { await cluster.stop(); await absent(cluster.storagePath); await listenerAbsent(port); throw error; }
}
