import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';
describe('reviewed saved production plan contract', () => {
  it('accepts only the exact reviewed manifest and refuses changed source before authority or writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reviewed-manifest-'));
    try {
      const manifest = { version: 'fss.reviewed-production-plan.v1', commit: 'b'.repeat(40), from: 'a'.repeat(40), fromSchema: 88, toSchema: 99, planSha256: 'c'.repeat(64), recipientPublicKeySha256: 'd'.repeat(64), imagesRunId: '1', gateRunId: '2', digests: { api: `sha256:${'1'.repeat(64)}`, worker: `sha256:${'2'.repeat(64)}` }, bindings: { apiTaskDefinition: 'api:1', workerTaskDefinition: 'worker:1' } };
      const file = join(directory, 'manifest.json'); const bytes = JSON.stringify(manifest); writeFileSync(file, bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const run = (commit: string, approvedHash: string) => spawnSync(process.execPath, [repositoryPath('infra/scripts/reviewed-release.mjs'), 'validate', file, approvedHash], { env: { ...process.env, COMMIT: commit, RUN_ID: '1', GATE_RUN_ID: '2' }, encoding: 'utf8' });
      expect(run(manifest.commit, hash).status).toBe(0);
      expect(run('e'.repeat(40), hash).status).toBe(1);
      expect(run(manifest.commit, 'f'.repeat(64)).status).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps reviewed execution held before identity or Terraform access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reviewed-held-'));
    try {
      const result = spawnSync(process.execPath, [repositoryPath('infra/scripts/reviewed-release.mjs'), 'execute', 'absent-manifest', 'absent-hash', 'absent-packet', 'absent-key', 'absent-images', directory], { env: { ...process.env, FSS_RELEASE_HOLD: 'true' }, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))).toMatchObject({ outcome: 'held', writesStarted: false, schema: 'unobserved', reason: 'release_held' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('prepares the exact observed saved plan without apply and removes private bytes on a changed baseline', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reviewed-prepare-'));
    try {
      const bin = join(directory, 'bin'); mkdirSync(bin);
      const commands = join(directory, 'commands'); const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
      const key = join(directory, 'public.pem'); writeFileSync(key, pair.publicKey.export({ type: 'spki', format: 'pem' }));
      const images = join(directory, 'images.json');
      writeFileSync(images, JSON.stringify({ schema: 'fss.image-digests.v1', commit: 'b'.repeat(40), workflowRunId: '1', workflowRunAttempt: '1', images: {
        api: { repository: 'fss-rh-api', tag: `ci-${'b'.repeat(40)}`, digest: `sha256:${'1'.repeat(64)}`, schemaRange: { minimum: 88, maximum: 88 } },
        worker: { repository: 'fss-rh-worker', tag: `ci-${'b'.repeat(40)}`, digest: `sha256:${'2'.repeat(64)}`, schemaRange: { minimum: 88, maximum: 88 } },
      } }));
      const executable = (name: string, source: string) => { const file = join(bin, name); writeFileSync(file, `#!${process.execPath}\n${source}`); chmodSync(file, 0o755); return file; };
      const aws = executable('aws', `const a=process.argv.slice(2).join(' '); const fs=require('fs'); fs.appendFileSync(process.env.LOG,a+'\\n'); if(a.startsWith('sts ')) console.log(JSON.stringify({Account:'326255650484',Arn:'arn:aws:sts::326255650484:assumed-role/fss-prod-ci-plan/controlled'})); else if(a.startsWith('ecs ')) console.log(JSON.stringify({services:['api','worker'].map(n=>({serviceName:'fss-prod-'+n,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:n+':1'}))})); else if(a.startsWith('rds ')) console.log(JSON.stringify({DBInstances:[{DBInstanceIdentifier:'fss-prod-pg',DBInstanceStatus:'available',BackupRetentionPeriod:35,EarliestRestorableTime:'2026-10-01T00:00:00Z',LatestRestorableTime:'2026-10-11T00:00:00Z'}]})); else process.exit(1);`);
      const terraform = executable('terraform', `const fs=require('fs'),a=process.argv.slice(2); fs.appendFileSync(process.env.LOG,a.join(' ')+'\\n'); if(a.includes('plan')) fs.writeFileSync(a.find(x=>x.startsWith('-out=')).slice(5),'saved private plan bytes'); else if(a.includes('show')) console.log(JSON.stringify({resource_changes:[{address:'aws_iam_role.ci_plan',change:{actions:['create']}}]})); else if(a.includes('state')) console.log(JSON.stringify({lineage:'literal-lineage',serial:7})); else if(!a.includes('init')) process.exit(1);`);
      executable('curl', `const fs=require('fs'); const countFile=process.env.LOG+'.health'; const n=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8')):0; fs.writeFileSync(countFile,String(n+1)); console.log(JSON.stringify({status:'serving',build:{commit:process.env.CHANGE_BASELINE==='1'&&n>0?'c'.repeat(40):'a'.repeat(40)},schema:{accepted:true,databaseVersion:88}}));`);
      const run = (output: string, change: boolean) => spawnSync(process.execPath, [repositoryPath('infra/scripts/reviewed-release.mjs'), 'prepare', images, key, 'absent-evidence', 'absent-binding', output], { cwd: repositoryPath('.'), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, FSS_REHEARSAL_AWS_COMMAND: aws, TERRAFORM: terraform, LOG: commands, CHANGE_BASELINE: change ? '1' : '0', COMMIT: 'b'.repeat(40), RUN_ID: '1', RUN_ATTEMPT: '1', GATE_RUN_ID: '2', FSS_PRODUCTION_ORIGIN: 'https://controlled.invalid', AWS_REGION: 'us-east-1' } });
      const prepared = join(directory, 'prepared'); const success = run(prepared, false);
      expect(success.status, success.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(join(prepared, 'public/manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ from: 'a'.repeat(40), fromSchema: 88, toSchema: 88, stateLineage: 'literal-lineage', stateSerial: 7, activationAllowed: false, backup: { retentionDays: 35, restoreTested: false }, changes: [{ address: 'aws_iam_role.ci_plan', actions: ['create'] }] });
      expect(existsSync(join(prepared, 'private'))).toBe(false);
      expect(readFileSync(commands, 'utf8')).not.toContain('apply');
      rmSync(commands + '.health');
      const failed = join(directory, 'failed'); const failure = run(failed, true);
      expect(failure.status).toBe(1); expect(failure.stderr).toContain('reviewed_baseline_changed_during_plan');
      expect(existsSync(join(failed, 'public/manifest.json'))).toBe(false);
      expect(existsSync(join(failed, 'private'))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('transports exact saved bytes and rejects a changed manifest before decryption', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reviewed-plan-'));
    try {
      const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
      const fingerprint = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      const plan = join(directory, 'plan'); const manifest = join(directory, 'manifest'); const publicPath = join(directory, 'public'); const privatePath = join(directory, 'private'); const packet = join(directory, 'packet'); const output = join(directory, 'output');
      const bytes = Buffer.from([0, 1, 2, 255, 10]); writeFileSync(plan, bytes);
      writeFileSync(publicPath, publicKey); writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const original = JSON.stringify({ planSha256: createHash('sha256').update(bytes).digest('hex') }); writeFileSync(manifest, original);
      const run = (...args: string[]) => spawnSync(process.execPath, [repositoryPath('infra/scripts/diagnostic-plan.mjs'), ...args], { encoding: 'utf8' });
      expect(run('seal', plan, manifest, publicPath, fingerprint, packet).status).toBe(0);
      expect(run('decrypt', packet, manifest, privatePath, output).status).toBe(0);
      expect(readFileSync(output)).toEqual(bytes);
      writeFileSync(manifest, original + '\n');
      expect(run('decrypt', packet, manifest, privatePath, join(directory, 'refused')).status).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
