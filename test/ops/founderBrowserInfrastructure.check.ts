import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/repository.ts';

const source = (path: string): string => readRepositoryFile(`infra/${path}`);
const cluster = source('modules/cluster/main.tf');
const browser = source('modules/cluster/founder-browser.tf');
const edge = source('modules/edge/founder-browser.tf');
const stack = source('modules/stack/main.tf');

function block(text: string, header: string): string {
  const start = text.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf('\n}', start) + 2);
}

describe('optional founder browser infrastructure source contract', () => {
  it('keeps both roots and every browser input disabled by default', () => {
    for (const path of ['roots/production', 'roots/rehearsal', 'modules/stack', 'modules/cluster']) {
      const config = source(`${path}/founder-browser.tf`);
      expect(config).toMatch(/default\s*= null/);
      expect(config).toContain('origin             = optional(string, "https://sales.usecallie.com")');
      expect(config).not.toContain('https://app.usecallie.com');
      for (const field of ['clientVersion', 'founderWorkspaceId', 'founderUserId', 'cookieKeySecretArn']) {
        expect(config).toMatch(new RegExp(`${field}\\s*= string`));
      }
      expect(config).toMatch(/certificateArn\s*= optional\(string\)/);
    }
    for (const root of ['production', 'rehearsal']) {
      expect(source(`roots/${root}/main.tf`)).toContain('founder_browser = var.founder_browser');
      expect(source(`roots/${root}/founder-browser.tf`)).toContain('module.stack.founder_browser');
    }
    expect(stack).toContain('founder_browser = var.founder_browser');
  });

  it('injects exactly four public configuration fields and one ECS-only key', () => {
    expect([...browser.matchAll(/(FSS_BROWSER_[A-Z_]+)\s*=/g)].map((match) => match[1]).sort()).toEqual([
      'FSS_BROWSER_CLIENT_VERSION', 'FSS_BROWSER_COOKIE_KEY_HEX', 'FSS_BROWSER_FOUNDER_USER_ID',
      'FSS_BROWSER_FOUNDER_WORKSPACE_ID', 'FSS_BROWSER_ORIGIN',
    ]);
    expect(browser).toMatch(/browser_environment = var.founder_browser == null \? \{\} : \{/);
    expect(browser).toMatch(/browser_task_secrets = var.founder_browser == null \? \{\} : \{/);
    expect(browser).toMatch(/FSS_BROWSER_COOKIE_KEY_HEX\s*= var.founder_browser.cookieKeySecretArn/);
    expect(browser.slice(browser.indexOf('  browser_environment ='), browser.indexOf('  browser_task_secrets ='))).not.toContain('FSS_BROWSER_COOKIE_KEY_HEX');
    expect(cluster).toContain('local.runtime_database_secret, local.browser_task_secrets)');
    expect(browser).toContain('merge(local.common_environment, var.api_environment, local.browser_environment, {');
    expect(cluster).toContain('secrets = [for name in sort(keys(local.api_task_secrets))');
  });

  it('grants the additional reference to API execution only, not workers or task roles', () => {
    const policy = block(cluster, 'resource "aws_iam_role_policy" "api_execution_secrets"');
    expect(policy).toContain('role = aws_iam_role.api_execution.id');
    expect(policy).toContain('Action   = ["secretsmanager:GetSecretValue"]');
    expect(policy).toContain('distinct(concat(local.runtime_secret_arns, values(local.browser_task_secrets)))');
    for (const name of ['worker_execution_secrets', 'migration_execution_secrets']) {
      expect(block(cluster, `resource "aws_iam_role_policy" "${name}"`)).not.toContain('browser');
    }
    for (const name of ['worker_task_secrets', 'operations_task_secrets']) {
      expect(cluster.split('\n').find((line) => line.trimStart().startsWith(`${name} `))).not.toContain('browser');
    }
    expect(cluster.match(/local\.browser_task_secrets/g)).toHaveLength(2);
  });

  it('adds only an optional certificate attachment on the existing listener', () => {
    expect(edge.match(/resource "[^"]+"/g)).toEqual(['resource "aws_lb_listener_certificate"']);
    expect(edge).toContain('var.browser_certificate_arn == null ? {} : { browser = var.browser_certificate_arn }');
    expect(edge).toContain('for_each = local.browser_certificates');
    expect(edge).toContain('listener_arn    = aws_lb_listener.https.arn');
    expect(stack).toContain('browser_certificate_arn = var.founder_browser == null ? null : var.founder_browser.certificateArn');
    const currentEdge = source('modules/edge/main.tf');
    expect(currentEdge).toMatch(/preserve_host_header\s*= true/);
    expect(currentEdge).toMatch(/certificate_arn\s*= var.certificate_arn/);
    expect(currentEdge).toMatch(/path\s*= "\/readyz"/);
    expect(currentEdge).toMatch(/target_group_arn\s*= aws_lb_target_group.api.arn/);
  });

  it('preserves task counts, database and port without creating paid resources or secrets', () => {
    expect(source('roots/production/main.tf')).toContain('api_desired_count = 2');
    expect(cluster).toContain('worker_declared_desired_count = 1');
    expect(stack).toMatch(/container_port\s*= 8080/);
    expect(stack).toContain('instance_class             = "db.t4g.small"');
    for (const path of ['modules/cluster', 'modules/stack', 'roots/production', 'roots/rehearsal']) {
      expect(source(`${path}/founder-browser.tf`)).not.toMatch(/resource "/);
    }
  });

  it('publishes routing metadata only and retains separate desktop/API origin', () => {
    const config = source('modules/stack/founder-browser.tf');
    const output = block(config, 'output "founder_browser"');
    expect(output).toContain('${var.founder_browser.origin}/browser/callback');
    expect(output).not.toMatch(/cookieKey|founderUserId|founderWorkspaceId/);
    expect(stack).toContain('FSS_PUBLIC_ORIGIN      = "https://${var.api_hostname}"');
  });
});
