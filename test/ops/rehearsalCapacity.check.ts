import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/repository.ts';

const WORKFLOW = readRepositoryFile('.github/workflows/greenfield-release.yml');

function step(name: string): string {
  const start = WORKFLOW.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`No rehearsal step named ${name}`);
  const next = WORKFLOW.indexOf('\n      - ', start + 1);
  return WORKFLOW.slice(start, next < 0 ? undefined : next);
}

function body(text: string): string {
  const start = text.indexOf('        run: |\n');
  if (start < 0) throw new Error('No workflow run block');
  return text.slice(start + '        run: |\n'.length).split('\n').map(line => line.slice(10)).join('\n');
}

const WRITE = step('Write the variables this run plans, applies and tears down with');
const FIXTURES: Readonly<Record<string, string>> = {
  'steps.prefix.outputs.prefix': 'fss-rh-capacity',
  'secrets.FSS_REHEARSAL_API_REPOSITORY': '123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api',
  'secrets.FSS_REHEARSAL_WORKER_REPOSITORY': '123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker',
  'secrets.FSS_REHEARSAL_CERTIFICATE_ARN': 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555',
  'secrets.FSS_REHEARSAL_API_HOSTNAME': 'rehearsal.example.invalid',
  'inputs.api_image_digest': `sha256:${'1'.repeat(64)}`,
  'inputs.worker_image_digest': `sha256:${'2'.repeat(64)}`,
};

function render(script: string): string {
  return script.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match: string, expression: string) => {
    const value = FIXTURES[expression];
    if (value === undefined) throw new Error(`Uncontrolled workflow expression ${expression}`);
    return value;
  });
}

/** Execute the actual workflow shell/Python with public fixture identifiers only. */
function writeVariables(pair: string | undefined, consume?: (directory: string) => void): { readonly code: number; readonly output: string; readonly variables: unknown } {
  const directory = mkdtempSync(join(tmpdir(), 'fss-rehearsal-zones-'));
  try {
    const script = render(body(WRITE));
    const result = spawnSync('/bin/bash', ['-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        BASH_ENV: '/dev/null',
        API_SCHEMA_MIN: '64', API_SCHEMA_MAX: '64', WORKER_SCHEMA_MIN: '64', WORKER_SCHEMA_MAX: '64',
        ...(pair === undefined ? {} : { FSS_REHEARSAL_AVAILABILITY_ZONES: pair }),
      },
    });
    const code = result.status ?? 1;
    if (code === 0) consume?.(directory);
    return {
      code,
      output: `${result.stdout}${result.stderr}`,
      variables: code === 0 ? JSON.parse(readFileSync(join(directory, 'run.auto.tfvars.json'), 'utf8')) : null,
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe('issue 473: the rehearsal workflow persists its bounded capacity choice', () => {
  it('writes the alternate pair to the same file that survives into apply and teardown', () => {
    const result = writeVariables('us-east-1a,us-east-1d');
    expect(result.code, result.output).toBe(0);
    expect(result.variables).toMatchObject({
      name_prefix: 'fss-rh-capacity',
      availability_zones: ['us-east-1a', 'us-east-1d'],
      assume_deployment_role: false,
      bootstrap: true,
    });
  });

  it('preserves a/b when the optional input is omitted', () => {
    const result = writeVariables(undefined);
    expect(result.code, result.output).toBe(0);
    expect(result.variables).toMatchObject({ availability_zones: ['us-east-1a', 'us-east-1b'] });
  });

  it.each([
    'us-east-1a,us-east-1a',
    'us-west-2a,us-west-2b',
    'us-east-1a,us-east-1c',
    'us-east-1d,us-east-1a',
    'us-east-1a',
    'us-east-1a,us-east-1b,us-east-1d',
    'us-east-1a,$(touch injected)',
    '',
  ])('refuses the unsupported pair %j before creating usable variables', pair => {
    const result = writeVariables(pair);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('Rehearsal availability_zones');
    expect(result.variables).toBeNull();
  });

  it('passes the choice through an environment value, never a shell expression', () => {
    expect(WRITE).toContain("FSS_REHEARSAL_AVAILABILITY_ZONES: ${{ inputs.availability_zones || 'us-east-1a,us-east-1b' }}");
    expect(body(WRITE)).not.toContain('inputs.availability_zones');
  });

  it('the actual plan and create commands read the generated pair from the same directory', () => {
    const planStep = step('Plan the rehearsal environment, and summarise it without values');
    const createStep = step('Create the rehearsal environment');
    for (const consumer of [planStep, createStep]) expect(consumer).toContain('working-directory: infra/roots/rehearsal');
    const plan = body(planStep).match(/terraform plan [\s\S]*? > "\$plan_log"/u)?.[0];
    const create = body(createStep).match(/^terraform apply .+$/mu)?.[0];
    if (plan === undefined || create === undefined) throw new Error('No Terraform plan/create command');
    const result = writeVariables('us-east-1a,us-east-1d', directory => {
      const stub = join(directory, 'terraform');
      writeFileSync(stub, `#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
if args[0] not in ("plan", "apply") or any("availability_zones" in arg for arg in args):
    raise SystemExit("unexpected command or zone override")
variables = json.loads(pathlib.Path("run.auto.tfvars.json").read_text())
with pathlib.Path("consumed.jsonl").open("a") as log:
    log.write(json.dumps({"operation": args[0], "pair": variables["availability_zones"]}) + "\\n")
`);
      chmodSync(stub, 0o755);
      for (const command of [plan, create]) {
        const call = spawnSync('/bin/bash', ['-c', render(command)], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            PATH: `${directory}:${process.env['PATH'] ?? ''}`, BASH_ENV: '/dev/null',
            plan_file: join(directory, 'rehearsal.tfplan'), plan_log: join(directory, 'plan.log'),
            prefix: 'fss-rh-capacity',
            API_SCHEMA_MIN: '64', API_SCHEMA_MAX: '64', WORKER_SCHEMA_MIN: '64', WORKER_SCHEMA_MAX: '64',
          },
        });
        expect(call.status, `${call.stdout}${call.stderr}`).toBe(0);
      }
      expect(readFileSync(join(directory, 'consumed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
        { operation: 'plan', pair: ['us-east-1a', 'us-east-1d'] },
        { operation: 'apply', pair: ['us-east-1a', 'us-east-1d'] },
      ]);
    });
    expect(result.code, result.output).toBe(0);
  });
});
