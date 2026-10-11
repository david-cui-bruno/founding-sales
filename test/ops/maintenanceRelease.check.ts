import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';
describe('routine maintenance operator', () => {
  it('refuses a held release before credentials or cloud operations and leaves visible status', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maintenance-status-'));
    try {
      const result = spawnSync(process.execPath, [repositoryPath('infra/scripts/maintenance-release.mjs'), '--status', join(directory, 'status.json')], { env: { ...process.env, FSS_RELEASE_HOLD: 'true' }, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))).toMatchObject({ phase: 'readiness', outcome: 'held', writesStarted: false });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

// Controlled cloud/operations adapters exercise the operator command, not its helpers.
// The existing operation-script suites separately verify stop/migrate/record behavior.
import { chmodSync, writeFileSync } from 'node:fs';
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
function controlledRelease(failure = '') {
  const directory = mkdtempSync(join(tmpdir(), 'routine-controlled-'));
  const bin = join(directory, 'bin');
  // mkdir imported through the standard fs seam, private files never contain credentials.
  mkdirSync(bin);
  const executable = (name: string, source: string) => {
    const file = join(bin, name); writeFileSync(file, `#!${process.execPath}\n${source}`); chmodSync(file, 0o700); return file;
  };
  const definitions: Record<string, unknown> = {};
  for (const name of ['api', 'worker', 'operations', 'migration']) {
    const image = name === 'api' ? 'api' : 'worker';
    definitions[name] = { taskDefinition: {
      family: `fss-prod-${name}`, taskDefinitionArn: `arn:aws:ecs:us-east-1:123456789012:task-definition/fss-prod-${name}:1`,
      containerDefinitions: [{ name, image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-${image}@sha256:${'0'.repeat(64)}`,
        environment: [{ name: 'FSS_SCHEMA_MIN', value: '1' }, { name: 'FSS_SCHEMA_MAX', value: '1' }, { name: 'FSS_DATABASE_HOST', value: 'database.invalid' }, { name: 'FSS_SENDING_ENABLED', value: 'false' }, { name: 'FSS_CRM_CAPABILITY_ADAPTERS', value: 'preserved-settings' }],
        secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: 'runtime-secret-reference' }, { name: 'MIGRATION_DATABASE_SECRET', valueFrom: 'migration-secret-reference' }], logConfiguration: { options: { 'awslogs-group': '/fss/fss-prod/worker' } } }],
    }, tags: [{ key: 'NamePrefix', value: 'fss-prod' }] };
  }
  const aws = executable('aws', `const fs=require('node:fs'); const args=process.argv.slice(2); const defs=${JSON.stringify(definitions)}; const log=process.env.TEST_DIRECTORY+'/calls.jsonl'; fs.appendFileSync(log,JSON.stringify(args)+'\\n'); let value;
if(args[0]==='sts') value={Account:'123456789012',Arn:'arn:aws:sts::123456789012:assumed-role/fss-prod-ci-maintenance/fss-prod-maintenance-1'};
else if(args[1]==='describe-services'){const name=args[args.indexOf('--services')+1];value={services:[{status:'ACTIVE',taskDefinition:'arn:aws:ecs:us-east-1:123456789012:task-definition/'+name+':1',desiredCount:name.endsWith('api')?2:1,runningCount:name.endsWith('api')?2:1,pendingCount:0,networkConfiguration:{awsvpcConfiguration:{subnets:['subnet-12345678'],securityGroups:['sg-12345678'],assignPublicIp:'ENABLED'}}}]};}
else if(args[1]==='describe-task-definition'){const ref=args[args.indexOf('--task-definition')+1]; const name=ref.split('fss-prod-')[1].split(':')[0];value=defs[name];}
else if(args[1]==='describe-db-instances') value={DBInstances:[{BackupRetentionPeriod:35,LatestRestorableTime:'2026-10-11T14:00:00Z',EarliestRestorableTime:'2026-09-10T14:00:00Z',DBInstanceStatus:'available',Endpoint:{Address:'database.invalid'},DBName:'fss'}]};
else if(args[1]==='describe-security-groups') value={SecurityGroups:[{IpPermissions:[]}]};
else if(args[1]==='register-task-definition'){const doc=JSON.parse(fs.readFileSync(args[args.indexOf('--cli-input-json')+1].slice(7)));fs.appendFileSync(process.env.TEST_DIRECTORY+'/registered.jsonl',JSON.stringify(doc)+'\\n');value={taskDefinition:{taskDefinitionArn:'arn:aws:ecs:us-east-1:123456789012:task-definition/'+doc.family+':2'}};}
else if(args[1]==='update-service') value={service:{}}; else throw new Error('Unhandled controlled cloud operation');console.log(JSON.stringify(value));`);
  const step = executable('step', `const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(process.env.TEST_DIRECTORY+'/steps.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='record.sh'&&args[1]==='from-ci')fs.writeFileSync(args[args.indexOf('--out')+1],'{}');
if(args[0]==='deploy.sh'&&args[1]==='release'){fs.writeFileSync(process.env.TEST_DIRECTORY+'/migrated','yes');if(process.env.TEST_FAIL)process.exit(1);}
if(args[0]==='deploy.sh'&&args[2]==='canary')console.log('canary_age=2');`);
  executable('curl', `const fs=require('node:fs'); const args=process.argv.slice(2);const migrated=fs.existsSync(process.env.TEST_DIRECTORY+'/migrated');const body=JSON.stringify({status:'serving',build:{commit:migrated?'${HEAD}':'${BASE}'},schema:{databaseVersion:migrated?2:1,accepted:true}});const at=args.indexOf('-o');if(at>=0){fs.writeFileSync(args[at+1],body);process.stdout.write('200');}else process.stdout.write(body);`);
  writeFileSync(join(directory, 'plan.json'), JSON.stringify({ decision: 'maintenance', from: BASE, to: HEAD, fromSchema: 1, toSchema: 2 }));
  const images = Object.fromEntries(['api', 'worker'].map((name, index) => [name, { repository: `fss-rh-${name}`, tag: `ci-${HEAD}`, digest: `sha256:${String(index + 1).repeat(64)}`, schemaRange: { minimum: 2, maximum: 2 } }]));
  writeFileSync(join(directory, 'digests.json'), JSON.stringify({ schema: 'fss.image-digests.v1', commit: HEAD, workflowRunId: '1', workflowRunAttempt: '1', images }));
  writeFileSync(join(directory, 'evidence.txt'), 'PASS  schema 1 → 2\n');
  const result = spawnSync(process.execPath, [repositoryPath('infra/scripts/maintenance-release.mjs'), '--plan', join(directory, 'plan.json'), '--digests', join(directory, 'digests.json'), '--evidence', join(directory, 'evidence.txt'), '--status', join(directory, 'status.json')], {
    env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, GITHUB_ACTIONS: 'false', TEST_DIRECTORY: directory, TEST_FAIL: failure, FSS_RELEASE_SCRIPT_COMMAND: step, FSS_REHEARSAL_AWS_COMMAND: aws, FSS_RELEASE_HOLD: 'false', FSS_PRODUCTION_ACCOUNT_ID: '123456789012', COMMIT: HEAD, GATE_RUN_ID: '1', RUN_ID: '1', RUN_ATTEMPT: '1', FSS_PRODUCTION_ORIGIN: 'https://api.example.invalid', RESOLVE_ATTEMPTS: '1' }, encoding: 'utf8',
  });
  return { directory, result };
}
describe('routine maintenance through controlled cloud and existing operation seams', () => {
  it('stores records before drain, preserves settings, migrates before verification and reports actual completion', () => {
    const { directory, result } = controlledRelease();
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))).toMatchObject({ phase: 'verified', outcome: 'completed', schema: 2, backup: { restoreTested: false, retentionDays: 35 } });
      const steps: string[][] = readFileSync(join(directory, 'steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      const meaningful = steps.filter(step => !(step[0] === 'deploy.sh' && step[2] === 'gate')).map(step => `${step[0]} ${step[1]}`);
      expect(meaningful).toEqual(['record.sh from-ci', 'record.sh put', 'images.sh promote', 'stop.sh infra/roots/production', 'deploy.sh release', 'record.sh read-back', 'deploy.sh ci', 'productionSmoke.mjs https://api.example.invalid']);
      expect(readFileSync(join(directory, 'calls.jsonl'), 'utf8')).toContain('fss-prod-pg');
      const registered = readFileSync(join(directory, 'registered.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { containerDefinitions: { environment: { name: string; value: string }[] }[] });
      for (const definition of registered) expect(definition.containerDefinitions[0]?.environment).toContainEqual({ name: 'FSS_CRM_CAPABILITY_ADAPTERS', value: 'preserved-settings' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps migration failure unknown, never starts a rollback and exposes forward-repair status', () => {
    const { directory, result } = controlledRelease('after-migration');
    try {
      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))).toMatchObject({ phase: 'migrate-verify-restart', outcome: 'repair-required', schema: 'unknown-after-migration-attempt' });
      expect(readFileSync(join(directory, 'steps.jsonl'), 'utf8')).not.toContain('rollback');
      expect(readFileSync(join(directory, 'steps.jsonl'), 'utf8')).not.toContain('read-back');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
