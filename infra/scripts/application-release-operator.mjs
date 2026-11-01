// Root's reusable operator for one same-schema protected application release. It never
// dispatches, approves, migrates, stops tasks or replays; schema changes use the reviewed
// migration release path. Usage: node infra/scripts/application-release-operator.mjs
// <preflight|observe-off|verify-off|verify-application> --dir <absolute private run directory>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { ACCOUNT, REGION } from './release-backend-contract.mjs';
import { createReleaseSafety, normalizeTaskDefinition, readerTaskDocument } from './release-safety.mjs';

// Production identities not exported by repository config. Changing one is a reviewed source change.
const REPOSITORY = 'david-cui-bruno/founding-sales', ORIGIN = 'https://api.usecallie.com', ACTOR = `arn:aws:iam::${ACCOUNT}:user/david`;
const CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/fss-prod-cluster`, DEFINITION = `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/`, DATABASE = `arn:aws:rds:${REGION}:${ACCOUNT}:db:fss-prod-pg`;
const SUBNETS = ['subnet-01f53573964548294', 'subnet-07ae1d846228e9e83'], SECURITY_GROUPS = ['sg-001321fbde693b058'];
// Current stored owner OFF setting versions. A newer owner stop changes them and needs review, never an override.
const OFF_VERSIONS = [4];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_KEYS = ['candidate', 'gateId', 'imagesId', 'prHead', 'prNumber', 'upgradeJobId'], BINDING_KEYS = ['jobId', 'runId', ...SOURCE_KEYS].sort();
const FILES = { bindings: 'release-bindings.json', preflight: 'release-preflight.json', custody: 'preapproval-off-custody.json', result: 'preapproval-off-result.json', independent: 'preapproval-off-independent.json', native: 'application-native-input.json', images: 'main-images/image-digests.json', acceptance: 'application-acceptance.json' };
const OUTPUTS = { preflight: [['preflight'], 'observation_already_saved'], 'observe-off': [['custody', 'result'], 'reader_already_attempted'], 'verify-off': [['independent'], 'snapshot_already_exists'], 'verify-application': [['acceptance'], 'report_already_exists'] };
const READS = { sts: ['get-caller-identity'], ecs: ['describe-services', 'describe-task-definition', 'list-tasks', 'describe-tasks'], rds: ['describe-db-instances', 'describe-db-instance-automated-backups'] };
const OFF_READS = { sts: READS.sts, ecs: READS.ecs, logs: ['get-log-events'] }, OFF_WRITES = ['register-task-definition', 'run-task', 'deregister-task-definition'];
const UPGRADE_GUARDS = ['Does this branch change the schema or a migration?', 'Resolve what production runs, from production', 'What production runs, and what this branch would move it to', 'The grants baseline may not move in the same pull request as a migration'];
const UPGRADE_WORK = ['Install', 'No durability for the throwaway database', 'Upgrade test', 'Bind the upgrade evidence to observed source builds', 'Upload the evidence'];

const must = (value, reason) => { if (!value) throw new Error(reason); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const digestOf = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const instant = value => { must(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'timestamp_invalid'); return Date.parse(value); };
const tags = value => JSON.stringify((value ?? []).map(t => [t.key, t.value]).sort((a, b) => a[0].localeCompare(b[0])));
const image = (kind, digest) => `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/fss-prod-${kind}@${digest}`;
const taskArn = value => typeof value === 'string' && value.startsWith(`arn:aws:ecs:${REGION}:${ACCOUNT}:task/fss-prod-cluster/`) && /\/[a-f0-9]{32}$/u.test(value);
const revisionOf = (arn, family) => { const match = typeof arn === 'string' && arn.startsWith(DEFINITION) && new RegExp(`^fss-prod-${family}:([1-9][0-9]*)$`, 'u').exec(arn.slice(DEFINITION.length)); return match ? Number(match[1]) : 0; };
const environment = d => { const entries = d.containerDefinitions?.[0]?.environment ?? []; must(new Set(entries.map(e => e.name)).size === entries.length, 'duplicate_environment'); return Object.fromEntries(entries.map(e => [e.name, e.value])); };
// The root OFF reader's ECS owner is derived from the bound source, never a guessed future identity.
export const readerOwner = bindings => `fss-root-pr${bindings.prNumber}-${bindings.candidate.slice(0, 12)}`;

export function parseArguments(argv) {
  must(argv.length === 3 && Object.hasOwn(OUTPUTS, argv[0]) && argv[1] === '--dir' && isAbsolute(argv[2] ?? ''), 'operator_arguments_invalid');
  // Canonical paths: symlinks cannot place the run directory inside the repository.
  let directory = null; try { directory = realpathSync(argv[2]); } catch { /* refused below */ }
  const inside = directory && relative(realpathSync(ROOT), directory);
  must(directory && statSync(directory).isDirectory() && (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)), 'run_directory_invalid');
  return { command: argv[0], directory };
}

// All eight keys are always present. Application run/job identities stay null until dispatch.
export function validateBindings(value, application = false) {
  must(value && typeof value === 'object' && !Array.isArray(value) && equal(Object.keys(value).sort(), BINDING_KEYS), 'release_bindings_shape_invalid');
  for (const key of ['prNumber', 'gateId', 'imagesId', 'upgradeJobId']) must(positive(value[key]), 'release_source_ci_unbound');
  must(sha(value.candidate) && sha(value.prHead), 'release_source_commit_unbound');
  must(value.gateId !== value.imagesId, 'release_ci_identity_alias');
  for (const key of ['runId', 'jobId']) must(application ? positive(value[key]) : value[key] === null || positive(value[key]), 'release_application_unbound');
  if (application) must(new Set([value.runId, value.gateId, value.imagesId]).size === 3, 'candidate_invalid');
  return value;
}

// The current baseline is the saved live preflight observation, never a constant or a re-derivation.
export function baselineFromPreflight(p) {
  must(p && typeof p === 'object' && sha(p.production) && positive(p.schema) && p.cloudWrites === 0 && p.nonterminalOneoffs === 0 && Number.isFinite(Date.parse(p.at)) && Array.isArray(p.services) && Array.isArray(p.runtime), 'baseline_preflight_invalid');
  must(p.bindings && equal(Object.keys(p.bindings).sort(), SOURCE_KEYS), 'baseline_preflight_unbound');
  const baseline = { production: p.production, schema: p.schema, at: p.at };
  for (const name of ['api', 'worker']) {
    const matches = p.services.filter(s => s.name === `fss-prod-${name}`), service = matches[0];
    must(matches.length === 1 && revisionOf(service.definition, name) && positive(service.count), 'baseline_service_invalid');
    const live = p.runtime.filter(t => t.definition === service.definition);
    must(live.length === service.count && live.every(t => taskArn(t.arn) && digestOf(t.digest) && t.digest === live[0].digest), 'baseline_digest_invalid');
    baseline[name] = { definition: service.definition, revision: revisionOf(service.definition, name), count: service.count, digest: live[0].digest };
  }
  must(p.services.length === 2 && p.runtime.length === baseline.api.count + baseline.worker.count && new Set(p.runtime.map(t => t.arn)).size === p.runtime.length, 'baseline_runtime_invalid');
  for (const name of ['operations', 'migration']) {
    must(revisionOf(p.normal?.[name], name) && digestOf(p.normalDigests?.[name]), 'baseline_normal_invalid');
    baseline[name] = { definition: p.normal[name], revision: revisionOf(p.normal[name], name), digest: p.normalDigests[name] };
  }
  return baseline;
}

function execute(program, args, { env = {}, input, binary = false, timeout = 45000, maxBuffer = 8000000 } = {}) {
  return execFileSync(program, args, { ...(binary ? {} : { encoding: 'utf8' }), input, timeout, maxBuffer, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
}
async function fetchPublic(url) {
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20000), redirect: 'error' });
  must(response.ok, 'health_unavailable'); return response.json();
}
const parsed = (thunk, reason) => { try { return JSON.parse(thunk()); } catch (cause) { throw new Error(reason, { cause }); } };

// Allowed read verbs only. Writes exist solely for the observe-off reader: each verb at most
// once, custody saved first, one native AWS attempt, unknown outcomes surfaced and never retried.
function awsClient(run, reads, { retries = false, writes = [], beforeWrite } = {}) {
  return (service, action, args = [], write = false) => {
    must(write ? service === 'ecs' && writes.includes(action) : reads[service]?.includes(action), 'operation_not_permitted');
    const cli = ['--profile', 'default', '--region', REGION, '--output', 'json', '--no-paginate', '--no-cli-pager', '--cli-connect-timeout', '10'];
    if (!write) return parsed(() => run('aws', [service, action, ...args, ...cli, '--cli-read-timeout', '20'], { env: retries ? {} : { AWS_MAX_ATTEMPTS: '1' } }), 'read_failed_no_retry');
    beforeWrite(action);
    const response = parsed(() => run('aws', [service, action, ...args, ...cli], { env: { AWS_MAX_ATTEMPTS: '1' }, timeout: 60000 }), `write_outcome_unknown_no_retry:${action}`);
    if (action === 'deregister-task-definition') must(response.taskDefinition?.taskDefinitionArn === args[1] && response.taskDefinition.status === 'INACTIVE', 'retirement_response_unknown');
    return response;
  };
}
const ghClient = run => path => parsed(() => run('gh', ['api', '--method', 'GET', `repos/${REPOSITORY}/${path}`], { env: { GH_PAGER: 'cat' } }), 'read_failed_no_retry');
function actor(aws) { const value = aws('sts', 'get-caller-identity'); must(value.Account === ACCOUNT && value.Arn === ACTOR, 'actor_changed'); return value; }
function tasks(aws, arns) {
  must(Array.isArray(arns) && arns.length <= 100 && arns.every(taskArn) && new Set(arns).size === arns.length, 'task_inventory_unbounded');
  if (!arns.length) return [];
  const d = aws('ecs', 'describe-tasks', ['--cluster', CLUSTER, '--tasks', ...arns]);
  must(!d.failures?.length && d.tasks?.length === arns.length && new Set(d.tasks.map(t => t.taskArn)).size === arns.length && d.tasks.every(t => arns.includes(t.taskArn) && t.clusterArn === CLUSTER), 'task_inventory_incomplete');
  return d.tasks;
}
function inventory(aws, status) { const d = aws('ecs', 'list-tasks', ['--cluster', CLUSTER, '--desired-status', status, '--max-results', '100']); must(!d.nextToken, 'task_inventory_incomplete'); return tasks(aws, d.taskArns); }
// Shared admission holds stay held and the protected environment keeps reviewer/main-only/no bypass.
function releaseControls(gh) {
  const holds = {};
  for (const scope of ['actions/variables', 'environments/production-release-review/variables']) {
    const r = gh(`${scope}?per_page=100`); must(Array.isArray(r.variables) && r.variables.length === r.total_count && r.total_count <= 100, 'shared_hold_inventory_incomplete');
    const found = r.variables.filter(v => v.name === 'FSS_RELEASE_HOLD'); must(found.length <= 1 && found[0]?.value !== 'false', 'shared_hold_changed');
    holds['/' + scope] = found[0]?.value ?? 'missing/default-held';
  }
  const protection = gh('environments/production-release-review'), branches = gh('environments/production-release-review/deployment-branch-policies?per_page=100');
  must(protection.can_admins_bypass === false && protection.deployment_branch_policy?.custom_branch_policies === true && protection.protection_rules?.some(r => r.type === 'required_reviewers' && r.reviewers?.length > 0) && branches.total_count === 1 && branches.branch_policies?.length === 1 && branches.branch_policies[0].name === 'main', 'protected_environment_changed');
  return holds;
}
// Same-schema only: bounded production...candidate history touching no schema/migration path.
function sameSchemaSource(gh, base, candidate) {
  const c = gh(`compare/${base}...${candidate}?per_page=100&page=1`);
  must(c.base_commit?.sha === base && c.merge_base_commit?.sha === base && c.status === 'ahead' && c.behind_by === 0 && positive(c.total_commits) && c.total_commits <= 100 && c.ahead_by === c.total_commits && c.commits?.length === c.total_commits && c.commits.at(-1)?.sha === candidate, 'same_schema_comparison_incomplete');
  must(Array.isArray(c.files) && c.files.length > 0 && c.files.length < 300 && new Set(c.files.map(f => f.filename)).size === c.files.length, 'same_schema_file_inventory_incomplete');
  const schemaPath = p => p === '.gitattributes' || p.endsWith('/.gitattributes') || p === 'packages/domain/db/schemaRange.ts' || p === 'packages/domain/db/migrations' || p.startsWith('packages/domain/db/migrations/');
  must(c.files.every(f => typeof f.filename === 'string' && !schemaPath(f.filename) && (!Object.hasOwn(f, 'previous_filename') || (typeof f.previous_filename === 'string' && !schemaPath(f.previous_filename)))), 'schema_change_refused');
}

export function createOperator({ directory, run = execute, fetchJson = fetchPublic, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, repositoryRoot = ROOT }) {
  const path = name => resolve(directory, FILES[name]);
  const read = name => JSON.parse(readFileSync(path(name), 'utf8'));
  const write = (name, value) => writeFileSync(path(name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const absent = command => { const [names, reason] = OUTPUTS[command]; for (const name of names) must(!existsSync(path(name)), reason); };
  const gh = ghClient(run);
  const health = async route => fetchJson(ORIGIN + route);
  // Later steps bind to the saved preflight and its source identities instead of re-deriving.
  function bound(application) {
    const bindings = validateBindings(read('bindings'), application), preflight = read('preflight'), baseline = baselineFromPreflight(preflight);
    must(equal(preflight.bindings, Object.fromEntries(SOURCE_KEYS.map(k => [k, bindings[k]]))), 'bindings_changed_since_preflight');
    must(bindings.candidate !== baseline.production, 'candidate_already_production');
    return { bindings, preflight, baseline };
  }
  // Exact live services/tasks against a bound baseline (observe-off, verify-off).
  function runtimeBound(aws, baseline, reason) {
    const services = aws('ecs', 'describe-services', ['--cluster', CLUSTER, '--services', 'fss-prod-api', 'fss-prod-worker']);
    must(!services.failures?.length && services.services?.length === 2 && new Set(services.services.map(s => s.serviceName)).size === 2 && services.services.every(s => { const b = baseline[s.serviceName?.replace(/^fss-prod-/u, '')]; return ['fss-prod-api', 'fss-prod-worker'].includes(s.serviceName) && s.clusterArn === CLUSTER && s.taskDefinition === b.definition && s.runningCount === b.count && s.desiredCount === b.count && s.pendingCount === 0 && s.deployments?.length === 1 && s.deployments[0].rolloutState === 'COMPLETED'; }), 'services_not_stable');
    const running = inventory(aws, 'RUNNING');
    must(running.length === baseline.api.count + baseline.worker.count && running.every(t => { const name = t.group?.replace(/^service:fss-prod-/u, ''), b = baseline[name]; return ['api', 'worker'].includes(name) && t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING' && t.taskDefinitionArn === b.definition && t.containers?.length === 1 && t.containers[0].name === name && t.containers[0].imageDigest === b.digest; }) && ['api', 'worker'].every(name => running.filter(t => t.group === `service:fss-prod-${name}`).length === baseline[name].count), reason);
    must(inventory(aws, 'STOPPED').every(t => t.lastStatus === 'STOPPED' && t.desiredStatus === 'STOPPED'), 'stopping_task_in_flight');
    return { services, running };
  }

  async function preflight() {
    const bindings = validateBindings(read('bindings')); absent('preflight');
    const aws = awsClient(run, READS, { retries: true });
    actor(aws);
    const h = await health('/health');
    must(h?.status === 'serving' && sha(h.build?.commit) && positive(h.schema?.databaseVersion) && h.schema.accepted === true, 'baseline_changed');
    const production = h.build.commit, schema = h.schema.databaseVersion;
    must(bindings.candidate !== production, 'candidate_already_production');
    sameSchemaSource(gh, production, bindings.candidate);
    const services = aws('ecs', 'describe-services', ['--cluster', CLUSTER, '--services', 'fss-prod-api', 'fss-prod-worker']), observed = {};
    must(!services.failures?.length && services.services?.length === 2, 'services_unavailable');
    for (const s of services.services) { const name = s.serviceName?.replace(/^fss-prod-/u, ''); must(['api', 'worker'].includes(name) && !observed[name] && s.clusterArn === CLUSTER && revisionOf(s.taskDefinition, name) && positive(s.runningCount) && s.desiredCount === s.runningCount && s.pendingCount === 0 && s.deployments?.length === 1 && s.deployments[0].rolloutState === 'COMPLETED', 'runtime_not_stable'); observed[name] = s; }
    const running = inventory(aws, 'RUNNING');
    must(running.length === observed.api.runningCount + observed.worker.runningCount, 'nonterminal_oneoff');
    for (const name of ['api', 'worker']) {
      const group = running.filter(t => t.group === `service:fss-prod-${name}`);
      must(group.length === observed[name].runningCount && group.every(t => t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING' && t.taskDefinitionArn === observed[name].taskDefinition && t.containers?.length === 1 && t.containers[0].name === name && digestOf(t.containers[0].imageDigest) && t.containers[0].imageDigest === group[0].containers[0].imageDigest), 'runtime_digest_changed');
    }
    must(inventory(aws, 'STOPPED').every(t => t.lastStatus === 'STOPPED'), 'stopping_task');
    const normal = {}, normalDigests = {};
    for (const kind of ['operations', 'migration']) {
      const d = aws('ecs', 'describe-task-definition', ['--task-definition', 'fss-prod-' + kind]).taskDefinition, digest = d?.containerDefinitions?.[0]?.image?.split('@')[1];
      must(d?.status === 'ACTIVE' && revisionOf(d.taskDefinitionArn, kind) && d.containerDefinitions.length === 1 && digestOf(digest) && d.containerDefinitions[0].image === image('worker', digest), 'normal_definition_changed');
      normal[kind] = d.taskDefinitionArn; normalDigests[kind] = digest;
    }
    const sharedHolds = releaseControls(gh);
    const db = aws('rds', 'describe-db-instances', ['--db-instance-identifier', 'fss-prod-pg']).DBInstances;
    must(db?.length === 1 && db[0].DBInstanceArn === DATABASE && db[0].DBInstanceStatus === 'available' && db[0].BackupRetentionPeriod === 35, 'recovery_unavailable');
    const backup = aws('rds', 'describe-db-instance-automated-backups', ['--dbi-resource-id', db[0].DbiResourceId]);
    must(!backup.Marker && backup.DBInstanceAutomatedBackups?.length === 1, 'recovery_inventory_incomplete');
    const document = { at: new Date(now()).toISOString(), production, schema, bindings: Object.fromEntries(SOURCE_KEYS.map(k => [k, bindings[k]])), normal, normalDigests, nonterminalOneoffs: 0, services: services.services.map(s => ({ name: s.serviceName, definition: s.taskDefinition, count: s.runningCount })), runtime: running.map(t => ({ arn: t.taskArn, definition: t.taskDefinitionArn, digest: t.containers[0].imageDigest })), sharedHolds, protectedEnvironment: { requiredReviewer: true, mainOnly: true, administratorBypass: false }, recovery: { databaseArn: db[0].DBInstanceArn, resourceId: db[0].DbiResourceId, retentionDays: 35, restoreWindow: backup.DBInstanceAutomatedBackups[0].RestoreWindow, restoreTested: false }, historical40522197864: 'UNKNOWN', cloudWrites: 0 };
    baselineFromPreflight(document); write('preflight', document);
    return `Read-only baseline/runtime/protection/recovery preflight PASS for ${production}/schema${schema}; stored OFF requires a new root observation before approval.`;
  }

  async function observeOff() {
    const { bindings, baseline } = bound(false); absent('observe-off');
    const owner = readerOwner(bindings), expected = baseline.operations.definition;
    const state = { owner, sourceOperationsDefinition: expected, currentTaskArn: null, lastStoppedTaskArn: null, temporaryReaderDefinition: null, settingVersions: [...OFF_VERSIONS], schema: baseline.schema, production: baseline.production, observationOnly: true, attemptedWrites: [] };
    let saved = false;
    const save = () => { writeFileSync(path('custody'), JSON.stringify({ ...state, savedAt: new Date(now()).toISOString() }, null, 2) + '\n', { mode: 0o600, flag: saved ? 'w' : 'wx' }); saved = true; };
    const aws = awsClient(run, OFF_READS, { retries: true, writes: OFF_WRITES, beforeWrite(action) { must(saved && !state.attemptedWrites.some(w => w.action === action), 'write_already_attempted'); state.attemptedWrites.push({ action, at: new Date(now()).toISOString() }); save(); } });
    actor(aws);
    const h = await health('/health');
    must(h?.status === 'serving' && h.build?.commit === baseline.production && h.schema?.accepted === true && h.schema.databaseVersion === baseline.schema, 'health_changed');
    const source = aws('ecs', 'describe-task-definition', ['--task-definition', 'fss-prod-operations', '--include', 'TAGS']);
    must(source.taskDefinition?.taskDefinitionArn === expected && source.taskDefinition.status === 'ACTIVE' && source.taskDefinition.containerDefinitions?.length === 1 && source.taskDefinition.containerDefinitions[0].name === 'operations', 'base_changed');
    const { services, running } = runtimeBound(aws, baseline, 'runtime_bindings_changed');
    must(source.taskDefinition.containerDefinitions[0].image === running.find(t => t.group === 'service:fss-prod-worker').containers[0].image, 'operations_image_changed');
    const network = services.services.find(s => s.serviceName === 'fss-prod-worker').networkConfiguration?.awsvpcConfiguration;
    must(network?.assignPublicIp === 'ENABLED' && equal([...network.subnets ?? []].sort(), SUBNETS) && equal(network.securityGroups, SECURITY_GROUPS), 'network_changed');
    save();
    const waitFor = async (probe, reason, count) => { for (let i = 0; i < count; i++) { if (await probe()) return; await sleep(2000); } throw new Error(reason); };
    const safety = createReleaseSafety({ aws, waitFor, now, state, save, cluster: CLUSTER, network, owner });
    const offRead = await safety.off({ definition: source.taskDefinition, tags: source.tags ?? [] }, baseline.schema);
    must(state.currentTaskArn === null && state.temporaryReaderDefinition === null && state.lastTaskExitCode === 0, 'reader_cleanup_incomplete');
    const task = aws('ecs', 'describe-tasks', ['--cluster', CLUSTER, '--tasks', state.lastStoppedTaskArn]).tasks?.[0];
    must(task?.lastStatus === 'STOPPED' && task.startedBy === owner + '-off-1' && task.containers?.[0]?.exitCode === 0, 'terminal_changed');
    must(aws('ecs', 'describe-task-definition', ['--task-definition', task.taskDefinitionArn]).taskDefinition?.status === 'INACTIVE', 'reader_not_retired');
    must(aws('ecs', 'describe-task-definition', ['--task-definition', 'fss-prod-operations']).taskDefinition?.taskDefinitionArn === expected, 'normal_operations_changed');
    state.outcome = 'complete'; save(); write('result', { read: offRead, state, completedAt: new Date(now()).toISOString() });
    return `Root preapproval schema${baseline.schema} OFF read accepted; exact reader STOPPED0/INACTIVE, normal operations${baseline.operations.revision} unchanged.`;
  }

  async function verifyOff() {
    const { bindings, baseline } = bound(false); absent('verify-off');
    const c = read('custody'), result = read('result');
    must(c.outcome === 'complete' && c.currentTaskArn === null && c.temporaryReaderDefinition === null && c.lastTaskExitCode === 0 && c.owner === readerOwner(bindings) && c.sourceOperationsDefinition === baseline.operations.definition && c.schema === baseline.schema, 'custody_incomplete');
    must(equal({ ...c, savedAt: undefined }, { ...result.state, savedAt: undefined }) && equal(c.off, result.read), 'result_conflict');
    must(c.production === baseline.production, 'baseline_production_changed');
    const rootOff = result.read; must(rootOff?.releaseOff && rootOff.storedOff && rootOff.effectiveOff && rootOff.finishing === 0 && rootOff.schema === baseline.schema && equal(rootOff.versions, OFF_VERSIONS), 'off_changed');
    const aws = awsClient(run, { sts: READS.sts, ecs: READS.ecs }), who = actor(aws);
    const task = aws('ecs', 'describe-tasks', ['--cluster', CLUSTER, '--tasks', c.lastStoppedTaskArn]); must(!task.failures?.length && task.tasks?.length === 1, 'task_unavailable');
    const t = task.tasks[0];
    must(t.taskArn === c.lastStoppedTaskArn && t.clusterArn === CLUSTER && t.startedBy === c.owner + '-off-1' && t.lastStatus === 'STOPPED' && t.desiredStatus === 'STOPPED' && t.containers?.length === 1 && t.containers[0].name === 'operations' && t.containers[0].exitCode === 0, 'task_changed');
    must(equal(t.overrides?.containerOverrides, [{ name: 'operations', command: [] }]), 'override_changed');
    const source = aws('ecs', 'describe-task-definition', ['--task-definition', c.sourceOperationsDefinition, '--include', 'TAGS']), retired = aws('ecs', 'describe-task-definition', ['--task-definition', t.taskDefinitionArn, '--include', 'TAGS']);
    const want = readerTaskDocument({ definition: source.taskDefinition, tags: source.tags ?? [] });
    must(source.taskDefinition.status === 'ACTIVE' && source.taskDefinition.taskDefinitionArn === c.sourceOperationsDefinition && retired.taskDefinition.status === 'INACTIVE' && retired.taskDefinition.taskDefinitionArn === t.taskDefinitionArn && retired.taskDefinition.registeredBy === who.Arn && equal(normalizeTaskDefinition(retired.taskDefinition), normalizeTaskDefinition(want)) && equal(retired.tags, source.tags) && t.containers[0].imageDigest === want.containerDefinitions[0].image.split('@')[1], 'definition_changed');
    must(Date.parse(t.startedAt) <= Date.parse(rootOff.observedAt) && Date.parse(t.stoppedAt) >= Date.parse(rootOff.observedAt), 'read_time_changed');
    const normal = aws('ecs', 'describe-task-definition', ['--task-definition', 'fss-prod-operations', '--include', 'TAGS']), migration = aws('ecs', 'describe-task-definition', ['--task-definition', 'fss-prod-migration']);
    must(equal(normal, source) && migration.taskDefinition?.taskDefinitionArn === baseline.migration.definition && migration.taskDefinition.status === 'ACTIVE', 'normal_changed');
    runtimeBound(aws, baseline, 'runtime_changed');
    const observedAt = new Date(now()).toISOString(); must(Date.parse(result.completedAt) <= Date.parse(observedAt), 'snapshot_order_changed');
    write('independent', { outcome: 'PASS', cloudWrites: 0, observedAt, rootOff, task, source, retired, normalOperations: baseline.operations.revision, migration: baseline.migration.revision, nonterminalOneoffs: 0 });
    return `Independent root OFF snapshot PASS: exact STOPPED0/INACTIVE, normal operations${baseline.operations.revision}/migration${baseline.migration.revision}, no nonterminal oneoffs.`;
  }

  async function verifyApplication() {
    const { bindings, preflight, baseline } = bound(true); absent('verify-application');
    const { runId, jobId, gateId, imagesId, candidate, prNumber, prHead, upgradeJobId } = bindings, schema = baseline.schema, kinds = ['api', 'worker', 'operations', 'migration'];
    const input = read('native'), native = input.nativeFinalStatus;
    must(input.applicationRunId === runId && input.applicationJobId === jobId && input.renderedSummaryUrl === `https://github.com/${REPOSITORY}/actions/runs/${runId}`, 'native_identity_missing');
    must(native?.phase === 'completed' && native.outcome === 'completed' && native.writesStarted === true && native.reason == null && native.rollback == null && native.readerRecovery == null && native.offObservation == null, 'native_completion_missing');
    must(native.fromSchema === schema && native.targetSchema === schema && native.observedSchema === schema && native.migrationStarted === false, 'schema_change_refused');
    must(native.currentTaskArn === null && native.temporaryReaderDefinition === null && native.lastTaskExitCode === 0 && taskArn(native.lastStoppedTaskArn), 'native_custody_not_closed');
    const off = native.off; must(off?.releaseOff === true && off.storedOff === true && off.effectiveOff === true && off.finishing === 0 && off.schema === schema && equal(off.versions, OFF_VERSIONS), 'native_off_changed'); instant(off.observedAt);
    const previous = native.previousDefinitions, normal = native.candidateDefinitions;
    for (const name of kinds) must(previous?.[name] === baseline[name].definition && typeof normal?.[name] === 'string' && normal[name] !== previous[name], 'native_definition_binding_changed');
    const images = read('images'); must(images.schema === 'fss.image-digests.v1' && images.commit === candidate && String(images.workflowRunId) === String(imagesId) && String(images.workflowRunAttempt) === '1', 'artifact_binding_changed');
    for (const name of ['api', 'worker']) must(images.images?.[name]?.repository === 'fss-rh-' + name && images.images[name].tag === 'ci-' + candidate && images.images[name].schemaRange?.minimum === schema && images.images[name].schemaRange.maximum === schema && digestOf(images.images[name].digest), 'artifact_range_changed');
    must(images.images.api.digest !== images.images.worker.digest, 'artifact_digest_alias');
    const aws = awsClient(run, READS), who = actor(aws);
    const successful = (id, workflow, event, commit = candidate, branch = 'main') => { const r = gh('actions/runs/' + id); must(r.id === id && r.status === 'completed' && r.conclusion === 'success' && r.head_sha === commit && r.head_branch === branch && r.run_attempt === 1 && r.path === `.github/workflows/${workflow}` && r.event === event && r.head_repository?.full_name === REPOSITORY, 'run_binding_changed'); return r; };
    const gate = successful(gateId, 'greenfield.yml', 'push'); successful(imagesId, 'greenfield-images.yml', 'push'); successful(runId, 'greenfield-deploy.yml', 'workflow_dispatch');
    const pr = gh('pulls/' + prNumber); must(pr.number === prNumber && pr.merged === true && pr.base?.ref === 'main' && pr.base.repo?.full_name === REPOSITORY && pr.head?.repo?.full_name === REPOSITORY && pr.merge_commit_sha === candidate && pr.head.sha === prHead, 'merged_pr_binding_changed');
    for (const workflow of ['greenfield.yml', 'greenfield-images.yml']) { const r = gh(`actions/workflows/${workflow}/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`); must(r.workflow_runs?.length > 0 && r.total_count <= 100, 'pr_workflow_inventory_incomplete'); successful(r.workflow_runs[0].id, workflow, 'pull_request', pr.head.sha, pr.head.ref); }
    must(gh('git/ref/heads/main').object?.sha === candidate, 'main_changed');
    const sourceBytes = (path, ref) => { const s = gh(`contents/${path}?ref=${ref}`); must(s.encoding === 'base64' && typeof s.content === 'string', 'audited_source_missing'); return Buffer.from(s.content, 'base64').toString('utf8'); };
    for (const path of ['infra/scripts/application-release.mjs', 'infra/scripts/release-safety.mjs']) must(sourceBytes(path, candidate) === readFileSync(resolve(repositoryRoot, path), 'utf8'), 'audited_release_source_changed');
    // No schema change: the upgrade job proves its guarded same-schema path and intentionally uploads no evidence.
    sameSchemaSource(gh, baseline.production, candidate);
    const gateWorkflow = sourceBytes('.github/workflows/greenfield.yml', candidate); must(gateWorkflow === sourceBytes('.github/workflows/greenfield.yml', baseline.production) && gateWorkflow === readFileSync(resolve(repositoryRoot, '.github/workflows/greenfield.yml'), 'utf8'), 'audited_gate_source_changed');
    const gateJobs = gh(`actions/runs/${gateId}/jobs?filter=latest&per_page=100&page=1`); must(Number.isSafeInteger(gateJobs.total_count) && gateJobs.total_count <= 100 && gateJobs.jobs?.length === gateJobs.total_count, 'gate_job_inventory_incomplete');
    const upgradeJobs = gateJobs.jobs.filter(j => j.name === 'upgrade'); must(upgradeJobs.length === 1, 'same_schema_upgrade_job_ambiguous'); const upgradeJob = upgradeJobs[0];
    must(positive(upgradeJob.id) && upgradeJob.id === upgradeJobId && upgradeJob.run_id === gateId && upgradeJob.run_attempt === 1 && upgradeJob.head_sha === candidate && upgradeJob.status === 'completed' && upgradeJob.conclusion === 'success', 'same_schema_upgrade_job_changed');
    must(Array.isArray(upgradeJob.steps) && new Set(upgradeJob.steps.map(s => s.name)).size === upgradeJob.steps.length, 'same_schema_upgrade_steps_incomplete');
    for (const [names, conclusion] of [[UPGRADE_GUARDS, 'success'], [UPGRADE_WORK, 'skipped']]) for (const name of names) { const matches = upgradeJob.steps.filter(s => s.name === name); must(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === conclusion, 'same_schema_upgrade_step_changed'); }
    const artifacts = gh(`actions/runs/${imagesId}/artifacts?per_page=100`); must(artifacts.total_count <= 100 && artifacts.artifacts?.length === artifacts.total_count, 'artifact_inventory_incomplete');
    const exactImages = artifacts.artifacts.filter(v => v.name === 'fss-image-digests'); must(exactImages.length === 1 && exactImages[0].expired === false && exactImages[0].workflow_run?.id === imagesId && exactImages[0].workflow_run?.head_sha === candidate, 'artifact_identity_missing');
    must(equal(JSON.parse(artifactContents(exactImages[0].id, ['image-digests.json'])['image-digests.json']), images), 'saved_image_artifact_changed');
    const job = gh('actions/jobs/' + jobId); must(job.id === jobId && job.run_id === runId && job.run_attempt === 1 && job.name === 'Opt-in protected application release (legacy remains default)' && job.status === 'completed' && job.conclusion === 'success', 'job_binding_changed');
    const start = instant(job.started_at), end = instant(job.completed_at); must(start <= end && instant(off.observedAt) >= start && instant(off.observedAt) <= end, 'native_off_time_changed');
    must(equal(releaseControls(gh), preflight.sharedHolds), 'shared_hold_changed');
    const session = `arn:aws:sts::${ACCOUNT}:assumed-role/fss-prod-ci-application/fss-prod-application-${runId}`, cache = new Map();
    const definition = arn => { must(typeof arn === 'string' && arn.startsWith(DEFINITION) && /^fss-prod-(api|worker|operations|migration):[1-9][0-9]*$/u.test(arn.slice(DEFINITION.length)), 'definition_identity_invalid'); if (!cache.has(arn)) { const d = aws('ecs', 'describe-task-definition', ['--task-definition', arn, '--include', 'TAGS']); must(d.taskDefinition?.taskDefinitionArn === arn, 'definition_not_exact'); cache.set(arn, d); } return cache.get(arn); };
    const terminal = (t, source, name, owner, command) => {
      const d = source.taskDefinition, c = d.containerDefinitions[0], o = t.overrides;
      must(taskArn(t.taskArn) && t.clusterArn === CLUSTER && t.taskDefinitionArn === d.taskDefinitionArn && t.startedBy === owner && t.lastStatus === 'STOPPED' && t.desiredStatus === 'STOPPED' && t.containers?.length === 1 && t.containers[0].name === name && t.containers[0].exitCode === 0 && t.containers[0].image === c.image && t.containers[0].imageDigest === c.image.split('@')[1], 'task_not_exact_terminal');
      must(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => ['containerOverrides', 'inferenceAcceleratorOverrides'].includes(k)) && equal(o.containerOverrides, [{ name, command }]) && (!Object.hasOwn(o, 'inferenceAcceleratorOverrides') || equal(o.inferenceAcceleratorOverrides, [])), 'task_override_changed');
      must(instant(t.createdAt) <= instant(t.startedAt) && instant(t.startedAt) <= instant(t.stoppedAt), 'task_time_invalid');
    };
    for (const name of kinds) {
      const before = definition(previous[name]), after = definition(normal[name]), d = after.taskDefinition, kind = name === 'api' ? 'api' : 'worker';
      must(before.taskDefinition.status === 'ACTIVE' && before.taskDefinition.containerDefinitions?.length === 1 && before.taskDefinition.containerDefinitions[0].image === image(kind, baseline[name].digest), 'baseline_definition_changed');
      must(d.status === 'ACTIVE' && d.family === 'fss-prod-' + name && d.containerDefinitions?.length === 1 && d.containerDefinitions[0].name === name && d.containerDefinitions[0].image === image(kind, images.images[kind].digest) && d.registeredBy === session && instant(d.registeredAt) >= start && instant(d.registeredAt) <= end, 'candidate_definition_changed');
      const keys = name === 'migration' ? ['FSS_TARGET_SCHEMA_MIN', 'FSS_TARGET_SCHEMA_MAX'] : ['FSS_SCHEMA_MIN', 'FSS_SCHEMA_MAX'];
      must(keys.every(k => environment(d)[k] === String(schema) && environment(before.taskDefinition)[k] === String(schema)), 'definition_schema_changed');
      const want = normalizeTaskDefinition(before.taskDefinition); want.containerDefinitions[0].image = image(kind, images.images[kind].digest);
      for (const key of keys) { must(want.containerDefinitions[0].environment?.filter(e => e.name === key).length === 1, 'schema_environment_invalid'); want.containerDefinitions[0].environment.find(e => e.name === key).value = String(schema); }
      must(equal(normalizeTaskDefinition(d), want) && tags(after.tags) === tags(before.tags), 'candidate_transformation_changed');
      if (['operations', 'migration'].includes(name)) { must(equal(d.containerDefinitions[0].entryPoint, ['node', 'apps/worker/src/tools/fss.ts']) && equal(d.containerDefinitions[0].command, [name === 'operations' ? 'verify' : 'migrate']), 'normal_cli_changed'); const latest = aws('ecs', 'describe-task-definition', ['--task-definition', 'fss-prod-' + name]); must(latest.taskDefinition?.taskDefinitionArn === normal[name] && latest.taskDefinition.status === 'ACTIVE', 'latest_normal_definition_changed'); }
    }
    const live = aws('ecs', 'describe-services', ['--cluster', CLUSTER, '--services', 'fss-prod-api', 'fss-prod-worker']); must(!live.failures?.length && live.services?.length === 2 && new Set(live.services.map(s => s.serviceName)).size === 2, 'services_incomplete');
    for (const s of live.services) { const name = s.serviceName?.replace(/^fss-prod-/u, ''), n = ['api', 'worker'].includes(name) && baseline[name].count; must(n && s.clusterArn === CLUSTER && s.status === 'ACTIVE' && s.taskDefinition === normal[name] && s.runningCount === n && s.desiredCount === n && s.pendingCount === 0 && s.deployments?.length === 1 && s.deployments[0].taskDefinition === normal[name] && s.deployments[0].rolloutState === 'COMPLETED' && s.deploymentConfiguration?.deploymentCircuitBreaker?.enable === true && s.deploymentConfiguration.deploymentCircuitBreaker.rollback === true, 'runtime_not_stable'); }
    const running = inventory(aws, 'RUNNING'), stopped = inventory(aws, 'STOPPED');
    must(running.length === baseline.api.count + baseline.worker.count && running.every(t => t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING') && stopped.every(t => t.lastStatus === 'STOPPED'), 'nonterminal_oneoff');
    const runtime = [];
    for (const name of ['api', 'worker']) { const group = running.filter(t => t.group === 'service:fss-prod-' + name); must(group.length === baseline[name].count, 'runtime_group_changed'); for (const t of group) { must(t.taskDefinitionArn === normal[name] && t.containers?.length === 1 && t.containers[0].name === name && t.containers[0].image === image(name, images.images[name].digest) && t.containers[0].imageDigest === images.images[name].digest, 'runtime_digest_changed'); runtime.push({ service: name, definition: t.taskDefinitionArn, digest: t.containers[0].imageDigest }); } }
    const owned = stopped.filter(t => t.startedBy?.startsWith(`fss-app-${runId}-`)), readers = [], readerTasks = [];
    must(owned.length === 6, 'native_tasks_incomplete');
    for (let n = 1; n <= 3; n++) {
      const owner = `fss-app-${runId}-off-${n}`, matches = owned.filter(t => t.startedBy === owner); must(matches.length === 1, 'native_reader_missing_or_ambiguous');
      const t = matches[0], source = definition(n === 1 ? previous.operations : normal.operations), want = readerTaskDocument({ definition: source.taskDefinition, tags: source.tags ?? [] }), got = definition(t.taskDefinitionArn);
      must(got.taskDefinition.status === 'INACTIVE' && got.taskDefinition.registeredBy === session && instant(got.taskDefinition.registeredAt) >= start && instant(got.taskDefinition.registeredAt) <= instant(t.createdAt) && equal(normalizeTaskDefinition(got.taskDefinition), normalizeTaskDefinition(want)) && tags(got.tags) === tags(want.tags), 'native_reader_recipe_changed');
      terminal(t, got, 'operations', owner, []); must(instant(t.startedAt) >= start && instant(t.stoppedAt) <= end, 'native_reader_time_changed');
      readerTasks.push(t); readers.push({ task: t.taskArn, definition: t.taskDefinitionArn, startedBy: owner, status: 'STOPPED0/INACTIVE', basis: 'direct-live-task-metadata', schema });
    }
    must(new Set(readerTasks.map(t => t.taskDefinitionArn)).size === 3, 'native_reader_definition_reused');
    const numeric = owned.filter(t => new RegExp(`^fss-app-${runId}-[1-9][0-9]*$`, 'u').test(t.startedBy)).sort((a, b) => Number(a.startedBy.split('-').at(-1)) - Number(b.startedBy.split('-').at(-1)));
    must(numeric.length === 3 && owned.length === numeric.length + 3, 'native_task_sequence_incomplete');
    const database = aws('rds', 'describe-db-instances', ['--db-instance-identifier', 'fss-prod-pg']).DBInstances;
    must(database?.length === 1 && database[0].DBInstanceArn === preflight.recovery?.databaseArn && database[0].DbiResourceId === preflight.recovery.resourceId && database[0].DBInstanceStatus === 'available' && database[0].BackupRetentionPeriod === 35, 'recovery_database_changed');
    const db = database[0];
    const record = { schema: 'fss.release-record.v1', source: 'ci-gate', releaseGateReference: `ci-gate-${gateId}-${candidate.slice(0, 12)}`, recordedAt: gate.updated_at, suite: 'pass', commit: candidate, gateRunId: String(gateId), gateRunUrl: `https://github.com/${REPOSITORY}/actions/runs/${gateId}`, imagesRunId: String(imagesId), artifacts: { api: images.images.api.digest, worker: images.images.worker.digest, desktopCommitStamp: candidate }, enablesSending: false }; instant(record.recordedAt);
    const put = ['admin', 'release-record', 'put', '--json-base64', Buffer.from(JSON.stringify(record)).toString('base64')];
    const recipes = [{ source: previous.operations, command: put }, { source: normal.operations, command: ['verify'] }, { source: normal.operations, command: put }], oneoffs = [];
    for (let i = 0; i < 3; i++) {
      const t = numeric[i], owner = `fss-app-${runId}-${i + 1}`; terminal(t, definition(recipes[i].source), 'operations', owner, recipes[i].command);
      must(instant(t.startedAt) >= start && instant(t.stoppedAt) <= end && (!i || instant(numeric[i - 1].stoppedAt) <= instant(t.startedAt)), 'native_oneoff_order_changed');
      oneoffs.push({ task: t.taskArn, definition: t.taskDefinitionArn, startedBy: owner, status: 'STOPPED0', command: recipes[i].command });
    }
    const precedes = (a, b) => must(instant(a.stoppedAt) <= instant(b.startedAt), 'native_interleaving_changed');
    precedes(readerTasks[0], numeric[0]); precedes(numeric[0], numeric[1]); precedes(numeric[1], readerTasks[1]); precedes(readerTasks[1], readerTasks[2]); precedes(readerTasks[2], numeric[2]);
    must(numeric[2].taskArn === native.lastStoppedTaskArn && numeric[2].startedBy === native.currentTaskOwner && native.currentTaskOwner === `fss-app-${runId}-3` && instant(readerTasks[2].startedAt) <= instant(off.observedAt) && instant(readerTasks[2].stoppedAt) >= instant(off.observedAt), 'native_final_custody_changed');
    const point = native.recoveryPoint, pinned = instant(point?.timestamp);
    must(point.databaseArn === db.DBInstanceArn && point.resourceId === db.DbiResourceId && point.restoreTested === false && instant(point.earliest) <= pinned && instant(point.latest) >= pinned && pinned >= start - 60000 && pinned <= instant(readerTasks[1].createdAt) && pinned <= instant(off.observedAt), 'same_schema_recovery_point_missing');
    const backups = aws('rds', 'describe-db-instance-automated-backups', ['--dbi-resource-id', point.resourceId]); must(!backups.Marker && backups.DBInstanceAutomatedBackups?.length === 1, 'recovery_inventory_incomplete');
    const backup = backups.DBInstanceAutomatedBackups[0];
    must(backup.DBInstanceArn === point.databaseArn && backup.DbiResourceId === point.resourceId && backup.Status === 'active' && instant(backup.RestoreWindow?.EarliestTime) <= pinned && instant(backup.RestoreWindow?.LatestTime) >= pinned, 'recovery_no_longer_covered');
    // Explicit dated independent basis for the root reader; MISSING never proves historical STOPPED0.
    const preapproval = read('result'), custody = read('custody'), saved = read('independent'), rootState = preapproval.state;
    must(equal(rootState, custody) || equal({ ...rootState, savedAt: undefined }, { ...custody, savedAt: undefined }), 'root_custody_conflict');
    must(rootState.production === baseline.production && rootState.schema === schema && rootState.outcome === 'complete' && rootState.lastTaskExitCode === 0 && rootState.currentTaskArn === null && rootState.temporaryReaderDefinition === null && rootState.sourceOperationsDefinition === previous.operations && rootState.owner === readerOwner(bindings), 'root_reader_custody_incomplete');
    const rootOff = preapproval.read; must(rootOff?.releaseOff === true && rootOff.storedOff === true && rootOff.effectiveOff === true && rootOff.finishing === 0 && rootOff.schema === schema && equal(rootOff.versions, OFF_VERSIONS) && equal(rootState.off, rootOff) && saved.outcome === 'PASS' && saved.cloudWrites === 0 && equal(saved.rootOff, rootOff), 'root_off_snapshot_changed');
    must(saved.normalOperations === baseline.operations.revision && saved.migration === baseline.migration.revision && saved.nonterminalOneoffs === 0, 'root_snapshot_baseline_changed');
    const at = instant(saved.observedAt); must(instant(preflight.at) <= instant(rootOff.observedAt) && instant(rootOff.observedAt) <= instant(preapproval.completedAt) && instant(preapproval.completedAt) <= at && at <= instant(readerTasks[0].createdAt) && at <= now(), 'root_off_snapshot_order_changed');
    must(saved.task?.tasks?.length === 1 && !saved.task.failures?.length, 'root_task_snapshot_incomplete');
    const rootTask = saved.task.tasks[0], rootSource = definition(previous.operations), rootWant = readerTaskDocument({ definition: rootSource.taskDefinition, tags: rootSource.tags ?? [] }), rootDefinition = definition(rootTask.taskDefinitionArn);
    for (const source of [saved.source, rootSource]) must(source?.taskDefinition?.taskDefinitionArn === previous.operations && source.taskDefinition.status === 'ACTIVE' && equal(normalizeTaskDefinition(source.taskDefinition), normalizeTaskDefinition(rootSource.taskDefinition)) && tags(source.tags) === tags(rootSource.tags), 'root_source_changed');
    for (const retired of [saved.retired, rootDefinition]) must(retired?.taskDefinition?.taskDefinitionArn === rootTask.taskDefinitionArn && retired.taskDefinition.status === 'INACTIVE' && retired.taskDefinition.registeredBy === who.Arn && equal(normalizeTaskDefinition(retired.taskDefinition), normalizeTaskDefinition(rootWant)) && tags(retired.tags) === tags(rootWant.tags), 'root_reader_recipe_changed');
    terminal(rootTask, rootDefinition, 'operations', rootState.owner + '-off-1', []); must(instant(rootDefinition.taskDefinition.registeredAt) <= instant(rootTask.createdAt), 'root_registration_time_changed');
    must(rootTask.taskArn === rootState.lastStoppedTaskArn && instant(rootTask.startedAt) <= instant(rootOff.observedAt) && instant(rootTask.stoppedAt) >= instant(rootOff.observedAt) && instant(rootTask.stoppedAt) <= at, 'root_reader_time_changed');
    const currentRoot = aws('ecs', 'describe-tasks', ['--cluster', CLUSTER, '--tasks', rootTask.taskArn]);
    if (currentRoot.tasks?.length) { must(currentRoot.tasks.length === 1 && !currentRoot.failures?.length && currentRoot.tasks[0].taskArn === rootTask.taskArn, 'root_task_current_conflict'); terminal(currentRoot.tasks[0], rootDefinition, 'operations', rootState.owner + '-off-1', []); }
    else must(equal(currentRoot.tasks, []) && currentRoot.failures?.length === 1 && currentRoot.failures[0].arn === rootTask.taskArn && currentRoot.failures[0].reason === 'MISSING', 'root_task_current_unknown');
    readers.push({ task: rootTask.taskArn, definition: rootTask.taskDefinitionArn, startedBy: rootTask.startedBy, status: 'STOPPED0/INACTIVE', basis: 'independent-dated-cloud-observation', taskObservedAt: saved.observedAt, currentTaskObserved: currentRoot.tasks.length === 1, currentDefinitionRetirementObserved: true });
    const h = await health('/health'), ready = await health('/readyz');
    must(h?.status === 'serving' && h.build?.commit === candidate && h.schema?.databaseVersion === schema && h.schema.accepted === true && ready?.ready === true && ready.schema?.databaseVersion === schema && ready.schema.accepted === true, 'public_runtime_changed');
    write('acceptance', { outcome: 'PASS', observedAt: new Date(now()).toISOString(), production: candidate, baselineProduction: baseline.production, schema, run: runId, job: jobId, gate: gateId, images: imagesId, releasedAt: job.completed_at, renderedSummaryUrl: input.renderedSummaryUrl, normalDefinitions: normal, runtimeBindings: runtime, retiredReaders: readers, nativeOneoffs: oneoffs, nonterminalOneoffs: 0, off, recoveryPoint: point, restoreTested: false, cloudWrites: 0, fromSchema: schema, migrationStarted: false, limits: ['Native smokes and exact release-record readback accepted from actual authenticated rendered final status and exact successful native source/job; none replayed.', 'Three native OFF readers and all three normal oneoffs require directly available exact terminal task metadata; no historical fallback for native tasks.', 'Root preapproval terminal task uses an explicitly dated independent cloud snapshot plus current exact INACTIVE definition; current task metadata is crosschecked when available, MISSING never proves historical execution.', 'Stored OFF is dated native evidence, not a fresh database observation by this verifier.', 'Same-schema native PITR point remains covered; no migration or restore test occurred.', 'Complete bounded RUNNING/STOPPED inventories at most 100 each; exclusive two-service production ownership assumption retained.', `Same-schema ${schema} protected application replacement; no migration, Terraform or sending activation.`, 'Historical 40522197864 effects remain UNKNOWN.'] });
    return `Application independent acceptance PASS: exact schema${schema} runtime API${baseline.api.count}/worker${baseline.worker.count}, three native readers retired, three normal operations terminal, no migration or drain, no nonterminal oneoffs.`;
  }

  // Read the exact immutable artifact archive in memory without extracting files.
  function artifactContents(id, expectedNames) {
    must(positive(id), 'artifact_id_invalid');
    let archive; try { archive = run('gh', ['api', '--method', 'GET', `repos/${REPOSITORY}/actions/artifacts/${id}/zip`], { env: { GH_PAGER: 'cat' }, binary: true, maxBuffer: 4000000 }); } catch { throw new Error('artifact_read_failed_no_retry'); }
    const program = 'import sys,io,zipfile,json\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nn=z.namelist()\nassert len(n)==len(set(n)) and len(n)<=4\nassert sum(i.file_size for i in z.infolist())<=4000000 and all(not i.is_dir() for i in z.infolist())\nprint(json.dumps({k:z.read(k).decode("utf-8") for k in n}))';
    const contents = parsed(() => run('python3', ['-c', program], { input: archive, timeout: 15000, maxBuffer: 5000000 }), 'artifact_archive_invalid');
    must(equal(Object.keys(contents).sort(), [...expectedNames].sort()), 'artifact_members_changed'); return contents;
  }

  return { preflight, 'observe-off': observeOff, 'verify-off': verifyOff, 'verify-application': verifyApplication };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, directory } = parseArguments(argv);
  console.log(await createOperator({ directory })[command]());
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
