#!/usr/bin/env node
// Additive protected application release. Legacy remains the default until hosted acceptance.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReleaseSafety } from './release-safety.mjs';
export { offRead } from './release-safety.mjs';

const execute = promisify(execFile);
const names = ['api', 'worker', 'migration', 'operations'];
const sha = /^[0-9a-f]{40}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const id = /^[1-9][0-9]{0,19}$/u;
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const envValue = (definition, key) => definition.containerDefinitions[0].environment?.find(item => item.name === key)?.value;
const secret = (definition, key) => {
  const matches = definition.containerDefinitions[0].secrets?.filter(item => item.name === key) || [];
  return matches.length === 1 ? matches[0].valueFrom : undefined;
};
const explicitBedrock = definition => {
  const container = definition?.containerDefinitions?.[0];
  const entries = container?.environment?.filter(item => item.name === 'FSS_MODEL_TRANSPORT') || [];
  return entries.length === 1 && entries[0].value === 'bedrock' && !container.secrets?.some(item => item.name === 'FSS_MODEL_TRANSPORT');
};
const credentialNames = ['DATABASE_SECRET_ARN', 'MIGRATION_DATABASE_SECRET', 'FSS_RUNTIME_DATABASE_SECRET_ARN'];
const imageSide = name => name === 'api' ? 'api' : 'worker';
const accepted = (definition, schema) => Number(envValue(definition, 'FSS_SCHEMA_MIN')) <= schema && Number(envValue(definition, 'FSS_SCHEMA_MAX')) >= schema;


/** io supplies ordinary process/files/clock operations. Tests replace cloud transport, not policy. */
export async function runRelease(io, environment) {
  const e = environment;
  const state = { phase: 'preflight', outcome: 'pending', writesStarted: false, migrationStarted: false, observedSchema: 'unknown', recoveryPoint: null, previousDefinitions: {}, candidateDefinitions: {} };
  const save = () => io.save(structuredClone(state));
  const phase = name => { state.phase = name; save(); };
  const json = async (program, args) => JSON.parse(await io.run(program, args));
  const gh = path => json('gh', ['api', `repos/${e.GITHUB_REPOSITORY}/${path}`]);
  let images, gate, baseline, definitions, network, database, cluster, registry, taskSequence = 0;
  const runInfo = (run, workflow, commit, runId) => {
    requireThat(String(run.id) === runId && run.path?.split('@')[0] === `.github/workflows/${workflow}.yml` && run.event === 'push' && run.head_branch === 'main' && run.head_repository?.full_name === e.GITHUB_REPOSITORY && run.status === 'completed' && run.conclusion === 'success' && run.head_sha === commit, 'provenance_changed');
  };
  async function gateCheck() {
    requireThat(e.FSS_RELEASE_HOLD === 'false', 'release_held');
    runInfo(await gh(`actions/runs/${e.GATE_RUN_ID}`), 'greenfield', e.COMMIT, e.GATE_RUN_ID);
    const currentImages = await gh(`actions/runs/${e.RUN_ID}`);
    runInfo(currentImages, 'greenfield-images', e.COMMIT, e.RUN_ID);
    requireThat(String(currentImages.run_attempt) === String(images.workflowRunAttempt), 'image_attempt_changed');
    const latest = await gh(`actions/workflows/greenfield.yml/runs?head_sha=${e.COMMIT}&event=push&branch=main&per_page=100`);
    requireThat(latest.workflow_runs?.[0]?.id === Number(e.GATE_RUN_ID) && latest.workflow_runs[0].run_attempt === gate.run_attempt, 'gate_superseded');
    const branch = await gh('git/ref/heads/main');
    requireThat(branch.object?.sha === e.GITHUB_SHA, 'dispatch_main_changed');
  }
  async function aws(service, action, args = [], write = false) {
    if (write) { await gateCheck(); state.writesStarted = true; state.outcome = 'started'; save(); }
    return await json('aws', [service, action, ...args, '--output', 'json']);
  }
  async function services() {
    const found = (await aws('ecs', 'describe-services', ['--cluster', cluster, '--services', 'fss-prod-api', 'fss-prod-worker']));
    requireThat(!found.failures?.length && found.services?.length === 2, 'services_unreadable');
    return Object.fromEntries(['api', 'worker'].map(name => {
      const service = found.services.find(item => item.serviceName === `fss-prod-${name}`);
      requireThat(service?.status === 'ACTIVE', 'service_binding_changed');
      return [name, service];
    }));
  }
  function stable(service, count, definition) {
    return service.desiredCount === count && service.runningCount === count && service.pendingCount === 0 && service.taskDefinition === definition && service.deployments?.length === 1 && service.deployments[0].taskDefinition === definition && service.deployments[0].rolloutState === 'COMPLETED';
  }
  async function waitFor(check, reason, attempts = 60) {
    for (let n = 0; n < attempts; n++) { if (await check()) return; await io.sleep(15000); }
    throw new Error(reason);
  }
  async function register(name, document) {
    const result = await aws('ecs', 'register-task-definition', ['--cli-input-json', JSON.stringify(document)], true);
    const arn = result.taskDefinition?.taskDefinitionArn;
    requireThat(typeof arn === 'string' && arn.startsWith(`${cluster.split(':cluster/')[0]}:task-definition/fss-prod-${name}:`), 'registration_unknown');
    const readback = await aws('ecs', 'describe-task-definition', ['--task-definition', arn, '--include', 'TAGS']);
    const normalize = d => {
      const copy = structuredClone(d);
      for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt', 'tags']) delete copy[key];
      return copy;
    };
    requireThat(io.equal(normalize(readback.taskDefinition), normalize(document)) && io.equal(readback.tags, document.tags), 'registered_definition_changed');
    return { definition: readback.taskDefinition, tags: readback.tags };
  }
  function nextDefinition(name, source, candidate) {
    const next = structuredClone(source.definition);
    for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']) delete next[key];
    next.tags = source.tags;
    const container = next.containerDefinitions[0];
    if (candidate) {
      container.image = `${registry}/fss-prod-${imageSide(name)}@${images.images[imageSide(name)].digest}`;
      for (const key of name === 'migration' ? ['FSS_TARGET_SCHEMA_MIN', 'FSS_TARGET_SCHEMA_MAX'] : ['FSS_SCHEMA_MIN', 'FSS_SCHEMA_MAX']) {
        requireThat(container.environment?.some(item => item.name === key), 'schema_environment_missing');
        container.environment.find(item => item.name === key).value = String(state.targetSchema);
      }
    }
    return next;
  }
  async function oneOff(name, source, words, inline = false) {
    const d = source.definition;
    const c = d.containerDefinitions[0];
    const owner = `fss-app-${e.GITHUB_RUN_ID}-${++taskSequence}`;
    state.currentTaskOwner = owner; state.lastStoppedTaskArn = null; save();
    const task = await aws('ecs', 'run-task', ['--cluster', cluster, '--started-by', owner, '--task-definition', d.taskDefinitionArn, '--launch-type', 'FARGATE', '--count', '1', '--propagate-tags', 'TASK_DEFINITION', '--network-configuration', JSON.stringify({ awsvpcConfiguration: network }), '--overrides', JSON.stringify({ containerOverrides: [{ name, command: inline ? [] : words }] })], true);
    requireThat(!task.failures?.length && task.tasks?.length === 1 && task.tasks[0].taskArn, 'task_start_unknown');
    const arn = task.tasks[0].taskArn;
    state.currentTaskArn = arn; save();
    let stopped;
    await waitFor(async () => {
      const read = await aws('ecs', 'describe-tasks', ['--cluster', cluster, '--tasks', arn]);
      requireThat(!read.failures?.length && read.tasks?.length === 1, 'task_outcome_unknown');
      stopped = read.tasks[0];
      return stopped.lastStatus === 'STOPPED';
    }, 'task_outcome_unknown', 120);
    requireThat(stopped.taskArn === arn && stopped.clusterArn === cluster && stopped.startedBy === owner && stopped.taskDefinitionArn === d.taskDefinitionArn && stopped.containers?.length === 1 && stopped.containers[0].name === name && Number.isInteger(stopped.containers[0].exitCode) && stopped.containers[0].imageDigest === c.image.split('@')[1], 'task_failed_or_foreign');
    state.currentTaskArn = null; state.lastStoppedTaskArn = arn; state.lastTaskExitCode = stopped.containers[0].exitCode; save();
    requireThat(stopped.containers[0].exitCode === 0, 'task_nonzero_exit');
    const options = c.logConfiguration?.options;
    const stream = `${options?.['awslogs-stream-prefix']}/${name}/${arn.split('/').at(-1)}`;
    let answer;
    await waitFor(async () => {
      const result = await aws('logs', 'get-log-events', ['--log-group-name', options['awslogs-group'], '--log-stream-name', stream, '--start-from-head']);
      for (const event of result.events || []) {
        try { const value = JSON.parse(event.message); if (!value.event && !value.level) answer = value; } catch { /* No raw log line leaves this reader. */ }
      }
      return answer !== undefined;
    }, 'task_report_unavailable', 8);
    return answer;
  }
  let safety;
  const off = (source, expected) => safety.off(source, expected);
  async function update(name, values, definition = state.candidateDefinitions[name] || baseline[name].taskDefinition) {
    return await aws('ecs', 'update-service', ['--cluster', cluster, '--service', `fss-prod-${name}`, '--task-definition', definition, ...values], true);
  }
  async function configuration(rollback) {
    for (const name of ['api', 'worker']) {
      const saved = baseline[name].deploymentConfiguration;
      requireThat(saved?.deploymentCircuitBreaker?.enable === true, 'circuit_breaker_unavailable');
      await update(name, ['--deployment-configuration', JSON.stringify({ ...saved, deploymentCircuitBreaker: { ...saved.deploymentCircuitBreaker, rollback } })], baseline[name].taskDefinition);
    }
    const read = await services();
    requireThat(['api', 'worker'].every(name => read[name].deploymentConfiguration?.deploymentCircuitBreaker?.rollback === rollback && read[name].deploymentConfiguration?.deploymentCircuitBreaker?.enable === true), 'circuit_breaker_not_applied');
  }
  async function verifyDefinitions(current) {
    for (const name of names) {
      const arn = state.candidateDefinitions[name];
      const read = await aws('ecs', 'describe-task-definition', ['--task-definition', arn, '--include', 'TAGS']);
      if (['api', 'worker'].includes(name)) requireThat(explicitBedrock(read.taskDefinition), 'bedrock_not_explicit');
      requireThat(io.equal(read.taskDefinition, current[name].definition) && io.equal(read.tags, current[name].tags), 'candidate_definition_changed');
    }
  }
  async function running(current) {
    const live = await services();
    for (const [name, count] of [['api', 2], ['worker', 1]]) {
      requireThat(stable(live[name], count, current[name].definition.taskDefinitionArn), 'deployment_not_complete');
      const listed = await aws('ecs', 'list-tasks', ['--cluster', cluster, '--service-name', `fss-prod-${name}`, '--desired-status', 'RUNNING']);
      requireThat(listed.taskArns?.length === count, 'running_count_changed');
      const tasks = await aws('ecs', 'describe-tasks', ['--cluster', cluster, '--tasks', ...listed.taskArns]);
      requireThat(!tasks.failures?.length && tasks.tasks?.length === count && tasks.tasks.every(task => task.lastStatus === 'RUNNING' && task.taskDefinitionArn === current[name].definition.taskDefinitionArn && task.containers?.length === 1 && task.containers[0].name === name && task.containers[0].imageDigest === images.images[name].digest), 'running_digest_changed');
    }
    await verifyDefinitions(current);
  }
  const pinRecovery = after => safety.pinRecovery(database, after);
  async function credentialVersion() {
    const result = await aws('secretsmanager', 'describe-secret', ['--secret-id', secret(definitions.migration.definition, 'MIGRATION_DATABASE_SECRET')]);
    const versions = Object.entries(result.VersionIdsToStages || {}).filter(([, stages]) => stages.includes('AWSCURRENT'));
    requireThat(versions.length === 1, 'migration_credential_version_unknown');
    return versions[0][0];
  }
  async function authenticate(source) {
    const before = await credentialVersion();
    const report = await oneOff('migration', source, ['migration-auth-check', '--expected-database', database.DBName, '--expected-user', 'fss_admin', '--expected-host', database.Endpoint.Address]);
    requireThat(report.ok === true && report.readOnly === true && report.migrationMember === true && report.identity === 'fss_admin' && report.database === database.DBName && report.schemaVersion === state.fromSchema && before === await credentialVersion(), 'migration_authentication_refused');
    return before;
  }
  async function compatibleRollback(current) {
    // This function is called only for a known same-schema rollout/smoke failure.
    requireThat(!state.migrationStarted, 'migration_forward_repair_only');
    await off(current.operations, state.fromSchema);
    requireThat(['api', 'worker'].every(name => accepted(definitions[name].definition, state.observedSchema)), 'rollback_schema_incompatible');
    const live = await services();
    requireThat(['api', 'worker'].every(name => [baseline[name].taskDefinition, current[name].definition.taskDefinitionArn].includes(live[name].taskDefinition) && live[name].deployments?.every(deployment => [baseline[name].taskDefinition, current[name].definition.taskDefinitionArn].includes(deployment.taskDefinition))), 'rollback_outcome_unknown');
    phase('compatible-app-rollback');
    for (const name of ['worker', 'api']) {
      await aws('ecs', 'update-service', ['--cluster', cluster, '--service', `fss-prod-${name}`, '--task-definition', baseline[name].taskDefinition, '--desired-count', String(baseline[name].desiredCount)], true);
    }
    await waitFor(async () => { const actual = await services(); return ['api', 'worker'].every(name => stable(actual[name], baseline[name].desiredCount, baseline[name].taskDefinition)); }, 'rollback_outcome_unknown');
    await off(current.operations, state.fromSchema);
    state.rollback = 'previous-application-restored'; save();
  }
  save();
  try {
    requireThat(e.GITHUB_ACTIONS === 'true' && e.GITHUB_REF === 'refs/heads/main' && e.FSS_RELEASE_HOLD === 'false' && sha.test(e.GITHUB_SHA || '') && sha.test(e.COMMIT || '') && id.test(e.RUN_ID || '') && id.test(e.GATE_RUN_ID || '') && id.test(e.GITHUB_RUN_ID || '') && e.GATE_RUN_ID !== e.RUN_ID && e.GITHUB_REPOSITORY === 'david-cui-bruno/founding-sales' && e.FSS_PRODUCTION_ORIGIN === 'https://api.usecallie.com', 'unapproved_execution');
    requireThat(!Object.keys(e).some(key => /^(FSS_RELEASE_OUTPUT_|FSS_REHEARSAL_|FSS_PROD_FORCE_IDLE|FSS_APPLICATION_RELEASE_TEST)/u.test(key)), 'ambient_override_forbidden');
    images = io.read('images');
    requireThat(images.schema === 'fss.image-digests.v1' && images.commit === e.COMMIT && String(images.workflowRunId) === e.RUN_ID, 'artifact_binding_changed');
    for (const name of ['api', 'worker']) {
      const image = images.images?.[name];
      requireThat(image?.repository === `fss-rh-${name}` && image.tag === `ci-${e.COMMIT}` && digest.test(image.digest || '') && Number.isInteger(image.schemaRange?.minimum) && image.schemaRange.minimum === image.schemaRange.maximum && image.schemaRange.minimum > 0, 'image_binding_changed');
    }
    requireThat(images.images.api.digest !== images.images.worker.digest && images.images.api.schemaRange.minimum === images.images.worker.schemaRange.minimum, 'image_range_mismatch');
    state.targetSchema = images.images.api.schemaRange.minimum;
    gate = await gh(`actions/runs/${e.GATE_RUN_ID}`); await gateCheck();
    const identity = await aws('sts', 'get-caller-identity');
    requireThat(identity.Account === '326255650484' && identity.Arn === `arn:aws:sts::326255650484:assumed-role/fss-prod-ci-application/fss-prod-application-${e.GITHUB_RUN_ID}` && e.AWS_REGION === 'us-east-1', 'wrong_release_identity');
    cluster = 'arn:aws:ecs:us-east-1:326255650484:cluster/fss-prod-cluster';
    registry = '326255650484.dkr.ecr.us-east-1.amazonaws.com';
    baseline = await services();
    for (const [name, count] of [['api', 2], ['worker', 1]]) requireThat(stable(baseline[name], count, baseline[name].taskDefinition), 'baseline_not_stable');
    const health = await json('curl', ['--fail', '--silent', '--show-error', '--max-time', '15', `${e.FSS_PRODUCTION_ORIGIN}/health`]);
    requireThat(sha.test(health.build?.commit || '') && Number.isInteger(health.schema?.databaseVersion) && health.schema.accepted === true, 'baseline_schema_unknown');
    state.fromSchema = health.schema.databaseVersion; state.observedSchema = state.fromSchema;
    requireThat(state.targetSchema >= state.fromSchema, 'schema_downgrade_refused');
    const plan = JSON.parse(await io.run('node', ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', 'tools/ci/release-plan.ts', '--repository', '.', '--from', health.build.commit, '--to', e.COMMIT]));
    requireThat(plan.fromSchema === state.fromSchema && plan.toSchema === state.targetSchema && !plan.reasons.some(reason => /deployed migration|missing or duplicate|unknown migration|schema rollback/u.test(reason)), 'migration_history_changed');
    if (state.targetSchema !== state.fromSchema) {
      const binding = io.read('upgradeBinding');
      const evidence = io.read('upgradeEvidence');
      requireThat(binding.from === health.build.commit && binding.to === e.COMMIT && evidence.includes(`PASS  schema ${state.fromSchema} → ${state.targetSchema}`) && !evidence.includes('FAIL '), 'actual_upgrade_evidence_missing');
    }
    const result = await aws('rds', 'describe-db-instances', ['--db-instance-identifier', 'fss-prod-pg']);
    requireThat(result.DBInstances?.length === 1, 'database_unavailable'); database = result.DBInstances[0];
    requireThat(database.DBInstanceArn === 'arn:aws:rds:us-east-1:326255650484:db:fss-prod-pg' && database.DbiResourceId && database.DBName && database.Endpoint?.Address && database.DBInstanceStatus === 'available' && database.BackupRetentionPeriod === 35, 'database_binding_changed');
    network = baseline.worker.networkConfiguration?.awsvpcConfiguration;
    const apiNetwork = baseline.api.networkConfiguration?.awsvpcConfiguration;
    const validId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-[0-9a-f]{8}([0-9a-f]{9})?$`, 'u').test(value);
    const expectedSubnets = e.TASK_SUBNETS?.split(',');
    const validSubnets = value => Array.isArray(value) && value.length === 2 && value.every(item => validId(item, 'subnet')) && new Set(value).size === 2;
    const sameSubnets = value => validSubnets(value) && io.equal([...value].sort(), [...expectedSubnets].sort());
    const validNetwork = value => value && sameSubnets(value.subnets) && Array.isArray(value.securityGroups) && value.securityGroups.length === 1 && validId(value.securityGroups[0], 'sg') && value.assignPublicIp === 'ENABLED';
    requireThat(validSubnets(expectedSubnets) && validId(e.TASK_SECURITY_GROUP, 'sg') && validNetwork(network) && validNetwork(apiNetwork) && network.securityGroups[0] === e.TASK_SECURITY_GROUP && apiNetwork.securityGroups[0] !== network.securityGroups[0], 'network_binding_changed');
    const groups = await aws('ec2', 'describe-security-groups', ['--group-ids', network.securityGroups[0], apiNetwork.securityGroups[0]]);
    const workerGroup = groups.SecurityGroups?.find(group => group.GroupId === network.securityGroups[0]);
    const apiGroup = groups.SecurityGroups?.find(group => group.GroupId === apiNetwork.securityGroups[0]);
    requireThat(groups.SecurityGroups?.length === 2 && workerGroup?.GroupName === 'fss-prod-worker-task' && apiGroup?.GroupName === 'fss-prod-api-task' && validId(workerGroup.VpcId, 'vpc') && apiGroup.VpcId === workerGroup.VpcId, 'network_group_binding_changed');
    requireThat(Array.isArray(workerGroup.IpPermissions) && workerGroup.IpPermissions.length === 0, 'network_ingress_changed');
    // Terraform network/main.tf permits only TCP 8080 from the ALB to the API.
    const rules = apiGroup.IpPermissions, rule = rules?.[0], source = rule?.UserIdGroupPairs?.[0];
    requireThat(Array.isArray(rules) && rules.length === 1 && rule.IpProtocol === 'tcp' && rule.FromPort === 8080 && rule.ToPort === 8080 && rule.IpRanges?.length === 0 && rule.Ipv6Ranges?.length === 0 && rule.PrefixListIds?.length === 0 && rule.UserIdGroupPairs?.length === 1 && validId(source?.GroupId, 'sg') && source.UserId === identity.Account && !source.VpcPeeringConnectionId, 'api_network_ingress_changed');
    const alb = await aws('ec2', 'describe-security-groups', ['--group-ids', source.GroupId]);
    requireThat(alb.SecurityGroups?.length === 1 && alb.SecurityGroups[0].GroupId === source.GroupId && alb.SecurityGroups[0].GroupName === 'fss-prod-alb' && alb.SecurityGroups[0].VpcId === workerGroup.VpcId, 'api_network_source_changed');
    definitions = {};
    for (const name of names) {
      const response = await aws('ecs', 'describe-task-definition', ['--task-definition', baseline[name]?.taskDefinition || `fss-prod-${name}`, '--include', 'TAGS']);
      const d = response.taskDefinition, c = d?.containerDefinitions?.[0];
      requireThat(d?.family === `fss-prod-${name}` && d.containerDefinitions?.length === 1 && c.name === name && response.tags?.some(tag => tag.key === 'NamePrefix' && tag.value === 'fss-prod') && d.taskRoleArn === `arn:aws:iam::326255650484:role/fss-prod-${name === 'migration' ? 'migration' : imageSide(name)}-task` && d.executionRoleArn === `arn:aws:iam::326255650484:role/fss-prod-${name === 'migration' ? 'migration' : imageSide(name)}-exec`, 'definition_identity_changed');
      requireThat(c.image.startsWith(`${registry}/fss-prod-${imageSide(name)}@`) && digest.test(c.image.split('@')[1] || '') && envValue(d, 'FSS_DATABASE_HOST') === database.Endpoint.Address, 'definition_database_or_image_changed');
      requireThat(!c.environment?.some(item => /SECRET|DATABASE_URL|PASSWORD/u.test(item.name)), 'literal_credential_forbidden');
      const credentials = c.secrets?.filter(item => credentialNames.includes(item.name)) || [];
      if (name !== 'migration') requireThat(credentials.length === 1 && secret(d, 'DATABASE_SECRET_ARN')?.startsWith('arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/app-runtime-database-'), 'runtime_credential_binding_changed');
      else requireThat(credentials.length === 2 && secret(d, 'MIGRATION_DATABASE_SECRET')?.startsWith('arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/migration-database-') && secret(d, 'FSS_RUNTIME_DATABASE_SECRET_ARN')?.startsWith('arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/app-runtime-database-') && !secret(d, 'DATABASE_SECRET_ARN'), 'migration_credential_binding_changed');
      if (['api', 'worker'].includes(name)) requireThat(explicitBedrock(d), 'bedrock_not_explicit');
      if (['migration', 'operations'].includes(name)) requireThat(io.equal(c.entryPoint, ['node', 'apps/worker/src/tools/fss.ts']) && io.equal(c.command, [name === 'migration' ? 'migrate' : 'verify']), 'oneoff_cli_contract_changed');
      if (['api', 'worker'].includes(name)) {
        const sourceImage = await aws('ecr', 'describe-images', ['--repository-name', `fss-prod-${name}`, '--image-ids', `imageDigest=${c.image.split('@')[1]}`]);
        requireThat(sourceImage.imageDetails?.length === 1 && sourceImage.imageDetails[0].imageTags?.some(tag => tag === `ci-${health.build.commit}` || tag === health.build.commit), 'baseline_image_source_changed');
      }
      definitions[name] = { definition: d, tags: response.tags }; state.previousDefinitions[name] = d.taskDefinitionArn;
    }
    requireThat(['api', 'worker'].every(name => accepted(definitions[name].definition, state.fromSchema)) && secret(definitions.api.definition, 'DATABASE_SECRET_ARN') === secret(definitions.worker.definition, 'DATABASE_SECRET_ARN') && secret(definitions.operations.definition, 'DATABASE_SECRET_ARN') === secret(definitions.worker.definition, 'DATABASE_SECRET_ARN') && secret(definitions.migration.definition, 'FSS_RUNTIME_DATABASE_SECRET_ARN') === secret(definitions.api.definition, 'DATABASE_SECRET_ARN'), 'baseline_binding_incompatible');
    requireThat(['migration', 'operations'].every(name => definitions[name].definition.containerDefinitions[0].image === definitions.worker.definition.containerDefinitions[0].image), 'oneoff_baseline_image_changed');
    safety = createReleaseSafety({ aws, waitFor, now: io.now, state, save, cluster, network, owner: `fss-app-${e.GITHUB_RUN_ID}` });
    phase('observe-stored-off');
    await off(definitions.operations, state.fromSchema);
    const record = { schema: 'fss.release-record.v1', source: 'ci-gate', releaseGateReference: `ci-gate-${e.GATE_RUN_ID}-${e.COMMIT.slice(0, 12)}`, recordedAt: gate.updated_at, suite: 'pass', commit: e.COMMIT, gateRunId: e.GATE_RUN_ID, gateRunUrl: `https://github.com/${e.GITHUB_REPOSITORY}/actions/runs/${e.GATE_RUN_ID}`, imagesRunId: e.RUN_ID, artifacts: { api: images.images.api.digest, worker: images.images.worker.digest, desktopCommitStamp: e.COMMIT }, enablesSending: false };
    requireThat(Number.isFinite(Date.parse(record.recordedAt)), 'gate_time_unknown');
    const encodedRecord = Buffer.from(JSON.stringify(record)).toString('base64');
    phase('release-record');
    const put = await oneOff('operations', definitions.operations, ['admin', 'release-record', 'put', '--json-base64', encodedRecord]);
    requireThat(['created', 'existing'].includes(put.outcome) && put.reference === record.releaseGateReference, 'release_record_not_stored');
    phase('promote-images');
    const login = await io.run('aws', ['ecr', 'get-login-password', '--region', 'us-east-1']);
    await io.run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], login);
    for (const name of ['api', 'worker']) {
      await gateCheck();
      const tag = `ci-${e.COMMIT}`, expected = images.images[name].digest;
      const existing = await aws('ecr', 'batch-get-image', ['--repository-name', `fss-prod-${name}`, '--image-ids', `imageTag=${tag}`]);
      requireThat(Array.isArray(existing.images) && Array.isArray(existing.failures), 'promotion_tag_unreadable');
      if (existing.images.length === 1 && existing.failures.length === 0) {
        requireThat(existing.images[0].imageId?.imageTag === tag && existing.images[0].imageId.imageDigest === expected, 'promotion_tag_conflict');
      } else {
        requireThat(existing.images.length === 0 && existing.failures.length === 1 && existing.failures[0].failureCode === 'ImageNotFound' && existing.failures[0].imageId?.imageTag === tag, 'promotion_tag_unreadable');
        await gateCheck();
        await io.run('docker', ['buildx', 'imagetools', 'create', '--tag', `${registry}/fss-prod-${name}:${tag}`, '--prefer-index=false', `${registry}/fss-rh-${name}@${expected}`]);
      }
      const promoted = await aws('ecr', 'describe-images', ['--repository-name', `fss-prod-${name}`, '--image-ids', `imageTag=ci-${e.COMMIT}`]);
      requireThat(promoted.imageDetails?.length === 1 && promoted.imageDetails[0].imageDigest === expected, 'promotion_digest_changed');
      // This runner's pull is an early guard, not a guarantee of a later Fargate pull.
      try { await io.run('docker', ['pull', '--platform', 'linux/arm64', `${registry}/fss-prod-${name}@${expected}`]); }
      catch { throw new Error('image_pullability_guard_failed'); }
    }
    const current = {};
    for (const name of names) {
      current[name] = await register(name, nextDefinition(name, definitions[name], true));
      state.candidateDefinitions[name] = current[name].definition.taskDefinitionArn; save();
    }
    if (state.targetSchema !== state.fromSchema) {
      phase('migration-authentication'); await authenticate(current.migration);
      phase('suppress-incompatible-rollback');
      // Configuration update must NOT switch service definitions before the stop.
      await configuration(false);
      const beforeStop = await services();
      requireThat(['api', 'worker'].every(name => stable(beforeStop[name], baseline[name].desiredCount, baseline[name].taskDefinition)), 'baseline_changed_before_stop');
      phase('drain');
      const drained = await oneOff('operations', definitions.operations, ['admin', 'release', 'drain', 'on', '--minutes', '60']);
      requireThat(drained.active === true && Date.parse(drained.until) > io.now(), 'drain_not_active');
      await waitFor(async () => (await oneOff('operations', definitions.operations, ['admin', 'release', 'idle-check'])).idle === true, 'production_busy', 30);
      await authenticate(current.migration); await off(definitions.operations, state.fromSchema);
      phase('stop');
      for (const name of ['api', 'worker']) await update(name, ['--desired-count', '0']);
      await waitFor(async () => { const live = await services(); return ['api', 'worker'].every(name => live[name].desiredCount === 0 && live[name].runningCount === 0 && live[name].pendingCount === 0); }, 'services_not_stopped');
      const runningTasks = await aws('ecs', 'list-tasks', ['--cluster', cluster, '--desired-status', 'RUNNING']);
      requireThat(runningTasks.taskArns?.length === 0, 'writers_still_running');
      phase('recovery-pinned'); await pinRecovery(io.now());
      await off(definitions.operations, state.fromSchema); await authenticate(current.migration);
      const stillStopped = await services();
      requireThat(['api', 'worker'].every(name => stillStopped[name].desiredCount === 0 && stillStopped[name].runningCount === 0 && stillStopped[name].pendingCount === 0 && stillStopped[name].deploymentConfiguration?.deploymentCircuitBreaker?.rollback === false), 'writer_or_rollback_reenabled');
      phase('migrate'); state.migrationStarted = true; state.observedSchema = 'unknown'; save();
      const migrated = await oneOff('migration', current.migration, ['release-prepare']);
      requireThat(migrated.migrate?.schemaVersionAfter === state.targetSchema, 'migration_result_unknown');
    } else { phase('recovery-pinned'); await pinRecovery(io.now() - 60000); }
    phase('schema-verify');
    const verified = await oneOff('operations', current.operations, ['verify']);
    requireThat(verified.schemaVersion === state.targetSchema && verified.apiAccepts === true && verified.workerAccepts === true && verified.write === true && verified.read === true && verified.persisted === false, 'schema_verification_failed');
    state.observedSchema = state.targetSchema; save(); await off(current.operations, state.targetSchema);
    phase('deploy');
    try {
      for (const name of ['worker', 'api']) {
        await update(name, ['--desired-count', String(baseline[name].desiredCount)]);
        await waitFor(async () => { const live = await services(); return stable(live[name], baseline[name].desiredCount, current[name].definition.taskDefinitionArn); }, 'deployment_failed');
      }
      phase('runtime-verify'); await running(current);
      const liveHealth = await json('curl', ['--fail', '--silent', '--show-error', '--max-time', '15', `${e.FSS_PRODUCTION_ORIGIN}/health`]);
      requireThat(liveHealth.build?.commit === e.COMMIT && liveHealth.schema?.databaseVersion === state.targetSchema && liveHealth.schema?.accepted === true, 'runtime_binding_changed');
      phase('smoke');
      const metric = await aws('cloudwatch', 'get-metric-statistics', ['--namespace', 'FSS/fss-prod', '--metric-name', 'CanaryCompletionAgeSeconds', '--statistics', 'Maximum', '--period', '300', '--start-time', new Date(io.now() - 3600000).toISOString(), '--end-time', new Date(io.now()).toISOString()]);
      const latest = metric.Datapoints?.sort((a, b) => Date.parse(b.Timestamp) - Date.parse(a.Timestamp))[0];
      requireThat(latest && Number.isFinite(latest.Maximum) && io.now() - Date.parse(latest.Timestamp) <= 1200000 && latest.Maximum <= 300, 'canary_unavailable');
      await io.run('node', ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', 'scripts/productionSmoke.mjs', '--origin', e.FSS_PRODUCTION_ORIGIN, '--canary-age-seconds', String(latest.Maximum), '--expect-sending', envValue(definitions.api.definition, 'FSS_SENDING_ENABLED') === 'true' ? 'enabled' : 'disabled']);
      await off(current.operations, state.targetSchema);
      const readback = await oneOff('operations', current.operations, ['admin', 'release-record', 'put', '--json-base64', encodedRecord]);
      requireThat(readback.outcome === 'existing' && readback.reference === record.releaseGateReference, 'release_record_readback_failed');
      if (state.migrationStarted) {
        // New candidate is now the only completed deployment, so native rollback can no longer select the old schema.
        await running(current);
        phase('restore-compatible-circuit-breaker');
        for (const name of ['api', 'worker']) await update(name, ['--deployment-configuration', JSON.stringify(baseline[name].deploymentConfiguration)]);
        const restored = await services();
        requireThat(['api', 'worker'].every(name => io.equal(restored[name].deploymentConfiguration, baseline[name].deploymentConfiguration)), 'circuit_breaker_restore_failed');
        const undrained = await oneOff('operations', current.operations, ['admin', 'release', 'drain', 'off']);
        requireThat(undrained.active === false, 'drain_clear_failed');
      }
    } catch (error) {
      if (!state.migrationStarted && ['deployment_failed', 'runtime_binding_changed', 'canary_unavailable', 'command_node_failed'].includes(error.message)) await compatibleRollback(current);
      throw error;
    }
    state.phase = 'completed'; state.outcome = 'completed'; save(); return state;
  } catch (error) {
    state.outcome = state.writesStarted ? 'repair-required' : 'refused';
    state.reason = /^[a-z][a-z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'release_failed';
    if (state.migrationStarted && state.phase === 'migrate') state.observedSchema = 'unknown';
    save(); return state;
  }
}

// Trusted always-step only: normalize interrupted local status, never issue a release action.
export function finalizeInterrupted(state) {
  requireThat(state && typeof state === 'object' && typeof state.writesStarted === 'boolean', 'status_unreadable');
  if (['completed', 'repair-required', 'refused'].includes(state.outcome)) return state;
  const result = { ...state, outcome: state.writesStarted ? 'repair-required' : 'refused', reason: 'release_interrupted' };
  if (state.migrationStarted && state.phase === 'migrate') result.observedSchema = 'unknown';
  return result;
}
function writeStatus(path, state) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  const status = value('--status');
  requireThat(args.includes('--status') && status, 'status_path_required');
  mkdirSync(dirname(status), { recursive: true, mode: 0o700 });
  if (args.includes('--finalize')) {
    requireThat(args.length === 3 && args[0] === '--finalize' && args[1] === '--status', 'finalizer_arguments_refused');
    writeStatus(status, finalizeInterrupted(JSON.parse(readFileSync(status, 'utf8'))));
    return;
  }
  const files = { images: value('--images'), upgradeBinding: value('--upgrade-binding'), upgradeEvidence: value('--upgrade-evidence') };
  const { isDeepStrictEqual } = await import('node:util');
  const io = {
    now: () => Date.now(), equal: isDeepStrictEqual,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    save: state => writeStatus(status, state),
    read: key => key === 'upgradeEvidence' ? readFileSync(files[key], 'utf8') : JSON.parse(readFileSync(files[key], 'utf8')),
    async run(program, values, input) {
      try {
        const child = execute(program, values, { timeout: 180000, maxBuffer: 8000000, env: process.env });
        child.child.stdin?.end(input);
        return (await child).stdout;
      } catch { throw new Error(`command_${program.replaceAll(/[^a-z]/gu, '')}_failed`); }
    },
  };
  const result = await runRelease(io, process.env);
  process.exitCode = result.outcome === 'completed' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
