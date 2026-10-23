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
      const apiTaskDefinition = 'arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-api:1';
      const aws = executable('aws', `
const args=process.argv.slice(2),a=args.join(' '),fs=require('fs');
fs.appendFileSync(process.env.LOG,a+'\\n');
if(a.startsWith('sts get-caller-identity ')) console.log(JSON.stringify({Account:'326255650484',Arn:'arn:aws:sts::326255650484:assumed-role/'+(process.env.IDENTITY_ROLE||'fss-prod-ci-plan')+'/controlled'}));
else if(a.startsWith('ecs describe-services ')) console.log(JSON.stringify({services:['api','worker'].map(n=>({serviceName:'fss-prod-'+n,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:'arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-'+n+':1'}))}));
else if(a.startsWith('ecs describe-task-definition ')) {
 const requested=args[args.indexOf('--task-definition')+1];
 if(requested!==${JSON.stringify(apiTaskDefinition)}) process.exit(1);
 const taskDefinition={taskDefinitionArn:process.env.BASELINE_MODE==='mismatch'?requested.replace(':1',':2'):requested,containerDefinitions:[{name:'api',environment:[],secrets:[]}]};
 if(process.env.BASELINE_MODE==='unknown') delete taskDefinition.containerDefinitions;
 if(process.env.BASELINE_MODE==='enabled') taskDefinition.containerDefinitions[0].environment.push({name:'FSS_BROWSER_ORIGIN',value:'https://sales.example.test'});
 console.log(JSON.stringify({taskDefinition}));
}
else if(a.startsWith('rds describe-db-instances ')) console.log(JSON.stringify({DBInstances:[{DBInstanceIdentifier:'fss-prod-pg',DBInstanceStatus:process.env.BACKUP_MODE==='unavailable'?'backing-up':'available',BackupRetentionPeriod:process.env.BACKUP_MODE==='retention'?1:35,LatestRestorableTime:process.env.BACKUP_MODE==='invalid'?'invalid-time':process.env.BACKUP_MODE==='missing'?null:'2026-10-11T00:00:00Z'}]}));
else process.exit(1);`);
      const terraform = executable('terraform', `const fs=require('fs'),a=process.argv.slice(2); fs.appendFileSync(process.env.LOG,a.join(' ')+'\\n'); if(a.includes('plan')) {fs.copyFileSync(a.find(x=>x.startsWith('-var-file=')).slice(10),process.env.LOG+'.variables');fs.writeFileSync(a.find(x=>x.startsWith('-out=')).slice(5),'saved private plan bytes\\n'+fs.readFileSync(process.env.LOG+'.variables','utf8'));} else if(a.includes('show')) console.log(JSON.stringify({resource_changes:[{address:'aws_iam_role.ci_plan',change:{actions:['create']}}]})); else if(a.includes('state')) console.log(JSON.stringify({lineage:'literal-lineage',serial:7})); else if(!a.includes('init')) process.exit(1);`);
      executable('curl', `const fs=require('fs'); const countFile=process.env.LOG+'.health'; const n=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8')):0; fs.writeFileSync(countFile,String(n+1)); console.log(JSON.stringify({status:'serving',build:{commit:process.env.CHANGE_BASELINE==='1'&&n>0?'c'.repeat(40):'a'.repeat(40)},schema:{accepted:true,databaseVersion:88}}));`);
      const run = (output: string, change: boolean, backupMode = '', extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [repositoryPath('infra/scripts/reviewed-release.mjs'), 'prepare', images, key, 'absent-evidence', 'absent-binding', output], { cwd: repositoryPath('.'), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, FSS_REHEARSAL_AWS_COMMAND: aws, TERRAFORM: terraform, LOG: commands, BACKUP_MODE: backupMode, BASELINE_MODE: '', FSS_PRODUCTION_FOUNDER_BROWSER_JSON: '', CHANGE_BASELINE: change ? '1' : '0', COMMIT: 'b'.repeat(40), RUN_ID: '1', RUN_ATTEMPT: '1', GATE_RUN_ID: '2', FSS_PRODUCTION_ORIGIN: 'https://controlled.invalid', AWS_REGION: 'us-east-1', ...extra } });
      const prepared = join(directory, 'prepared'); const success = run(prepared, false);
      expect(success.status, success.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(join(prepared, 'public/manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ from: 'a'.repeat(40), fromSchema: 88, toSchema: 88, stateLineage: 'literal-lineage', stateSerial: 7, activationAllowed: false, backup: { retentionDays: 35, earliestRestorableTime: null, latestRestorableTime: '2026-10-11T00:00:00Z', restoreTested: false }, changes: [{ address: 'aws_iam_role.ci_plan', actions: ['create'] }] });
      expect(existsSync(join(prepared, 'private'))).toBe(false);
      expect(manifest.bindings.apiTaskDefinition).toBe(apiTaskDefinition);
      expect(JSON.parse(readFileSync(commands + '.variables', 'utf8')).founder_browser).toBeNull();
      expect(readFileSync(commands, 'utf8')).toContain(`ecs describe-task-definition --task-definition ${apiTaskDefinition} --output json`);
      expect(readFileSync(commands, 'utf8')).not.toContain('apply');
      for (const [mode, reason] of [['mismatch', 'baseline_api_binding_changed'], ['unknown', 'founder_browser_configuration_invalid'], ['enabled', 'founder_browser_configuration_required']]) {
        const refused = join(directory, `baseline-${mode}`); const before = readFileSync(commands, 'utf8');
        const result = run(refused, false, '', { BASELINE_MODE: mode });
        expect(result.status, mode).toBe(1); expect(result.stderr).toContain(reason);
        expect(readFileSync(commands, 'utf8').slice(before.length)).not.toContain('-chdir=');
        expect(existsSync(join(refused, 'public/manifest.json'))).toBe(false);
        expect(existsSync(join(refused, 'private'))).toBe(false);
      }
      const configuration = { origin: 'https://sales.example.test', clientVersion: '1.0.0', founderWorkspaceId: '00000000-0000-4000-8000-000000000001', founderUserId: '00000000-0000-4000-8000-000000000002', cookieKeySecretArn: 'arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/browser-cookie-key-ABC123' };
      const configured = join(directory, 'configured');
      const configuredResult = run(configured, false, '', { BASELINE_MODE: 'enabled', FSS_PRODUCTION_FOUNDER_BROWSER_JSON: JSON.stringify(configuration) });
      expect(configuredResult.status, configuredResult.stderr).toBe(0);
      expect(JSON.parse(readFileSync(commands + '.variables', 'utf8')).founder_browser).toEqual(configuration);
      const configuredManifest = JSON.parse(readFileSync(join(configured, 'public/manifest.json'), 'utf8'));
      const savedBytes = 'saved private plan bytes\n' + readFileSync(commands + '.variables', 'utf8');
      expect(configuredManifest).toMatchObject({ activationAllowed: false, bindings: { apiTaskDefinition }, planSha256: createHash('sha256').update(savedBytes).digest('hex') });
      expect(existsSync(join(configured, 'public/plan.encrypted.json'))).toBe(true);
      const privateKey = join(directory, 'recipient.pem'); const decrypted = join(directory, 'decrypted-plan');
      writeFileSync(privateKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      const opened = spawnSync(process.execPath, [repositoryPath('infra/scripts/release-plan-transport.mjs'), 'decrypt', join(configured, 'public/plan.encrypted.json'), join(configured, 'public/manifest.json'), privateKey, decrypted], { encoding: 'utf8' });
      expect(opened.status, opened.stderr).toBe(0); expect(readFileSync(decrypted, 'utf8')).toBe(savedBytes);
      expect(existsSync(join(configured, 'private'))).toBe(false);
      expect(readFileSync(join(configured, 'public/manifest.json'), 'utf8')).not.toContain(configuration.cookieKeySecretArn);
      for (const mode of ['retention', 'invalid', 'missing', 'unavailable']) {
        const refused = join(directory, `backup-${mode}`);
        const result = run(refused, false, mode);
        expect(result.status, mode).toBe(1);
        expect(result.stderr).toContain('reviewed_backup_unavailable');
        expect(existsSync(join(refused, 'public/manifest.json'))).toBe(false);
        expect(existsSync(join(refused, 'private'))).toBe(false);
      }
      for (const role of ['fss-prod-deploy', 'fss-prod-ci-deploy', 'fss-prod-ci-maintenance']) {
        const result = run(join(directory, `wrong-${role}`), false, '', { IDENTITY_ROLE: role });
        expect(result.status).toBe(1); expect(result.stderr).toContain('reviewed_identity_mismatch');
      }
      rmSync(commands + '.health');
      const failed = join(directory, 'failed'); const failure = run(failed, true);
      expect(failure.status).toBe(1); expect(failure.stderr).toContain('reviewed_baseline_changed_during_plan');
      expect(existsSync(join(failed, 'public/manifest.json'))).toBe(false);
      expect(existsSync(join(failed, 'private'))).toBe(false);
      expect(readFileSync(commands, 'utf8')).not.toContain('apply');
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
      const run = (...args: string[]) => spawnSync(process.execPath, [repositoryPath('infra/scripts/release-plan-transport.mjs'), ...args], { encoding: 'utf8' });
      expect(run('seal', plan, manifest, publicPath, fingerprint, packet).status).toBe(0);
      expect(run('decrypt', packet, manifest, privatePath, output).status).toBe(0);
      expect(readFileSync(output)).toEqual(bytes);
      writeFileSync(manifest, original + '\n');
      expect(run('decrypt', packet, manifest, privatePath, join(directory, 'refused')).status).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
