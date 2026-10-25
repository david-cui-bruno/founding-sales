import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createOwnedTeardown, startTestDatabaseEnvironment } from '@fss/domain/db/testing/globalSetup.ts';
import { startPostgresCluster, type PostgresCluster } from '@fss/domain/db/testing/embeddedPostgres.ts';
import { createTemplateDatabase, createTestDatabase, CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { requireLocalDemo } from '../support/syntheticBrowserApp.ts';

const fakeCluster = (stop: () => Promise<void>): PostgresCluster => ({ adminUrl: 'unused', source: 'embedded', stop });

describe('issue781 owned teardown failure boundary', () => {
  it('attempts cluster stop after template drop rejects and preserves the original error', async () => {
    const failure = Error('controlled drop failure');
    const calls: string[] = [];
    const release = await startTestDatabaseEnvironment(
      async () => fakeCluster(async () => { calls.push('stop'); }),
      async () => ({ name: 'controlled', drop: async () => { calls.push('drop'); throw failure; } }),
    );
    await expect(release()).rejects.toBe(failure);
    expect(calls).toEqual(['drop', 'stop']);
    expect(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]).toBeUndefined();
    expect(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]).toBeUndefined();
    await expect(release()).rejects.toBe(failure);
    expect(calls).toEqual(['drop', 'stop', 'drop']);
  });

  it('preserves both teardown errors, retries failed owners and skips successful owners', async () => {
    const dropFailure = Error('drop'), stopFailure = Error('stop');
    let attempts = 0, stops = 0, verifications = 0;
    const cleanup = createOwnedTeardown([
      async () => { if (++attempts === 1) throw dropFailure; },
      async () => { if (++stops === 1) throw stopFailure; },
      async () => { verifications++; },
    ]);
    await expect(cleanup()).rejects.toMatchObject({ errors: [dropFailure, stopFailure] });
    await cleanup();
    await cleanup();
    expect([attempts, stops, verifications]).toEqual([2, 2, 1]);
  });

  it('shares an in-flight teardown instead of duplicating owner operations', async () => {
    let finish = (): void => {};
    let calls = 0;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const cleanup = createOwnedTeardown([async () => { calls++; await gate; }]);
    const first = cleanup(), second = cleanup();
    expect(first).toBe(second);
    finish();
    await first;
    expect(calls).toBe(1);
  });

  it('preserves template initialization and cluster stop errors together', async () => {
    const original = Error('template initialization'), stop = Error('cluster stop');
    await expect(startTestDatabaseEnvironment(
      async () => fakeCluster(async () => { throw stop; }),
      async () => { throw original; },
    )).rejects.toMatchObject({ errors: [original, stop] });
  });

  it.skipIf(process.env['FSS_SYNTHETIC_CLEANUP_PROOF'] !== '1')('real restricted role denies privileged read and injected template-drop failure still removes the exact owned cluster', async () => {
    requireLocalDemo(process.env);
    const cluster = await startPostgresCluster();
    const path = cluster.storagePath!;
    const pid = Number((await readFile(`${path}/postmaster.pid`, 'utf8')).split('\n')[0]);
    const url = new URL(cluster.adminUrl);
    const failure = Error('CONTROLLED_781_TEMPLATE_DROP_FAILURE');
    let stopAttempts = 0;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await startTestDatabaseEnvironment(
        async () => ({ ...cluster, stop: async () => { stopAttempts++; await cluster.stop(); } }),
        async adminUrl => {
          const template = await createTemplateDatabase(adminUrl);
          return { name: template.name, drop: async () => { throw failure; } };
        },
      );
      const database = await createTestDatabase();
      try {
        const restricted = await database.appRuntimeSession();
        expect((await restricted.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user).toBe('app_runtime');
        await expect(restricted.query('SELECT rolpassword FROM pg_authid')).rejects.toMatchObject({ code: '42501' });
        expect((await database.session.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user).not.toBe('app_runtime');
        console.log('SYNTHETIC_781_FORBIDDEN_PRIVILEGE_VERIFIED', JSON.stringify({ currentUser: 'app_runtime', denied: 'pg_authid', sqlstate: '42501' }));
      } finally { await database.drop(); }
      await expect(release()).rejects.toBe(failure);
      expect(stopAttempts).toBe(1);
      expect(existsSync(path)).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
      const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) });
        socket.once('connect', () => { socket.destroy(); reject(Error('Owned PG listener remains')); });
        socket.once('error', resolve);
      });
      expect(error.code).toBe('ECONNREFUSED');
      process.kill(1106, 0);
      console.log('SYNTHETIC_781_DROP_FAILURE_OWNED_CLEANUP', JSON.stringify({ pid, path, port: Number(url.port), stopAttempts, originalErrorPreserved: true, directoryAbsent: true, pidAbsent: true, listenerRefused: true, homebrew1106Alive: true }));
    } finally {
      delete process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
      delete process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE];
      await cluster.stop();
    }
  }, 60_000);
});
