import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * Audit O01, lane g85: an ordinary production plan needs no Google login.
 *
 * `infra/roots/production` declared `provider "google"` for the Gmail push objects, and
 * Terraform configures every provider a root requires before it plans anything. So
 * every production plan, an image-only release included, needed application-default
 * credentials for callie@usecallie.com, which lapse about every 17 hours; an expired
 * one held back the deployment of a worker fix. David's decision of 25 September 2026:
 * the Google provider gets a root of its own. `infra/roots/production-google` owns the
 * topic, the subscription, the push service account and Gmail's publisher grant under
 * its own state key; the production root carries their public identifiers as committed
 * variable defaults. `docs/decisions/g85-the-google-provider-has-its-own-root.md`.
 *
 * The Terraform behaviour is proved by `terraform test` in both roots (the identifiers
 * reach both task definitions; the rehearsal placeholders are refused; the Google root
 * adopts the objects by their production names). This file holds what a plan cannot:
 * which root may name Google at all, that the two roots agree on names neither of them
 * computes from the other, and that the split never destroys what production made.
 *
 * ## The vacuous-pass traps, named
 *
 * Absence is the claim, and a scan that looks at nothing finds nothing. Closed by
 * requiring the same scanner to *find* the Google provider and the pubsub module where
 * they are allowed — in `infra/roots/production-google` and `infra/modules/pubsub` —
 * so "found none in production" cannot mean "could not see it", and by asserting the
 * file lists by name.
 *
 * Two copies of an identifier agree by accident until one moves. Closed by deriving the
 * expected topic id and service-account email from the Google root's own project and
 * prefix defaults and the module's own naming expression, never from a literal in this
 * file, and comparing the production defaults with that.
 *
 * And a migration that removes four addresses from a state is a destroy if the net is
 * missing. Closed by requiring the production root's `removed` block to say
 * `destroy = false`.
 *
 * `scripts/releaseMutationCheck.mjs` holds three mutations against this file: the
 * production root declares the Google provider again, the production topic default
 * drifts, and the `removed` block destroys. Each must turn this file red.
 */

const PRODUCTION = 'infra/roots/production';
const GOOGLE = 'infra/roots/production-google';
const PUBSUB = 'infra/modules/pubsub';

/** `.tf` and `.tftest.hcl` files under a directory, dot-directories (`.terraform`) excluded. */
function terraformSources(relative: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(repositoryPath(relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...terraformSources(child));
    else if (entry.name.endsWith('.tf') || entry.name.endsWith('.tftest.hcl')) files.push(child);
  }
  return files.sort();
}

/** A file with its `#` and `//` comment lines removed, so prose can neither pass nor fail a code assertion. */
function code(relative: string): string {
  return readRepositoryFile(relative)
    .split('\n')
    .filter(line => !/^\s*(#|\/\/)/u.test(line))
    .join('\n');
}

/** Every non-test `.tf` file of a root, concatenated as code. */
function rootCode(root: string): string {
  return terraformSources(root)
    .filter(file => file.endsWith('.tf'))
    .map(file => code(file))
    .join('\n');
}

/** The body of a top-level `<kind> "<name>" {` block, up to its closing brace at column 0. */
function block(text: string, kind: string, name: string): string {
  const start = text.indexOf(`${kind} "${name}" {`);
  if (start < 0) return '';
  const end = text.indexOf('\n}', start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** A variable's string default, or undefined when it has none. */
function stringDefault(variables: string, name: string): string | undefined {
  return /^\s*default\s*=\s*"([^"]*)"\s*$/mu.exec(block(variables, 'variable', name))?.[1];
}

/** One backend setting's value, quotes removed. */
function backendSetting(backend: string, setting: string): string | undefined {
  return new RegExp(`^${setting}\\s*=\\s*"?([^"\\n]*?)"?\\s*$`, 'mu').exec(backend)?.[1];
}

/** What names the Google provider or calls the pubsub module, in code. */
const GOOGLE_PATTERN = /hashicorp\/google|provider\s+"google"|mock_provider\s+"google"|modules\/pubsub"|resource\s+"google_/u;

describe('O01: only the Google root names Google', () => {
  it('finds the provider and the module where they are allowed, so the scan can see', () => {
    const google = terraformSources(GOOGLE);
    expect(google).toEqual(
      expect.arrayContaining([
        `${GOOGLE}/imports.tf`,
        `${GOOGLE}/main.tf`,
        `${GOOGLE}/outputs.tf`,
        `${GOOGLE}/providers.tf`,
        `${GOOGLE}/tests/adoption.tftest.hcl`,
        `${GOOGLE}/variables.tf`,
        `${GOOGLE}/versions.tf`,
      ]),
    );
    expect(code(`${GOOGLE}/versions.tf`)).toMatch(/source\s*=\s*"hashicorp\/google"/u);
    expect(code(`${GOOGLE}/providers.tf`)).toMatch(/^provider "google" \{$/mu);
    expect(code(`${GOOGLE}/main.tf`)).toContain('source = "../../modules/pubsub"');
    expect(code(`${PUBSUB}/main.tf`)).toMatch(/resource "google_pubsub_subscription" "gmail_push"/u);
  });

  it('declares no Google provider, requirement, resource, mock or module in the production root', () => {
    const files = terraformSources(PRODUCTION);
    expect(files).toEqual(
      expect.arrayContaining([
        `${PRODUCTION}/main.tf`,
        `${PRODUCTION}/providers.tf`,
        `${PRODUCTION}/versions.tf`,
        `${PRODUCTION}/variables.tf`,
        `${PRODUCTION}/tests/isolation.tftest.hcl`,
      ]),
    );
    for (const file of files) {
      expect(code(file), `${file} names the Google provider or the pubsub module`).not.toMatch(GOOGLE_PATTERN);
    }
    // And none of the variables that configured it survives to be typed by habit.
    const variables = code(`${PRODUCTION}/variables.tf`);
    for (const gone of ['enable_gmail_push', 'gcp_project_id', 'gcp_region']) {
      expect(variables, gone).not.toContain(`variable "${gone}"`);
    }
  });

  it('names Google nowhere else in infra: not the rehearsal roots, not another module', () => {
    const offenders = [...terraformSources('infra/modules'), ...terraformSources('infra/roots')]
      .filter(file => !file.startsWith(`${GOOGLE}/`) && !file.startsWith(`${PUBSUB}/`))
      .filter(file => GOOGLE_PATTERN.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('keeps AWS out of the Google root: no provider, no resource, one module and it is unconditional', () => {
    const google = rootCode(GOOGLE);
    expect(google).not.toMatch(/hashicorp\/aws|provider\s+"aws"|resource\s+"aws_/u);
    expect([...google.matchAll(/^module "([^"]+)" \{$/gmu)].map(match => match[1])).toEqual(['pubsub']);
    expect(block(google, 'module', 'pubsub')).not.toMatch(/^\s*(count|for_each)\s*=/mu);
  });
});

describe('O01: the Google root is its own state, beside production’s', () => {
  const production = readRepositoryFile(`${PRODUCTION}/backend.hcl`);
  const google = readRepositoryFile(`${GOOGLE}/backend.hcl`);

  it('shares the bucket, region and lock table and owns a key no other root uses', () => {
    for (const setting of ['bucket', 'region', 'dynamodb_table', 'encrypt', 'use_lockfile']) {
      expect(backendSetting(google, setting), setting).toBeDefined();
      expect(backendSetting(google, setting), setting).toBe(backendSetting(production, setting));
    }
    expect(backendSetting(google, 'encrypt')).toBe('true');
    expect(backendSetting(google, 'use_lockfile')).toBe('true');

    const key = backendSetting(google, 'key');
    expect(key).toBe('fss/greenfield/production-google/terraform.tfstate');
    const others = readdirSync(repositoryPath('infra/roots'))
      .filter(root => root !== 'production-google')
      .map(root => backendSetting(readRepositoryFile(`infra/roots/${root}/backend.hcl`), 'key'));
    expect(others).toContain('fss/greenfield/production/terraform.tfstate');
    expect(others).not.toContain(key);
    // `fss-rh-deploy` may touch `fss/greenfield/rehearsal*` and nothing else.
    expect(key?.startsWith('fss/greenfield/rehearsal')).toBe(false);
  });

  it('declares the backend with no arguments, and says its file is the per-account file', () => {
    expect(code(`${GOOGLE}/versions.tf`)).toMatch(/^\s*backend "s3" \{\}$/mu);
    expect(google).toContain('This file is the per-account file, and it is the only one');
    expect(google).toContain('docs/greenfield/accounts.md');
    expect(google).not.toMatch(/access_key|secret_key|token|password/u);
  });
});

describe('O01: the two roots agree on every identifier the task definitions carry', () => {
  const googleVariables = code(`${GOOGLE}/variables.tf`);
  const googleMain = code(`${GOOGLE}/main.tf`);
  const productionVariables = code(`${PRODUCTION}/variables.tf`);
  const productionMain = code(`${PRODUCTION}/main.tf`);
  const pubsub = code(`${PUBSUB}/main.tf`);

  it('carries, as production defaults, the topic and identity the Google root’s own names produce', () => {
    const project = stringDefault(googleVariables, 'gcp_project_id');
    const prefix = stringDefault(googleVariables, 'name_prefix');
    expect(project).toBe('callie-fss');
    expect(prefix).toBe('fss-prod');
    expect(stringDefault(productionVariables, 'name_prefix')).toBe(prefix);

    // The module names the topic `<name_prefix>-gmail-push`; the Google root names the
    // service account `<stem>-gmail-push`, and for a prefix this short the stem is
    // the prefix. Read, not assumed: a module that renamed either would fail here.
    expect(block(pubsub, 'resource', 'google_pubsub_topic" "gmail')).toMatch(
      /^\s*name\s*=\s*"\$\{var\.name_prefix\}-gmail-push"$/mu,
    );
    expect(googleMain).toMatch(/^\s*push_service_account_id = "\$\{local\.service_account_stem\}-gmail-push"$/mu);
    expect(googleMain).toContain('length(var.name_prefix) > 18 ? substr(var.name_prefix, 0, 18) : var.name_prefix');
    expect((prefix ?? '').length).toBeLessThanOrEqual(18);

    const topic = `projects/${project ?? ''}/topics/${prefix ?? ''}-gmail-push`;
    const identity = `${prefix ?? ''}-gmail-push@${project ?? ''}.iam.gserviceaccount.com`;
    expect(stringDefault(productionVariables, 'gmail_push_topic')).toBe(topic);
    expect(stringDefault(productionVariables, 'gmail_push_service_account')).toBe(identity);
  });

  it('hands those two variables, and nothing computed, to the stack', () => {
    const stack = block(productionMain, 'module', 'stack');
    expect(stack).toMatch(/^\s*gmail_push_topic\s*=\s*var\.gmail_push_topic$/mu);
    expect(stack).toMatch(/^\s*gmail_push_service_account\s*=\s*var\.gmail_push_service_account$/mu);
    expect(stack).toMatch(/^\s*gmail_push_audience\s*=\s*local\.push_audience$/mu);
    const outputs = code(`${PRODUCTION}/outputs.tf`);
    expect(block(outputs, 'output', 'gmail_push_topic_id')).toMatch(/value\s*=\s*var\.gmail_push_topic$/mu);
    expect(block(outputs, 'output', 'gmail_push_service_account')).toMatch(
      /value\s*=\s*var\.gmail_push_service_account$/mu,
    );
  });

  it('derives the audience with one expression from one path default in both roots', () => {
    const expression = 'push_audience = "https://${var.api_hostname}${var.gmail_push_path}"';
    expect(productionMain).toContain(expression);
    expect(googleMain).toContain(expression);
    expect(googleMain).toContain('push_endpoint = "https://${var.api_hostname}${var.gmail_push_path}"');
    expect(stringDefault(googleVariables, 'gmail_push_path')).toBe('/integrations/gmail/push');
    expect(stringDefault(productionVariables, 'gmail_push_path')).toBe(
      stringDefault(googleVariables, 'gmail_push_path'),
    );
  });

  it('refuses the rehearsal’s placeholders at the production variables', () => {
    // The rehearsal carries a project that does not exist and an `.invalid` address.
    // Both production validations pin the production names, so neither can arrive.
    const rehearsal = code('infra/roots/rehearsal/variables.tf');
    const placeholderTopic = stringDefault(rehearsal, 'gmail_push_topic') ?? '';
    const placeholderIdentity = stringDefault(rehearsal, 'gmail_push_service_account') ?? '';
    expect(placeholderTopic).toContain('no-push');
    expect(placeholderIdentity.endsWith('.invalid')).toBe(true);
    expect(block(productionVariables, 'variable', 'gmail_push_topic')).toContain('/topics/fss-prod-gmail-push$');
    expect(block(productionVariables, 'variable', 'gmail_push_service_account')).toContain(
      '^fss-prod-gmail-push@',
    );
  });
});

describe('O01: the split moves four objects and destroys none', () => {
  it('forgets, and never destroys, the module the production root used to call', () => {
    const removed = code(`${PRODUCTION}/main.tf`);
    const at = removed.indexOf('removed {');
    expect(at).toBeGreaterThan(0);
    const body = removed.slice(at, removed.indexOf('\n}', at));
    expect(body).toMatch(/^\s*from = module\.pubsub$/mu);
    expect(body).toMatch(/^\s*destroy = false$/mu);
  });

  it('imports exactly the four objects the module declares, by the provider’s import formats', () => {
    const declared = [...code(`${PUBSUB}/main.tf`).matchAll(/^resource "(google_[a-z_]+)" "([a-z_]+)" \{$/gmu)].map(
      match => `module.pubsub.${match[1] ?? ''}.${match[2] ?? ''}`,
    );
    expect(declared).toHaveLength(4);

    const imports = code(`${GOOGLE}/imports.tf`);
    const targets = [...imports.matchAll(/^\s*to = (\S+)$/gmu)].map(match => match[1]);
    expect([...targets].sort()).toEqual([...declared].sort());

    const ids = [...imports.matchAll(/^\s*id = "([^"]+)"$/gmu)].map(match => match[1]);
    expect(ids).toEqual([
      'projects/${var.gcp_project_id}/serviceAccounts/${local.push_service_account_email}',
      'projects/${var.gcp_project_id}/topics/${local.topic_name}',
      'projects/${var.gcp_project_id}/topics/${local.topic_name} roles/pubsub.publisher ${local.gmail_publisher_member}',
      'projects/${var.gcp_project_id}/subscriptions/${local.subscription_name}',
    ]);
    // The member the import names is the member the module grants.
    expect(imports).toContain('gmail_publisher_member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"');
    expect(code(`${PUBSUB}/variables.tf`)).toContain('default     = "gmail-api-push@system.gserviceaccount.com"');
    expect(code(`${PUBSUB}/main.tf`)).toContain('member  = "serviceAccount:${var.gmail_publisher_service_account}"');
  });

  it('gives the operator a migration that backs up, imports, removes, proves and rolls back', () => {
    const runbook = readRepositoryFile('docs/greenfield/google-root-migration-runbook.md');
    for (const phrase of [
      'terraform state pull',
      "terraform state rm 'module.pubsub[0]'",
      'Plan: 4 to import, 0 to add',
      '0 to destroy',
      'CLOUDSDK_CONFIG',
      'terraform providers',
      '## Rollback',
      'fss/greenfield/production-google/terraform.tfstate',
    ]) {
      expect(runbook, phrase).toContain(phrase);
    }
    // Never a credential value, and never a key file.
    expect(runbook).not.toMatch(/AKIA[0-9A-Z]{16}|"private_key"|ya29\./u);
  });
});
