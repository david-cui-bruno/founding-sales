// One reviewed saved-plan path in the existing production workflow. The encrypted
// transport reuses diagnostic-plan seal/decrypt; this is deployment, not feature consent.
import { createHash, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { validateConfiguration, backendPolicy, validatePolicy, proposeExistingPolicy, stageMapping } from './release-backend-contract.mjs';
const [mode, ...args] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
let status, statusPath, preparationDirectory;
function save() { if (statusPath) writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 }); }
function command(name, values, options = {}) {
  const result = spawnSync(name, values, { encoding: 'utf8', env: process.env, cwd: options.cwd, maxBuffer: 20_000_000, timeout: options.timeout || 600_000 });
  if (result.status !== 0) throw new Error(options.reason || 'operation_failed');
  return result.stdout;
}
function script(name, values) { return command(resolve('infra/scripts', name), values, { timeout: 4_800_000, reason: `${name.replace('.sh', '')}_failed` }); }
function aws(values) { return JSON.parse(command(process.env.FSS_REHEARSAL_AWS_COMMAND || 'aws', [...values, '--output', 'json'], { reason: 'cloud_read_failed' })); }
const terraform = (values, reason) => command(process.env.TERRAFORM || 'terraform', ['-chdir=infra/roots/production', ...values], { timeout: 4_800_000, reason });
function validate(file, fingerprint) {
  const bytes = readFileSync(file);
  if (!/^[0-9a-f]{64}$/u.test(fingerprint || '') || hash(bytes) !== fingerprint) throw new Error('reviewed_manifest_changed');
  const value = JSON.parse(bytes);
  if (value.version !== 'fss.reviewed-production-plan.v1' || value.commit !== process.env.COMMIT || !/^[0-9a-f]{40}$/u.test(value.from || '') || !/^[0-9a-f]{40}$/u.test(value.commit || '') || String(value.imagesRunId) !== process.env.RUN_ID || String(value.gateRunId) !== process.env.GATE_RUN_ID || !Number.isInteger(value.fromSchema) || !Number.isInteger(value.toSchema) || value.toSchema < value.fromSchema || !/^[0-9a-f]{64}$/u.test(value.planSha256 || '') || !/^[0-9a-f]{64}$/u.test(value.recipientPublicKeySha256 || '') || !/^sha256:[0-9a-f]{64}$/u.test(value.digests?.api || '') || !/^sha256:[0-9a-f]{64}$/u.test(value.digests?.worker || '') || !value.bindings?.apiTaskDefinition || !value.bindings?.workerTaskDefinition) throw new Error('reviewed_source_binding_changed');
  return value;
}
function gate() {
  if (process.env.FSS_RELEASE_HOLD !== 'false') throw new Error('release_held');
  script('deploy.sh', ['ci', 'gate', '--commit', process.env.COMMIT, '--gate-run-id', process.env.GATE_RUN_ID]);
}
function phase(name, action, write = false) {
  status.phase = name; status.outcome = 'started'; save();
  if (write) { gate(); status.writesStarted = true; save(); }
  const result = action(); status.outcome = 'completed'; save(); return result;
}
function identity(kind) {
  const value = aws(['sts', 'get-caller-identity']);
  const account = process.env.FSS_PRODUCTION_ACCOUNT_ID || '326255650484';
  const role = kind === 'plan' ? 'fss-prod-ci-plan' : 'fss-prod-deploy';
  if (value.Account !== account || !new RegExp(`^arn:aws:sts::${account}:assumed-role/${role}/[A-Za-z0-9_-]+$`, 'u').test(value.Arn) || (process.env.AWS_REGION || 'us-east-1') !== 'us-east-1') throw new Error('reviewed_identity_mismatch');
  return account;
}
function current() {
  const body = command('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', `${process.env.FSS_PRODUCTION_ORIGIN}/health`], { reason: 'baseline_unavailable' });
  const value = JSON.parse(body);
  if (value.status !== 'serving' || value.schema?.accepted !== true || !Number.isInteger(value.schema?.databaseVersion) || !/^[0-9a-f]{40}$/u.test(value.build?.commit || '')) throw new Error('baseline_unavailable');
  const services = aws(['ecs', 'describe-services', '--cluster', 'fss-prod-cluster', '--services', 'fss-prod-api', 'fss-prod-worker']).services;
  if (services?.length !== 2 || services.some(service => service.status !== 'ACTIVE' || service.desiredCount < 1 || service.runningCount !== service.desiredCount || service.pendingCount !== 0)) throw new Error('baseline_not_stable');
  const bindings = Object.fromEntries(services.map(service => [service.serviceName === 'fss-prod-api' ? 'apiTaskDefinition' : service.serviceName === 'fss-prod-worker' ? 'workerTaskDefinition' : 'foreign', service.taskDefinition]));
  if (!bindings.apiTaskDefinition || !bindings.workerTaskDefinition || bindings.foreign) throw new Error('baseline_service_binding_changed');
  return { from: value.build.commit, fromSchema: value.schema.databaseVersion, bindings };
}
function backupReadiness() {
  const instance = aws(['rds', 'describe-db-instances', '--db-instance-identifier', 'fss-prod-pg']).DBInstances?.[0];
  if (instance?.DBInstanceIdentifier !== 'fss-prod-pg' || instance.DBInstanceStatus !== 'available' || instance.BackupRetentionPeriod !== 35 || typeof instance.LatestRestorableTime !== 'string' || !Number.isFinite(Date.parse(instance.LatestRestorableTime))) throw new Error('reviewed_backup_unavailable');
  return { retentionDays: instance.BackupRetentionPeriod, earliestRestorableTime: null, latestRestorableTime: instance.LatestRestorableTime, restoreTested: false };
}
function imageDocument(file) {
  const value = read(file);
  if (value.schema !== 'fss.image-digests.v1' || value.commit !== process.env.COMMIT || String(value.workflowRunId) !== process.env.RUN_ID || String(value.workflowRunAttempt) !== process.env.RUN_ATTEMPT) throw new Error('reviewed_image_provenance_changed');
  for (const name of ['api', 'worker']) if (value.images?.[name]?.repository !== `fss-rh-${name}` || value.images[name].tag !== `ci-${process.env.COMMIT}` || !/^sha256:[0-9a-f]{64}$/u.test(value.images[name].digest || '') || value.images[name].schemaRange?.minimum !== value.images[name].schemaRange?.maximum) throw new Error('reviewed_image_binding_changed');
  if (value.images.api.schemaRange.minimum !== value.images.worker.schemaRange.minimum) throw new Error('reviewed_schema_binding_changed');
  return value;
}
try {
  if (mode === 'backend-proposal') {
    if (args.length !== 1) throw new Error('backend_baseline_required');
    const bytes = readFileSync(args[0]);
    const proposal = proposeExistingPolicy(JSON.parse(bytes));
    process.stdout.write(JSON.stringify({ ...proposal, baselineSha256: hash(bytes), proposedPolicySha256: hash(JSON.stringify(proposal.proposed.policy)) }, null, 2) + '\n');
  } else if (mode === 'backend-policy-check') {
    if (args.length !== 2) throw new Error('backend_policy_required');
    validatePolicy(read(args[1]), args[0]);
    process.stdout.write('Source policy contract verified, not effective live authorization.\n');
  } else if (mode === 'backend-contract') {
    if (args.length !== 1) throw new Error('backend_stage_required');
    const mapping = ['prepare', 'execute', 'local-plan'].includes(args[0]) ? validateConfiguration(args[0]) : stageMapping(args[0]);
    process.stdout.write(JSON.stringify({ ...mapping, policy: mapping.backend ? backendPolicy(args[0]) : null, operationalApproval: false }, null, 2) + '\n');
  } else if (mode === 'validate') { validate(args[0], args[1]); process.stdout.write('Reviewed manifest verified; no cloud or deployment operations.\n'); }
  else if (mode === 'prepare') {
    if (args.length !== 5) throw new Error('backend_unexpected_arguments');
    validateConfiguration('prepare');
    const [digestsFile, publicKeyFile, evidenceFile, bindingFile, directory] = args;
    preparationDirectory = directory;
    mkdirSync(join(directory, 'public'), { recursive: true, mode: 0o700 }); mkdirSync(join(directory, 'private'), { recursive: true, mode: 0o700 });
    const recipient = createPublicKey(readFileSync(publicKeyFile));
    if (recipient.asymmetricKeyType !== 'rsa' || recipient.asymmetricKeyDetails.modulusLength < 3072) throw new Error('reviewed_recipient_invalid');
    const recipientPublicKeySha256 = hash(recipient.export({ type: 'spki', format: 'der' }));
    const account = identity('plan');
    const baseline = current(); const backup = backupReadiness();
    const images = imageDocument(digestsFile); const toSchema = images.images.api.schemaRange.minimum;
    if (toSchema !== baseline.fromSchema) {
      const evidenceBinding = read(bindingFile);
      if (evidenceBinding.from !== baseline.from || evidenceBinding.to !== process.env.COMMIT || !readFileSync(evidenceFile, 'utf8').includes(`PASS  schema ${baseline.fromSchema} → ${toSchema}`)) throw new Error('reviewed_upgrade_evidence_changed');
    }
    const variables = { assume_deployment_role: false, api_image: `${account}.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@${images.images.api.digest}`, worker_image: `${account}.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@${images.images.worker.digest}`, api_schema_range: { min: toSchema, max: toSchema }, worker_schema_range: { min: toSchema, max: toSchema } };
    const variableFile = resolve(directory, 'private', 'variables.json'); writeFileSync(variableFile, JSON.stringify(variables), { mode: 0o600 });
    const planFile = resolve(directory, 'private', 'release.tfplan');
    terraform(['init', '-input=false', '-reconfigure', '-backend-config=backend.hcl'], 'reviewed_init_failed');
    terraform(['plan', '-input=false', '-no-color', `-var-file=${variableFile}`, `-out=${planFile}`], 'reviewed_plan_failed');
    const plan = JSON.parse(terraform(['show', '-json', planFile], 'reviewed_plan_read_failed'));
    const state = JSON.parse(terraform(['state', 'pull'], 'reviewed_state_read_failed'));
    const after = current(); if (after.from !== baseline.from || after.fromSchema !== baseline.fromSchema || after.bindings.apiTaskDefinition !== baseline.bindings.apiTaskDefinition || after.bindings.workerTaskDefinition !== baseline.bindings.workerTaskDefinition) throw new Error('reviewed_baseline_changed_during_plan');
    const changes = (plan.resource_changes || []).filter(change => change.change.actions.join() !== 'no-op').map(change => ({ address: change.address, actions: change.change.actions }));
    const manifest = { version: 'fss.reviewed-production-plan.v1', commit: process.env.COMMIT, ...baseline, toSchema, planSha256: hash(readFileSync(planFile)), recipientPublicKeySha256, imagesRunId: process.env.RUN_ID, gateRunId: process.env.GATE_RUN_ID, digests: { api: images.images.api.digest, worker: images.images.worker.digest }, stateLineage: state.lineage, stateSerial: state.serial, backup, changes, root: 'infra/roots/production', activationAllowed: false };
    const manifestFile = resolve(directory, 'public', 'manifest.json'); writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const fingerprint = hash(readFileSync(manifestFile)); writeFileSync(resolve(directory, 'public', 'manifest.sha256'), fingerprint + '\n', { mode: 0o600 });
    command(process.execPath, [resolve('infra/scripts/diagnostic-plan.mjs'), 'seal', planFile, manifestFile, publicKeyFile, recipientPublicKeySha256, resolve(directory, 'public', 'plan.encrypted.json')]);
    process.stdout.write(`Reviewed plan prepared: manifest ${fingerprint}; ${changes.length} changed resources; schema ${baseline.fromSchema} → ${toSchema}. No resource apply or activation.\n`);
    rmSync(join(directory, 'private'), { recursive: true, force: true });
  } else if (mode === 'execute') {
    if (args.length !== 6) throw new Error('backend_unexpected_arguments');
    const [manifestFile, fingerprint, envelopeFile, privateKeyFile, digestsFile, directory] = args;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); statusPath = join(directory, 'status.json');
    status = { phase: 'readiness', outcome: 'pending', writesStarted: false, schema: 'unobserved', recovery: 'Inspect actual state and committed schema before forward repair. No automatic schema rollback or blind replay.' }; save();
    if (process.env.FSS_RELEASE_HOLD !== 'false') throw new Error('release_held');
    validateConfiguration('execute');
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_WORKFLOW_REF !== 'david-cui-bruno/founding-sales/.github/workflows/greenfield-deploy.yml@refs/heads/main' || process.env.FSS_REHEARSAL_AWS_COMMAND || process.env.FSS_REHEARSAL_DRY_RUN === '1' || process.env.FSS_PROD_FORCE_IDLE === '1' || Object.keys(process.env).some(key => key.startsWith('FSS_RELEASE_OUTPUT_'))) throw new Error('reviewed_workflow_required');
    const manifest = validate(manifestFile, fingerprint); identity('execute'); gate();
    const images = imageDocument(digestsFile);
    if (images.images.api.digest !== manifest.digests.api || images.images.worker.digest !== manifest.digests.worker || images.images.api.schemaRange.minimum !== manifest.toSchema) throw new Error('reviewed_images_changed');
    const baseline = current(); if (baseline.from !== manifest.from || baseline.fromSchema !== manifest.fromSchema || baseline.bindings.apiTaskDefinition !== manifest.bindings.apiTaskDefinition || baseline.bindings.workerTaskDefinition !== manifest.bindings.workerTaskDefinition) throw new Error('reviewed_baseline_changed');
    status.schema = baseline.fromSchema; status.backup = backupReadiness(); save();
    const plan = resolve(directory, 'release.tfplan');
    phase('decrypt-saved-plan', () => command(process.execPath, [resolve('infra/scripts/diagnostic-plan.mjs'), 'decrypt', envelopeFile, manifestFile, privateKeyFile, plan]));
    if (hash(readFileSync(plan)) !== manifest.planSha256) throw new Error('reviewed_plan_changed');
    phase('initialize-existing-root', () => terraform(['init', '-input=false', '-reconfigure', '-backend-config=backend.hcl'], 'reviewed_init_failed'));
    const state = JSON.parse(terraform(['state', 'pull'], 'reviewed_state_read_failed'));
    if (state.lineage !== manifest.stateLineage || state.serial !== manifest.stateSerial) throw new Error('reviewed_state_changed');
    const planJson = JSON.parse(terraform(['show', '-json', plan], 'reviewed_plan_read_failed'));
    if (planJson.variables?.assume_deployment_role?.value !== false) throw new Error('backend_provider_mapping_changed');
    if (planJson.variables?.api_image?.value !== `${process.env.FSS_PRODUCTION_ACCOUNT_ID || '326255650484'}.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@${manifest.digests.api}` || planJson.variables?.worker_image?.value !== `${process.env.FSS_PRODUCTION_ACCOUNT_ID || '326255650484'}.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@${manifest.digests.worker}`) throw new Error('reviewed_plan_images_changed');
    process.env.FSS_REHEARSAL_REPORTS = resolve(directory);
    const record = resolve(directory, 'release-record.json');
    const recordArgs = ['from-ci', process.env.GATE_RUN_ID, manifest.commit, manifest.digests.api, manifest.digests.worker, '--images-run', process.env.RUN_ID, '--out', record];
    const configuration = JSON.parse(terraform(['output', '-json', 'deployment_plan'], 'reviewed_current_plan_unavailable'));
    const workerDefinition = aws(['ecs', 'describe-task-definition', '--task-definition', baseline.bindings.workerTaskDefinition]).taskDefinition;
    if (workerDefinition.containerDefinitions?.[0]?.environment?.find(entry => entry.name === 'FSS_SENDING_ENABLED')?.value === 'true') recordArgs.push('--enables-sending');
    phase('build-release-record', () => script('record.sh', recordArgs));
    phase('store-release-record', () => script('record.sh', ['put', 'infra/roots/production', 'fss-prod', '--api-digest', manifest.digests.api, '--worker-digest', manifest.digests.worker, '--release-record', record]), true);
    phase('promote', () => script('images.sh', ['promote', digestsFile, '--gate-run-id', process.env.GATE_RUN_ID]), true);
    const schemaChange = manifest.toSchema !== manifest.fromSchema;
    if (schemaChange) phase('drain-idle-stop', () => script('stop.sh', ['infra/roots/production', 'fss-prod', '--environment', 'production', '--worker-digest', manifest.digests.worker]), true);
    // Terraform itself rejects a changed state serial; exact encrypted saved bytes are applied.
    phase('apply-saved-plan', () => terraform(['apply', '-input=false', '-no-color', plan], 'reviewed_apply_unknown'), true);
    phase('migrate-verify-restart', () => script('deploy.sh', ['release', 'infra/roots/production', 'fss-prod', ...(schemaChange ? ['--schema-change'] : []), '--api-digest', manifest.digests.api, '--worker-digest', manifest.digests.worker]), true);
    status.schema = manifest.toSchema; save();
    phase('release-record-readback', () => script('record.sh', ['read-back', 'infra/roots/production', 'fss-prod', '--api-digest', manifest.digests.api, '--worker-digest', manifest.digests.worker, '--release-record', record]), true);
    phase('smoke', () => {
      const age = /^canary_age=([0-9.]+)$/mu.exec(script('deploy.sh', ['ci', 'canary']))?.[1]; if (!age) throw new Error('reviewed_canary_unavailable');
      command(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', resolve('scripts/productionSmoke.mjs'), '--origin', process.env.FSS_PRODUCTION_ORIGIN, '--canary-age-seconds', age, '--expect-sending', recordArgs.includes('--enables-sending') ? 'enabled' : 'disabled', '--json'], { reason: 'reviewed_smoke_failed' });
      const live = current(); if (live.from !== manifest.commit || live.fromSchema !== manifest.toSchema) throw new Error('reviewed_readback_changed');
    });
    status.phase = 'verified'; status.outcome = 'completed'; status.previousDeclaredCounts = { api: configuration.api?.declared_desired_count, worker: configuration.worker?.declared_desired_count }; save();
    rmSync(plan);
  } else throw new Error('invalid_reviewed_command');
} catch (error) {
  if (preparationDirectory) {
    rmSync(join(preparationDirectory, 'private'), { recursive: true, force: true });
    rmSync(join(preparationDirectory, 'public'), { recursive: true, force: true });
  }
  if (status) { status.outcome = error.message === 'release_held' ? 'held' : status.writesStarted ? 'repair-required' : 'refused'; status.reason = error.message; if (status.phase === 'migrate-verify-restart') status.schema = 'unknown-after-migration-attempt'; save(); }
  console.error(`Reviewed release refused: ${error.message}. No automatic retry or schema rollback.`); process.exitCode = 1;
}
