// Routine schema branch of greenfield-deploy. Uses the existing stop/release/record scripts.
// No Terraform apply, state write, credential fallback, feature configuration or automatic rollback.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
const args = process.argv.slice(2);
const argument = name => args[args.indexOf(name) + 1];
const statusFile = argument('--status');
if (!statusFile) throw new Error('--status required');
mkdirSync(dirname(statusFile), { recursive: true, mode: 0o700 });
const status = { phase: 'readiness', outcome: 'pending', writesStarted: false, schema: 'unobserved', registered: {}, recovery: 'No automatic cross-schema rollback. Preserve status and inspect actual state before repair.' };
const save = () => writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
save();
let env = { ...process.env };
const scripts = resolve('infra/scripts');
const work = dirname(statusFile);
function command(executable, values, options = {}) {
  const result = spawnSync(executable, values, { env, encoding: 'utf8', maxBuffer: 10_000_000, timeout: options.timeout ?? 600_000 });
  if (result.status !== 0) throw new Error(options.failure ?? 'operation_failed');
  return result.stdout;
}
function aws(values, write = false) {
  if (write) { gate(); status.writesStarted = true; status.outcome = 'started'; save(); }
  return JSON.parse(command(env.FSS_REHEARSAL_AWS_COMMAND || 'aws', [...values, '--output', 'json'], { failure: write ? 'cloud_write_unknown' : 'cloud_read_failed' }));
}
function scriptCommand(script, values, options = {}) {
  const adapter = env.FSS_RELEASE_SCRIPT_COMMAND;
  return command(adapter || join(scripts, script), adapter ? [script, ...values] : values, options);
}
function step(name, script, values, write = false) {
  status.phase = name; status.outcome = 'started'; save();
  if (write) { gate(); status.writesStarted = true; save(); }
  scriptCommand(script, values, { timeout: 4_800_000, failure: `${name}_failed` });
  status.outcome = 'completed'; save();
}
function gate() {
  if (env.FSS_RELEASE_HOLD !== 'false') throw new Error('release_held');
  scriptCommand('deploy.sh', ['ci', 'gate', '--commit', env.COMMIT, '--gate-run-id', env.GATE_RUN_ID], { failure: 'gate_changed' });
}
try {
  if (env.FSS_RELEASE_HOLD !== 'false') { status.outcome = 'held'; save(); process.exitCode = 1; }
  else {
    if (env.GITHUB_ACTIONS === 'true' && (env.FSS_RELEASE_SCRIPT_COMMAND || env.FSS_REHEARSAL_AWS_COMMAND)) throw new Error('controlled_adapter_forbidden_in_production');
    if (env.FSS_REHEARSAL_DRY_RUN === '1' || env.FSS_PROD_FORCE_IDLE === '1' || Object.keys(env).some(key => key.startsWith('FSS_RELEASE_OUTPUT_'))) throw new Error('ambient_release_override_forbidden');
    const plan = JSON.parse(readFileSync(argument('--plan'), 'utf8'));
    const digestsFile = argument('--digests');
    const digestDocument = JSON.parse(readFileSync(digestsFile, 'utf8'));
    if (digestDocument.schema !== 'fss.image-digests.v1' || digestDocument.commit !== env.COMMIT || String(digestDocument.workflowRunId) !== env.RUN_ID || String(digestDocument.workflowRunAttempt) !== env.RUN_ATTEMPT) throw new Error('image_provenance_changed');
    const digests = digestDocument.images;
    if (plan.decision !== 'maintenance' || plan.to !== env.COMMIT || !/^[0-9a-f]{40}$/u.test(plan.from) || !Number.isInteger(plan.fromSchema) || !Number.isInteger(plan.toSchema) || plan.toSchema <= plan.fromSchema) throw new Error('ineligible_plan');
    if (!/^[1-9][0-9]*$/u.test(env.GATE_RUN_ID || '') || !/^[1-9][0-9]*$/u.test(env.RUN_ID || '')) throw new Error('missing_provenance');
    const identity = aws(['sts', 'get-caller-identity']);
    const account = identity.Account;
    const region = env.AWS_REGION || 'us-east-1';
    if (account !== (env.FSS_PRODUCTION_ACCOUNT_ID || '326255650484') || region !== (env.FSS_PRODUCTION_REGION || 'us-east-1') || !/^[0-9]{12}$/u.test(account) || !new RegExp(`^arn:aws:sts::${account}:assumed-role/fss-prod-ci-maintenance/fss-prod-maintenance-[0-9]+$`, 'u').test(identity.Arn)) throw new Error('wrong_migration_identity');
    const cluster = `arn:aws:ecs:${region}:${account}:cluster/fss-prod-cluster`;
    const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
    const observed = {};
    for (const service of ['api', 'worker']) {
      const entries = aws(['ecs', 'describe-services', '--cluster', cluster, '--services', `fss-prod-${service}`]).services;
      if (entries?.length !== 1 || entries[0].status !== 'ACTIVE' || entries[0].desiredCount < 1 || entries[0].runningCount !== entries[0].desiredCount || entries[0].pendingCount !== 0) throw new Error('production_not_stable');
      observed[service] = entries[0];
    }
    // Actual observed source/schema must still be the exact upgrade baseline.
    command('bash', [join(resolve('tools/ci'), 'resolve-prod-base.sh')], { failure: 'baseline_unavailable' });
    const health = JSON.parse(command('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', `${env.FSS_PRODUCTION_ORIGIN}/health`]));
    if (health.build?.commit !== plan.from || health.schema?.databaseVersion !== plan.fromSchema || health.schema?.accepted !== true) throw new Error('baseline_changed');
    status.schema = plan.fromSchema; save();
    const evidence = readFileSync(argument('--evidence'), 'utf8');
    if (!evidence.includes(`PASS  schema ${plan.fromSchema} → ${plan.toSchema}`) || evidence.includes(`FAIL  schema ${plan.fromSchema} → ${plan.toSchema}`)) throw new Error('upgrade_evidence_missing');
    // Inventory existing recovery, not an inferred successful restore.
    const databases = aws(['rds', 'describe-db-instances', '--db-instance-identifier', 'fss-prod-pg']).DBInstances;
    const database = databases?.[0];
    if (databases?.length !== 1 || database.BackupRetentionPeriod !== 35 || !database.LatestRestorableTime || !database.EarliestRestorableTime || database.DBInstanceStatus !== 'available') throw new Error('backup_readiness_unavailable');
    status.backup = { retentionDays: 35, earliest: database.EarliestRestorableTime, latest: database.LatestRestorableTime, restoreTested: false }; save();
    const definitions = {};
    for (const name of ['api', 'worker', 'migration', 'operations']) {
      const source = aws(['ecs', 'describe-task-definition', '--task-definition', observed[name]?.taskDefinition || `fss-prod-${name}`, '--include', 'TAGS']);
      const definition = source.taskDefinition;
      const containerName = name;
      if (definition?.family !== `fss-prod-${name}` || definition.containerDefinitions?.length !== 1 || definition.containerDefinitions[0].name !== containerName || !source.tags?.some(tag => tag.key === 'NamePrefix' && tag.value === 'fss-prod')) throw new Error('definition_binding_unavailable');
      const container = definition.containerDefinitions[0];
      const service = name === 'api' ? 'api' : 'worker';
      const digest = digests[service]?.digest;
      const range = digests[service]?.schemaRange;
      if (digests[service]?.repository !== `fss-rh-${service}` || digests[service]?.tag !== `ci-${env.COMMIT}` || !/^sha256:[0-9a-f]{64}$/u.test(digest || '') || range?.minimum !== plan.toSchema || range?.maximum !== plan.toSchema) throw new Error('image_schema_binding_changed');
      if (!container.image.startsWith(`${registry}/fss-prod-${service}@sha256:`)) throw new Error('foreign_image');
      definitions[name] = { definition, tags: source.tags, digest };
    }
    const valueOf = (definition, key) => definition.containerDefinitions[0].environment?.find(entry => entry.name === key)?.value;
    const secretOf = (definition, key) => definition.containerDefinitions[0].secrets?.find(entry => entry.name === key)?.valueFrom;
    const host = valueOf(definitions.worker.definition, 'FSS_DATABASE_HOST');
    if (!host || valueOf(definitions.api.definition, 'FSS_DATABASE_HOST') !== host || valueOf(definitions.migration.definition, 'FSS_DATABASE_HOST') !== host) throw new Error('database_binding_changed');
    const network = observed.worker.networkConfiguration?.awsvpcConfiguration;
    if (!network?.subnets?.length || network.securityGroups?.length !== 1 || network.assignPublicIp !== 'ENABLED') throw new Error('network_binding_unavailable');
    const groups = aws(['ec2', 'describe-security-groups', '--group-ids', network.securityGroups[0]]).SecurityGroups;
    if (groups?.length !== 1 || groups[0].IpPermissions?.length !== 0) throw new Error('task_network_inbound_changed');
    const migrationSecret = secretOf(definitions.migration.definition, 'MIGRATION_DATABASE_SECRET');
    const runtimeSecret = secretOf(definitions.worker.definition, 'DATABASE_SECRET_ARN');
    if (!migrationSecret || !runtimeSecret || database.Endpoint?.Address !== host || !database.DBName) throw new Error('secret_or_database_binding_unavailable');
    const deployment = { bootstrap: false };
    for (const name of ['api', 'worker']) {
      const definition = definitions[name].definition;
      deployment[name] = { service_name: `fss-prod-${name}`, declared_desired_count: observed[name].desiredCount, planned_desired_count: observed[name].desiredCount, task_definition: observed[name].taskDefinition, image: definition.containerDefinitions[0].image, schema_min: valueOf(definition, 'FSS_SCHEMA_MIN'), schema_max: valueOf(definition, 'FSS_SCHEMA_MAX') };
    }
    const setOutput = (name, value) => { env[`FSS_RELEASE_OUTPUT_${name.toUpperCase()}`] = typeof value === 'string' ? value : JSON.stringify(value); };
    setOutput('cluster_arn', cluster); setOutput('deployment_plan', deployment);
    setOutput('migration_task_definition_arn', definitions.migration.definition.taskDefinitionArn);
    setOutput('operations_task_definition_arn', definitions.operations.definition.taskDefinitionArn);
    setOutput('migration_database_secret_arn', migrationSecret); setOutput('app_runtime_database_secret_arn', runtimeSecret);
    setOutput('database_name', database.DBName); setOutput('worker_log_group_name', definitions.worker.definition.containerDefinitions[0].logConfiguration.options['awslogs-group']);
    setOutput('task_network_configuration', { subnet_ids: network.subnets, security_group_id: network.securityGroups[0], assign_public_ip: network.assignPublicIp, database_host: host, database_port: 5432, inbound_rule_count: 0 });
    env.FSS_REHEARSAL_REPORTS = work;
    // Records precede new workers; source generation and readback remain internal.
    const record = join(work, 'release-record.json');
    const digest = name => definitions[name].digest;
    const recordArgs = ['from-ci', env.GATE_RUN_ID, env.COMMIT, digest('api'), digest('worker'), '--images-run', env.RUN_ID, '--out', record];
    if (valueOf(definitions.worker.definition, 'FSS_SENDING_ENABLED') === 'true') recordArgs.push('--enables-sending');
    step('release-record-build', 'record.sh', recordArgs);
    step('release-record-put', 'record.sh', ['put', 'infra/roots/production', 'fss-prod', '--api-digest', digest('api'), '--worker-digest', digest('worker'), '--release-record', record], true);
    step('promote', 'images.sh', ['promote', digestsFile, '--gate-run-id', env.GATE_RUN_ID], true);
    step('drain-idle-stop', 'stop.sh', ['infra/roots/production', 'fss-prod', '--environment', 'production', '--worker-digest', digest('worker')], true);
    for (const name of ['migration', 'operations', 'worker', 'api']) {
      status.phase = `register-${name}`; save();
      const { definition, tags } = definitions[name];
      const next = structuredClone(definition);
      for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']) delete next[key];
      next.tags = tags;
      const container = next.containerDefinitions[0];
      container.image = `${registry}/fss-prod-${name === 'api' ? 'api' : 'worker'}@${digest(name === 'api' ? 'api' : 'worker')}`;
      for (const entry of container.environment || []) if (['FSS_SCHEMA_MIN', 'FSS_SCHEMA_MAX'].includes(entry.name)) entry.value = String(plan.toSchema);
      const file = join(work, `definition-${name}.json`); writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
      const registered = aws(['ecs', 'register-task-definition', '--cli-input-json', `file://${file}`], true).taskDefinition;
      if (!registered?.taskDefinitionArn) throw new Error('registration_unknown');
      status.registered[name] = registered.taskDefinitionArn; save();
      if (name === 'migration' || name === 'operations') setOutput(`${name}_task_definition_arn`, registered.taskDefinitionArn);
      else {
        deployment[name].task_definition = registered.taskDefinitionArn; deployment[name].image = container.image;
        deployment[name].schema_min = String(plan.toSchema); deployment[name].schema_max = String(plan.toSchema); deployment[name].planned_desired_count = 0;
        aws(['ecs', 'update-service', '--cluster', cluster, '--service', `fss-prod-${name}`, '--task-definition', registered.taskDefinitionArn, '--desired-count', '0'], true);
      }
    }
    setOutput('deployment_plan', deployment);
    // One existing script owns migration, verify, restart and drain-off. Never recover by starting old binaries.
    step('migrate-verify-restart', 'deploy.sh', ['release', 'infra/roots/production', 'fss-prod', '--schema-change', '--api-digest', digest('api'), '--worker-digest', digest('worker')], true);
    status.schema = plan.toSchema; save();
    step('release-record-readback', 'record.sh', ['read-back', 'infra/roots/production', 'fss-prod', '--api-digest', digest('api'), '--worker-digest', digest('worker'), '--release-record', record], true);
    const currentHealth = JSON.parse(command('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', `${env.FSS_PRODUCTION_ORIGIN}/health`]));
    if (currentHealth.build?.commit !== plan.to || currentHealth.schema?.databaseVersion !== plan.toSchema || currentHealth.schema?.accepted !== true) throw new Error('deployed_binding_mismatch');
    status.phase = 'smoke'; save();
    const age = /^canary_age=([0-9.]+)$/mu.exec(scriptCommand('deploy.sh', ['ci', 'canary']))?.[1];
    if (!age) throw new Error('canary_unavailable');
    if (env.FSS_RELEASE_SCRIPT_COMMAND) scriptCommand('productionSmoke.mjs', [env.FSS_PRODUCTION_ORIGIN], { failure: 'smoke_failed' });
    else command(process.execPath, [resolve('scripts/productionSmoke.mjs'), '--origin', env.FSS_PRODUCTION_ORIGIN, '--canary-age-seconds', age, '--expect-sending', valueOf(definitions.worker.definition, 'FSS_SENDING_ENABLED') === 'true' ? 'enabled' : 'disabled', '--json'], { failure: 'smoke_failed' });
    status.phase = 'verified'; status.outcome = 'completed'; save();
  }
} catch (error) {
  status.outcome = error.message === 'release_held' ? 'held' : status.writesStarted ? 'repair-required' : 'refused';
  status.reason = error.message;
  status.schema = status.phase === 'migrate-verify-restart' ? 'unknown-after-migration-attempt' : status.schema;
  save(); console.error(`Routine release ${status.outcome} at ${status.phase}: ${status.reason}. See private status; do not blindly replay or roll back schema.`); process.exitCode = 1;
}
