import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES as API_VARIABLES } from '../../apps/api/src/bootstrap/deployment.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES as WORKER_VARIABLES } from '../../apps/worker/src/bootstrap/deployment.ts';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * Each task definition carries the secrets its own process reads (audit S17, lane
 * g81).
 *
 * One map, `task_secrets`, went to the API, the worker, the operations tool and the
 * drill alike, so three processes that never sign anybody in held the session-signing
 * key, the device-credential pepper and the Google sign-in client. The cluster module
 * now names, per process, the application secrets it reads, and builds each
 * definition's `secrets` block from that list alone.
 *
 * ## The vacuous-pass trap, named
 *
 * A check that only read the lists could pass while a definition was still built from
 * the old common map. So it also requires every runtime definition's `secrets` block to
 * name its own map, and no `local.task_secrets` to survive. And a list is only as true
 * as the code it describes, so the names each process's deployment reader actually
 * requires (`DEPLOYMENT_ENVIRONMENT_VARIABLES`) must be in that process's list: a
 * narrowing that dropped the Gmail client from the worker would pass a text check and
 * refuse to start in the cloud. The per-process result is planned and read back from
 * the definitions in `infra/modules/cluster/tests/migration_identity.tftest.hcl` and
 * `infra/roots/production/tests/isolation.tftest.hcl`.
 */

const CLUSTER = readRepositoryFile('infra/modules/cluster/main.tf');
const SECRETS_VARIABLES = readRepositoryFile('infra/modules/secrets/variables.tf');

const AUTHENTICATION_SECRETS = ['session-signing-key', 'device-credential-pepper', 'google-oidc-client'];

function listLocal(name: string): string[] {
  const match = new RegExp(`\\n  ${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'u').exec(CLUSTER);
  if (match?.[1] === undefined) return [];
  return [...match[1].matchAll(/"([a-z0-9-]+)"/gu)].map(entry => entry[1] ?? '');
}

/** The `secrets = [for name in sort(keys(local.X))` map a task definition resource uses. */
function secretsMapOf(resource: string): string | null {
  const start = CLUSTER.indexOf(`resource "aws_ecs_task_definition" "${resource}" {`);
  if (start < 0) return null;
  const end = CLUSTER.indexOf('\n}\n', start);
  const block = CLUSTER.slice(start, end < 0 ? undefined : end);
  return /secrets = \[for name in sort\(keys\(local\.([a-z_]+)\)\)/u.exec(block)?.[1] ?? null;
}

const DEFAULT_SECRET_NAMES = ((): string[] => {
  const start = SECRETS_VARIABLES.indexOf('variable "secret_names" {');
  const block = SECRETS_VARIABLES.slice(start, SECRETS_VARIABLES.indexOf('\n}\n', start));
  return [...block.matchAll(/^\s+"([a-z0-9-]+)",$/gmu)].map(entry => entry[1] ?? '');
})();

const API = listLocal('api_secret_names');
const WORKER = listLocal('worker_secret_names');
const OPERATIONS = listLocal('operations_secret_names');

describe('g81: every task gets the secrets its process reads', () => {
  it('still finds the three lists and the secrets module defaults', () => {
    expect(API.length).toBeGreaterThan(0);
    expect(WORKER.length).toBeGreaterThan(0);
    expect(OPERATIONS.length).toBeGreaterThan(0);
    expect(DEFAULT_SECRET_NAMES).toContain('app-runtime-database');
  });

  it('builds each runtime definition from its own map, and no common map survives', () => {
    expect(secretsMapOf('api')).toBe('api_task_secrets');
    expect(secretsMapOf('worker')).toBe('worker_task_secrets');
    expect(secretsMapOf('operations')).toBe('operations_task_secrets');
    expect(secretsMapOf('drill')).toBe('drill_task_secrets');
    expect(secretsMapOf('migration')).toBe('migration_task_secrets');
    expect(CLUSTER).not.toMatch(/local\.task_secrets\b/u);
    expect(CLUSTER).toContain('drill_task_secrets = merge(local.operations_task_secrets, {');
    expect(CLUSTER).toMatch(/api_task_secrets\s+= merge\(\{ for name, arn in var\.secret_arns : name => arn if contains\(local\.api_secret_names, name\) \}/u);
    expect(CLUSTER).toMatch(/worker_task_secrets\s+= merge\(\{ for name, arn in var\.secret_arns : name => arn if contains\(local\.worker_secret_names, name\) \}/u);
    expect(CLUSTER).toMatch(
      /operations_task_secrets\s+= merge\(\{ for name, arn in var\.secret_arns : name => arn if contains\(local\.operations_secret_names, name\) \}/u,
    );
  });

  it('keeps the authentication secrets on the API alone', () => {
    for (const name of AUTHENTICATION_SECRETS) {
      expect(API, name).toContain(name);
      expect(WORKER, name).not.toContain(name);
      expect(OPERATIONS, name).not.toContain(name);
    }
  });

  it('gives each process every secret its deployment reader requires', () => {
    for (const name of [API_VARIABLES.gmailOAuthClient, API_VARIABLES.oidcClient, API_VARIABLES.sessionSigningKey]) {
      expect(API, `the API reads ${name}`).toContain(name);
    }
    // The worker, and the tool on the operations and drill definitions, read the Gmail
    // client through `readWorkerDeployment`.
    expect(WORKER).toContain(WORKER_VARIABLES.gmailOAuthClient);
    expect(OPERATIONS).toContain(WORKER_VARIABLES.gmailOAuthClient);
  });

  it('names only secrets the secrets module creates, and leaves none unassigned', () => {
    const application = DEFAULT_SECRET_NAMES.filter(name => name !== 'migration-database' && name !== 'app-runtime-database');
    for (const name of [...API, ...WORKER, ...OPERATIONS]) expect(application, name).toContain(name);
    for (const name of application) expect([...API, ...WORKER, ...OPERATIONS], name).toContain(name);
    expect(CLUSTER).toContain('condition     = length(local.unassigned_secret_names) == 0');
  });
});
