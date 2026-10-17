import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath, readRepositoryFile } from './support/repository.ts';

interface Statement {
  Sid: string; Effect: string; Action: string[] | string; Resource?: string[] | string;
  NotResource?: string[]; Condition?: Record<string, Record<string, string[]>>;
}
interface Policy { Version: string; Statement: Statement[] }
interface Mapping { backend: string | null; provider: string | null; policy: Policy; assumeDeploymentRole?: boolean; initializeTerraform?: boolean; encryption?: string; kmsKeyId?: null }
const STATE = 'arn:aws:s3:::callie-sourcing-tfstate-326255650484/fss/greenfield/production/terraform.tfstate';
const ROLE = 'arn:aws:iam::326255650484:role/fss-prod-deploy';
const cli = repositoryPath('infra/scripts/reviewed-release.mjs');
function run(args: string[], cwd = repositoryPath('.'), env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
function mapping(stage: string): Mapping {
  const result = run(['backend-contract', stage]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Mapping;
}
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'backend-contract-'));
  mkdirSync(join(directory, 'infra/roots/production'), { recursive: true });
  mkdirSync(join(directory, 'infra/policies'), { recursive: true });
  for (const file of ['backend.hcl', 'providers.tf', 'versions.tf', 'main.tf']) copyFileSync(repositoryPath(`infra/roots/production/${file}`), join(directory, 'infra/roots/production', file));
  copyFileSync(repositoryPath('infra/policies/production-backend-plan.json'), join(directory, 'infra/policies/production-backend-plan.json'));
  return directory;
}
function baseline() {
  return { roleArn: ROLE, policyName: 'fss-prod-deploy-scope', maxSessionDuration: 3600,
    trust: { Statement: [{ Sid: 'CurrentAdministrator', Action: 'sts:AssumeRole', Principal: { AWS: 'arn:aws:iam::326255650484:user/controlled-fixture' } }] },
    policy: { Version: '2012-10-17', Statement: [
      { Sid: 'OlderResourceControls', Effect: 'Allow', Action: ['ecs:UpdateService'], Resource: ['arn:aws:ecs:us-east-1:326255650484:service/fss-prod-cluster/fss-prod-api'] },
      { Sid: 'OlderUnrelatedDeny', Effect: 'Deny', Action: ['iam:DeleteRole'], Resource: ['*'] },
      { Sid: 'NoDeploymentDataAccess', Effect: 'Deny', Action: ['s3:GetObject*', 's3:BypassGovernanceRetention', 'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'], Resource: '*' },
    ] } as Policy };
}
function check(policy: Policy, stage: string, directory: string) {
  const path = join(directory, 'candidate.json'); writeFileSync(path, JSON.stringify(policy));
  return run(['backend-policy-check', stage, path]);
}

describe('ordinary reviewed release backend contract CLI', () => {
  it('maps ambient backend and provider identities separately, with no app/maintenance backend', () => {
    expect(mapping('prepare')).toMatchObject({ backend: ROLE.replace('fss-prod-deploy', 'fss-prod-ci-plan'), provider: ROLE.replace('fss-prod-deploy', 'fss-prod-ci-plan'), assumeDeploymentRole: false, encryption: 'SSE-S3', kmsKeyId: null });
    expect(mapping('execute')).toMatchObject({ backend: ROLE, provider: ROLE, assumeDeploymentRole: false });
    expect(mapping('local-plan')).toMatchObject({ provider: ROLE, assumeDeploymentRole: true });
    for (const stage of ['app-only', 'maintenance']) expect(mapping(stage)).toMatchObject({ backend: null, provider: null, initializeTerraform: false, policy: null });
    expect(run(['backend-contract', 'bootstrap-admin']).status).toBe(1);
    expect(readRepositoryFile('infra/roots/production/ci_plan.tf')).toContain('jsondecode(file("${path.module}/../../policies/production-backend-plan.json")).Statement');
    expect(readRepositoryFile('infra/scripts/maintenance-release.mjs')).not.toContain("terraform(['init'");
  });

  it('separates state and checksum reads from native/DynamoDB lock writes, with apply writes only', () => {
    const directory = sandbox();
    try {
      const plan = mapping('prepare').policy; const apply = mapping('execute').policy;
      expect(check(plan, 'prepare', directory).status).toBe(0);
      expect(check(apply, 'execute', directory).status).toBe(0);
      expect(plan.Statement.find(s => s.Sid === 'BackendState')).toMatchObject({ Action: ['s3:GetObject'], Resource: [STATE] });
      expect(apply.Statement.find(s => s.Sid === 'BackendState')).toMatchObject({ Action: ['s3:GetObject', 's3:PutObject'], Resource: [STATE] });
      expect(plan.Statement.find(s => s.Sid === 'BackendNativeLock')).toMatchObject({ Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [STATE + '.tflock'] });
      expect(plan.Statement.find(s => s.Sid === 'BackendChecksum')?.Action).toEqual(['dynamodb:GetItem']);
      expect(apply.Statement.find(s => s.Sid === 'BackendChecksum')?.Action).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem']);
      expect(JSON.stringify(apply)).not.toContain('kms:');
      expect(check(apply, 'prepare', directory).stderr).toContain('backend_excess_state_permission');
      for (const sid of ['BackendNativeLock', 'BackendLockRow', 'BackendChecksum', 'BackendList', 'BackendTable']) {
        const missing = structuredClone(plan); missing.Statement = missing.Statement.filter(s => s.Sid !== sid);
        expect(check(missing, 'prepare', directory).stderr, sid).toContain('backend_required_permission_denied');
      }
      for (const sid of ['BackendNativeLock', 'BackendLockRow']) {
        const missing = structuredClone(plan); const entry = missing.Statement.find(s => s.Sid === sid)!;
        entry.Action = (entry.Action as string[]).filter(action => !action.endsWith('PutObject') && !action.endsWith('PutItem'));
        expect(check(missing, 'prepare', directory).status).toBe(1);
      }
      const deletion = structuredClone(apply); deletion.Statement.push({ Sid: 'WrongDeletion', Effect: 'Allow', Action: 's3:DeleteObject', Resource: STATE });
      expect(check(deletion, 'execute', directory).stderr).toContain('backend_excess_state_permission');
      const denial = structuredClone(plan); denial.Statement.push({ Sid: 'Explicit', Effect: 'Deny', Action: 's3:GetObject*', Resource: '*' });
      expect(check(denial, 'prepare', directory).stderr).toContain('backend_required_permission_denied');
      for (const sid of ['BackendState', 'BackendNativeLock', 'BackendTable']) {
        const generic = structuredClone(plan); generic.Statement.find(s => s.Sid === sid)!.Resource = ['*'];
        expect(check(generic, 'prepare', directory).stderr, sid).toContain('backend_permission_scope');
      }
      const combined = structuredClone(plan);
      combined.Statement.find(s => s.Sid === 'BackendLockRow')!.Condition = { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['callie-sourcing-tfstate-326255650484/fss/greenfield/production/terraform.tfstate', 'callie-sourcing-tfstate-326255650484/fss/greenfield/production/terraform.tfstate-md5'] } };
      expect(check(combined, 'prepare', directory).stderr).toContain('backend_permission_scope');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses the supplied older policy, preserves trust/duration/rights and splits only its actual read deny', () => {
    const directory = sandbox();
    try {
      const original = baseline(); const file = join(directory, 'actual-baseline.json'); const bytes = JSON.stringify(original); writeFileSync(file, bytes);
      const result = run(['backend-proposal', file]); expect(result.status, result.stderr).toBe(0);
      const proposal = JSON.parse(result.stdout) as { operationalApproval: boolean; baseline: ReturnType<typeof baseline>; proposed: ReturnType<typeof baseline> };
      expect(proposal.operationalApproval).toBe(false); expect(proposal.baseline).toEqual(original);
      expect(proposal.proposed.trust).toEqual(original.trust); expect(proposal.proposed.maxSessionDuration).toBe(3600);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      const statements = proposal.proposed.policy.Statement;
      expect(statements.slice(0, 2)).toEqual(original.policy.Statement.slice(0, 2));
      expect(statements.find(s => s.Sid === 'NoDeploymentDataAccess')).toEqual({ ...original.policy.Statement[2], Action: ['s3:BypassGovernanceRetention', 'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'] });
      expect(statements.find(s => s.Sid === 'BackendReadDenyOutsideExactObjects')).toEqual({ Sid: 'BackendReadDenyOutsideExactObjects', Effect: 'Deny', Action: ['s3:GetObject*'], NotResource: [STATE, STATE + '.tflock'] });
      expect(check(proposal.proposed.policy, 'execute', directory).status).toBe(0);
      // Every newly granted right comes from the exact minimal backend contract, not a generic template.
      expect(statements.slice(4)).toEqual(mapping('execute').policy.Statement);
      expect(JSON.stringify(proposal)).not.toContain('AccountMetadata');
      for (const mutation of [
        (v: ReturnType<typeof baseline>) => { v.roleArn = ROLE.replace('deploy', 'ci-deploy'); },
        (v: ReturnType<typeof baseline>) => { v.policyName = 'unrelated'; },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement.pop(); },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement[2]!.Action = ['s3:GetObject']; },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement[2]!.Resource = STATE; },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement[2]!.Condition = { StringEquals: { 'aws:PrincipalArn': [ROLE] } }; },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement.push({ Sid: 'OtherReadDeny', Effect: 'Deny', Action: 's3:GetObject', Resource: '*' }); },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement.push({ Sid: 'UnexpectedBroadRead', Effect: 'Allow', Action: 's3:GetObject*', Resource: '*' }); },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement.push({ Sid: 'UnexpectedAclRead', Effect: 'Allow', Action: 's3:GetObjectAcl', Resource: STATE }); },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement.push({ Sid: 'StateDeletion', Effect: 'Allow', Action: 's3:DeleteObject', Resource: STATE }); },
        (v: ReturnType<typeof baseline>) => { v.policy.Statement.push({ Sid: 'BackendNativeLock', Effect: 'Allow', Action: 's3:GetObject', Resource: STATE }); },
      ]) {
        const changed = baseline(); mutation(changed); writeFileSync(file, JSON.stringify(changed));
        const refused = run(['backend-proposal', file]); expect(refused.status, refused.stdout).toBe(1); expect(refused.stdout).toBe('');
      }
      expect(run(['backend-proposal']).stderr).toContain('backend_baseline_required');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['TF_CLI_ARGS', 'TF_CLI_ARGS_init', 'TF_CLI_ARGS_plan', 'TF_CLI_ARGS_apply', 'TF_VAR_assume_deployment_role', 'TF_DATA_DIR', 'TF_WORKSPACE', 'AWS_ENDPOINT_URL_S3', 'AWS_PROFILE', 'AWS_ROLE_ARN'])('refuses hidden %s before prepare/execute can reach Terraform or cloud', key => {
    const directory = sandbox();
    try {
      for (const stage of ['prepare', 'execute']) {
        const args = stage === 'prepare' ? ['prepare', 'absent', 'absent', 'absent', 'absent', join(directory, 'out')] : ['execute', 'absent', 'absent', 'absent', 'absent', 'absent', join(directory, 'out')];
        const result = run(args, directory, { [key]: 'unintended-override', FSS_RELEASE_HOLD: 'false' });
        expect(result.status).toBe(1); expect(result.stderr).toContain('backend_hidden_configuration');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects wrong account/region, backend keys/encryption, auto overrides and missing source lock rights', () => {
    const directory = sandbox();
    try {
      for (const env of [{ AWS_REGION: 'us-west-2' }, { AWS_DEFAULT_REGION: 'us-west-2' }, { FSS_PRODUCTION_ACCOUNT_ID: '123456789012' }]) expect(run(['backend-contract', 'prepare'], directory, env).stderr).toContain('backend_scope_changed');
      const path = join(directory, 'infra/roots/production/backend.hcl'); const original = readFileSync(path, 'utf8');
      for (const value of [original + '\nkms_key_id = "unapproved-key"\n', original.replace('encrypt        = true', 'encrypt        = false'), original.replace('use_lockfile   = true', 'use_lockfile   = false'), original.replace('production/terraform.tfstate', 'production/foreign.tfstate'), original + '\nprofile = "unapproved"\n']) {
        writeFileSync(path, value);
        for (const stage of ['prepare', 'execute', 'local-plan']) expect(run(['backend-contract', stage], directory).stderr).toContain('backend_configuration_changed');
      }
      writeFileSync(path, original);
      const providerPath = join(directory, 'infra/roots/production/providers.tf'); const provider = readFileSync(providerPath, 'utf8');
      writeFileSync(providerPath, provider.replace('for_each = var.assume_deployment_role ? [1] : []', 'for_each = [1]'));
      expect(run(['backend-contract', 'prepare'], directory).stderr).toContain('backend_provider_mapping_changed'); writeFileSync(providerPath, provider);
      const override = join(directory, 'infra/roots/production/local.auto.tfvars'); writeFileSync(override, 'assume_deployment_role = true');
      expect(run(['backend-contract', 'execute'], directory).stderr).toContain('backend_hidden_configuration'); rmSync(override);
      const policy = mapping('prepare').policy; policy.Statement = policy.Statement.filter(s => s.Sid !== 'BackendNativeLock');
      writeFileSync(join(directory, 'infra/policies/production-backend-plan.json'), JSON.stringify(policy));
      expect(run(['backend-contract', 'prepare'], directory).stderr).toContain('backend_required_permission_denied');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
