import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKER_SCHEMA_RANGE } from '@fss/domain/db';
import { ConfigError, readWorkerConfig } from '../../apps/worker/src/bootstrap/config.ts';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * One CloudWatch namespace per environment (open item g42, lane g55).
 *
 * The evidence is the tenth full rehearsal, run 35943001092 of 23 September 2026: its
 * smoke failed in two seconds on a canary age of 837.9 s, and that number was
 * *production's*. Every environment in the account published into the bare `FSS`
 * namespace and every alarm read it, so a rehearsal's smoke read production's
 * datapoint, and a rehearsal worker's heartbeats, canary age and safety counters could
 * trip or mask `fss-prod-*` alarms (`docs/greenfield/release.md` 8.0s).
 *
 * The namespace is now `FSS/<name_prefix>`, derived once in `infra/modules/stack` and
 * handed to the three modules that publish, filter and alarm. This file is the map from
 * that one line to every place the value has to arrive, and to every place something
 * reads a metric back.
 *
 * ## The vacuous-pass traps, named
 *
 * Three.
 *
 * A scan for the literal `"FSS"` would pass a module that had merely spelled the shared
 * namespace some other way — `"F${"SS"}"`, a local, a default in another file. Closed by
 * asserting the positive shape as well: every `namespace` and `cloudwatch:namespace` in
 * the tree reads `var.metric_namespace`, the counts of those reads are what the modules
 * actually declare (so a scan over no files would fail), and the one derivation in the
 * tree is the stack's.
 *
 * Asserting that the smoke *mentions* the namespace output would pass a step that read
 * the output and then queried `--namespace FSS` anyway. Closed by reading the query
 * itself and by refusing a bare `--namespace FSS` in every workflow and script. The
 * mutation appended to `scripts/releaseMutationCheck.mjs` puts that exact query back
 * and requires this file to go red.
 *
 * And a worker that kept `?? 'FSS'` would pass every Terraform assertion, because a
 * task definition always sets the variable — until one does not. Closed by running the
 * real `readWorkerConfig` against a task-shaped environment that lacks it.
 *
 * The Terraform behaviour — the value reaching all five task definitions, all four task
 * role conditions, every metric filter and every alarm, and the bare namespace refused
 * at each module's variable — is proved by `terraform test` in
 * `infra/modules/{observability,cluster,alerts}` and in both roots, which assert
 * `FSS/fss-prod` and `FSS/<run prefix>` against the plan.
 */

const STACK = readRepositoryFile('infra/modules/stack/main.tf');
const WORKFLOW = readRepositoryFile('.github/workflows/greenfield-release.yml');
const WORKER_CONFIG = readRepositoryFile('apps/worker/src/bootstrap/config.ts');

/** The three modules that take the namespace, and what each does with it. */
const CONSUMERS = ['observability', 'cluster', 'alerts'] as const;

/** Every `.tf` file under a directory, `tests/` and dot-directories (`.terraform`) excluded. */
function terraformFiles(relative: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(repositoryPath(relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name.startsWith('.')) continue;
      files.push(...terraformFiles(child));
    } else if (entry.name.endsWith('.tf')) {
      files.push(child);
    }
  }
  return files.sort();
}

/** Every file under a directory with one of the given suffixes, recursively. */
function filesUnder(relative: string, suffixes: readonly string[]): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(repositoryPath(relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      files.push(...filesUnder(child, suffixes));
    } else if (suffixes.some(suffix => entry.name.endsWith(suffix))) {
      files.push(child);
    }
  }
  return files.sort();
}

/** The text of a file with its `#` and `//` comment lines removed, so prose cannot pass or fail a code assertion. */
function code(relative: string): string {
  return readRepositoryFile(relative)
    .split('\n')
    .filter(line => !/^\s*(#|\/\/)/u.test(line))
    .join('\n');
}

/** The body of a top-level `<kind> "<name>" {` block, up to its closing brace at column 0. */
function block(text: string, kind: string, name: string): string {
  const start = text.indexOf(`${kind} "${name}" {`);
  if (start < 0) return '';
  const end = text.indexOf('\n}', start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

const INFRA_FILES = [...terraformFiles('infra/modules'), ...terraformFiles('infra/roots')];

/** An environment shaped like the worker task definition's, for one prefix. */
function taskEnvironment(prefix: string, namespace: string | undefined): Record<string, string | undefined> {
  return {
    FSS_ROLE: 'worker',
    FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
    FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
    FSS_NAME_PREFIX: prefix,
    FSS_METRIC_NAMESPACE: namespace,
    AWS_REGION: 'us-east-1',
    DATABASE_URL: 'postgresql://unused.invalid/fss',
  };
}

describe('g55: one metric namespace per environment (g42)', () => {
  it('derives the namespace once, in the stack, from the name prefix', () => {
    const opening = STACK.indexOf('\nlocals {');
    expect(opening).toBeGreaterThan(0);
    const locals = STACK.slice(opening, STACK.indexOf('\n}', opening + 1));
    expect(locals).toMatch(/^\s*metric_namespace\s*=\s*"FSS\/\$\{var\.name_prefix\}"\s*$/mu);
    // Nowhere else: a second derivation is a second value that can disagree.
    const derivations = INFRA_FILES.filter(file => code(file).includes('"FSS/${var.name_prefix}"'));
    expect(derivations).toEqual(['infra/modules/stack/main.tf']);
  });

  it('hands that one value to the modules that filter, publish and alarm', () => {
    for (const consumer of CONSUMERS) {
      const call = block(STACK, 'module', consumer);
      expect(call, `module "${consumer}" in the stack`).not.toBe('');
      expect(call, `module "${consumer}" takes the stack's namespace`).toMatch(
        /^\s*metric_namespace\s*=\s*local\.metric_namespace\s*$/mu,
      );
    }
    // And the stack and both roots say what it is, so a reader never has to guess.
    expect(readRepositoryFile('infra/modules/stack/outputs.tf')).toMatch(
      /output "metric_namespace" \{[^}]*value\s*=\s*local\.metric_namespace/u,
    );
    for (const root of ['rehearsal', 'production']) {
      expect(readRepositoryFile(`infra/roots/${root}/outputs.tf`), root).toMatch(
        /output "metric_namespace" \{[^}]*value\s*=\s*module\.stack\.metric_namespace/u,
      );
    }
  });

  it('gives the modules no default to fall back to, and refuses the bare namespace at each of them', () => {
    for (const consumer of CONSUMERS) {
      const variable = block(readRepositoryFile(`infra/modules/${consumer}/variables.tf`), 'variable', 'metric_namespace');
      expect(variable, consumer).not.toBe('');
      expect(variable, `${consumer} has no default`).not.toMatch(/^\s*default\s*=/mu);
      expect(variable, `${consumer} validates the shape`).toContain(
        'can(regex("^FSS/[a-z][a-z0-9-]{2,31}$", var.metric_namespace))',
      );
    }
  });

  it('lets no module or root hard-code a namespace', () => {
    expect(INFRA_FILES.length).toBeGreaterThan(20);
    for (const file of INFRA_FILES) {
      expect(code(file), `${file} names the bare FSS namespace`).not.toContain('"FSS"');
    }

    // The positive half. Every metric-filter and alarm namespace, and every
    // PutMetricData condition, reads the variable — and there are as many of them as
    // the modules declare, so a scan that found nothing could not pass.
    const assignments = INFRA_FILES.flatMap(file =>
      [...code(file).matchAll(/^\s*namespace\s*=\s*(\S+)\s*$/gmu)].map(match => `${file}: ${match[1] ?? ''}`),
    );
    expect(assignments).toEqual([
      'infra/modules/alerts/main.tf: var.metric_namespace',
      'infra/modules/alerts/main.tf: var.metric_namespace',
      'infra/modules/alerts/main.tf: var.metric_namespace',
      'infra/modules/observability/main.tf: var.metric_namespace',
    ]);
    const conditions = INFRA_FILES.flatMap(file =>
      [...code(file).matchAll(/"cloudwatch:namespace"\s*=\s*([^\s}]+)/gmu)].map(match => `${file}: ${match[1] ?? ''}`),
    );
    expect(conditions).toEqual(Array.from({ length: 4 }, () => 'infra/modules/cluster/main.tf: var.metric_namespace'));
    expect(code('infra/modules/cluster/main.tf')).toMatch(/^\s*FSS_METRIC_NAMESPACE\s*=\s*var\.metric_namespace\s*$/mu);
  });

  it('starts no deployed worker that would publish without its own namespace', () => {
    // The default that let a missing variable publish into the shared namespace is gone.
    expect(WORKER_CONFIG).not.toContain("?? 'FSS'");

    const refusedWith = (environment: Record<string, string | undefined>): string | null => {
      try {
        readWorkerConfig(environment);
        return null;
      } catch (error) {
        return error instanceof ConfigError ? error.code : 'not a ConfigError';
      }
    };
    // A task definition that lost the variable, and a rehearsal told production's.
    expect(refusedWith(taskEnvironment('fss-rh-202609241713', undefined))).toBe('MISSING');
    expect(refusedWith(taskEnvironment('fss-rh-202609241713', 'FSS/fss-prod'))).toBe('INVALID');
    expect(refusedWith(taskEnvironment('fss-prod', 'FSS'))).toBe('INVALID');
    // And the two shapes the stack really produces.
    expect(refusedWith(taskEnvironment('fss-rh-202609241713', 'FSS/fss-rh-202609241713'))).toBeNull();
    expect(readWorkerConfig(taskEnvironment('fss-prod', 'FSS/fss-prod')).metrics.namespace).toBe('FSS/fss-prod');
  });

  it('makes the rehearsal smoke read its own run’s canary age and nothing else', () => {
    const start = WORKFLOW.indexOf('- name: Smoke the rehearsal environment with the production smoke script');
    expect(start).toBeGreaterThan(0);
    const next = WORKFLOW.indexOf('\n      - name:', start + 1);
    const step = WORKFLOW.slice(start, next < 0 ? undefined : next);

    // The value the alarms and the task definitions were built from, not a re-typed one.
    expect(step).toContain('namespace="$(terraform -chdir=infra/roots/rehearsal output -raw metric_namespace)"');
    // Refused unless it is this run's.
    expect(step).toContain('if [ "$namespace" != "FSS/${{ steps.prefix.outputs.prefix }}" ]; then');
    // And the query uses it.
    const queries = [...step.matchAll(/aws cloudwatch get-metric-statistics --namespace (\S+)/gu)].map(
      match => match[1],
    );
    expect(queries).toEqual(['"$namespace"']);
  });

  it('leaves no reader of a metric pointed at the bare namespace', () => {
    const readers = [
      ...filesUnder('.github/workflows', ['.yml', '.yaml']),
      ...filesUnder('infra/scripts', ['.sh']),
      'scripts/productionSmoke.mjs',
    ];
    expect(readers.length).toBeGreaterThan(20);
    const bare = /--namespace\s+["']?FSS["']?(?=[\s\\]|$)/mu;
    for (const file of readers) {
      expect(readRepositoryFile(file), `${file} reads the bare FSS namespace`).not.toMatch(bare);
    }
  });

  it('needs nothing new from the deployment roles', () => {
    // Neither deployment-role document conditions anything on a metric namespace:
    // reading a metric is `cloudwatch:Get*` on `*` in `AccountMetadata`, and alarms are
    // authorised by their `<prefix>*` names. So a namespace change is not a policy change,
    // and if a namespace condition ever appears it must not name the shared one.
    for (const file of filesUnder('infra/policies', ['.json', '.tftpl'])) {
      expect(readRepositoryFile(file), file).not.toContain('"FSS"');
    }
  });
});
