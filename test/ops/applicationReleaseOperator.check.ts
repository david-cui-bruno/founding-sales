import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryPath } from './support/repository.ts';

type Run = (program: string, args: string[], options?: { env?: Record<string, string> }) => string;
type Command = 'preflight' | 'observe-off' | 'verify-off' | 'verify-application';
// Untyped .mjs operator loaded by repository path, as the other ops checks load infra scripts.
const operator = await import(repositoryPath('infra/scripts/application-release-operator.mjs')) as {
  parseArguments(argv: string[]): { command: Command; directory: string };
  validateBindings(value: unknown, application?: boolean): unknown;
  baselineFromPreflight(preflight: unknown): unknown;
  readerOwner(bindings: { prNumber: number; candidate: string }): string;
  createOperator(options: { directory: string; run: Run; fetchJson: (url: string) => Promise<unknown>; now?: () => number }): Record<Command, () => Promise<string>>;
};

const P = 'arn:aws:ecs:us-east-1:326255650484:', CLUSTER = `${P}cluster/fss-prod-cluster`;
const def = (family: string, revision: number) => `${P}task-definition/fss-prod-${family}:${revision}`;
const task = (n: number) => `${P}task/fss-prod-cluster/${String(n).padStart(32, 'a')}`;
const image = (kind: string, digest: string) => `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-${kind}@${digest}`;
const PRODUCTION = 'b'.repeat(40), CANDIDATE = 'c'.repeat(40), HEAD = 'd'.repeat(40);
const API = `sha256:${'1'.repeat(64)}`, WORKER = `sha256:${'2'.repeat(64)}`;
const source = { candidate: CANDIDATE, gateId: 41243290797, imagesId: 41243290872, prHead: HEAD, prNumber: 871, upgradeJobId: 124661428799 };
const bindings = (overrides: Record<string, unknown> = {}) => ({ runId: null, jobId: null, ...source, ...overrides });
const preflightFixture = () => ({
  at: '2026-10-31T21:48:12.586Z', production: PRODUCTION, schema: 153, targetSchema: 153, migration: null as null | Record<string, unknown>, bindings: { ...source },
  normal: { operations: def('operations', 482), migration: def('migration', 197) }, normalDigests: { operations: WORKER, migration: WORKER }, nonterminalOneoffs: 0,
  services: [{ name: 'fss-prod-api', definition: def('api', 185), count: 2 }, { name: 'fss-prod-worker', definition: def('worker', 186), count: 1 }],
  runtime: [{ arn: task(1), definition: def('worker', 186), digest: WORKER }, { arn: task(2), definition: def('api', 185), digest: API }, { arn: task(3), definition: def('api', 185), digest: API }],
  sharedHolds: { '/actions/variables': 'missing/default-held', '/environments/production-release-review/variables': 'missing/default-held' },
  protectedEnvironment: { requiredReviewer: true, mainOnly: true, administratorBypass: false },
  recovery: { databaseArn: 'arn:aws:rds:us-east-1:326255650484:db:fss-prod-pg', resourceId: 'db-test', retentionDays: 35, restoreWindow: { EarliestTime: '2026-09-26T21:43:18+00:00', LatestTime: '2026-10-31T21:43:18+00:00' }, restoreTested: false },
  historical40522197864: 'UNKNOWN', cloudWrites: 0,
});
const expectedBaseline = {
  production: PRODUCTION, schema: 153, targetSchema: 153, schemaMigration: null, at: '2026-10-31T21:48:12.586Z',
  api: { definition: def('api', 185), revision: 185, count: 2, digest: API }, worker: { definition: def('worker', 186), revision: 186, count: 1, digest: WORKER },
  operations: { definition: def('operations', 482), revision: 482, digest: WORKER }, migration: { definition: def('migration', 197), revision: 197, digest: WORKER },
};
const native = (overrides: Record<string, unknown> = {}) => ({
  applicationRunId: 41245379477, applicationJobId: 124667631715, renderedSummaryUrl: 'https://github.com/david-cui-bruno/founding-sales/actions/runs/41245379477',
  nativeFinalStatus: {
    phase: 'completed', outcome: 'completed', writesStarted: true, migrationStarted: false, fromSchema: 153, targetSchema: 153, observedSchema: 153, reason: null, rollback: null, readerRecovery: null, offObservation: null,
    currentTaskArn: null, currentTaskOwner: 'fss-app-41245379477-3', lastStoppedTaskArn: task(9), lastTaskExitCode: 0, temporaryReaderDefinition: null,
    previousDefinitions: { api: def('api', 185), worker: def('worker', 186), migration: def('migration', 197), operations: def('operations', 482) },
    candidateDefinitions: { api: def('api', 186), worker: def('worker', 187), migration: def('migration', 198), operations: def('operations', 490) },
    off: { releaseOff: true, storedOff: true, effectiveOff: true, finishing: 0, schema: 153, versions: [4], observedAt: '2026-10-31T22:03:29.828Z' }, ...overrides,
  },
});

// One contiguous migration: actual CI disposable-PostgreSQL evidence shape (see tools/upgrade) for 153 → 154.
const MIGRATION = '0154_manual_phone_choice_standalone.sql', REVIEW = { reviewer: 'MigrationSpecialist', report: 'agent://MigrationSpecialist#0154', classification: 'touches-existing' };
const evidence = (cls: string, from = 153) => [`upgrade test: schema ${from} → ${from + 1}`, '  base         /home/runner/work/_temp/upgrade-base', `  migrations   1..${from} from the base checkout, ${from + 1}..${from + 1} from head`, `  deployed     ${from} file(s) byte-identical in both checkouts`, '', 'migrations this upgrade applies', `  ${MIGRATION}  ${cls}  constraint swap on sourcing_manual_prospect_states`, '', '  cluster      service-container on 127.0.0.1', `  database     fss_upgrade_${'0'.repeat(32)}`, '', 'step  1  fresh database, fss_migrator owns it                    0.01s', `step  2  migrations 1..${from} from the base checkout, as fss_migrator    1.12s  ${from} applied; runtime user created`, `step  5  migrations ${from + 1}..${from + 1} from head, as fss_migrator          0.01s  1 applied`, '', `PASS  schema ${from} → ${from + 1}`, ''].join('\n');
const upgradeFiles = (cls = 'additive', text = evidence(cls)) => ({ 'main-upgrade/upgrade-binding.json': { from: PRODUCTION, to: CANDIDATE }, [`main-upgrade/upgrade-evidence-${CANDIDATE}.txt`]: text });

// Stub production: reads plus only the reviewed reader register/run/retire; anything else fails the check.
const OBSERVED_AT = '2026-10-31T21:50:00.000Z', READER = def('operations', 491), READER_TASK = task(7);
function cloud(fault = '', onWrite: (action: string) => void = () => {}, artifactEvidence = evidence('additive')) {
  const target = fault === 'migration-n2' ? 155 : fault.startsWith('migration') ? 154 : 153;
  const migrations = (ref: string) => [...Array.from({ length: 153 }, (_, i) => ({ type: 'file', name: `${String(i + 1).padStart(4, '0')}_m.sql`, sha: ref !== PRODUCTION && fault === 'migration-blob' && i === 9 ? 'e'.repeat(40) : String(i + 1).padStart(40, '0') })), ...(ref === PRODUCTION ? [] : [{ type: 'file', name: MIGRATION, sha: 'f'.repeat(40) }])];
  const calls: string[][] = [], attempts: Record<string, string | undefined>[] = [];
  const reader: { document?: { tags?: unknown }; status: string; owner?: string } = { status: 'ACTIVE' };
  const operations = { taskDefinitionArn: def('operations', 482), family: 'fss-prod-operations', status: 'ACTIVE', containerDefinitions: [{ name: 'operations', image: image('worker', WORKER), entryPoint: ['node', 'apps/worker/src/tools/fss.ts'], command: ['verify'], logConfiguration: { options: { 'awslogs-group': '/fss/prod', 'awslogs-stream-prefix': 'fss' } } }] };
  const container = (name: string, digest: string) => [{ name, image: image(name, digest), imageDigest: digest }];
  const running = [
    { taskArn: task(1), clusterArn: CLUSTER, group: 'service:fss-prod-worker', lastStatus: 'RUNNING', desiredStatus: 'RUNNING', taskDefinitionArn: def('worker', 186), containers: container('worker', WORKER) },
    ...[2, 3].map(n => ({ taskArn: task(n), clusterArn: CLUSTER, group: 'service:fss-prod-api', lastStatus: 'RUNNING', desiredStatus: 'RUNNING', taskDefinitionArn: def('api', 185), containers: container('api', fault === 'mixed-digest' && n === 3 ? `sha256:${'3'.repeat(64)}` : API) })),
  ];
  const services = [['api', 185, 2], ['worker', 186, 1]].map(([name, revision, count]) => ({ serviceName: `fss-prod-${name}`, clusterArn: CLUSTER, taskDefinition: def(String(name), Number(revision)), runningCount: count, desiredCount: count, pendingCount: 0, deployments: [{ rolloutState: 'COMPLETED' }], networkConfiguration: { awsvpcConfiguration: { assignPublicIp: 'ENABLED', subnets: ['subnet-07ae1d846228e9e83', 'subnet-01f53573964548294'], securityGroups: ['sg-001321fbde693b058'] } } }));
  const run: Run = (program, args, options) => {
    calls.push([program, ...args]);
    if (['register-task-definition', 'run-task', 'deregister-task-definition'].includes(args[1]!)) { attempts.push({ action: args[1], attempts: options?.env?.['AWS_MAX_ATTEMPTS'] }); onWrite(args[1]!); }
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (program === 'aws') switch (`${args[0]} ${args[1]}`) {
      case 'sts get-caller-identity': return JSON.stringify({ Account: '326255650484', Arn: 'arn:aws:iam::326255650484:user/david' });
      case 'ecs describe-services': return JSON.stringify({ failures: [], services });
      case 'ecs list-tasks': return JSON.stringify({ taskArns: value('--desired-status') === 'RUNNING' ? running.map(t => t.taskArn) : [] });
      case 'ecs describe-tasks': return JSON.stringify({ failures: [], tasks: args.includes(READER_TASK) ? [{ taskArn: READER_TASK, clusterArn: CLUSTER, startedBy: reader.owner, lastStatus: 'STOPPED', taskDefinitionArn: READER, containers: [{ name: 'operations', exitCode: 0, imageDigest: WORKER }] }] : running.filter(t => args.includes(t.taskArn)) });
      case 'ecs describe-task-definition': {
        const name = value('--task-definition');
        if (name === READER) return JSON.stringify({ taskDefinition: { ...reader.document, taskDefinitionArn: READER, status: reader.status }, tags: reader.document?.tags });
        if (name === 'fss-prod-operations') return JSON.stringify({ taskDefinition: operations, tags: [{ key: 'NamePrefix', value: 'fss-prod' }] });
        return JSON.stringify({ taskDefinition: { taskDefinitionArn: def('migration', 197), status: 'ACTIVE', containerDefinitions: [{ name: 'migration', image: image('worker', WORKER) }] } });
      }
      case 'ecs register-task-definition': reader.document = JSON.parse(value('--cli-input-json')); return JSON.stringify({ taskDefinition: { taskDefinitionArn: READER } });
      case 'ecs run-task': reader.owner = value('--started-by'); return JSON.stringify({ failures: [], tasks: [{ taskArn: READER_TASK }] });
      case 'logs get-log-events': return JSON.stringify({ events: [{ message: JSON.stringify({ releaseOff: true, schema: 153, storedOff: true, effectiveOff: true, finishing: 0, versions: [4], observedAt: OBSERVED_AT }) }] });
      case 'ecs deregister-task-definition': reader.status = 'INACTIVE'; return JSON.stringify({ taskDefinition: { taskDefinitionArn: READER, status: 'INACTIVE' } });
      case 'rds describe-db-instances': return JSON.stringify({ DBInstances: [{ DBInstanceArn: 'arn:aws:rds:us-east-1:326255650484:db:fss-prod-pg', DbiResourceId: 'db-test', DBInstanceStatus: 'available', BackupRetentionPeriod: 35 }] });
      case 'rds describe-db-instance-automated-backups': return JSON.stringify({ DBInstanceAutomatedBackups: [{ RestoreWindow: { EarliestTime: '2026-09-26T21:43:18+00:00', LatestTime: '2026-10-31T21:43:18+00:00' } }] });
    }
    if (program === 'gh' && args.slice(0, 3).join(' ') === 'api --method GET') {
      const path = args[3]!.replace('repos/david-cui-bruno/founding-sales/', '');
      const files = [{ filename: 'packages/domain/sourcing/discoveryIdentity.ts', status: 'modified' }, ...(fault === 'schema' ? [{ filename: 'packages/domain/db/migrations/154_change.sql', status: 'added' }] : []), ...(target > 153 ? [{ filename: 'packages/domain/db/schemaRange.ts', status: 'modified' }, { filename: `packages/domain/db/migrations/${MIGRATION}`, status: 'added' }] : [])];
      if (path.startsWith(`compare/${PRODUCTION}...${CANDIDATE}`)) return JSON.stringify({ base_commit: { sha: PRODUCTION }, merge_base_commit: { sha: PRODUCTION }, status: 'ahead', behind_by: 0, total_commits: 1, ahead_by: 1, commits: [{ sha: CANDIDATE }], files });
      if (path.startsWith('contents/packages/domain/db/schemaRange.ts?ref=')) return JSON.stringify({ encoding: 'base64', content: Buffer.from(`export const REQUIRED_SCHEMA = ${path.endsWith(PRODUCTION) ? 153 : target};\n`).toString('base64') });
      if (path.startsWith('contents/packages/domain/db/migrations?ref=')) return JSON.stringify(migrations(path.split('=')[1]!));
      if (path === `actions/runs/${source.gateId}/artifacts?per_page=100`) return JSON.stringify({ total_count: 1, artifacts: [{ id: 77, name: `upgrade-evidence-${CANDIDATE}`, expired: false, workflow_run: { id: source.gateId, head_sha: CANDIDATE } }] });
      if (path === 'actions/artifacts/77/zip') return 'zip';
      if (path.endsWith('variables?per_page=100')) return JSON.stringify({ total_count: 0, variables: [] });
      if (path === 'environments/production-release-review') return JSON.stringify({ can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true }, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] });
      if (path === 'environments/production-release-review/deployment-branch-policies?per_page=100') return JSON.stringify({ total_count: 1, branch_policies: [{ name: 'main' }] });
    }
    if (program === 'python3') return JSON.stringify({ 'upgrade-binding.json': JSON.stringify({ from: PRODUCTION, to: CANDIDATE }), [`upgrade-evidence-${CANDIDATE}.txt`]: artifactEvidence });
    throw new Error(`unexpected ${program} ${args.join(' ')}`);
  };
  const fetchJson = async () => ({ status: 'serving', build: { commit: fault === 'candidate-live' ? CANDIDATE : fault === 'production-moved' ? 'e'.repeat(40) : PRODUCTION }, schema: { databaseVersion: 153, accepted: true } });
  return { run, fetchJson, calls, attempts };
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function runDirectory(files: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'fss-release-operator-'));
  directories.push(directory); mkdirSync(join(directory, 'main-images')); mkdirSync(join(directory, 'main-upgrade'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  return directory;
}
async function refused(directory: string, command: Command, reason: string, fault = '', artifactEvidence?: string) {
  const stub = cloud(fault, undefined, artifactEvidence);
  await expect(operator.createOperator({ directory, run: stub.run, fetchJson: stub.fetchJson })[command]()).rejects.toThrow(reason);
  return stub.calls;
}

describe('application release operator arguments and bindings', () => {
  it('accepts one subcommand with an absolute private run directory outside the repository', () => {
    const directory = runDirectory({});
    expect(operator.parseArguments(['observe-off', '--dir', directory])).toEqual({ command: 'observe-off', directory: realpathSync(directory) });
    for (const argv of [[], ['deploy', '--dir', directory], ['preflight', directory], ['preflight', '--dir', 'relative/run'], ['preflight', '--dir', directory, 'extra']]) expect(() => operator.parseArguments(argv)).toThrow('operator_arguments_invalid');
    const lookalike = mkdtempSync(repositoryPath('..release-')), link = join(directory, 'inside');
    directories.push(lookalike); symlinkSync(repositoryPath('infra'), link);
    writeFileSync(join(directory, 'file.json'), '{}');
    for (const path of [join(directory, 'absent'), repositoryPath('infra'), repositoryPath(''), join(directory, 'file.json'), lookalike, link]) expect(() => operator.parseArguments(['preflight', '--dir', path]), path).toThrow('run_directory_invalid');
  });

  it('requires exactly the eight binding keys with bound source/CI and, for application acceptance, bound run/job', () => {
    expect(operator.validateBindings(bindings())).toEqual(bindings());
    expect(operator.validateBindings(bindings({ runId: 41245379477, jobId: 124667631715 }), true)).toMatchObject({ runId: 41245379477 });
    for (const [value, reason] of [
      [{ ...bindings(), extra: 1 }, 'release_bindings_shape_invalid'], [(({ jobId: _, ...rest }) => rest)(bindings()), 'release_bindings_shape_invalid'], [null, 'release_bindings_shape_invalid'],
      [bindings({ prNumber: null }), 'release_source_ci_unbound'], [bindings({ upgradeJobId: 0 }), 'release_source_ci_unbound'], [bindings({ gateId: '41243290797' }), 'release_source_ci_unbound'],
      [bindings({ candidate: null }), 'release_source_commit_unbound'], [bindings({ prHead: 'C'.repeat(40) }), 'release_source_commit_unbound'],
      [bindings({ imagesId: source.gateId }), 'release_ci_identity_alias'], [bindings({ runId: -1 }), 'release_application_unbound'],
    ] as const) expect(() => operator.validateBindings(value), reason).toThrow(reason);
    expect(() => operator.validateBindings(bindings(), true)).toThrow('release_application_unbound');
    expect(() => operator.validateBindings(bindings({ runId: source.gateId, jobId: 1 }), true)).toThrow('candidate_invalid');
    expect(operator.validateBindings(bindings({ migrationReview: REVIEW }))).toMatchObject({ migrationReview: REVIEW });
    for (const review of [null, 'reviewed', { ...REVIEW, classification: 'additive' }, { ...REVIEW, classification: 'privilege' }, { ...REVIEW, report: ' ' }, { ...REVIEW, extra: 'x' }]) expect(() => operator.validateBindings(bindings({ migrationReview: review })), JSON.stringify(review)).toThrow('migration_review_invalid');
  });
});

describe('baseline derived from the saved live preflight', () => {
  it('derives commit, schema, definitions, revisions, counts and digests from the fixture observation', () => {
    expect(operator.baselineFromPreflight(preflightFixture())).toEqual(expectedBaseline);
    expect(operator.readerOwner(source)).toBe('fss-root-pr871-cccccccccccc');
  });

  it('refuses incomplete, ambiguous or written preflight observations', () => {
    const cases: [(p: ReturnType<typeof preflightFixture>) => unknown, string][] = [
      [p => { p.cloudWrites = 1; }, 'baseline_preflight_invalid'], [p => { p.production = 'HEAD'; }, 'baseline_preflight_invalid'], [p => { p.nonterminalOneoffs = 1; }, 'baseline_preflight_invalid'],
      [p => { delete (p as Partial<typeof p>).bindings; }, 'baseline_preflight_unbound'],
      [p => { p.services[0]!.count = 3; }, 'baseline_digest_invalid'], [p => { p.runtime[2]!.digest = WORKER; }, 'baseline_digest_invalid'],
      [p => { p.services.push({ ...p.services[0]! }); }, 'baseline_service_invalid'], [p => { p.services[1]!.definition = def('api', 186); }, 'baseline_service_invalid'],
      [p => { p.runtime.push({ arn: task(4), definition: def('operations', 482), digest: WORKER }); }, 'baseline_runtime_invalid'],
      [p => { p.normalDigests.migration = 'latest'; }, 'baseline_normal_invalid'], [p => { p.normal.operations = def('migration', 197); }, 'baseline_normal_invalid'],
    ];
    for (const [change, reason] of cases) { const p = preflightFixture(); change(p); expect(() => operator.baselineFromPreflight(p), reason).toThrow(reason); }
  });

  it('binds one authorized migration and refuses unauthorized saved classifications', () => {
    const migration = (m: Record<string, unknown> | null, target = 154) => ({ ...preflightFixture(), targetSchema: target, migration: m });
    const additive = { file: MIGRATION, sha: 'f'.repeat(40), class: 'additive', review: null };
    expect(operator.baselineFromPreflight(migration(additive))).toMatchObject({ schema: 153, targetSchema: 154, schemaMigration: additive, migration: expectedBaseline.migration });
    expect(operator.baselineFromPreflight(migration({ ...additive, class: 'touches-existing', review: REVIEW }))).toMatchObject({ schemaMigration: { review: REVIEW } });
    for (const [p, reason] of [[migration(null), 'baseline_preflight_target_invalid'], [migration(additive, 155), 'baseline_preflight_target_invalid'], [{ ...migration(null), targetSchema: 153, migration: additive }, 'baseline_preflight_target_invalid'], [migration({ ...additive, class: 'touches-existing' }), 'migration_review_required'], [migration({ ...additive, class: 'destructive' }), 'migration_classification_refused'], [migration({ ...additive, review: REVIEW }), 'migration_review_mismatch']] as const) expect(() => operator.baselineFromPreflight(p), reason).toThrow(reason);
  });
});

describe('preflight', () => {
  it('saves one exclusive read-only observation whose derived baseline matches live production', async () => {
    const directory = runDirectory({ 'release-bindings.json': bindings() }), stub = cloud();
    const run = operator.createOperator({ directory, run: stub.run, fetchJson: stub.fetchJson, now: () => Date.parse('2026-10-31T21:48:12.586Z') });
    await expect(run.preflight()).resolves.toContain(`${PRODUCTION}/schema153`);
    const output = join(directory, 'release-preflight.json'), saved = JSON.parse(readFileSync(output, 'utf8'));
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(operator.baselineFromPreflight(saved)).toEqual(expectedBaseline);
    expect(saved).toMatchObject({ bindings: source, sharedHolds: preflightFixture().sharedHolds, recovery: { resourceId: 'db-test', restoreTested: false }, cloudWrites: 0 });
    expect(stub.calls.filter(c => c[0] === 'aws').map(c => `${c[1]} ${c[2]}`).every(c => /^(sts get-caller-identity|ecs (describe-services|list-tasks|describe-tasks|describe-task-definition)|rds describe-db-instance(s|-automated-backups))$/u.test(c))).toBe(true);
    const count = stub.calls.length;
    await expect(run.preflight()).rejects.toThrow('observation_already_saved');
    expect(stub.calls).toHaveLength(count);
  });

  it('refuses unbound bindings, a schema-changing source, a candidate already live and a mixed runtime before saving', async () => {
    expect(await refused(runDirectory({ 'release-bindings.json': bindings({ prNumber: null }) }), 'preflight', 'release_source_ci_unbound')).toEqual([]);
    for (const [fault, reason] of [['schema', 'same_schema_source_changed'], ['candidate-live', 'candidate_already_production'], ['mixed-digest', 'runtime_digest_changed']]) {
      const directory = runDirectory({ 'release-bindings.json': bindings() });
      await refused(directory, 'preflight', reason!, fault);
      expect(existsSync(join(directory, 'release-preflight.json'))).toBe(false);
    }
  });
});

describe('preflight for exactly one contiguous migration', () => {
  async function migrate(files: Record<string, unknown>, fault = 'migration', artifactEvidence?: string) {
    const directory = runDirectory({ 'release-bindings.json': bindings(), ...files }), stub = cloud(fault, undefined, artifactEvidence ?? (files[`main-upgrade/upgrade-evidence-${CANDIDATE}.txt`] as string | undefined));
    const result = operator.createOperator({ directory, run: stub.run, fetchJson: stub.fetchJson, now: () => Date.parse('2026-10-31T21:48:12.586Z') }).preflight();
    return { directory, stub, result };
  }
  const saved = (directory: string) => JSON.parse(readFileSync(join(directory, 'release-preflight.json'), 'utf8'));

  it('accepts N→N+1 additive from the bound disposable-PostgreSQL upgrade evidence and records the classifier result', async () => {
    const { directory, stub, result } = await migrate(upgradeFiles('additive'));
    await expect(result).resolves.toContain(`schema153→154 (${MIGRATION}, additive)`);
    expect(saved(directory)).toMatchObject({ schema: 153, targetSchema: 154, migration: { file: MIGRATION, sha: 'f'.repeat(40), class: 'additive', review: null } });
    expect(operator.baselineFromPreflight(saved(directory))).toMatchObject({ targetSchema: 154, schemaMigration: { class: 'additive' } });
    expect(stub.calls.some(c => c[0] === 'gh' && c[4] === 'repos/david-cui-bruno/founding-sales/actions/artifacts/77/zip')).toBe(true);
  });

  it('accepts touches-existing only with a matching explicit migration review', async () => {
    const refusedReview = await migrate(upgradeFiles('touches-existing'));
    await expect(refusedReview.result).rejects.toThrow('migration_review_required');
    expect(existsSync(join(refusedReview.directory, 'release-preflight.json'))).toBe(false);
    const reviewed = await migrate({ ...upgradeFiles('touches-existing'), 'release-bindings.json': bindings({ migrationReview: REVIEW }) });
    await expect(reviewed.result).resolves.toContain('touches-existing');
    expect(saved(reviewed.directory).migration).toEqual({ file: MIGRATION, sha: 'f'.repeat(40), class: 'touches-existing', review: REVIEW });
    for (const cls of ['additive', 'privilege', 'destructive']) {
      const mismatch = await migrate({ ...upgradeFiles(cls), 'release-bindings.json': bindings({ migrationReview: REVIEW }) });
      await expect(mismatch.result, cls).rejects.toThrow('migration_review_mismatch');
    }
  });

  it('refuses destructive, privilege, replaced-routine and unclassified migrations outright', async () => {
    for (const cls of ['destructive', 'privilege', 'replaces-routine', 'unclassified']) await expect((await migrate(upgradeFiles(cls))).result, cls).rejects.toThrow('migration_classification_refused');
  });

  it('refuses N→N+2, a changed deployed migration blob, a review on a same-schema source and missing or non-upgrade evidence', async () => {
    const cases: [Record<string, unknown>, string, string, string?][] = [
      [upgradeFiles(), 'migration-n2', 'multiple_migrations_refused'],
      [upgradeFiles(), 'migration-blob', 'migration_blob_changed'],
      [{ 'release-bindings.json': bindings({ migrationReview: REVIEW }) }, '', 'migration_review_unexpected'],
      [{}, 'migration', 'upgrade_evidence_missing', evidence('additive')],
      [upgradeFiles('additive', evidence('additive').replace(/^step {2}5 .*$/mu, 'step  5  skipped')), 'migration', 'upgrade_evidence_not_disposable_upgrade'],
      [upgradeFiles('additive', evidence('additive', 152)), 'migration', 'upgrade_evidence_not_passing'],
      [upgradeFiles(), 'migration', 'upgrade_evidence_changed', evidence('touches-existing')],
    ];
    for (const [files, fault, reason, artifact] of cases) {
      const { directory, result } = await migrate(files, fault, artifact);
      await expect(result, reason).rejects.toThrow(reason);
      expect(existsSync(join(directory, 'release-preflight.json'))).toBe(false);
    }
  });
});

describe('later steps bind to the saved preflight', () => {
  const prepared = (extra: Record<string, unknown> = {}, bound = bindings()) => runDirectory({ 'release-bindings.json': bound, 'release-preflight.json': preflightFixture(), ...extra });

  it('observe-off refuses replay, rebinding and a moved production commit before any write', async () => {
    expect(await refused(prepared({ 'preapproval-off-custody.json': {} }), 'observe-off', 'reader_already_attempted')).toEqual([]);
    expect(await refused(prepared({ 'preapproval-off-result.json': {} }), 'observe-off', 'reader_already_attempted')).toEqual([]);
    expect(await refused(prepared({}, bindings({ prHead: 'e'.repeat(40) })), 'observe-off', 'bindings_changed_since_preflight')).toEqual([]);
    expect(await refused(runDirectory({ 'release-bindings.json': bindings() }), 'observe-off', 'ENOENT')).toEqual([]);
    const directory = prepared(), calls = await refused(directory, 'observe-off', 'health_changed', 'production-moved');
    expect(calls.map(c => c.slice(0, 3).join(' '))).toEqual(['aws sts get-caller-identity']);
    expect(existsSync(join(directory, 'preapproval-off-custody.json'))).toBe(false);
  });

  it('observe-off saves custody before each single-attempt reader write and retires only its own reader', async () => {
    const directory = prepared(), custody = join(directory, 'preapproval-off-custody.json'), seen: string[][] = [];
    const stub = cloud('', action => seen.push([action, ...JSON.parse(readFileSync(custody, 'utf8')).attemptedWrites.map((w: { action: string }) => w.action)]));
    const run = operator.createOperator({ directory, run: stub.run, fetchJson: stub.fetchJson, now: () => Date.parse(OBSERVED_AT) });
    await expect(run['observe-off']()).resolves.toContain('normal operations482 unchanged');
    expect(seen).toEqual([['register-task-definition', 'register-task-definition'], ['run-task', 'register-task-definition', 'run-task'], ['deregister-task-definition', 'register-task-definition', 'run-task', 'deregister-task-definition']]);
    expect(stub.attempts.map(a => a['attempts'])).toEqual(['1', '1', '1']);
    expect(stub.calls.find(c => c[2] === 'deregister-task-definition')).toContain(READER);
    expect(JSON.parse(readFileSync(custody, 'utf8'))).toMatchObject({ outcome: 'complete', owner: 'fss-root-pr871-cccccccccccc', sourceOperationsDefinition: def('operations', 482), production: PRODUCTION, schema: 153, currentTaskArn: null, temporaryReaderDefinition: null, lastStoppedTaskArn: READER_TASK, lastTaskExitCode: 0 });
    expect(JSON.parse(readFileSync(join(directory, 'preapproval-off-result.json'), 'utf8')).read).toMatchObject({ releaseOff: true, versions: [4], schema: 153 });
    expect(statSync(custody).mode & 0o777).toBe(0o600);
    const count = stub.calls.length;
    await expect(run['observe-off']()).rejects.toThrow('reader_already_attempted');
    expect(stub.calls).toHaveLength(count);
  });

  it('verify-off refuses an existing snapshot', async () => {
    expect(await refused(prepared({ 'preapproval-off-independent.json': {} }), 'verify-off', 'snapshot_already_exists')).toEqual([]);
  });

  it('verify-application refuses unbound runs, replays, schema changes, mismatched commits and a different baseline', async () => {
    const application = bindings({ runId: 41245379477, jobId: 124667631715 });
    expect(await refused(prepared({ 'application-native-input.json': native() }), 'verify-application', 'release_application_unbound')).toEqual([]);
    expect(await refused(prepared({ 'application-acceptance.json': {} }, application), 'verify-application', 'report_already_exists')).toEqual([]);
    expect(await refused(prepared({ 'application-native-input.json': native({ targetSchema: 154 }) }, application), 'verify-application', 'native_schema_binding_changed')).toEqual([]);
    expect(await refused(prepared({ 'application-native-input.json': native({ migrationStarted: true }) }, application), 'verify-application', 'native_schema_binding_changed')).toEqual([]);
    const migrationPreflight = { ...preflightFixture(), targetSchema: 154, migration: { file: MIGRATION, sha: 'f'.repeat(40), class: 'touches-existing', review: REVIEW } };
    const migrated = (input: unknown, bound: Record<string, unknown> = { ...application, migrationReview: REVIEW }) => runDirectory({ 'release-bindings.json': bound, 'release-preflight.json': migrationPreflight, 'application-native-input.json': input });
    expect(await refused(migrated(native({ targetSchema: 154, observedSchema: 154, migrationStarted: true }), application), 'verify-application', 'bindings_changed_since_preflight')).toEqual([]);
    expect(await refused(migrated(native({ targetSchema: 154, observedSchema: 154 })), 'verify-application', 'native_schema_binding_changed')).toEqual([]);
    expect(await refused(migrated(native({ targetSchema: 155, observedSchema: 155, migrationStarted: true })), 'verify-application', 'native_schema_binding_changed')).toEqual([]);
    const live = native(); live.nativeFinalStatus.previousDefinitions.api = def('api', 184);
    expect(await refused(prepared({ 'application-native-input.json': live }, application), 'verify-application', 'native_definition_binding_changed')).toEqual([]);
    const sameCommit = { ...preflightFixture(), bindings: { ...source, candidate: PRODUCTION } };
    expect(await refused(runDirectory({ 'release-bindings.json': { ...application, candidate: PRODUCTION }, 'release-preflight.json': sameCommit }), 'verify-application', 'candidate_already_production')).toEqual([]);
  });
});
