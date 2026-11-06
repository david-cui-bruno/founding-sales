import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Explicit opt-in for the fresh M2 Prospects/calling acceptance. The value names this
 * synthetic, fake-provider-only lane; it grants nothing historical and nothing live. It
 * is checked before any process, port, directory, database or browser is allocated. */
export const CALLING_M2_GRANT_ENV = 'FSS_CALLING_M2_FAKE_PROVIDER_GRANT';
export const CALLING_M2_GRANT = 'workspace-m2-20261106-fake-provider';
/** Legacy glass-workspace lane marker. It admits only the legacy glass fixtures. */
const LEGACY_GLASS_LANE = '783';
/** The only foreign PostgreSQL server this lane tolerates: the user's Homebrew service,
 * identified by exact executable and data directory, never by a process id. */
const HOMEBREW_POSTGRES = '/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17';

export function hasCallingM2Grant(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CALLING_M2_GRANT_ENV] === CALLING_M2_GRANT;
}
/** Chrome launcher admission: a current M2 grant or the legacy glass lane marker. */
export function hasExplicitLaneGrant(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasCallingM2Grant(env) || env['FSS_GLASS_WORKSPACE_EXCLUSIVE_LANE'] === LEGACY_GLASS_LANE;
}

/** Process listing helper shared by every fixture: BSD-style `axww` with untruncated
 * commands works with both macOS and Linux procps `ps`. */
export function processCommands(): string {
  return execFileSync('ps', ['axww', '-o', 'pid=,command='], { encoding: 'utf8' });
}

/** Sorted `pid command` lines of every PostgreSQL server (postmaster) on this host. */
export function postgresServers(): string[] {
  return processCommands().split('\n')
    .map(line => line.trim()).filter(line => /^\d+\s/u.test(line))
    .filter(line => /\s(?:\S*\/)?postgres(?:\s|$)/u.test(line.replace(/^\d+/u, '')) && !/postgres: /u.test(line))
    .sort();
}

/** Sole-lane gate. Refuses any PostgreSQL server other than the exact Homebrew service and
 * returns the preserved set so teardown can prove nothing foreign changed and nothing
 * owned remains. */
export function requireSoleDisposableLane(): readonly string[] {
  const servers = postgresServers();
  assert(servers.every(line => { const command = line.replace(/^\d+\s+/u, ''); return command === HOMEBREW_POSTGRES || command.startsWith(`${HOMEBREW_POSTGRES} `); }), 'Another disposable PostgreSQL lane is active');
  return servers;
}

/** Called after every owned resource is released: the owned cluster/template environment
 * must be gone again, and the host PostgreSQL set must equal the pre-allocation set exactly
 * (same pids and commands), so the unrelated Homebrew server is untouched and no owned
 * server leaked. Admission itself runs only before allocation, never against owned state. */
export function assertForeignPostgresPreserved(before: readonly string[]): void {
  for (const key of ['FSS_TEST_POSTGRES_URL', 'FSS_TEST_CLUSTER_URL', 'FSS_TEST_TEMPLATE_DATABASE']) assert.equal(process.env[key], undefined, `${key} must be restored after owned release`);
  assert.deepEqual(postgresServers(), [...before], 'Unrelated PostgreSQL servers must be unchanged and no owned server may remain');
}

/** Private artifact directory: a strict descendant of the current actor's `~/.jcode/scratch`
 * (the machine's home, so the same rule holds on the local Mac and on a CI runner). The
 * requested path is normalized first, so `..` cannot escape the root. */
export function privateArtifactsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env['FSS_GLASS_PRIVATE_ARTIFACTS'];
  assert(requested && isAbsolute(requested), 'FSS_GLASS_PRIVATE_ARTIFACTS must be an absolute path');
  const root = join(homedir(), '.jcode', 'scratch');
  const directory = resolve(requested);
  assert(directory.startsWith(`${root}${sep}`), `Private scratch artifacts required under ${root}`);
  return directory;
}
