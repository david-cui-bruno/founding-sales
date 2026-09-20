/**
 * Prove the CI path locally.
 *
 * In CI the greenfield tests adopt a `postgres:16` service container through
 * `FSS_TEST_POSTGRES_URL` instead of starting embedded-postgres. This script starts a
 * cluster, hands its URL to the gate through that variable, and stops it afterwards,
 * so the service-container branch of db/testing/embeddedPostgres.ts is exercised on
 * this machine rather than only on the runner.
 *
 *   node scripts/greenfieldServiceClusterCheck.mjs [npm-script]
 *
 * It is a developer tool. Nothing in the product reads it, and CI does not run it.
 *
 * The gate runs through an asynchronous `spawn`, never `spawnSync`. embedded-postgres
 * pipes the server's stdout and stderr to this process; `spawnSync` blocks the event
 * loop, the pipe fills after about 64 KB of ordinary CREATE DATABASE chatter, and the
 * cluster freezes with the tests still running. That freeze looks exactly like a
 * database deadlock and is not one.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseDir = await mkdtemp(join(tmpdir(), 'fss-service-sim-'));
// A throwaway credential for a loopback cluster that lives for one command.
const password = `p${Math.random().toString(36).slice(2)}`;
const port = 55_432;
const script = process.argv[2] ?? 'gate:greenfield';

const cluster = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password,
  port,
  persistent: false,
  onLog: () => undefined,
  onError: () => undefined,
});

await cluster.initialise();
await cluster.start();

const child = spawn('npm', ['run', script], {
  cwd: projectRoot,
  env: {
    ...process.env,
    FSS_TEST_POSTGRES_URL: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
  },
  stdio: 'inherit',
});

const code = await new Promise(resolve_ => {
  child.on('exit', status => { resolve_(status ?? 1); });
});

await cluster.stop();
await rm(databaseDir, { recursive: true, force: true });
process.exit(code);
