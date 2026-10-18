import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

type Condition = Record<string, Record<string, string | string[]>>;
interface Statement { Sid: string; Effect: string; Action: string | string[]; Resource?: string | string[]; NotResource?: string | string[]; Condition?: Condition }
interface Policy { Version: string; Statement: Statement[] }
const KEY = 'arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404';
const OTHER_KEY = KEY.replace('a321a083', 'b321a083');
const SID = 'BackendLockTableDecrypt';
const conditions = { StringEquals: { 'kms:ViaService': 'dynamodb.us-east-1.amazonaws.com', 'kms:EncryptionContext:aws:dynamodb:tableName': 'callie-sourcing-tflock', 'kms:EncryptionContext:aws:dynamodb:subscriberId': '326255650484' } };
const decrypt = (): Statement => ({ Sid: SID, Effect: 'Allow', Action: ['kms:Decrypt'], Resource: [KEY], Condition: structuredClone(conditions) });
function cli(args: string[]) { return spawnSync(process.execPath, [repositoryPath('infra/scripts/reviewed-release.mjs'), ...args], { cwd: repositoryPath('.'), env: process.env, encoding: 'utf8' }); }
function policy(stage: string): Policy {
  const result = cli(['backend-contract', stage]); expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { policy: Policy }).policy;
}
function check(value: Policy, stage: string) {
  const directory = mkdtempSync(join(tmpdir(), 'backend-kms-'));
  try { const path = join(directory, 'policy.json'); writeFileSync(path, JSON.stringify(value)); return cli(['backend-policy-check', stage, path]); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function candidate(stage: string): Policy {
  const value = policy(stage); value.Statement = value.Statement.filter(s => s.Sid !== SID); value.Statement.push(decrypt()); return value;
}
// Public source-rendered historical-shape projection, never private role readback.
function syntheticBaseline() {
  const rendered = spawnSync('bash', [repositoryPath('infra/scripts/policy.sh'), 'render', 'fss-prod', '--compact'], { encoding: 'utf8', env: process.env });
  expect(rendered.status, rendered.stderr).toBe(0);
  return { roleArn: 'arn:aws:iam::326255650484:role/fss-prod-deploy', policyName: 'fss-prod-deploy-scope', lockKeyNamePrefix: null as string | null, maxSessionDuration: 3600, policy: JSON.parse(rendered.stdout) as Policy };
}

describe('ordinary backend CLI existing DynamoDB lock-table CMK contract', () => {
  it('shares only exact service/context Decrypt across prepare/execute, with unchanged SSE-S3 config', () => {
    for (const stage of ['prepare', 'execute', 'local-plan']) {
      const result = cli(['backend-contract', stage]); expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout) as { policy: Policy; encryption: string; kmsKeyId: null };
      expect(value.policy.Statement.find(s => s.Sid === SID)).toEqual(decrypt());
      expect(value.encryption).toBe('SSE-S3'); expect(value.kmsKeyId).toBeNull();
      expect(check(value.policy, stage).status).toBe(0);
    }
    expect(JSON.parse(readFileSync(repositoryPath('infra/policies/production-backend-plan.json'), 'utf8'))).toEqual(policy('prepare'));
  });

  it.each(['prepare', 'execute'])('requires lock table Decrypt for %s and honors explicit applicable denials', stage => {
    const value = candidate(stage); expect(check(value, stage).status).toBe(0);
    value.Statement = value.Statement.filter(s => s.Sid !== SID);
    expect(check(value, stage).stderr).toContain('backend_required_permission_denied');
    value.Statement.push(decrypt(), { ...decrypt(), Sid: 'DenyBackendDecrypt', Effect: 'Deny' });
    expect(check(value, stage).stderr).toContain('backend_required_permission_denied');
    value.Statement.pop();
    value.Statement.push({ ...decrypt(), Sid: 'DenyOtherTable', Effect: 'Deny', Condition: { StringEquals: { 'kms:EncryptionContext:aws:dynamodb:tableName': 'another-table' } } });
    expect(check(value, stage).status).toBe(0);
  });

  it.each([
    ['no conditions', (s: Statement) => { delete s.Condition; }],
    ['missing service', (s: Statement) => { delete s.Condition!['StringEquals']!['kms:ViaService']; }],
    ['missing table', (s: Statement) => { delete s.Condition!['StringEquals']!['kms:EncryptionContext:aws:dynamodb:tableName']; }],
    ['missing account', (s: Statement) => { delete s.Condition!['StringEquals']!['kms:EncryptionContext:aws:dynamodb:subscriberId']; }],
    ['wildcard key', (s: Statement) => { s.Resource = KEY.replace(/key\/.*/u, 'key/*'); }],
    ['other key', (s: Statement) => { s.Resource = OTHER_KEY; }],
    ['other service', (s: Statement) => { s.Condition!['StringEquals']!['kms:ViaService'] = 's3.us-east-1.amazonaws.com'; }],
    ['direct service wildcard', (s: Statement) => { s.Condition!['StringEquals']!['kms:ViaService'] = '*'; }],
    ['other region', (s: Statement) => { s.Condition!['StringEquals']!['kms:ViaService'] = 'dynamodb.us-west-2.amazonaws.com'; }],
    ['other table', (s: Statement) => { s.Condition!['StringEquals']!['kms:EncryptionContext:aws:dynamodb:tableName'] = 'another-table'; }],
    ['other account', (s: Statement) => { s.Condition!['StringEquals']!['kms:EncryptionContext:aws:dynamodb:subscriberId'] = '123456789012'; }],
    ['multiple contexts', (s: Statement) => { s.Condition!['StringEquals']!['kms:ViaService'] = ['dynamodb.us-east-1.amazonaws.com', 's3.us-east-1.amazonaws.com']; }],
    ['StringLike conditions', (s: Statement) => { s.Condition = { StringLike: s.Condition!['StringEquals']! }; }],
    ['IfExists conditions', (s: Statement) => { s.Condition = { StringEqualsIfExists: s.Condition!['StringEquals']! }; }],
    ['Encrypt', (s: Statement) => { s.Action = ['kms:Decrypt', 'kms:Encrypt']; }],
    ['GenerateDataKey', (s: Statement) => { s.Action = ['kms:Decrypt', 'kms:GenerateDataKey']; }],
    ['wildcard actions', (s: Statement) => { s.Action = ['kms:*']; }],
  ] as const)('refuses %s without widening another stage', (_name, mutate) => {
    for (const stage of ['prepare', 'execute']) {
      const value = candidate(stage); mutate(value.Statement.find(s => s.Sid === SID)!);
      expect(check(value, stage).status).toBe(1);
    }
  });

  it('rejects extra direct/key/context data rights even alongside the required constrained grant', () => {
    const direct = decrypt(); delete direct.Condition;
    for (const stage of ['prepare', 'execute']) for (const extra of [
      { ...direct, Sid: 'DirectDecrypt' },
      { ...decrypt(), Sid: 'OtherKeyDecrypt', Resource: [OTHER_KEY] },
      { ...decrypt(), Sid: 'OtherTableDecrypt', Condition: { StringEquals: { ...conditions.StringEquals, 'kms:EncryptionContext:aws:dynamodb:tableName': 'other' } } },
      { ...decrypt(), Sid: 'EncryptToo', Action: ['kms:Encrypt'] },
      { ...decrypt(), Sid: 'GenerateToo', Action: ['kms:GenerateDataKeyWithoutPlaintext'] },
    ]) {
      const value = candidate(stage); value.Statement.push(extra); expect(check(value, stage).status, extra.Sid).toBe(1);
    }
  });

  it('fails closed on unsupported relevant explicit deny conditions', () => {
    const value = candidate('execute'); value.Statement.push({ ...decrypt(), Sid: 'UnsupportedDeny', Effect: 'Deny', Condition: { Bool: { 'kms:GrantIsForAWSResource': 'true' } } });
    expect(check(value, 'execute').stderr).toContain('backend_unsupported_relevant_condition');
  });

  it('preserves all eighteen supplied historical-shape statements except the existing object-read deny carveout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'backend-kms-baseline-'));
    try {
      const original = syntheticBaseline(); expect(original.policy.Statement).toHaveLength(18);
      const file = join(directory, 'baseline.json'); const bytes = JSON.stringify(original); writeFileSync(file, bytes);
      const result = cli(['backend-proposal', file]); expect(result.status, result.stderr).toBe(0);
      const proposal = JSON.parse(result.stdout) as { baseline: typeof original; proposed: typeof original };
      expect(proposal.baseline).toEqual(original); expect(readFileSync(file, 'utf8')).toBe(bytes);
      for (const statement of original.policy.Statement.filter(s => s.Sid !== 'NoDeploymentDataAccess')) {
        expect(proposal.proposed.policy.Statement.find(s => s.Sid === statement.Sid)).toEqual(statement);
      }
      expect(proposal.proposed.policy.Statement.find(s => s.Sid === SID)).toEqual(decrypt());
      expect(check(proposal.proposed.policy, 'execute').stderr).toContain('backend_lock_key_tag_required');
      const proposedFile = join(directory, 'proposed.json'); writeFileSync(proposedFile, JSON.stringify(proposal.proposed.policy));
      const validateWithMetadata = (metadata: unknown) => spawnSync(process.execPath, ['--input-type=module', '-e', `import {readFileSync} from 'node:fs'; import {validatePolicy} from ${JSON.stringify(repositoryPath('infra/scripts/release-backend-contract.mjs'))}; validatePolicy(JSON.parse(readFileSync(process.argv[1], 'utf8')), 'execute', JSON.parse(process.argv[2]));`, proposedFile, JSON.stringify(metadata)], { encoding: 'utf8' });
      expect(validateWithMetadata({ lockKeyNamePrefix: null }).status).toBe(0);
      expect(validateWithMetadata({ lockKeyNamePrefix: 'unrelated-bootstrap' }).status).toBe(0);
      expect(validateWithMetadata({}).stderr).toContain('backend_lock_key_tag_required');
      for (const tag of ['fss-prod', 'fss-prod-locks', '*', 42, [], {}]) expect(validateWithMetadata({ lockKeyNamePrefix: tag }).status).toBe(1);
      // Root's already-authorized backend projection has the previous six backend
      // statements. A private delta may append only this new one, not re-render it.
      const current = structuredClone(proposal.proposed.policy); current.Statement = current.Statement.filter(s => s.Sid !== SID);
      expect(current.Statement).toHaveLength(25); const preserved = structuredClone(current.Statement);
      writeFileSync(proposedFile, JSON.stringify(current));
      expect(validateWithMetadata({ lockKeyNamePrefix: null }).stderr).toContain('backend_required_permission_denied');
      current.Statement.push(decrypt()); writeFileSync(proposedFile, JSON.stringify(current));
      expect(validateWithMetadata({ lockKeyNamePrefix: null }).status).toBe(0);
      expect(current.Statement.slice(0, 25)).toEqual(preserved);
      Reflect.deleteProperty(original, 'lockKeyNamePrefix'); writeFileSync(file, JSON.stringify(original));
      expect(cli(['backend-proposal', file]).stderr).toContain('backend_lock_key_tag_required');
      for (const tag of ['fss-prod', 'fss-prod-locks', '*']) {
        original.lockKeyNamePrefix = tag; writeFileSync(file, JSON.stringify(original));
        expect(cli(['backend-proposal', file]).status, tag).toBe(1);
      }
      original.lockKeyNamePrefix = null;
      original.policy.Statement.find(s => s.Sid === 'ManageTaggedKmsKeysInThisNamespace')!.Condition = { StringLike: { 'aws:ResourceTag/NamePrefix': '*' } };
      writeFileSync(file, JSON.stringify(original)); expect(cli(['backend-proposal', file]).status).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
