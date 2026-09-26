import { readFileSync } from 'node:fs';

/**
 * The restore runbook's two plan checks (`docs/greenfield/runbooks/restore.md` (c) and
 * (g); lane W3-S8 review). Run on the operator's machine, never in a task:
 *
 *   node --experimental-strip-types apps/worker/src/tools/restorePlan.ts <repoint|retire> \
 *     --plan <plan json> --reference <plan json> --plan-host <host> --reference-host <host>
 *
 * **What it compares.** Two `terraform show -json` plans of the production root that
 * differ in one input: `active_database_host`. Both replace the four task definitions by
 * request (`-replace`), so both carry them as the configuration computes them, and
 * comparing them compares like with like; a task definition's state is the provider's
 * reading of the API, which differs from the configuration in defaults and key order
 * however equal they are. It also means a rerun after an apply still has a plan to check.
 *
 * **What it requires, of both plans.** Every managed resource is unchanged except:
 * - the four task definitions (`api`, `worker`, `migration`, `operations`), each replaced,
 *   whose planned values are identical between the two plans except `FSS_DATABASE_HOST`,
 *   which is the plan's host in one and the reference's in the other, in every container
 *   that carries it (and at least one does);
 * - the two services (`api`, `worker`), each updated in place, with nothing changing but
 *   `task_definition`, which is the replaced definition's ARN, unknown until the apply,
 *   and planned identically in both;
 * - for `retire` only, the database instance, updated in place, changing only the
 *   attributes in `RETIREMENT_DATABASE_ATTRIBUTES`, and planned identically in both.
 *
 * Anything else, a replacement of the instance above all, is a refusal naming it.
 */

const CLUSTER = 'module.stack.module.cluster.';
export const RESTORE_TASK_DEFINITIONS: readonly string[] = ['api', 'worker', 'migration', 'operations'].map(
  name => `${CLUSTER}aws_ecs_task_definition.${name}`,
);
export const RESTORE_SERVICES: readonly string[] = ['api', 'worker'].map(name => `${CLUSTER}aws_ecs_service.${name}`);
export const RESTORE_DATABASE = 'module.stack.module.database.aws_db_instance.main';

/**
 * What the retirement plan may change on the imported instance, and why each can differ:
 * the first four are Terraform's own settings, which no import can read back, and a
 * point-in-time restore copies no tags. Everything else the restore is told in (b)
 * (storage type, CA, storage ceiling, windows, retention, the managed secret), so any
 * other difference is a surprise and a refusal.
 */
export const RETIREMENT_DATABASE_ATTRIBUTES: readonly string[] = [
  'apply_immediately',
  'delete_automated_backups',
  'final_snapshot_identifier',
  'skip_final_snapshot',
  'tags',
  'tags_all',
];

export type RestorePlanKind = 'repoint' | 'retire';

export interface RestorePlanInput {
  readonly kind: RestorePlanKind;
  readonly plan: unknown;
  readonly reference: unknown;
  /** `FSS_DATABASE_HOST` in the plan to apply. */
  readonly planHost: string;
  /** `FSS_DATABASE_HOST` in the reference plan. */
  readonly referenceHost: string;
}

export type RestorePlanVerdict =
  | { readonly ok: true; readonly kind: RestorePlanKind; readonly changes: Readonly<Record<string, readonly string[]>> }
  | { readonly ok: false; readonly kind: RestorePlanKind; readonly problems: readonly string[] };

interface Change {
  readonly address: string;
  readonly actions: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
  readonly afterUnknown: unknown;
}

const HOST_PLACEHOLDER = '<FSS_DATABASE_HOST>';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!deepEqual(left[key] ?? null, right[key] ?? null)) return false;
    }
    return true;
  }
  return false;
}

function hasUnknown(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(hasUnknown);
  if (isRecord(value)) return Object.values(value).some(hasUnknown);
  return false;
}

/** The managed resources a plan changes, by address, or the reason the plan is unreadable. */
function readChanges(plan: unknown, label: string, problems: string[]): Map<string, Change> | null {
  if (!isRecord(plan) || !Array.isArray(plan['resource_changes'])) {
    problems.push(`the ${label} plan is not a terraform show -json plan with resource_changes`);
    return null;
  }
  if (plan['errored'] === true) {
    problems.push(`the ${label} plan errored`);
    return null;
  }
  const changes = new Map<string, Change>();
  for (const entry of plan['resource_changes']) {
    if (!isRecord(entry) || typeof entry['address'] !== 'string' || !isRecord(entry['change'])) {
      problems.push(`the ${label} plan has a resource change without an address or a change`);
      continue;
    }
    if (entry['mode'] === 'data') continue;
    const change = entry['change'];
    const actions = Array.isArray(change['actions']) ? change['actions'].filter((a): a is string => typeof a === 'string') : [];
    if (actions.length === 1 && actions[0] === 'no-op') continue;
    changes.set(entry['address'], {
      address: entry['address'],
      actions,
      before: change['before'],
      after: change['after'],
      afterUnknown: change['after_unknown'],
    });
  }
  return changes;
}

/** The attributes an in-place update changes: known and different, or unknown until the apply. */
function changedAttributes(change: Change): readonly string[] {
  const before = isRecord(change.before) ? change.before : {};
  const after = isRecord(change.after) ? change.after : {};
  const unknown = isRecord(change.afterUnknown) ? change.afterUnknown : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(unknown)]);
  return [...keys].filter(key => hasUnknown(unknown[key]) || !deepEqual(before[key] ?? null, after[key] ?? null)).sort();
}

const isReplace = (actions: readonly string[]): boolean =>
  actions.length === 2 && actions.includes('create') && actions.includes('delete');
const isUpdate = (actions: readonly string[]): boolean => actions.length === 1 && actions[0] === 'update';

/** A task definition's planned value with `FSS_DATABASE_HOST` checked and blanked out. */
function withoutHost(change: Change, host: string, label: string, problems: string[]): unknown {
  const after = change.after;
  if (!isRecord(after) || typeof after['container_definitions'] !== 'string') {
    problems.push(`${change.address} (${label}): container_definitions is not known at plan time`);
    return null;
  }
  let containers: unknown;
  try {
    containers = JSON.parse(after['container_definitions']);
  } catch {
    problems.push(`${change.address} (${label}): container_definitions is not JSON`);
    return null;
  }
  if (!Array.isArray(containers)) {
    problems.push(`${change.address} (${label}): container_definitions is not a list`);
    return null;
  }
  let carriers = 0;
  const blanked = containers.map(container => {
    if (!isRecord(container) || !Array.isArray(container['environment'])) return container;
    return {
      ...container,
      environment: container['environment'].map(entry => {
        if (!isRecord(entry) || entry['name'] !== 'FSS_DATABASE_HOST') return entry;
        carriers += 1;
        if (entry['value'] !== host) {
          problems.push(
            `${change.address} (${label}): container ${String(container['name'])} has FSS_DATABASE_HOST ${JSON.stringify(entry['value'])}, not ${host}`,
          );
        }
        return { ...entry, value: HOST_PLACEHOLDER };
      }),
    };
  });
  if (carriers === 0) problems.push(`${change.address} (${label}): no container carries FSS_DATABASE_HOST`);
  return { ...after, container_definitions: blanked };
}

function checkOne(kind: RestorePlanKind, changes: Map<string, Change>, label: string, problems: string[]): Record<string, readonly string[]> {
  const described: Record<string, readonly string[]> = {};
  for (const address of RESTORE_TASK_DEFINITIONS) {
    const change = changes.get(address);
    if (change === undefined || !isReplace(change.actions)) {
      problems.push(`${address} (${label}): must be replaced, and the plan says ${change === undefined ? 'no change' : change.actions.join('+')}`);
    }
  }
  for (const address of RESTORE_SERVICES) {
    const change = changes.get(address);
    if (change === undefined || !isUpdate(change.actions)) {
      problems.push(`${address} (${label}): must be updated in place, and the plan says ${change === undefined ? 'no change' : change.actions.join('+')}`);
      continue;
    }
    const changed = changedAttributes(change);
    const unknown = isRecord(change.afterUnknown) ? change.afterUnknown['task_definition'] : undefined;
    if (changed.length !== 1 || changed[0] !== 'task_definition' || unknown !== true) {
      problems.push(`${address} (${label}): only task_definition may change, to the replaced definition; the plan changes ${changed.join(', ') || 'nothing'}`);
    }
    described[address] = changed;
  }
  const database = changes.get(RESTORE_DATABASE);
  if (database !== undefined) {
    if (kind !== 'retire') {
      problems.push(`${RESTORE_DATABASE} (${label}): the repoint changes nothing on the instance, and the plan says ${database.actions.join('+')}`);
    } else if (!isUpdate(database.actions)) {
      problems.push(`${RESTORE_DATABASE} (${label}): may only be updated in place, and the plan says ${database.actions.join('+')}`);
    } else {
      const changed = changedAttributes(database);
      const foreign = changed.filter(attribute => !RETIREMENT_DATABASE_ATTRIBUTES.includes(attribute));
      if (foreign.length > 0) {
        problems.push(`${RESTORE_DATABASE} (${label}): changes ${foreign.join(', ')}, which the retirement never changes (allowed: ${RETIREMENT_DATABASE_ATTRIBUTES.join(', ')})`);
      }
      described[RESTORE_DATABASE] = changed;
    }
  }
  const expected = new Set([...RESTORE_TASK_DEFINITIONS, ...RESTORE_SERVICES, RESTORE_DATABASE]);
  for (const change of changes.values()) {
    if (!expected.has(change.address)) problems.push(`${change.address} (${label}): ${change.actions.join('+')} is not part of a restore`);
  }
  return described;
}

export function checkRestorePlan(input: RestorePlanInput): RestorePlanVerdict {
  const problems: string[] = [];
  if (input.planHost === input.referenceHost) {
    problems.push('the plan and the reference name the same host, so the comparison would prove nothing');
  }
  const plan = readChanges(input.plan, 'plan', problems);
  const reference = readChanges(input.reference, 'reference', problems);
  if (plan === null || reference === null) return { ok: false, kind: input.kind, problems };

  const changes = checkOne(input.kind, plan, 'plan', problems);
  checkOne(input.kind, reference, 'reference', problems);

  for (const address of RESTORE_TASK_DEFINITIONS) {
    const mine = plan.get(address);
    const theirs = reference.get(address);
    if (mine === undefined || theirs === undefined) continue;
    const left = withoutHost(mine, input.planHost, 'plan', problems);
    const right = withoutHost(theirs, input.referenceHost, 'reference', problems);
    if (left === null || right === null) continue;
    if (!deepEqual(left, right) || !deepEqual(mine.afterUnknown ?? null, theirs.afterUnknown ?? null)) {
      const l = isRecord(left) ? left : {};
      const r = isRecord(right) ? right : {};
      const differing = [...new Set([...Object.keys(l), ...Object.keys(r)])].filter(key => !deepEqual(l[key] ?? null, r[key] ?? null));
      problems.push(
        `${address}: differs from the reference in more than FSS_DATABASE_HOST (${differing.join(', ') || 'the values unknown until the apply'})`,
      );
    }
    changes[address] = ['FSS_DATABASE_HOST'];
  }
  // The services too are planned identically in both (lane W3-S8 third review): the only
  // input between the two plans is the host, and it reaches no service.
  for (const address of RESTORE_SERVICES) {
    const mine = plan.get(address);
    const theirs = reference.get(address);
    if (mine === undefined || theirs === undefined) continue;
    if (
      !deepEqual(mine.before ?? null, theirs.before ?? null) ||
      !deepEqual(mine.after ?? null, theirs.after ?? null) ||
      !deepEqual(mine.afterUnknown ?? null, theirs.afterUnknown ?? null)
    ) {
      problems.push(`${address}: planned differently in the plan and the reference, though only the task definitions' host differs between them`);
    }
  }
  const mine = plan.get(RESTORE_DATABASE);
  const theirs = reference.get(RESTORE_DATABASE);
  if (input.kind === 'retire' && (mine !== undefined || theirs !== undefined)) {
    if (mine === undefined || theirs === undefined || !deepEqual(mine.after, theirs.after) || !deepEqual(mine.afterUnknown ?? null, theirs.afterUnknown ?? null)) {
      problems.push(`${RESTORE_DATABASE}: the plan and the reference plan the instance differently, though only the task definitions' host differs between them`);
    }
  }
  return problems.length > 0 ? { ok: false, kind: input.kind, problems } : { ok: true, kind: input.kind, changes };
}

const USAGE =
  'usage: restorePlan.ts <repoint|retire> --plan <plan json> --reference <plan json> --plan-host <host> --reference-host <host>';

export function main(argv: readonly string[], read: (path: string) => string = path => readFileSync(path, 'utf8')): number {
  const [kind, ...rest] = argv;
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || value === undefined || !['--plan', '--reference', '--plan-host', '--reference-host'].includes(flag)) {
      console.error(USAGE);
      return 64;
    }
    options[flag] = value;
  }
  const { '--plan': planPath, '--reference': referencePath, '--plan-host': planHost, '--reference-host': referenceHost } = options;
  if ((kind !== 'repoint' && kind !== 'retire') || !planPath || !referencePath || !planHost || !referenceHost) {
    console.error(USAGE);
    return 64;
  }
  let plan: unknown;
  let reference: unknown;
  try {
    plan = JSON.parse(read(planPath));
    reference = JSON.parse(read(referencePath));
  } catch {
    console.error(`NO-GO: a plan could not be read as JSON (${planPath}, ${referencePath})`);
    return 1;
  }
  const verdict = checkRestorePlan({ kind, plan, reference, planHost, referenceHost });
  if (!verdict.ok) {
    for (const problem of verdict.problems) console.error(`NO-GO: ${problem}`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
