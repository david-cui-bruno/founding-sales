import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const script = resolve('infra/scripts/diagnostic-handoff.mjs');
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const time = new Date();
const at = (minutes: number) =>
  new Date(time.getTime() + minutes * 60000).toISOString();
const lease = {
  schemaVersion: 1,
  purpose: 'acquisition_acceptance_lifecycle',
  leaseId: '11111111-2222-4333-8444-555555555555',
  environmentId: '22222222-2222-4333-8444-555555555555',
  prefix: 'fss-rh-cap90-o10a',
  databaseName: 'fss_diagnostic_cap90_o10a',
  apiHostname: 'cap90-o10a.rehearsal.usecallie.com',
  state: {
    bucket: 'callie-sourcing-tfstate-326255650484',
    key: 'fss/greenfield/rehearsal/fss-rh-cap90-o10a/terraform.tfstate',
    kmsKeyArn:
      'arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404',
  },
  sourceCommit: 'a'.repeat(40),
  imageBuildCommit: 'b'.repeat(40),
  images: {
    api: `sha256:${'1'.repeat(64)}`,
    worker: `sha256:${'2'.repeat(64)}`,
  },
  configurationSha256: 'c'.repeat(64),
  manifestSha256: 'd'.repeat(64),
  planSha256: 'e'.repeat(64),
  envelopeSha256: 'f'.repeat(64),
  objectKey: `fss/greenfield/rehearsal/fss-rh-cap90-o10a/diagnostic/plans/${'e'.repeat(64)}/envelope.json`,
  approvedAt: at(0),
  startDeadline: at(30),
  hardDeadline: at(240),
  cleanupAt: at(180),
  owner: 'David Cui',
  fallbackOwner: 'Named operator',
  proposedMaxUsd: 5,
  retention: { acknowledged: true, approvalRef: 'review-534-storage' },
  google: {
    projectId: 'callie-diagnostic',
    oidcClientId: '123-oidc.apps.googleusercontent.com',
    gmailClientId: '123-gmail.apps.googleusercontent.com',
    redirectUris: {
      oidc: 'https://cap90-o10a.rehearsal.usecallie.com/auth/google/callback',
      gmail: 'https://cap90-o10a.rehearsal.usecallie.com/oauth/gmail/callback',
    },
    inputsReviewRef: 'review-google-inputs',
    workspacePolicyReviewRef: 'review-workspace-policy',
  },
  bootstrapAdminEmail: 'david@example.test',
  requiredSecretEntries: ['google-oidc-client', 'google-gmail-oauth-client'],
};
function validate(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'fss-handoff-'));
  try {
    const path = join(directory, 'lease.json');
    const bytes = `${JSON.stringify(value)}\n`;
    writeFileSync(path, bytes);
    const run = spawnSync(
      process.execPath,
      [script, 'validate-lease', path, digest(bytes), join(directory, 'out')],
      { encoding: 'utf8' },
    );
    return {
      status: run.status,
      output: run.stdout + run.stderr,
      receipt:
        run.status === 0
          ? JSON.parse(
              readFileSync(
                join(directory, 'out', 'lease-receipt.json'),
                'utf8',
              ),
            )
          : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it('accepts one concretely reviewed bounded lease without application authority', () => {
  const run = validate(lease);
  expect(run.status, run.output).toBe(0);
  expect(run.receipt).toMatchObject({
    applyPerformed: false,
    activationAllowed: false,
    hardDeadline: lease.hardDeadline,
    retentionErasureSupported: false,
  });
});
it('accepts a sole named human cleanup owner with the independent workflow backup', () => {
  const run = validate({...lease, fallbackOwner: lease.owner});
  expect(run.status, run.output).toBe(0);
  expect(run.receipt).toMatchObject({applyPerformed:false, activationAllowed:false});
  expect(validate({...lease, fallbackOwner:''}).status).toBe(1);
});
it('refuses missing retention approval, changed redirects and unbounded lifecycle', () => {
  for (const value of [
    { ...lease, retention: { ...lease.retention, acknowledged: false } },
    { ...lease, hardDeadline: at(241) },
    { ...lease, cleanupAt: at(181) },
    {
      ...lease,
      google: {
        ...lease.google,
        redirectUris: {
          ...lease.google.redirectUris,
          gmail: 'https://api.usecallie.com/oauth/gmail/callback',
        },
      },
    },
    { ...lease, providerToken: 'PRIVATE-SENTINEL' },
  ]) {
    const run = validate(value);
    expect(run.status).not.toBe(0);
    expect(run.output).not.toContain('PRIVATE-SENTINEL');
  }
});

it('privately conserves one exact proposal for a later reviewed lease and refuses replaced current objects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fss-handoff-roundtrip-'));
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    const store = join(directory, 'stored.json');
    const aws = join(bin, 'aws');
    writeFileSync(
      aws,
      `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.COMMAND_LOG,a.slice(0,2).join(' ')+"\\n");
const val=(key)=>a[a.indexOf(key)+1];const object=(key)=>process.env.OBJECT_STORE+'/'+require('crypto').createHash('sha256').update(key).digest('hex');fs.mkdirSync(process.env.OBJECT_STORE,{recursive:true});
if(a[0]==='sts')console.log(JSON.stringify({Account:'326255650484',Arn:'arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/run'}));
else if(a[0]==='kms')console.log(JSON.stringify({KeyId:val('--key-id'),Plaintext:Buffer.alloc(32,7).toString('base64'),CiphertextBlob:Buffer.from('opaque-kms-key').toString('base64')}));
else if(a[1]==='list-objects-v2')console.log(JSON.stringify({Contents:fs.existsSync(object(val('--prefix')))?[{Key:val('--prefix')}]:[]}));
else if(a[1]==='put-object'){if(fs.existsSync(object(val('--key'))))process.exit(1);fs.copyFileSync(val('--body'),object(val('--key')));if(process.env.FAIL_PUT_AFTER_WRITE){console.error('PRIVATE-CLOUD-SENTINEL');process.exit(1);}console.log('{}');}
else if(a[1]==='get-object'){fs.copyFileSync(object(val('--key')),a[6]);if(process.env.BAD_READBACK)fs.writeFileSync(a[6],'changed-object');console.log('{}');}
else process.exit(1);
`,
    );
    chmodSync(aws, 0o700);
    const config = {
      assume_deployment_role: false,
      bootstrap: true,
      name_prefix: lease.prefix,
      availability_zones: ['us-east-1a', 'us-east-1d'],
      api_image: `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@${lease.images.api}`,
      worker_image: `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${lease.images.worker}`,
      certificate_arn:
        'arn:aws:acm:us-east-1:326255650484:certificate/11111111-2222-4333-8444-555555555555',
      api_hostname: lease.apiHostname,
      api_schema_range: { min: 90, max: 90 },
      worker_schema_range: { min: 90, max: 90 },
      crm_acquisition_diagnostic: {
        environment_id: lease.environmentId,
        database_name: lease.databaseName,
      },
    };
    const configHash = digest(JSON.stringify(config));
    const plan = 'PRIVATE-EXACT-BINARY-PLAN';
    const manifest = {
      commit: lease.sourceCommit,
      imageBuildCommit: lease.imageBuildCommit,
      apiDigest: lease.images.api,
      workerDigest: lease.images.worker,
      stateKey: lease.state.key,
      configurationSha256: configHash,
      workflowRunId: '777',
      workflowRunAttempt: '1',
      diagnostic: {
        environmentId: lease.environmentId,
        prefix: lease.prefix,
        databaseName: lease.databaseName,
        apiHostname: lease.apiHostname,
        schema: 90,
        sendingEnabled: false,
      },
      planSha256: digest(plan),
      applySupported: false,
      activationAllowed: false,
    };
    const approval = {
      schemaVersion: 1,
      purpose: 'diagnostic_plan_storage',
      approvalId: lease.leaseId,
      approvedAt: at(-1),
      expiresAt: at(30),
      environmentId: lease.environmentId,
      prefix: lease.prefix,
      databaseName: lease.databaseName,
      apiHostname: lease.apiHostname,
      state: lease.state,
      sourceCommit: lease.sourceCommit,
      imageBuildCommit: lease.imageBuildCommit,
      images: lease.images,
      configurationSha256: configHash,
      retention: lease.retention,
    };
    const files = {
      approval: join(directory, 'approval.json'),
      plan: join(directory, 'source.tfplan'),
      manifest: join(directory, 'manifest.json'),
      config: join(directory, 'config.json'),
    };
    writeFileSync(files.approval, JSON.stringify(approval));
    writeFileSync(files.plan, plan);
    writeFileSync(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(files.config, JSON.stringify(config));
    const run = (
      args: string[],
      runId = '777',
      extraEnv: Record<string, string> = {},
    ) =>
      spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH']}`,
          OBJECT_STORE: store,
          COMMAND_LOG: join(directory, 'commands.log'),
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REPOSITORY: 'david-cui-bruno/founding-sales',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_SHA: lease.sourceCommit,
          GITHUB_RUN_ID: runId,
          GITHUB_RUN_ATTEMPT: '1',
          ...extraEnv,
        },
      });
    const reservation = run([
      'reserve-storage',
      files.approval,
      digest(readFileSync(files.approval, 'utf8')),
      join(directory, 'storage-reserve'),
    ]);
    expect(reservation.status, reservation.stderr).toBe(0);
    const secondProposal = run(
      [
        'reserve-storage',
        files.approval,
        digest(readFileSync(files.approval, 'utf8')),
        join(directory, 'storage-duplicate'),
      ],
      '888',
    );
    expect(secondProposal.status).not.toBe(0);
    const contradictory = join(directory, 'contradictory.json');
    writeFileSync(
      contradictory,
      JSON.stringify({ ...manifest, planSha256: '0'.repeat(64) }),
    );
    const beforeContradictory = readFileSync(
      join(directory, 'commands.log'),
      'utf8',
    );
    const rejectedManifest = run([
      'escrow',
      files.approval,
      digest(readFileSync(files.approval, 'utf8')),
      files.plan,
      contradictory,
      files.config,
      join(directory, 'contradictory'),
    ]);
    expect(rejectedManifest.status).not.toBe(0);
    expect(readFileSync(join(directory, 'commands.log'), 'utf8')).toBe(
      beforeContradictory,
    );
    const escrow = run([
      'escrow',
      files.approval,
      digest(readFileSync(files.approval, 'utf8')),
      files.plan,
      files.manifest,
      files.config,
      join(directory, 'escrow'),
    ]);
    expect(escrow.status, escrow.stdout + escrow.stderr).toBe(0);
    const receipt = JSON.parse(
      readFileSync(join(directory, 'escrow', 'escrow-receipt.json'), 'utf8'),
    );
    const reviewed = {
      ...lease,
      configurationSha256: configHash,
      manifestSha256: receipt.manifestSha256,
      planSha256: receipt.planSha256,
      envelopeSha256: receipt.envelopeSha256,
      objectKey: receipt.objectKey,
    };
    const leasePath = join(directory, 'reviewed.json');
    const leaseBytes = JSON.stringify(reviewed);
    writeFileSync(leasePath, leaseBytes);
    const loaded = run(
      ['load', leasePath, digest(leaseBytes), join(directory, 'load')],
      '1234',
    );
    expect(loaded.status, loaded.stdout + loaded.stderr).toBe(0);
    expect(
      readFileSync(join(directory, 'load', 'reviewed.tfplan'), 'utf8'),
    ).toBe(plan);
    const retried = run([
      'escrow',
      files.approval,
      digest(readFileSync(files.approval, 'utf8')),
      files.plan,
      files.manifest,
      files.config,
      join(directory, 'retry'),
    ]);
    expect(retried.status, retried.stdout + retried.stderr).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(directory, 'retry', 'escrow-receipt.json'), 'utf8'),
      ).envelopeSha256,
    ).toBe(receipt.envelopeSha256);
    const expired = {
      ...reviewed,
      approvedAt: at(-300),
      startDeadline: at(-270),
      cleanupAt: at(-120),
      hardDeadline: at(-60),
    };
    const expiredPath = join(directory, 'expired.json'),
      expiredBytes = JSON.stringify(expired);
    writeFileSync(expiredPath, expiredBytes);
    const expiredApply = run(
      [
        'load',
        expiredPath,
        digest(expiredBytes),
        join(directory, 'expired-apply'),
      ],
      '1234',
    );
    expect(expiredApply.status).not.toBe(0);
    expect(expiredApply.stderr).toContain('lease_start_expired');
    const cleanup = run(
      [
        'configuration-cleanup',
        expiredPath,
        digest(expiredBytes),
        join(directory, 'cleanup'),
      ],
      '999',
    );
    expect(cleanup.status).not.toBe(0);
    const registration = run(
      ['register', leasePath, digest(leaseBytes), join(directory, 'register')],
      '1234',
      {},
    );
    expect(registration.status, registration.stdout + registration.stderr).toBe(
      0,
    );
    const ownedCleanup = run(
      [
        'configuration-cleanup',
        leasePath,
        digest(leaseBytes),
        join(directory, 'owned-cleanup'),
      ],
      '999',
    );
    expect(ownedCleanup.status, ownedCleanup.stderr).toBe(0);
    expect(
      existsSync(join(directory, 'owned-cleanup', 'reviewed.tfplan')),
    ).toBe(false);
    const crossRun = run(
      ['register', leasePath, digest(leaseBytes), join(directory, 'cross-run')],
      '98765',
    );
    expect(crossRun.status).not.toBe(0);
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env node
const fs=require('fs');fs.appendFileSync(process.env.COMMAND_LOG,'gh api\\n');const endpoint=process.argv.at(-1);if(endpoint.includes('/workflows/'))console.log(JSON.stringify({id:789,path:process.env.BAD_WORKFLOW_PATH?'.github/workflows/ordinary.yml':'.github/workflows/crm-acquisition-diagnostic.yml'}));else{const parts=endpoint.split('/');const exact=endpoint.includes('/attempts/');const run=exact?parts.at(-3):parts.at(-1);console.log(JSON.stringify({id:Number(run),run_attempt:exact?1:2,workflow_id:789,head_sha:process.env.GITHUB_SHA,event:process.env.BAD_GH_ORIGIN?'push':'workflow_dispatch',head_branch:'main',repository:{full_name:'david-cui-bruno/founding-sales'},path:'.github/workflows/crm-acquisition-diagnostic.yml@main'}));}`,
    );
    chmodSync(gh, 0o700);
    const automaticCleanup = run(
      [
        'recover-cleanup',
        '1234',
        '1',
        lease.sourceCommit,
        join(directory, 'automatic-cleanup'),
      ],
      '999',
    );
    expect(automaticCleanup.status, automaticCleanup.stderr).toBe(0);
    const wrongOrigin = run(
      [
        'recover-cleanup',
        '1234',
        '1',
        lease.sourceCommit,
        join(directory, 'wrong-origin'),
      ],
      '999',
      { BAD_GH_ORIGIN: '1' },
    );
    expect(wrongOrigin.status).not.toBe(0);
    expect(wrongOrigin.stderr).toContain('origin_unverified');
    const wrongWorkflow = run(
      [
        'recover-cleanup',
        '1234',
        '1',
        lease.sourceCommit,
        join(directory, 'wrong-workflow'),
      ],
      '999',
      { BAD_WORKFLOW_PATH: '1' },
    );
    expect(wrongWorkflow.status).not.toBe(0);
    expect(wrongWorkflow.stderr).toContain('origin_unverified');
    const beforeWrongSource = readFileSync(
      join(directory, 'commands.log'),
      'utf8',
    );
    const wrongSource = run(
      [
        'recover-cleanup',
        '1234',
        '1',
        'b'.repeat(40),
        join(directory, 'wrong-source'),
      ],
      '999',
    );
    expect(wrongSource.status).not.toBe(0);
    expect(wrongSource.stderr).toContain('origin_unverified');
    expect(
      readFileSync(join(directory, 'commands.log'), 'utf8').slice(
        beforeWrongSource.length,
      ),
    ).toBe('gh api\n');
    const indexKey =
        'fss/greenfield/rehearsal/diagnostic/lifecycles/runs/1234/1/lease.json',
      indexFile = join(store, digest(indexKey)),
      savedIndex = readFileSync(indexFile, 'utf8');
    writeFileSync(
      indexFile,
      JSON.stringify({
        ...JSON.parse(savedIndex),
        execution: { runId: '1234', attempt: '2' },
      }),
    );
    const changedIndex = run(
      [
        'load-cleanup',
        '1234',
        '1',
        digest(leaseBytes),
        join(directory, 'changed-index'),
      ],
      '999',
    );
    expect(changedIndex.status).not.toBe(0);
    expect(changedIndex.stderr).toContain('lifecycle_run_changed');
    writeFileSync(indexFile, savedIndex);
    const primaryKey = `fss/greenfield/rehearsal/${lease.prefix}/diagnostic/lifecycles/${lease.leaseId}/execution.json`,
      primaryFile = join(store, digest(primaryKey)),
      savedPrimary = readFileSync(primaryFile, 'utf8');
    writeFileSync(
      primaryFile,
      JSON.stringify({
        ...JSON.parse(savedPrimary),
        execution: { runId: '5555', attempt: '1' },
      }),
    );
    const changedPrimary = run(
      [
        'load-cleanup',
        '1234',
        '1',
        digest(leaseBytes),
        join(directory, 'changed-primary'),
      ],
      '999',
    );
    expect(changedPrimary.status).not.toBe(0);
    expect(changedPrimary.stderr).toContain('execution_record_changed');
    writeFileSync(primaryFile, savedPrimary);
    const shortLease = {
        ...reviewed,
        leaseId: '44444444-2222-4333-8444-555555555555',
        startDeadline: new Date(Date.now() + 2000).toISOString(),
      },
      shortBytes = JSON.stringify(shortLease),
      shortPath = join(directory, 'short-lease.json');
    writeFileSync(shortPath, shortBytes);
    const shortRegistration = run(
      [
        'register',
        shortPath,
        digest(shortBytes),
        join(directory, 'short-register'),
      ],
      '4444',
    );
    expect(shortRegistration.status, shortRegistration.stderr).toBe(0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
    const afterDeadline = run(
      [
        'configuration-cleanup',
        shortPath,
        digest(shortBytes),
        join(directory, 'after-deadline'),
      ],
      '999',
    );
    expect(afterDeadline.status, afterDeadline.stderr).toBe(0);
    expect(
      existsSync(join(directory, 'after-deadline', 'reviewed.tfplan')),
    ).toBe(false);
    const duplicate = run(
      [
        'register',
        leasePath,
        digest(leaseBytes),
        join(directory, 'register-duplicate'),
      ],
      '1234',
      {},
    );
    expect(duplicate.status).not.toBe(0);
    const backup = run(
      [
        'load-cleanup',
        '1234',
        '1',
        digest(leaseBytes),
        join(directory, 'backup'),
      ],
      '999',
      {},
    );
    expect(backup.status, backup.stdout + backup.stderr).toBe(0);
    const ambiguousLease = {
        ...reviewed,
        leaseId: '33333333-2222-4333-8444-555555555555',
      },
      ambiguousBytes = JSON.stringify(ambiguousLease),
      ambiguousPath = join(directory, 'ambiguous-lease.json');
    writeFileSync(ambiguousPath, ambiguousBytes);
    const ambiguous = run(
      [
        'register',
        ambiguousPath,
        digest(ambiguousBytes),
        join(directory, 'ambiguous-register'),
      ],
      '3456',
      { FAIL_PUT_AFTER_WRITE: '1' },
    );
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain('cloud_command_refused');
    expect(ambiguous.stderr).not.toContain('PRIVATE-CLOUD-SENTINEL');
    const recovered = run(
      [
        'load-cleanup',
        '3456',
        '1',
        digest(ambiguousBytes),
        join(directory, 'ambiguous-cleanup'),
      ],
      '999',
    );
    expect(recovered.status).not.toBe(0);
    const collision = join(directory, 'load-collision');
    mkdirSync(collision, { mode: 0o700 });
    writeFileSync(
      join(collision, 'configuration.private.json'),
      'owned-existing',
    );
    const collisionRun = run(
      ['load', leasePath, digest(leaseBytes), collision],
      '1234',
    );
    expect(collisionRun.status).not.toBe(0);
    expect(existsSync(join(collision, 'reviewed.tfplan'))).toBe(false);
    const packet = JSON.parse(
      readFileSync(join(store, digest(receipt.objectKey)), 'utf8'),
    );
    expect(JSON.stringify(packet)).not.toContain(plan);
    writeFileSync(
      join(store, digest(receipt.objectKey)),
      JSON.stringify({
        ...packet,
        ciphertext: Buffer.from('changed').toString('base64'),
      }),
    );
    const refused = run(
      ['load', leasePath, digest(leaseBytes), join(directory, 'changed')],
      '1234',
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('envelope_hash_changed');
    const tamperedLease = {
        ...reviewed,
        envelopeSha256: digest(
          readFileSync(join(store, digest(receipt.objectKey)), 'utf8'),
        ),
      },
      tamperedBytes = JSON.stringify(tamperedLease),
      tamperedPath = join(directory, 'tampered.json');
    writeFileSync(tamperedPath, tamperedBytes);
    const authentication = run(
      [
        'load',
        tamperedPath,
        digest(tamperedBytes),
        join(directory, 'authentication'),
      ],
      '1234',
    );
    expect(authentication.status).not.toBe(0);
    expect(authentication.stderr).toContain('envelope_authentication_failed');
    expect(
      existsSync(join(directory, 'authentication', 'reviewed.tfplan')),
    ).toBe(false);
    expect(readFileSync(join(directory, 'commands.log'), 'utf8')).not.toMatch(
      /apply|delete|version|secret|provider/u,
    );
    expect(
      escrow.stdout +
        escrow.stderr +
        loaded.stdout +
        loaded.stderr +
        refused.stdout +
        refused.stderr,
    ).not.toContain(plan);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
