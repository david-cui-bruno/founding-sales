import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES } from '@fss/domain/classification';
import { COVERAGE_FRESHNESS_SECONDS, MAILBOX_CHECK_INTERVAL_SECONDS } from '@fss/domain/mail';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLES as API_VARIABLES,
  DeploymentConfigError,
  readUpgradeUrl,
} from '../../apps/api/src/bootstrap/deployment.ts';
import { LIVENESS_PATH, NOT_READY_STATUS, READINESS_PATH } from '../../apps/api/src/bootstrap/readiness.ts';
import { DEFAULT_UPGRADE_URL } from '../../apps/api/src/routes/types.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES as WORKER_VARIABLES } from '../../apps/worker/src/bootstrap/deployment.ts';
import { CHANNEL_MANIFEST_PATH } from '../../apps/desktop/src/main/updateChannel.ts';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

/**
 * Where the code and the Terraform must agree, and nothing but Terraform could say so:
 * the secrets each process reads, the readiness path, the thresholds the code and the
 * alarms share, the upgrade address, the journal-failure event, the digest's settings,
 * and the task definitions CI deploys around. Terraform-only facts are the
 * `terraform test` suites' (`infra/scripts/offline-gate.sh`).
 */

/** From `<header>` to the first line that is a lone `}`. */
function block(text: string, header: string): string {
  const start = text.indexOf(header);
  expect(start, `no ${header}`).toBeGreaterThan(-1);
  const end = text.indexOf('\n}\n', start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** A variable's literal numeric default. */
function numericDefault(variables: string, name: string): number {
  const match = /\n\s*default\s*=\s*([0-9]+)[ \t]*(?:\n|$)/u.exec(block(variables, `variable "${name}" {`));
  expect(match?.[1], `${name} has no literal numeric default`).toBeDefined();
  return Number(match?.[1]);
}

/** One entry of the alerts module's alarm map, from `<key> = {` to its closing brace. */
function alarmEntry(alerts: string, key: string): string {
  const start = alerts.indexOf(`\n    ${key} = {\n`);
  expect(start, `infra/modules/alerts/main.tf declares no ${key} alarm`).toBeGreaterThan(-1);
  return alerts.slice(start, alerts.indexOf('\n    }\n', start));
}

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
 *
 * ## The name a secret arrives under (lane g81)
 *
 * The ECS `secrets` block names the environment variable, and the classifier reads its
 * key as `FSS_LLM_CLASSIFIER_API_KEY` (`CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES`), not
 * as `llm-classifier-api-key`. The key was injected under the logical name, so the
 * deployed worker never had a classifier. The cluster's rename map must name exactly
 * the variable the classifier reads, and the worker's deployment map must say the same;
 * a rehearsal must not be handed the key at all, because the classifier has no recorded
 * seam. `research-provider-credentials` is read by nothing and handed to nothing.
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
const UNREAD = listLocal('unread_secret_names');
const STACK = readRepositoryFile('infra/modules/stack/main.tf');

describe('g81: every task gets the secrets its process reads', () => {
  it('still finds the three lists and the secrets module defaults', () => {
    expect(API.length).toBeGreaterThan(0);
    expect(WORKER.length).toBeGreaterThan(0);
    expect(OPERATIONS.length).toBeGreaterThan(0);
    expect(UNREAD.length).toBeGreaterThan(0);
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
    const built = (map: string, list: string): RegExp =>
      new RegExp(
        `${map}\\s+= merge\\(\\{ for name, arn in var\\.secret_arns : lookup\\(local\\.secret_environment_names, name, name\\) => arn if contains\\(local\\.${list}, name\\) \\}`,
        'u',
      );
    expect(CLUSTER).toMatch(built('api_task_secrets', 'api_secret_names'));
    expect(CLUSTER).toMatch(built('worker_task_secrets', 'worker_injected_secret_names'));
    expect(CLUSTER).toMatch(built('operations_task_secrets', 'operations_secret_names'));
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
    expect(WORKER).toContain('llm-classifier-api-key');
  });

  it('hands the classifier key over under the name the classifier reads, and only in production', () => {
    const reads = CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES.llm_classifier_api_key;
    expect(reads).toBe('FSS_LLM_CLASSIFIER_API_KEY');
    expect(CLUSTER).toContain(`    "llm-classifier-api-key" = "${reads}"\n`);
    expect(WORKER_VARIABLES.classifierApiKey).toBe(reads);
    // Held back from the worker unless the root says it reads it, and the stack says
    // so for production alone.
    expect(CLUSTER).toContain('if name != "llm-classifier-api-key" || var.worker_reads_classifier_key');
    expect(STACK).toContain('  worker_reads_classifier_key = local.is_production\n');
  });

  it('hands research-provider-credentials, which nothing reads, to no process', () => {
    expect(UNREAD).toEqual(['research-provider-credentials']);
    for (const list of [API, WORKER, OPERATIONS]) expect(list).not.toContain('research-provider-credentials');
    expect(Object.keys(WORKER_VARIABLES)).not.toContain('researchCredentials');
    expect(Object.keys(API_VARIABLES)).not.toContain('researchCredentials');
  });

  it('names only secrets the secrets module creates, and leaves none unassigned', () => {
    const application = DEFAULT_SECRET_NAMES.filter(name => name !== 'migration-database' && name !== 'app-runtime-database');
    for (const name of [...API, ...WORKER, ...OPERATIONS, ...UNREAD]) expect(application, name).toContain(name);
    for (const name of application) expect([...API, ...WORKER, ...OPERATIONS, ...UNREAD], name).toContain(name);
    expect(CLUSTER).toContain('condition     = length(local.unassigned_secret_names) == 0');
  });
});

describe('the target group polls readiness, and the container check stays on liveness (g81)', () => {
  const edgeVariables = readRepositoryFile('infra/modules/edge/variables.tf');
  const healthCheck = block(block(readRepositoryFile('infra/modules/edge/main.tf'), 'resource "aws_lb_target_group" "api" {'), 'health_check {');

  it('polls the path the API answers readiness on, and treats not-ready as unhealthy', () => {
    expect(READINESS_PATH).toBe('/readyz');
    expect(healthCheck).toContain('path                = var.health_check_path');
    expect(block(edgeVariables, 'variable "health_check_path" {')).toContain(`default     = "${READINESS_PATH}"`);
    expect(healthCheck).toContain('matcher             = "200"');
    expect(NOT_READY_STATUS).toBe(503);
  });

  it('keeps the container health check on liveness, so a database outage drains rather than restarts', () => {
    const containerCheck = block(readRepositoryFile('infra/modules/cluster/variables.tf'), 'variable "api_health_check_command" {');
    expect(containerCheck).toContain(`'${LIVENESS_PATH}'`);
    expect(containerCheck).not.toContain(READINESS_PATH);
  });
});

describe('the code and the alarms share their thresholds', () => {
  const alerts = readRepositoryFile('infra/modules/alerts/main.tf');
  const alertVariables = readRepositoryFile('infra/modules/alerts/variables.tf');

  it('warns on a stale coverage watermark at the send gate’s own freshness', () => {
    expect(alarmEntry(alerts, 'mailbox_coverage_stale')).toContain('threshold           = var.mailbox_coverage_stale_seconds');
    expect(numericDefault(alertVariables, 'mailbox_coverage_stale_seconds')).toBe(COVERAGE_FRESHNESS_SECONDS);
  });

  it('is the same five minutes of canary age in the smoke and in the alarm', () => {
    expect(readRepositoryFile('scripts/productionSmoke.mjs')).toContain('export const CANARY_MAXIMUM_AGE_SECONDS = 300;');
    expect(alarmEntry(alerts, 'canary_stale')).toContain('threshold           = var.canary_stale_seconds');
    expect(numericDefault(alertVariables, 'canary_stale_seconds')).toBe(300);
  });

  it('counts mailbox heartbeats over the interval the check promises', () => {
    const missed = alarmEntry(alerts, 'mailbox_heartbeat_missed');
    expect(missed).toContain('metric_name         = "MailboxCheckHeartbeat"');
    expect(missed).toMatch(new RegExp(`period\\s+= ${String(MAILBOX_CHECK_INTERVAL_SECONDS)}\\n`, 'u'));
  });

  it('turns the journal-failure event both writers log into the metric its alarm reads', () => {
    const observability = readRepositoryFile('infra/modules/observability/main.tf');
    for (const [key, service, path] of [
      ['suppression_journal_write_failed', 'api', 'apps/api/src/bootstrap/deployment.ts'],
      ['suppression_journal_write_failed_worker', 'worker', 'apps/worker/src/bootstrap/deployment.ts'],
    ] as const) {
      const start = observability.indexOf(`\n    ${key} = {\n`);
      expect(start, key).toBeGreaterThan(-1);
      const filter = observability.slice(start, observability.indexOf('\n    }\n', start));
      expect(filter, key).toContain(`service     = "${service}"`);
      expect(filter, key).toContain('pattern     = "{ $.event = \\"suppression_journal_write_failed\\" }"');
      expect(filter, key).toContain('metric_name = "SuppressionJournalWriteFailures"');
      expect(readRepositoryFile(path), path).toContain(
        `log.log('error', 'suppression_journal_write_failed', { writer: '${service}', error_name: name });`,
      );
    }
  });
});

describe('the upgrade notice address', () => {
  const name = API_VARIABLES.upgradeUrl;
  const variable = block(readRepositoryFile('infra/roots/production/variables.tf'), 'variable "desktop_upgrade_url" {');
  const productionDefault = /\n {2}default {5,}= "([^"]+)"\n/u.exec(variable)?.[1] ?? '';

  it('is set, under the name the API reads, on the API task definition alone', () => {
    const stack = readRepositoryFile('infra/modules/stack/main.tf');
    expect(name).toBe('FSS_DESKTOP_UPGRADE_URL');
    expect(stack).toContain(
      '  api_environment = var.desktop_upgrade_url == null ? {} : {\n    FSS_DESKTOP_UPGRADE_URL = var.desktop_upgrade_url\n  }\n',
    );
  });

  it('defaults in production to the signed manifest the desktop reads, and passes the API’s own rule', () => {
    expect(productionDefault.startsWith('https://')).toBe(true);
    expect(productionDefault.endsWith(`/${CHANNEL_MANIFEST_PATH}`)).toBe(true);
    expect(readUpgradeUrl({ FSS_ENVIRONMENT: 'production', [name]: productionDefault })).toEqual({
      value: productionDefault,
      source: 'environment',
    });
    expect(() => readUpgradeUrl({ FSS_ENVIRONMENT: 'production', [name]: DEFAULT_UPGRADE_URL })).toThrow(DeploymentConfigError);
  });
});

describe('the alarm digest gets the settings its code reads', () => {
  it('hands the function exactly the environment index.mjs reads, and zips every source file there is', () => {
    const digest = readRepositoryFile('infra/modules/alerts/digest.tf');
    const index = readRepositoryFile('infra/lambdas/alarm-digest/index.mjs');
    const read = [...index.matchAll(/process\.env\.([A-Z_]+)/gu)].map(match => match[1]).sort();
    const environment = digest.slice(digest.indexOf('  environment {'), digest.indexOf('  logging_config {'));
    const given = [...environment.matchAll(/^\s+([A-Z_]+)\s+=/gmu)].map(match => match[1]).sort();
    expect(read).toEqual(['FSS_ALARM_PREFIX', 'FSS_ALERT_TOPIC_ARN', 'FSS_DIGEST_TIME_ZONE']);
    expect(given).toEqual(read);
    const sources = readdirSync(repositoryPath('infra/lambdas/alarm-digest')).sort();
    const zipped = [...digest.matchAll(/^\s+filename = "([^"]+)"$/gmu)].map(match => match[1]).sort();
    expect(zipped).toEqual(sources);
    expect(digest).toContain('handler       = "index.handler"');
  });
});

describe('Terraform declares the task definitions CI deploys around (lane g91)', () => {
  const cluster = readRepositoryFile('infra/modules/cluster/main.tf');

  it('ignores only the count on both services, never the task definition, so an apply keeps CI’s revision', () => {
    for (const service of ['api', 'worker']) {
      const text = block(cluster, `resource "aws_ecs_service" "${service}" {`);
      expect(text).toContain(`task_definition = aws_ecs_task_definition.${service}.arn`);
      expect(text.match(/ignore_changes = \[[^\]]*\]/gu)).toEqual(['ignore_changes = [desired_count]']);
    }
  });

  it('tracks the newest revision on the two service definitions and on no one-off', () => {
    for (const family of ['api', 'worker']) {
      expect(block(cluster, `resource "aws_ecs_task_definition" "${family}" {`)).toMatch(/^ {2}track_latest = true$/mu);
    }
    for (const family of ['migration', 'operations', 'drill']) {
      expect(block(cluster, `resource "aws_ecs_task_definition" "${family}" {`)).not.toContain('track_latest');
    }
  });

  it('runs the operations task, which ci-deploy-app.sh record checks, as the worker image, roles and log group', () => {
    const operations = block(cluster, 'resource "aws_ecs_task_definition" "operations" {');
    expect(operations).toContain('execution_role_arn       = aws_iam_role.worker_execution.arn');
    expect(operations).toContain('task_role_arn            = aws_iam_role.worker_task.arn');
    expect(operations).toContain('image      = var.worker_image');
    expect(operations).toContain('"awslogs-group"         = var.worker_log_group_name');
    expect(operations).toContain('"awslogs-stream-prefix" = "operations"');
  });
});
