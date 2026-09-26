import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  RESTORE_DATABASE,
  RESTORE_SERVICES,
  RESTORE_TASK_DEFINITIONS,
  RETIREMENT_DATABASE_ATTRIBUTES,
  checkRestorePlan,
  main,
} from '../src/tools/restorePlan.ts';

/**
 * The restore runbook's plan checks (`restorePlan.ts`; lane W3-S8 second review), over plans
 * shaped as `terraform show -json` writes them.
 *
 * The review found the repoint check compared addresses and actions only, and the
 * retirement check only which resources were deleted. So each refusal here is one those
 * checks let through: a task definition that changes more than its host, a service that
 * changes more than its task definition, an unrelated resource updated, the instance
 * changed on a repoint, or changed beyond Terraform's own settings on a retirement.
 *
 * ## The vacuous-pass trap, named
 *
 * A checker that refused everything would pass every refusal below. So each case starts
 * from a pair of plans the checker accepts, and changes one thing.
 */

const OLD = 'fss-prod-pg.abcdefghijkl.us-east-1.rds.amazonaws.com';
const NEW = 'fss-prod-pg-r09261150.abcdefghijkl.us-east-1.rds.amazonaws.com';

interface Change {
  address: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  change: { actions: string[]; before: unknown; after: unknown; after_unknown: unknown };
}

function containers(name: string, host: string): string {
  return JSON.stringify([
    {
      name,
      image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-${name}@sha256:${'a'.repeat(64)}`,
      essential: true,
      environment: [
        { name: 'FSS_DATABASE_HOST', value: host },
        { name: 'FSS_DATABASE_NAME', value: 'fss' },
        { name: 'FSS_ENVIRONMENT', value: 'production' },
      ],
      secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-prod/app' }],
    },
  ]);
}

function taskDefinition(address: string, host: string): Change {
  const name = address.split('.').at(-1) ?? '';
  return {
    address,
    mode: 'managed',
    type: 'aws_ecs_task_definition',
    name,
    change: {
      actions: ['create', 'delete'],
      before: { family: `fss-prod-${name}`, container_definitions: containers(name, 'state-normalised'), revision: 7 },
      after: { family: `fss-prod-${name}`, container_definitions: containers(name, host), cpu: '512', memory: '1024', tags: { Environment: 'production' } },
      after_unknown: { arn: true, arn_without_revision: true, id: true, revision: true },
    },
  };
}

function service(address: string): Change {
  const name = address.split('.').at(-1) ?? '';
  const before = {
    name: `fss-prod-${name}`,
    desired_count: 0,
    task_definition: `arn:aws:ecs:us-east-1:123456789012:task-definition/fss-prod-${name}:7`,
    deployment_circuit_breaker: [{ enable: true, rollback: true }],
  };
  const after = { name: before.name, desired_count: 0, deployment_circuit_breaker: before.deployment_circuit_breaker };
  return {
    address,
    mode: 'managed',
    type: 'aws_ecs_service',
    name,
    change: { actions: ['update'], before, after, after_unknown: { task_definition: true, deployment_circuit_breaker: [{}] } },
  };
}

function unchanged(address: string, type: string): Change {
  return { address, mode: 'managed', type, name: 'x', change: { actions: ['no-op'], before: { id: 'x' }, after: { id: 'x' }, after_unknown: {} } };
}

const DATABASE_BEFORE = {
  identifier: 'fss-prod-pg',
  backup_retention_period: 35,
  apply_immediately: null,
  delete_automated_backups: true,
  skip_final_snapshot: false,
  final_snapshot_identifier: null,
  tags: {},
  tags_all: {},
};
const DATABASE_AFTER = {
  ...DATABASE_BEFORE,
  apply_immediately: false,
  delete_automated_backups: false,
  final_snapshot_identifier: 'fss-prod-pg-final',
  tags: { Name: 'fss-prod-pg' },
  tags_all: { Environment: 'production', Name: 'fss-prod-pg' },
};

function database(after: Record<string, unknown> = DATABASE_AFTER, actions: string[] = ['update']): Change {
  return { address: RESTORE_DATABASE, mode: 'managed', type: 'aws_db_instance', name: 'main', change: { actions, before: DATABASE_BEFORE, after, after_unknown: {} } };
}

function plan(host: string, extra: readonly Change[] = []): { format_version: string; resource_changes: Change[]; errored: boolean } {
  return {
    format_version: '1.2',
    errored: false,
    resource_changes: [
      ...RESTORE_TASK_DEFINITIONS.map(address => taskDefinition(address, host)),
      ...RESTORE_SERVICES.map(service),
      unchanged('module.stack.module.network.aws_vpc.main', 'aws_vpc'),
      { ...unchanged('module.stack.data.aws_caller_identity.current', 'aws_caller_identity'), mode: 'data', change: { actions: ['read'], before: null, after: {}, after_unknown: {} } },
      ...extra,
    ],
  };
}

const repoint = (thePlan: unknown, reference: unknown = plan(OLD)) =>
  checkRestorePlan({ kind: 'repoint', plan: thePlan, reference, planHost: NEW, referenceHost: OLD });
const retire = (thePlan: unknown, reference: unknown) =>
  checkRestorePlan({ kind: 'retire', plan: thePlan, reference, planHost: OLD, referenceHost: NEW });

function edit(thePlan: ReturnType<typeof plan>, address: string, change: (entry: Change) => void): ReturnType<typeof plan> {
  const copy = structuredClone(thePlan);
  const entry = copy.resource_changes.find(candidate => candidate.address === address);
  if (entry === undefined) throw new Error(`no ${address} in the fixture`);
  change(entry);
  return copy;
}

const problems = (verdict: ReturnType<typeof checkRestorePlan>): string => (verdict.ok ? '' : verdict.problems.join('\n'));

describe('the repoint check', () => {
  it('accepts the four task definitions replaced with only the host changed, and the services’ task definitions', () => {
    const verdict = repoint(plan(NEW));
    expect(verdict).toMatchObject({ ok: true, kind: 'repoint' });
    if (!verdict.ok) return;
    for (const address of RESTORE_TASK_DEFINITIONS) expect(verdict.changes[address]).toEqual(['FSS_DATABASE_HOST']);
    for (const address of RESTORE_SERVICES) expect(verdict.changes[address]).toEqual(['task_definition']);
  });

  it('refuses a task definition that changes more than its host', () => {
    const image = edit(plan(NEW), RESTORE_TASK_DEFINITIONS[1] ?? '', entry => {
      const after = entry.change.after as Record<string, string>;
      after['container_definitions'] = (after['container_definitions'] ?? '').replace('a'.repeat(64), 'b'.repeat(64));
    });
    expect(problems(repoint(image))).toMatch(/aws_ecs_task_definition\.worker: differs from the reference in more than FSS_DATABASE_HOST \(container_definitions\)/u);
    const memory = edit(plan(NEW), RESTORE_TASK_DEFINITIONS[0] ?? '', entry => {
      (entry.change.after as Record<string, string>)['memory'] = '2048';
    });
    expect(problems(repoint(memory))).toMatch(/aws_ecs_task_definition\.api: differs from the reference in more than FSS_DATABASE_HOST \(memory\)/u);
  });

  it('refuses a plan whose host is not the copy’s, or a task definition that carries none', () => {
    expect(problems(repoint(plan(OLD)))).toMatch(/has FSS_DATABASE_HOST "fss-prod-pg\.abcdefghijkl[^"]*", not fss-prod-pg-r09261150/u);
    const hostless = edit(plan(NEW), RESTORE_TASK_DEFINITIONS[3] ?? '', entry => {
      const after = entry.change.after as Record<string, string>;
      after['container_definitions'] = (after['container_definitions'] ?? '').replace('FSS_DATABASE_HOST', 'FSS_DATABASE_HOSTNAME');
    });
    expect(problems(repoint(hostless))).toMatch(/aws_ecs_task_definition\.operations \(plan\): no container carries FSS_DATABASE_HOST/u);
    expect(problems(checkRestorePlan({ kind: 'repoint', plan: plan(NEW), reference: plan(NEW), planHost: NEW, referenceHost: NEW }))).toMatch(
      /name the same host/u,
    );
  });

  it('refuses a service that changes more than its task definition', () => {
    const scaled = edit(plan(NEW), RESTORE_SERVICES[0] ?? '', entry => {
      (entry.change.after as Record<string, unknown>)['desired_count'] = 1;
    });
    expect(problems(repoint(scaled))).toMatch(/aws_ecs_service\.api \(plan\): only task_definition may change.*desired_count, task_definition/u);
  });

  it('refuses any other resource change, and the instance changed at all', () => {
    const rule = repoint(plan(NEW, [{ ...unchanged('module.stack.aws_security_group_rule.database_ingress', 'aws_security_group_rule'), change: { actions: ['update'], before: {}, after: { cidr_blocks: ['0.0.0.0/0'] }, after_unknown: {} } }]));
    expect(problems(rule)).toMatch(/aws_security_group_rule\.database_ingress \(plan\): update is not part of a restore/u);
    expect(problems(repoint(plan(NEW, [database()]), plan(OLD, [database()])))).toMatch(/the repoint changes nothing on the instance/u);
  });

  it('refuses a task definition left unreplaced, a service left alone, and a plan it cannot read', () => {
    const kept = edit(plan(NEW), RESTORE_TASK_DEFINITIONS[2] ?? '', entry => {
      entry.change.actions = ['no-op'];
    });
    expect(problems(repoint(kept))).toMatch(/aws_ecs_task_definition\.migration \(plan\): must be replaced, and the plan says no change/u);
    const inPlace = edit(plan(NEW), RESTORE_TASK_DEFINITIONS[2] ?? '', entry => {
      entry.change.actions = ['update'];
    });
    expect(problems(repoint(inPlace))).toMatch(/must be replaced, and the plan says update/u);
    const idle = edit(plan(NEW), RESTORE_SERVICES[1] ?? '', entry => {
      entry.change.actions = ['no-op'];
    });
    expect(problems(repoint(idle))).toMatch(/aws_ecs_service\.worker \(plan\): must be updated in place/u);
    expect(problems(repoint({ format_version: '1.2' }))).toMatch(/not a terraform show -json plan/u);
    expect(problems(repoint({ ...plan(NEW), errored: true }))).toMatch(/the plan plan errored/u);
    expect(problems(repoint(plan(NEW), { resource_changes: 'none' }))).toMatch(/the reference plan is not/u);
  });

  it('refuses services planned differently in the plan and its reference', () => {
    // Lane W3-S8 third review: each service changing only task_definition was checked in
    // each plan alone, never across the pair.
    const other = edit(plan(NEW), RESTORE_SERVICES[1] ?? '', entry => {
      (entry.change.after as Record<string, unknown>)['deployment_circuit_breaker'] = [{ enable: true, rollback: false }];
      (entry.change.before as Record<string, unknown>)['deployment_circuit_breaker'] = [{ enable: true, rollback: false }];
    });
    expect(problems(repoint(other))).toMatch(/aws_ecs_service\.worker: planned differently in the plan and the reference/u);
  });

  it('checks the reference as strictly as the plan', () => {
    const drifted = plan(OLD, [{ ...unchanged('module.stack.module.journal.aws_s3_bucket.journal', 'aws_s3_bucket'), change: { actions: ['delete'], before: {}, after: null, after_unknown: {} } }]);
    expect(problems(repoint(plan(NEW), drifted))).toMatch(/aws_s3_bucket\.journal \(reference\): delete is not part of a restore/u);
  });
});

describe('the retirement check', () => {
  it('accepts the task definitions back on the managed address and Terraform’s own settings and tags on the instance', () => {
    const verdict = retire(plan(OLD, [database()]), plan(NEW, [database()]));
    expect(verdict).toMatchObject({ ok: true, kind: 'retire' });
    if (!verdict.ok) return;
    expect(verdict.changes[RESTORE_DATABASE]).toEqual(['apply_immediately', 'delete_automated_backups', 'final_snapshot_identifier', 'tags', 'tags_all']);
    // And an import that matched the configuration exactly changes nothing there.
    expect(retire(plan(OLD), plan(NEW))).toMatchObject({ ok: true });
  });

  it('refuses any other change to the instance, and its replacement above all', () => {
    const retention = database({ ...DATABASE_AFTER, backup_retention_period: 7 });
    expect(problems(retire(plan(OLD, [retention]), plan(NEW, [retention])))).toMatch(
      /aws_db_instance\.main \(plan\): changes backup_retention_period, which the retirement never changes/u,
    );
    const replaced = database(DATABASE_AFTER, ['delete', 'create']);
    expect(problems(retire(plan(OLD, [replaced]), plan(NEW, [replaced])))).toMatch(/may only be updated in place, and the plan says delete\+create/u);
    const unknown: Change = { ...database(), change: { ...database().change, after_unknown: { endpoint: true } } };
    expect(problems(retire(plan(OLD, [unknown]), plan(NEW, [unknown])))).toMatch(/changes endpoint/u);
  });

  it('refuses an instance planned differently in the plan and its reference', () => {
    expect(problems(retire(plan(OLD, [database()]), plan(NEW)))).toMatch(/the plan and the reference plan the instance differently/u);
  });

  it('refuses a task definition not returned to the managed address', () => {
    expect(problems(retire(plan(NEW, [database()]), plan(NEW, [database()])))).toMatch(/has FSS_DATABASE_HOST "fss-prod-pg-r09261150/u);
    expect(problems(retire(plan(`other.${OLD}`, [database()]), plan(NEW, [database()])))).toMatch(/has FSS_DATABASE_HOST "other\./u);
  });

  it('allows exactly Terraform’s own settings and the tags', () => {
    expect([...RETIREMENT_DATABASE_ATTRIBUTES].sort()).toEqual([
      'apply_immediately',
      'delete_automated_backups',
      'final_snapshot_identifier',
      'skip_final_snapshot',
      'tags',
      'tags_all',
    ]);
  });
});

describe('the command the runbook runs', () => {
  const files = (contents: Record<string, unknown>) => (path: string): string => {
    if (!(path in contents)) throw new Error(`no ${path}`);
    return typeof contents[path] === 'string' ? (contents[path] as string) : JSON.stringify(contents[path]);
  };
  const quietly = <T>(run: () => T): T => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      return run();
    } finally {
      error.mockRestore();
      stdout.mockRestore();
    }
  };

  it('exits 0 for a plan it accepts, 1 for one it refuses or cannot read, and 64 for a malformed call', () => {
    const read = files({ point: plan(NEW), reference: plan(OLD), broken: '{"resource_changes": [' });
    const argv = (planPath: string) => ['repoint', '--plan', planPath, '--reference', 'reference', '--plan-host', NEW, '--reference-host', OLD];
    expect(quietly(() => main(argv('point'), read))).toBe(0);
    expect(quietly(() => main(argv('reference'), read))).toBe(1);
    expect(quietly(() => main(argv('broken'), read))).toBe(1);
    expect(quietly(() => main(['rollback', ...argv('point').slice(1)], read))).toBe(64);
    expect(quietly(() => main(['repoint', '--plan', 'point'], read))).toBe(64);
    expect(quietly(() => main([...argv('point'), '--force', 'yes'], read))).toBe(64);
  });
});

describe('what the runbook tells a restore, against what the module configures', () => {
  // (b) sets on the copy what a point-in-time restore does not carry over, so that (g)'s
  // check finds only Terraform's own settings and tags to change. A module that moves a
  // window or the CA without the runbook would turn every retirement into a NO-GO.
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
  const runbook = read('docs/greenfield/runbooks/restore.md');
  const module = read('infra/modules/database/main.tf');
  const production = read('infra/roots/production/main.tf');
  const literal = (text: string, name: string): string => {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\s]+)"?\\s*$`, 'mu').exec(text);
    if (match?.[1] === undefined) throw new Error(`${name} is not a literal any more`);
    return match[1];
  };

  it('restores with the module’s storage, CA and windows, and production’s ceiling and retention', () => {
    expect(literal(module, 'storage_type')).toBe('gp3');
    expect(runbook).toContain(`--storage-type ${literal(module, 'storage_type')}`);
    expect(runbook).toContain(`--ca-certificate-identifier ${literal(module, 'ca_cert_identifier')}`);
    expect(runbook).toContain(`--preferred-backup-window ${literal(module, 'backup_window')}`);
    expect(runbook).toContain(`--preferred-maintenance-window ${literal(module, 'maintenance_window')}`);
    expect(runbook).toContain(`--max-allocated-storage ${literal(production, 'database_max_allocated_storage')}`);
    expect(runbook).toContain(`--backup-retention-period ${literal(production, 'database_backup_retention_days')}`);
  });

  it('runs both checks through restorePlan.ts, each over a plan and a reference that replace the task definitions', () => {
    expect(runbook).toContain('check_plans repoint "$W/point.tfplan" "$W/point-reference.tfplan" "$NEW_HOST" "$OLD_HOST"');
    // Retirement uses the renamed copy's own address, read after the rename (third review).
    expect(runbook).toContain('check_plans retire "$W/retire.tfplan" "$W/retire-reference.tfplan" "$RETIRED_HOST" "$NEW_HOST"');
    expect(runbook).toContain('fill_migration fss-prod-pg "$RETIRED_HOST"');
    for (const name of ['api', 'worker', 'migration', 'operations']) expect(runbook).toContain(`-replace=$TD.${name}`);
  });
});
