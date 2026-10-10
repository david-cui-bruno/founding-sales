#!/usr/bin/env node
/** Private current-object saved-plan handoff; no apply, provider or authority commands. */
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const bytes = (value) => Buffer.from(JSON.stringify(value));
const HASH = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function refuse(code = 'invalid_handoff') {
  throw new Error(code);
}
function fields(value, expected) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...expected].sort().join()
  )
    refuse();
}
function text(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) refuse();
  return value;
}
function date(value) {
  const parsed = Date.parse(value);
  if (
    typeof value !== 'string' ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  )
    refuse();
  return parsed;
}
function binding(value) {
  text(value.prefix, /^fss-rh-[a-z0-9][a-z0-9-]{1,16}[a-z0-9]$/u);
  const suffix = value.prefix.slice(7);
  text(value.environmentId, UUID);
  if (
    value.databaseName !== `fss_diagnostic_${suffix.replaceAll('-', '_')}` ||
    value.apiHostname !== `${suffix}.rehearsal.usecallie.com`
  )
    refuse();
  fields(value.state, ['bucket', 'key', 'kmsKeyArn']);
  if (
    value.state.bucket !== 'callie-sourcing-tfstate-326255650484' ||
    value.state.key !==
      `fss/greenfield/rehearsal/${value.prefix}/terraform.tfstate` ||
    value.state.kmsKeyArn !==
      'arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404'
  )
    refuse();
  text(value.sourceCommit, /^[0-9a-f]{40}$/u);
  text(value.imageBuildCommit, /^[0-9a-f]{40}$/u);
  fields(value.images, ['api', 'worker']);
  for (const digest of Object.values(value.images))
    text(digest, /^sha256:[0-9a-f]{64}$/u);
  if (value.images.api === value.images.worker) refuse();
  text(value.configurationSha256, HASH);
  fields(value.retention, ['acknowledged', 'approvalRef']);
  if (value.retention.acknowledged !== true)
    refuse('retention_approval_required');
  text(value.retention.approvalRef, /^[A-Za-z0-9:._/#+-]{1,200}$/u);
}
export function parseLease(value) {
  fields(value, [
    'schemaVersion',
    'purpose',
    'leaseId',
    'environmentId',
    'prefix',
    'databaseName',
    'apiHostname',
    'state',
    'sourceCommit',
    'imageBuildCommit',
    'images',
    'configurationSha256',
    'manifestSha256',
    'planSha256',
    'envelopeSha256',
    'objectKey',
    'approvedAt',
    'startDeadline',
    'hardDeadline',
    'cleanupAt',
    'owner',
    'fallbackOwner',
    'proposedMaxUsd',
    'retention',
    'google',
    'requiredSecretEntries',
    'bootstrapAdminEmail',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.purpose !== 'acquisition_acceptance_lifecycle'
  )
    refuse();
  binding(value);
  text(
    value.bootstrapAdminEmail,
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u,
  );
  text(value.leaseId, UUID);
  for (const key of ['manifestSha256', 'planSha256', 'envelopeSha256'])
    text(value[key], HASH);
  if (value.objectKey !== objectKey(value)) refuse();
  const approved = date(value.approvedAt),
    start = date(value.startDeadline),
    hard = date(value.hardDeadline),
    cleanup = date(value.cleanupAt);
  if (
    !(
      approved < start &&
      start <= cleanup &&
      cleanup <= hard - 3600000 &&
      hard <= approved + 14400000
    )
  )
    refuse('unbounded_lease');
  for (const name of [value.owner, value.fallbackOwner])
    text(name, /^[A-Za-z][A-Za-z .'-]{1,79}$/u);
  if (
    value.owner === value.fallbackOwner ||
    typeof value.proposedMaxUsd !== 'number' ||
    value.proposedMaxUsd <= 0 ||
    value.proposedMaxUsd > 5
  )
    refuse();
  fields(value.google, [
    'projectId',
    'oidcClientId',
    'gmailClientId',
    'redirectUris',
    'inputsReviewRef',
    'workspacePolicyReviewRef',
  ]);
  text(value.google.projectId, /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u);
  for (const key of ['oidcClientId', 'gmailClientId'])
    text(
      value.google[key],
      /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u,
    );
  if (value.google.oidcClientId === value.google.gmailClientId) refuse();
  fields(value.google.redirectUris, ['oidc', 'gmail']);
  if (
    value.google.redirectUris.oidc !==
      `https://${value.apiHostname}/auth/google/callback` ||
    value.google.redirectUris.gmail !==
      `https://${value.apiHostname}/oauth/gmail/callback`
  )
    refuse();
  for (const key of ['inputsReviewRef', 'workspacePolicyReviewRef'])
    text(value.google[key], /^[A-Za-z0-9:._/#+-]{1,200}$/u);
  if (
    !Array.isArray(value.requiredSecretEntries) ||
    value.requiredSecretEntries.join() !==
      'google-oidc-client,google-gmail-oauth-client'
  )
    refuse();
  return value;
}
export function hashLease(value) {
  return sha(bytes(parseLease(value)));
}
export function readReviewedLease(leasePath, expectedLeaseSha256) {
  return parseLease(approvedFile(leasePath, expectedLeaseSha256));
}
function objectKey(value) {
  return `fss/greenfield/rehearsal/${value.prefix}/diagnostic/plans/${value.planSha256}/envelope.json`;
}
function parseStorageApproval(value) {
  fields(value, [
    'schemaVersion',
    'purpose',
    'approvalId',
    'approvedAt',
    'expiresAt',
    'environmentId',
    'prefix',
    'databaseName',
    'apiHostname',
    'state',
    'sourceCommit',
    'imageBuildCommit',
    'images',
    'configurationSha256',
    'retention',
  ]);
  if (value.schemaVersion !== 1 || value.purpose !== 'diagnostic_plan_storage')
    refuse();
  binding(value);
  text(value.approvalId, UUID);
  const approved = date(value.approvedAt),
    expires = date(value.expiresAt);
  if (
    !(
      approved <= Date.now() &&
      Date.now() < expires &&
      expires <= approved + 14400000
    )
  )
    refuse('storage_approval_expired');
  return value;
}
function approvedFile(path, expectedHash) {
  text(expectedHash, HASH);
  const data = readFileSync(path);
  if (sha(data) !== expectedHash) refuse('approval_hash_changed');
  return JSON.parse(data.toString('utf8'));
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    refuse('private_directory_required');
}
function write(path, value) {
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
}
function freshDestination(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return path;
    throw error;
  }
  refuse('destination_exists');
}
function aws(args) {
  try {
    if (args[0] === 's3api' && args[1] === 'get-object')
      freshDestination(args.at(-1));
    return execFileSync('aws', [...args, '--region', 'us-east-1'], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    refuse('cloud_command_refused');
  }
}
function identity() {
  const current = JSON.parse(
    aws(['sts', 'get-caller-identity', '--output', 'json']),
  );
  if (
    current.Account !== '326255650484' ||
    !/^arn:aws:sts::326255650484:assumed-role\/fss-rh-deploy\/[A-Za-z0-9+=,.@_-]+$/u.test(
      current.Arn,
    )
  )
    refuse('normal_role_required');
}
function context(meta) {
  return {
    purpose: 'diagnostic_plan_storage',
    stateKey: meta.state.key,
    planSha256: meta.planSha256,
    manifestSha256: meta.manifestSha256,
    configurationSha256: meta.configurationSha256,
  };
}
function validatePayload(
  meta,
  manifest,
  configuration,
  plan,
  manifestBytes = bytes(manifest),
) {
  fields(configuration, [
    'assume_deployment_role',
    'bootstrap',
    'name_prefix',
    'availability_zones',
    'api_image',
    'worker_image',
    'certificate_arn',
    'api_hostname',
    'api_schema_range',
    'worker_schema_range',
    'crm_acquisition_diagnostic',
  ]);
  if (
    configuration.assume_deployment_role !== false ||
    configuration.api_schema_range?.min !== 90 ||
    configuration.api_schema_range?.max !== 90 ||
    configuration.worker_schema_range?.min !== 90 ||
    configuration.worker_schema_range?.max !== 90 ||
    !configuration.api_image.endsWith(`@${meta.images.api}`) ||
    !configuration.worker_image.endsWith(`@${meta.images.worker}`)
  )
    refuse('payload_binding_changed');
  if (
    sha(bytes(configuration)) !== meta.configurationSha256 ||
    sha(manifestBytes) !== meta.manifestSha256 ||
    sha(plan) !== meta.planSha256
  )
    refuse('payload_hash_changed');
  if (
    meta.observedProposal &&
    (manifest.workflowRunId !== meta.observedProposal.runId ||
      manifest.workflowRunAttempt !== meta.observedProposal.attempt)
  )
    refuse('payload_binding_changed');
  if (
    manifest.planSha256 !== meta.planSha256 ||
    manifest.applySupported !== false
  )
    refuse('payload_binding_changed');
  if (
    manifest.commit !== meta.sourceCommit ||
    manifest.imageBuildCommit !== meta.imageBuildCommit ||
    manifest.apiDigest !== meta.images.api ||
    manifest.workerDigest !== meta.images.worker ||
    manifest.stateKey !== meta.state.key ||
    manifest.configurationSha256 !== meta.configurationSha256
  )
    refuse('payload_binding_changed');
  if (
    manifest.diagnostic?.environmentId !== meta.environmentId ||
    manifest.diagnostic?.prefix !== meta.prefix ||
    manifest.diagnostic?.databaseName !== meta.databaseName ||
    manifest.diagnostic?.apiHostname !== meta.apiHostname ||
    manifest.diagnostic?.schema !== 90 ||
    manifest.diagnostic?.sendingEnabled !== false ||
    manifest.activationAllowed !== false
  )
    refuse('payload_binding_changed');
  if (
    configuration.name_prefix !== meta.prefix ||
    configuration.api_hostname !== meta.apiHostname ||
    configuration.bootstrap !== true ||
    configuration.crm_acquisition_diagnostic?.environment_id !==
      meta.environmentId ||
    configuration.crm_acquisition_diagnostic?.database_name !==
      meta.databaseName
  )
    refuse('payload_binding_changed');
}
export async function preparePrivateProposal({
  approvalPath,
  expectedApprovalSha256,
  configurationInputPath,
  outDirectory,
  root,
}) {
  const approval = parseStorageApproval(
    approvedFile(approvalPath, expectedApprovalSha256),
  );
  const input = read(configurationInputPath);
  if (
    input.environmentId !== approval.environmentId ||
    input.databaseName !== approval.databaseName ||
    input.apiHostname !== approval.apiHostname ||
    process.env.GITHUB_SHA !== approval.sourceCommit ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  )
    refuse('proposal_run_changed');
  privateDirectory(outDirectory);
  const { prepareDiagnosticPlan } = await import('./diagnostic-plan.mjs');
  let receipt;
  await prepareDiagnosticPlan(configurationInputPath, outDirectory, root, {
    validatedConfigurationConsumer: async ({ configuration }) => {
      if (
        sha(bytes(configuration)) !== approval.configurationSha256 ||
        !configuration.api_image.endsWith(`@${approval.images.api}`) ||
        !configuration.worker_image.endsWith(`@${approval.images.worker}`)
      )
        refuse('payload_binding_changed');
      reserveStorageIntent({
        approvalPath,
        expectedApprovalSha256,
        outDirectory: resolve(outDirectory, 'storage-intent'),
      });
    },
    privatePlanConsumer: async ({ planPath, manifestPath, configuration }) => {
      const configurationPath = resolve(
        outDirectory,
        'configuration.private.json',
      );
      write(configurationPath, bytes(configuration));
      try {
        receipt = escrowPlan({
          approvalPath,
          expectedApprovalSha256,
          planPath,
          manifestPath,
          configurationPath,
          outDirectory: resolve(outDirectory, 'escrow'),
        });
      } finally {
        rmSync(configurationPath, { force: true });
      }
    },
  });
  if (!receipt) refuse('private_preparation_unavailable');
  return receipt;
}
export function escrowPlan({
  approvalPath,
  expectedApprovalSha256,
  planPath,
  manifestPath,
  configurationPath,
  outDirectory,
}) {
  const approval = parseStorageApproval(
    approvedFile(approvalPath, expectedApprovalSha256),
  );
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_SHA !== approval.sourceCommit
  )
    refuse('proposal_run_changed');
  privateDirectory(outDirectory);
  const plan = readFileSync(planPath),
    manifestBytes = readFileSync(manifestPath),
    manifest = JSON.parse(manifestBytes),
    configuration = read(configurationPath);
  const execution = observeExecution(approval.sourceCommit);
  const meta = {
    ...approval,
    observedProposal: execution,
    storageApprovalSha256: expectedApprovalSha256,
    planSha256: sha(plan),
    manifestSha256: sha(manifestBytes),
  };
  validatePayload(meta, manifest, configuration, plan, manifestBytes);
  if (
    manifest.workflowRunId !== execution.runId ||
    manifest.workflowRunAttempt !== execution.attempt
  )
    refuse('proposal_run_changed');
  identity();
  const observed = readIntentRecord(
    approval,
    expectedApprovalSha256,
    'storage',
    outDirectory,
  );
  if (JSON.stringify(observed.execution) !== JSON.stringify(execution))
    refuse('proposal_run_changed');
  const key = objectKey(meta),
    existingPath = resolve(outDirectory, 'existing.envelope.json');
  // Head distinguishes a missing object from permission/network failures; no failed read is treated as absence.
  const listed = JSON.parse(
    aws([
      's3api',
      'list-objects-v2',
      '--bucket',
      approval.state.bucket,
      '--prefix',
      key,
      '--output',
      'json',
    ]),
  );
  if (
    Array.isArray(listed.Contents) &&
    listed.Contents.some((entry) => entry.Key === key)
  ) {
    aws([
      's3api',
      'get-object',
      '--bucket',
      approval.state.bucket,
      '--key',
      key,
      existingPath,
    ]);
    const existing = read(existingPath);
    if (JSON.stringify(existing.metadata) !== JSON.stringify(meta))
      refuse('escrow_conflict');
    decryptPayload(existing, meta, outDirectory);
    const receipt = {
      observedCurrentObject: true,
      objectKey: key,
      envelopeSha256: sha(readFileSync(existingPath)),
      planSha256: meta.planSha256,
      manifestSha256: meta.manifestSha256,
      configurationSha256: meta.configurationSha256,
      approvalSha256: expectedApprovalSha256,
      applyPerformed: false,
      retentionErasureSupported: false,
    };
    write(
      resolve(outDirectory, 'escrow-receipt.json'),
      `${JSON.stringify(receipt)}\n`,
    );
    return receipt;
  }
  const generated = JSON.parse(
    aws([
      'kms',
      'generate-data-key',
      '--key-id',
      approval.state.kmsKeyArn,
      '--key-spec',
      'AES_256',
      '--encryption-context',
      JSON.stringify(context(meta)),
      '--output',
      'json',
    ]),
  );
  const dataKey = Buffer.from(generated.Plaintext, 'base64');
  if (dataKey.length !== 32 || generated.KeyId !== approval.state.kmsKeyArn) {
    dataKey.fill(0);
    refuse('data_key_changed');
  }
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  cipher.setAAD(bytes(meta));
  const payload = bytes({
    plan: plan.toString('base64'),
    manifestBytes: manifestBytes.toString('base64'),
    configuration,
  });
  let encrypted;
  try {
    encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  } finally {
    dataKey.fill(0);
  }
  const packet = {
    version: 'fss.private-plan.v1',
    metadata: meta,
    encryptedDataKey: generated.CiphertextBlob,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
  const packetPath = resolve(outDirectory, 'envelope.private.json');
  write(packetPath, bytes(packet));
  aws([
    's3api',
    'put-object',
    '--bucket',
    approval.state.bucket,
    '--key',
    key,
    '--body',
    packetPath,
    '--if-none-match',
    '*',
    '--server-side-encryption',
    'aws:kms',
    '--ssekms-key-id',
    approval.state.kmsKeyArn,
    '--output',
    'json',
  ]);
  const readbackPath = resolve(outDirectory, 'readback.envelope.private.json');
  aws([
    's3api',
    'get-object',
    '--bucket',
    approval.state.bucket,
    '--key',
    key,
    readbackPath,
  ]);
  if (sha(readFileSync(readbackPath)) !== sha(readFileSync(packetPath)))
    refuse('escrow_readback_changed');
  const receipt = {
    observedCurrentObject: true,
    objectKey: key,
    envelopeSha256: sha(readFileSync(packetPath)),
    planSha256: meta.planSha256,
    manifestSha256: meta.manifestSha256,
    configurationSha256: meta.configurationSha256,
    approvalSha256: expectedApprovalSha256,
    applyPerformed: false,
    retentionErasureSupported: false,
  };
  write(
    resolve(outDirectory, 'escrow-receipt.json'),
    `${JSON.stringify(receipt)}\n`,
  );
  return receipt;
}
function loadPacket(
  { leasePath, expectedLeaseSha256, outDirectory },
  cleanup = false,
) {
  const lease = parseLease(approvedFile(leasePath, expectedLeaseSha256));
  if (
    !cleanup &&
    (Date.now() < date(lease.approvedAt) ||
      Date.now() >= date(lease.startDeadline))
  )
    refuse('lease_start_expired');
  if (
    !cleanup &&
    (process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_SHA !== lease.sourceCommit)
  )
    refuse('lifecycle_run_changed');
  privateDirectory(outDirectory);
  identity();
  const ownedExecution = cleanup
    ? verifyOwnedLifecycleLease(lease, expectedLeaseSha256, outDirectory)
        .execution
    : undefined;
  const path = resolve(outDirectory, 'download.private.json');
  aws([
    's3api',
    'get-object',
    '--bucket',
    lease.state.bucket,
    '--key',
    lease.objectKey,
    path,
  ]);
  const raw = readFileSync(path);
  if (sha(raw) !== lease.envelopeSha256) refuse('envelope_hash_changed');
  const packet = JSON.parse(raw.toString('utf8'));
  fields(packet, [
    'version',
    'metadata',
    'encryptedDataKey',
    'nonce',
    'tag',
    'ciphertext',
  ]);
  if (packet.version !== 'fss.private-plan.v1') refuse();
  const meta = packet.metadata;
  parseStorageApprovalForRead(meta);
  for (const key of [
    'sourceCommit',
    'imageBuildCommit',
    'environmentId',
    'prefix',
    'databaseName',
    'apiHostname',
    'configurationSha256',
    'manifestSha256',
    'planSha256',
  ])
    if (meta[key] !== lease[key]) refuse('envelope_binding_changed');
  if (
    JSON.stringify(meta.state) !== JSON.stringify(lease.state) ||
    JSON.stringify(meta.images) !== JSON.stringify(lease.images) ||
    meta.retention.approvalRef !== lease.retention.approvalRef
  )
    refuse('envelope_binding_changed');
  const { plan, manifest, configuration } = decryptPayload(
    packet,
    meta,
    outDirectory,
  );
  if (cleanup)
    return {
      configuration,
      manifest,
      lease,
      execution: ownedExecution,
      cleanupOnly: true,
    };
  const privatePlanPath = resolve(outDirectory, 'reviewed.tfplan');
  const configurationPath = resolve(outDirectory, 'configuration.private.json');
  let planWritten = false,
    configurationWritten = false;
  try {
    write(privatePlanPath, plan);
    planWritten = true;
    write(configurationPath, bytes(configuration));
    configurationWritten = true;
  } catch (error) {
    if (planWritten) rmSync(privatePlanPath, { force: true });
    if (configurationWritten) rmSync(configurationPath, { force: true });
    throw error;
  }
  return {
    privatePlanPath,
    manifest,
    configuration,
    lease,
    planSha256: lease.planSha256,
  };
}
function observeExecution(sourceCommit) {
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_SHA !== sourceCommit ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REPOSITORY !== 'david-cui-bruno/founding-sales'
  )
    refuse('lifecycle_run_changed');
  return {
    runId: text(process.env.GITHUB_RUN_ID, /^[1-9][0-9]*$/u),
    attempt: text(process.env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/u),
  };
}
function intentKey(document, kind) {
  return `fss/greenfield/rehearsal/${document.prefix}/diagnostic/${kind === 'storage' ? 'proposals' : 'lifecycles'}/${kind === 'storage' ? document.approvalId : document.leaseId}/execution.json`;
}
export function lifecycleLeaseKey(originRunId, originAttempt) {
  text(originRunId, /^[1-9][0-9]*$/u);
  text(originAttempt, /^[1-9][0-9]*$/u);
  return `fss/greenfield/rehearsal/diagnostic/lifecycles/runs/${originRunId}/${originAttempt}/lease.json`;
}
function conditionalRecord(document, key, record, directory, label) {
  const path = resolve(directory, `${label}.private.json`),
    data = bytes(record);
  write(path, data);
  aws([
    's3api',
    'put-object',
    '--bucket',
    document.state.bucket,
    '--key',
    key,
    '--body',
    path,
    '--if-none-match',
    '*',
    '--server-side-encryption',
    'aws:kms',
    '--ssekms-key-id',
    document.state.kmsKeyArn,
    '--output',
    'json',
  ]);
  const returned = resolve(directory, `${label}-readback.private.json`);
  aws([
    's3api',
    'get-object',
    '--bucket',
    document.state.bucket,
    '--key',
    key,
    returned,
  ]);
  if (sha(readFileSync(returned)) !== sha(data))
    refuse('escrow_readback_changed');
}
function parseExecutionRecord(record, expectedHash, kind) {
  fields(record, [
    'version',
    'purpose',
    'documentBytes',
    'documentSha256',
    'execution',
    'sourceCommit',
  ]);
  if (
    record.version !== 'fss.diagnostic-execution.v1' ||
    record.purpose !== `diagnostic_${kind}_execution` ||
    record.documentSha256 !== expectedHash
  )
    refuse('execution_record_changed');
  fields(record.execution, ['runId', 'attempt']);
  for (const value of Object.values(record.execution))
    text(value, /^[1-9][0-9]*$/u);
  const raw = Buffer.from(record.documentBytes, 'base64');
  if (sha(raw) !== expectedHash) refuse('approval_hash_changed');
  const document = JSON.parse(raw);
  if (kind === 'lifecycle') parseLease(document);
  else
    parseStorageApprovalForRead({
      ...document,
      planSha256: '0'.repeat(64),
      manifestSha256: '0'.repeat(64),
      observedProposal: record.execution,
      storageApprovalSha256: expectedHash,
    });
  if (document.sourceCommit !== record.sourceCommit)
    refuse('execution_record_changed');
  return { record, document, raw };
}
function readIntentRecord(document, expectedHash, kind, directory) {
  const path = resolve(directory, `${kind}-intent-read.private.json`);
  aws([
    's3api',
    'get-object',
    '--bucket',
    document.state.bucket,
    '--key',
    intentKey(document, kind),
    path,
  ]);
  return parseExecutionRecord(read(path), expectedHash, kind).record;
}
export function reserveStorageIntent({
  approvalPath,
  expectedApprovalSha256,
  outDirectory,
}) {
  const document = parseStorageApproval(
      approvedFile(approvalPath, expectedApprovalSha256),
    ),
    execution = observeExecution(document.sourceCommit);
  privateDirectory(outDirectory);
  identity();
  const record = {
    version: 'fss.diagnostic-execution.v1',
    purpose: 'diagnostic_storage_execution',
    documentBytes: readFileSync(approvalPath).toString('base64'),
    documentSha256: expectedApprovalSha256,
    execution,
    sourceCommit: document.sourceCommit,
  };
  conditionalRecord(
    document,
    intentKey(document, 'storage'),
    record,
    outDirectory,
    'storage-reservation',
  );
  return {
    execution,
    approvalSha256: expectedApprovalSha256,
    firstDispatch: true,
  };
}
export function registerLifecycleLease({
  leasePath,
  expectedLeaseSha256,
  outDirectory,
}) {
  const lease = readReviewedLease(leasePath, expectedLeaseSha256);
  if (
    Date.now() < date(lease.approvedAt) ||
    Date.now() >= date(lease.startDeadline)
  )
    refuse('lease_start_expired');
  const execution = observeExecution(lease.sourceCommit);
  privateDirectory(outDirectory);
  identity();
  const record = {
    version: 'fss.diagnostic-execution.v1',
    purpose: 'diagnostic_lifecycle_execution',
    documentBytes: readFileSync(leasePath).toString('base64'),
    documentSha256: expectedLeaseSha256,
    execution,
    sourceCommit: lease.sourceCommit,
  };
  conditionalRecord(
    lease,
    intentKey(lease, 'lifecycle'),
    record,
    outDirectory,
    'lifecycle-reservation',
  );
  const objectKey = lifecycleLeaseKey(execution.runId, execution.attempt);
  conditionalRecord(lease, objectKey, record, outDirectory, 'origin-index');
  const receipt = {
    objectKey,
    leaseSha256: expectedLeaseSha256,
    execution,
    firstDispatch: true,
    applyPerformed: false,
    retentionErasureSupported: false,
  };
  write(resolve(outDirectory, 'registration-receipt.json'), bytes(receipt));
  return receipt;
}
function verifyOwnedLifecycleLease(lease, expectedHash, directory) {
  const primary = readIntentRecord(lease, expectedHash, 'lifecycle', directory),
    indexPath = resolve(directory, 'origin-verify.private.json');
  aws([
    's3api',
    'get-object',
    '--bucket',
    lease.state.bucket,
    '--key',
    lifecycleLeaseKey(primary.execution.runId, primary.execution.attempt),
    indexPath,
  ]);
  const indexed = parseExecutionRecord(
    read(indexPath),
    expectedHash,
    'lifecycle',
  ).record;
  if (JSON.stringify(primary) !== JSON.stringify(indexed))
    refuse('execution_record_changed');
  return primary;
}
function verifyCleanupOrigin(runId, attempt, sourceCommit) {
  text(runId, /^[1-9][0-9]*$/u);
  text(attempt, /^[1-9][0-9]*$/u);
  text(sourceCommit, /^[0-9a-f]{40}$/u);
  let observed;
  try {
    observed = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          `repos/david-cui-bruno/founding-sales/actions/runs/${runId}/attempts/${attempt}`,
        ],
        {
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 1048576,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
  } catch {
    refuse('origin_unverified');
  }
  if (
    String(observed.id) !== runId ||
    String(observed.run_attempt) !== attempt ||
    observed.head_sha !== sourceCommit ||
    observed.event !== 'workflow_dispatch' ||
    observed.head_branch !== 'main' ||
    observed.repository?.full_name !== 'david-cui-bruno/founding-sales'
  )
    refuse('origin_unverified');
  const workflowId = text(String(observed.workflow_id), /^[1-9][0-9]*$/u);
  let workflow;
  try {
    workflow = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          `repos/david-cui-bruno/founding-sales/actions/workflows/${workflowId}`,
        ],
        {
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 1048576,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
  } catch {
    refuse('origin_unverified');
  }
  if (
    String(workflow.id) !== workflowId ||
    workflow.path !== '.github/workflows/crm-acquisition-diagnostic.yml'
  )
    refuse('origin_unverified');
}
export function loadRegisteredLifecycleLeaseForCleanup({
  originRunId,
  originAttempt,
  expectedLeaseSha256,
  originSourceCommit,
  outDirectory,
}) {
  if (expectedLeaseSha256 === undefined)
    verifyCleanupOrigin(originRunId, originAttempt, originSourceCommit);
  else text(expectedLeaseSha256, HASH);
  privateDirectory(outDirectory);
  identity();
  const indexPath = resolve(outDirectory, 'owned-origin.private.json');
  aws([
    's3api',
    'get-object',
    '--bucket',
    'callie-sourcing-tfstate-326255650484',
    '--key',
    lifecycleLeaseKey(originRunId, originAttempt),
    indexPath,
  ]);
  const indexedRecord = read(indexPath);
  if (expectedLeaseSha256 === undefined) {
    text(indexedRecord.documentSha256, HASH);
    expectedLeaseSha256 = indexedRecord.documentSha256;
    if (indexedRecord.sourceCommit !== originSourceCommit)
      refuse('execution_record_changed');
  }
  const {
    record,
    document: lease,
    raw,
  } = parseExecutionRecord(indexedRecord, expectedLeaseSha256, 'lifecycle');
  if (
    record.execution.runId !== originRunId ||
    record.execution.attempt !== originAttempt
  )
    refuse('lifecycle_run_changed');
  const primary = readIntentRecord(
    lease,
    expectedLeaseSha256,
    'lifecycle',
    outDirectory,
  );
  if (JSON.stringify(primary) !== JSON.stringify(record))
    refuse('execution_record_changed');
  const path = resolve(outDirectory, 'owned-lease.private.json');
  write(path, raw);
  return {
    lease,
    leasePath: path,
    leaseSha256: expectedLeaseSha256,
    execution: record.execution,
    cleanupOnly: true,
  };
}
export function loadReviewedPlan(input) {
  return loadPacket(input);
}
export function loadReviewedConfigurationForCleanup(input) {
  return loadPacket(input, true);
}
function decryptPayload(packet, meta, outDirectory) {
  fields(packet, [
    'version',
    'metadata',
    'encryptedDataKey',
    'nonce',
    'tag',
    'ciphertext',
  ]);
  if (packet.version !== 'fss.private-plan.v1') refuse();
  const blobPath = resolve(outDirectory, 'key.private.bin');
  write(blobPath, Buffer.from(packet.encryptedDataKey, 'base64'));
  let dataKey;
  try {
    try {
      const result = JSON.parse(
        aws([
          'kms',
          'decrypt',
          '--key-id',
          meta.state.kmsKeyArn,
          '--ciphertext-blob',
          `fileb://${blobPath}`,
          '--encryption-context',
          JSON.stringify(context(meta)),
          '--output',
          'json',
        ]),
      );
      if (result.KeyId !== meta.state.kmsKeyArn) refuse('data_key_changed');
      dataKey = Buffer.from(result.Plaintext, 'base64');
    } finally {
      rmSync(blobPath, { force: true });
    }
    if (dataKey.length !== 32) {
      dataKey.fill(0);
      refuse('data_key_changed');
    }
    const nonce = Buffer.from(packet.nonce, 'base64'),
      tag = Buffer.from(packet.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) {
      dataKey.fill(0);
      refuse();
    }
    let payload;
    try {
      const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
      decipher.setAAD(bytes(meta));
      decipher.setAuthTag(tag);
      payload = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(packet.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      );
    } catch {
      refuse('envelope_authentication_failed');
    } finally {
      dataKey.fill(0);
    }
    fields(payload, ['plan', 'manifestBytes', 'configuration']);
    const manifestBytes = Buffer.from(payload.manifestBytes, 'base64'),
      manifest = JSON.parse(manifestBytes);
    const plan = Buffer.from(payload.plan, 'base64');
    validatePayload(meta, manifest, payload.configuration, plan, manifestBytes);
    return { plan, manifest, configuration: payload.configuration };
  } finally {
    dataKey?.fill(0);
  }
}
function parseStorageApprovalForRead(meta) {
  fields(meta, [
    'schemaVersion',
    'purpose',
    'approvalId',
    'approvedAt',
    'expiresAt',
    'environmentId',
    'prefix',
    'databaseName',
    'apiHostname',
    'state',
    'sourceCommit',
    'imageBuildCommit',
    'images',
    'configurationSha256',
    'retention',
    'planSha256',
    'manifestSha256',
    'observedProposal',
    'storageApprovalSha256',
  ]);
  fields(meta.observedProposal, ['runId', 'attempt']);
  for (const value of Object.values(meta.observedProposal))
    text(value, /^[1-9][0-9]*$/u);
  text(meta.storageApprovalSha256, HASH);
  binding(meta);
  if (meta.schemaVersion !== 1 || meta.purpose !== 'diagnostic_plan_storage')
    refuse();
  text(meta.approvalId, UUID);
  text(meta.planSha256, HASH);
  text(meta.manifestSha256, HASH);
  date(meta.approvedAt);
  date(meta.expiresAt);
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'validate-lease' && args.length === 3) {
      const value = parseLease(approvedFile(args[0], args[1]));
      privateDirectory(args[2]);
      write(
        resolve(args[2], 'lease-receipt.json'),
        bytes({
          leaseSha256: args[1],
          hardDeadline: value.hardDeadline,
          applyPerformed: false,
          activationAllowed: false,
          retentionErasureSupported: false,
        }),
      );
    } else if (action === 'reserve-storage' && args.length === 3)
      reserveStorageIntent({
        approvalPath: args[0],
        expectedApprovalSha256: args[1],
        outDirectory: args[2],
      });
    else if (action === 'prepare' && args.length === 5)
      await preparePrivateProposal({
        approvalPath: args[0],
        expectedApprovalSha256: args[1],
        configurationInputPath: args[2],
        outDirectory: args[3],
        root: args[4],
      });
    else if (action === 'escrow' && args.length === 6)
      escrowPlan({
        approvalPath: args[0],
        expectedApprovalSha256: args[1],
        planPath: args[2],
        manifestPath: args[3],
        configurationPath: args[4],
        outDirectory: args[5],
      });
    else if (action === 'register' && args.length === 3)
      registerLifecycleLease({
        leasePath: args[0],
        expectedLeaseSha256: args[1],
        outDirectory: args[2],
      });
    else if (action === 'load-cleanup' && args.length === 4) {
      const result = loadRegisteredLifecycleLeaseForCleanup({
        originRunId: args[0],
        originAttempt: args[1],
        expectedLeaseSha256: args[2],
        outDirectory: args[3],
      });
      write(
        resolve(args[3], 'cleanup-receipt.json'),
        bytes({
          leaseSha256: result.leaseSha256,
          cleanupOnly: true,
          applyPerformed: false,
        }),
      );
    } else if (action === 'recover-cleanup' && args.length === 4) {
      const result = loadRegisteredLifecycleLeaseForCleanup({
        originRunId: args[0],
        originAttempt: args[1],
        originSourceCommit: args[2],
        outDirectory: args[3],
      });
      write(
        resolve(args[3], 'cleanup-receipt.json'),
        bytes({
          leaseSha256: result.leaseSha256,
          cleanupOnly: true,
          applyPerformed: false,
        }),
      );
    } else if (action === 'configuration-cleanup' && args.length === 3) {
      const result = loadReviewedConfigurationForCleanup({
        leasePath: args[0],
        expectedLeaseSha256: args[1],
        outDirectory: args[2],
      });
      write(
        resolve(args[2], 'configuration.private.json'),
        bytes(result.configuration),
      );
      write(
        resolve(args[2], 'cleanup-receipt.json'),
        bytes({
          cleanupOnly: true,
          applyPerformed: false,
          activationAllowed: false,
        }),
      );
    } else if (action === 'load' && args.length === 3) {
      const result = loadReviewedPlan({
        leasePath: args[0],
        expectedLeaseSha256: args[1],
        outDirectory: args[2],
      });
      write(
        resolve(args[2], 'load-receipt.json'),
        bytes({
          planSha256: result.planSha256,
          applyPerformed: false,
          activationAllowed: false,
        }),
      );
    } else refuse('invalid_command');
  } catch (error) {
    const allowed = new Set([
      'invalid_handoff',
      'retention_approval_required',
      'unbounded_lease',
      'storage_approval_expired',
      'approval_hash_changed',
      'private_directory_required',
      'cloud_command_refused',
      'normal_role_required',
      'payload_hash_changed',
      'payload_binding_changed',
      'proposal_run_changed',
      'escrow_conflict',
      'data_key_changed',
      'lease_start_expired',
      'lifecycle_run_changed',
      'envelope_hash_changed',
      'envelope_binding_changed',
      'envelope_authentication_failed',
      'invalid_command',
      'private_preparation_unavailable',
      // Fixed preparation categories only; never child-process output or arbitrary exceptions.
      'invalid_configuration',
      'main_required',
      'namespace_mismatch',
      'public_key_required',
      'recipient_mismatch',
      'schema90_required',
      'distinct_images_required',
      'account_mismatch',
      'invalid_zones',
      'root_changed',
      'source_changed',
      'invalid_provenance',
      'image_mismatch',
      'wrong_role',
      'certificate_mismatch',
      'terraform_version_mismatch',
      'nonempty_state',
      'unsafe_summary',
      'not_creation_plan',
      'empty_plan',
      'state_changed',
      'plan_configuration_changed',
      'plan_changed',
      'secret_value_plan_refused',
      'registry_provenance_changed',
      'command_failed_bash',
      'command_failed_aws',
      'command_failed_terraform',
      'command_failed_terraform_version',
      'command_failed_terraform_init',
      'command_failed_terraform_state',
      'command_failed_terraform_plan',
      'command_failed_terraform_show',
      'command_failed_git',
      'command_failed_docker',
      'destination_exists',
      'execution_record_changed',
      'origin_unverified',
      'escrow_readback_changed',
    ]);
    console.error(
      allowed.has(error?.message) ? error.message : 'handoff_refused',
    );
    process.exitCode = 1;
  }
}
