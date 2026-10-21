import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';
import { reviewedSafetyCloud } from './support/reviewedSafetyCloud.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const COMMIT = 'b'.repeat(40);
const API = `sha256:${'1'.repeat(64)}`;
const WORKER = `sha256:${'2'.repeat(64)}`;
// Real reviewed execute, manifest validator and encrypted transport. Cloud, public
// health, Terraform and gate commands are controlled processes, never live tools.
function execute(mode: string) {
  const schemaChange = mode.startsWith('schema-');
  const smoke = mode.startsWith('smoke-') || schemaChange;
  const directory = mkdtempSync(join(tmpdir(), 'reviewed-backend-execute-'));
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const scripts = join(directory, 'infra/scripts'); mkdirSync(scripts, { recursive: true });
    mkdirSync(join(directory, 'infra/roots/production'), { recursive: true });
    mkdirSync(join(directory, 'infra/policies'), { recursive: true });
    for (const name of ['backend.hcl', 'providers.tf', 'versions.tf', 'main.tf']) copyFileSync(repositoryPath(`infra/roots/production/${name}`), join(directory, 'infra/roots/production', name));
    copyFileSync(repositoryPath('infra/policies/production-backend-plan.json'), join(directory, 'infra/policies/production-backend-plan.json'));
    copyFileSync(repositoryPath('infra/scripts/release-plan-transport.mjs'), join(scripts, 'release-plan-transport.mjs'));
    mkdirSync(join(directory, 'packages/domain/db'), { recursive: true });
    copyFileSync(repositoryPath('packages/domain/db/schemaRange.ts'), join(directory, 'packages/domain/db/schemaRange.ts'));
    const log = join(directory, 'commands'); writeFileSync(log, '');
    const executable = (path: string, source: string) => { writeFileSync(path, `#!${process.execPath}\n${source}`); chmodSync(path, 0o755); return path; };
    executable(join(bin, 'aws'), `const fs=require('fs'),a=process.argv.slice(2).join(' '); fs.appendFileSync(process.env.LOG,'aws '+a+'\\n'); if(a.startsWith('sts ')) console.log(JSON.stringify({Account:'326255650484',Arn:'arn:aws:sts::326255650484:assumed-role/'+(process.env.MODE==='identity'?'fss-prod-ci-deploy':'fss-prod-deploy')+'/controlled'})); else if(a.startsWith('ecs describe-task-definition ')) console.log(JSON.stringify({taskDefinition:{containerDefinitions:[{environment:[{name:'FSS_SENDING_ENABLED',value:'false'}]}]}})); else if(a.startsWith('ecs ')) console.log(JSON.stringify({services:['api','worker'].map(n=>({serviceName:'fss-prod-'+n,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:n+':1'}))})); else if(a.startsWith('rds ')) console.log(JSON.stringify({DBInstances:[{DBInstanceIdentifier:'fss-prod-pg',DBInstanceStatus:'available',BackupRetentionPeriod:35,LatestRestorableTime:'2026-10-17T00:00:00Z'}]})); else process.exit(99);`);
    executable(join(bin, 'curl'), `const fs=require('fs'),file=process.env.LOG+'.health',n=fs.existsSync(file)?1:0;fs.writeFileSync(file,'read');console.log(JSON.stringify({status:'serving',build:{commit:(n?'b':'a').repeat(40)},schema:{accepted:true,databaseVersion:88}}));`);
    const terraform = executable(join(bin, 'terraform'), `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,'terraform '+a.join(' ')+'\\n'); if(a.includes('init')) {if(['lock-denied','read-denied'].includes(process.env.MODE))process.exit(1);} else if(a.includes('state'))console.log(JSON.stringify({lineage:process.env.MODE==='lineage'?'foreign':'lineage',serial:process.env.MODE==='serial'?8:7}));else if(a.includes('show'))console.log(JSON.stringify({variables:{assume_deployment_role:{value:process.env.MODE==='provider'},api_image:{value:'326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@${API}'},worker_image:{value:'326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@${WORKER}'}}}));else if(process.env.MODE.startsWith('smoke-')&&a.includes('output'))console.log(JSON.stringify({api:{declared_desired_count:1},worker:{declared_desired_count:1}}));else if(!(process.env.MODE.startsWith('smoke-')&&a.includes('apply')))process.exit(99);`);
    executable(join(scripts, 'deploy.sh'), `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,'deploy '+a.join(' ')+'\\n');if(a[0]==='ci'&&a[1]==='gate')process.exit(0);if(!process.env.MODE.startsWith('smoke-'))process.exit(99);if(a[0]==='ci'&&a[1]==='canary')console.log('canary_age=1');else if(a[0]!=='release')process.exit(99);`);
    if (smoke) {
      const cloud = reviewedSafetyCloud
        .replace("mode==='schema-stopping-writer'?'STOPPING':'STOPPED'", "mode==='schema-stopping-writer'?'STOPPING':mode==='schema-shutdown-progress'?(flag('shutdown-observed')?'STOPPED':(fs.writeFileSync(log+'.shutdown-observed','yes'),'STOPPING')):'STOPPED'")
        .replace("['schema-stopping-writer','schema-terminal-writer']", "['schema-stopping-writer','schema-terminal-writer','schema-shutdown-progress']");
      executable(join(bin, 'aws'), cloud);
      executable(terraform, `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,'terraform '+a.join(' ')+'\\n');
        if(a.includes('init')){}else if(a.includes('state'))console.log(JSON.stringify({lineage:'lineage',serial:7}));
        else if(a.includes('show'))console.log(JSON.stringify({variables:{assume_deployment_role:{value:false},api_image:{value:'326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@${API}'},worker_image:{value:'326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@${WORKER}'}}}));
        else if(a.includes('output'))console.log(JSON.stringify({api:{declared_desired_count:1},worker:{declared_desired_count:1},operations_task_definition:'arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-operations:1'}));
        else if(a.includes('apply'))fs.writeFileSync(process.env.LOG+'.applied','yes');else process.exit(99);`);
      executable(join(scripts, 'stop.sh'), `const fs=require('fs');fs.appendFileSync(process.env.LOG,'stop\\n');fs.writeFileSync(process.env.LOG+'.stopped','yes');`);
      executable(join(scripts, 'deploy.sh'), `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,'deploy '+a.join(' ')+'\\n');if(a[0]==='ci'&&a[1]==='gate'){if(process.env.MODE==='schema-postrestart-gate'&&fs.existsSync(process.env.LOG+'.migrated'))process.exit(1);if(process.env.MODE==='schema-stale-finalgate'&&fs.existsSync(process.env.LOG+'.off-count')&&Number(fs.readFileSync(process.env.LOG+'.off-count','utf8'))===3){fs.writeFileSync(process.env.LOG+'.clock',String(Date.now()+181000));fs.appendFileSync(process.env.LOG,'final-gate advanced 181s\\n');}process.exit(0);}if(a[0]==='ci'&&a[1]==='canary')console.log('canary_age=1');else if(a[0]==='release'){fs.writeFileSync(process.env.LOG+'.migrated','yes');if(process.env.MODE==='schema-release-unknown')process.exit(1);}else process.exit(99);`);
      executable(join(bin, 'curl'), `const fs=require('fs'),m=fs.existsSync(process.env.LOG+'.migrated');console.log(JSON.stringify({status:'serving',build:{commit:(m?'b':'a').repeat(40)},schema:{accepted:true,databaseVersion:m&&process.env.MODE.startsWith('schema-')?89:88}}));`);
      for (const name of ['record.sh', 'images.sh']) executable(join(scripts, name), `require('fs').appendFileSync(process.env.LOG,'${name} '+process.argv.slice(2).join(' ')+'\\n');`);
      mkdirSync(join(directory, 'scripts'));
      // A real child imports syntax Node24 cannot execute with strip-only support.
      writeFileSync(join(directory, 'scripts/smoke-types.ts'), 'export class Check { constructor(public passed: boolean) {} }');
      writeFileSync(join(directory, 'scripts/productionSmoke.mjs'), `import { Check } from './smoke-types.ts';import { appendFileSync } from 'node:fs';appendFileSync(process.env.LOG,'smoke '+JSON.stringify({flags:process.execArgv,args:process.argv.slice(2),passed:new Check(true).passed})+'\\n');console.log('private-smoke-stdout');console.error('private-smoke-stderr');if(process.env.MODE==='smoke-fail')process.exit(1);`);
    }
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const publicPath = join(directory, 'public.pem'); const privatePath = join(directory, 'private.pem');
    writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const fingerprint = hash(pair.publicKey.export({ type: 'spki', format: 'der' }));
    const saved = join(directory, 'saved'); writeFileSync(saved, 'controlled immutable saved plan');
    const manifest = { version: 'fss.reviewed-production-plan.v1', commit: COMMIT, from: 'a'.repeat(40), fromSchema: 88, toSchema: schemaChange ? 89 : 88, imagesRunId: '1', gateRunId: '2', planSha256: hash(readFileSync(saved)), recipientPublicKeySha256: fingerprint, digests: { api: API, worker: WORKER }, bindings: { apiTaskDefinition: 'api:1', workerTaskDefinition: 'worker:1' }, stateLineage: 'lineage', stateSerial: 7 };
    const manifestPath = join(directory, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(directory, 'images.json'), JSON.stringify({ schema: 'fss.image-digests.v1', commit: COMMIT, workflowRunId: '1', workflowRunAttempt: '1', images: {
      api: { repository: 'fss-rh-api', tag: `ci-${COMMIT}`, digest: API, schemaRange: { minimum: schemaChange ? 89 : 88, maximum: schemaChange ? 89 : 88 } },
      worker: { repository: 'fss-rh-worker', tag: `ci-${COMMIT}`, digest: WORKER, schemaRange: { minimum: schemaChange ? 89 : 88, maximum: schemaChange ? 89 : 88 } },
    } }));
    const envelope = join(directory, 'envelope.json');
    const sealed = spawnSync(process.execPath, [repositoryPath('infra/scripts/release-plan-transport.mjs'), 'seal', saved, manifestPath, publicPath, fingerprint, envelope], { encoding: 'utf8' });
    expect(sealed.status, sealed.stderr).toBe(0);
    if (mode === 'plan') {
      const packet = JSON.parse(readFileSync(envelope, 'utf8')) as { ciphertext: string }; packet.ciphertext = Buffer.from('changed ciphertext').toString('base64');
      writeFileSync(envelope, JSON.stringify(packet, null, 2) + '\n');
    }
    const output = join(directory, 'out');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, TERRAFORM: terraform, LOG: log, MODE: mode, COMMIT: mode === 'source' ? 'c'.repeat(40) : COMMIT, RUN_ID: '1', RUN_ATTEMPT: '1', GATE_RUN_ID: '2', AWS_REGION: 'us-east-1', FSS_RELEASE_HOLD: 'false', FSS_PRODUCTION_ORIGIN: 'https://controlled.invalid', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'david-cui-bruno/founding-sales/.github/workflows/greenfield-deploy.yml@refs/heads/main' };
    env['GITHUB_RUN_ID'] = '33'; env['TASK_SUBNETS'] = 'subnet-11111111,subnet-22222222'; env['TASK_SECURITY_GROUP'] = 'sg-11111111';
    delete env['FSS_REHEARSAL_AWS_COMMAND'];
    delete env['NODE_OPTIONS'];
    const clock = join(directory, 'controlled-clock.mjs');
    writeFileSync(clock, `import { existsSync, readFileSync } from 'node:fs';const realNow=Date.now;Date.now=()=>existsSync(process.env.LOG+'.clock')?Number(readFileSync(process.env.LOG+'.clock','utf8')):realNow();if(['schema-containment-stuck','schema-postrestart-unknown','schema-stopping-writer','schema-shutdown-progress'].includes(process.env.MODE))globalThis.setTimeout=callback=>setImmediate(callback);`);
    if (mode === 'schema-template-stale') {
      // Freeze the native template container: success must clone, never mutate it.
      writeFileSync(clock, readFileSync(clock, 'utf8') + `const parse=JSON.parse;JSON.parse=(...args)=>{const value=parse(...args),d=value?.taskDefinition;if(d?.family==='fss-prod-operations'&&d.taskDefinitionArn.endsWith(':1'))Object.freeze(d.containerDefinitions[0]);return value;};`);
    }
    const result = spawnSync(process.execPath, ['--import', clock, repositoryPath('infra/scripts/reviewed-release.mjs'), 'execute', manifestPath, hash(readFileSync(manifestPath)), envelope, privatePath, join(directory, 'images.json'), output], { cwd: directory, env, encoding: 'utf8' });
    const commands = readFileSync(log, 'utf8');
    if (!smoke) expect(commands).not.toMatch(/(?:^|\s)(?:apply|put|promote)(?:\s|$)/mu);
    const status = JSON.parse(readFileSync(join(output, 'status.json'), 'utf8')) as { writesStarted: boolean; outcome: string; reason: string; recoveryPoint?: { timestamp: string; earliest: string; latest: string; restoreTested: boolean }; containment?: { outcome: string; reason: string; stopRequests: { service: string; outcome: string }[] }; currentTaskArn?: string; currentTaskOwner?: string; temporaryReaderDefinition?: string; lastStoppedTaskArn?: string; quiescedAt?: string };
    const runtimeStopped = ['api', 'worker'].map(name => { try { readFileSync(log + '.contained-fss-prod-' + name); return true; } catch { return false; } });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, commands, status, runtimeStopped };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('reviewed execution backend refusal before resource writes', () => {
  // Bindings are valid throughout so each case reaches the intended existing guard.
  it.each([
    ['source', 'reviewed_source_binding_changed'],
    ['identity', 'reviewed_identity_mismatch'],
    ['plan', 'operation_failed'],
    ['serial', 'reviewed_state_changed'],
    ['lineage', 'reviewed_state_changed'],
    ['provider', 'backend_provider_mapping_changed'],
    ['lock-denied', 'reviewed_init_failed'],
    ['read-denied', 'reviewed_init_failed'],
  ])('refuses %s without apply or release writes', (mode, reason) => {
    const result = execute(mode);
    expect(result.exitCode).toBe(1);
    expect(result.status).toMatchObject({ writesStarted: false, outcome: 'refused', reason });
    expect(result.stderr).toContain(reason);
  });
});

describe('reviewed schema release native safety integration', () => {
  it.each([
    ['schema-database-binding', 'database_binding_changed'], ['schema-network', 'network_binding_changed'],
    ['schema-reader-role', 'off_reader_binding_changed'], ['schema-reader-image', 'off_reader_binding_changed'],
    ['schema-reader-credential', 'off_reader_binding_changed'],
    ['schema-reader-host', 'off_reader_binding_changed'], ['schema-reader-tag', 'off_reader_binding_changed'],
    ...['account', 'region', 'repository', 'tag', 'digest'].map(suffix => [`schema-template-${suffix}`, 'off_reader_binding_changed']),
  ])('refuses %s before any reader launch or release write', (mode, reason) => {
    const result = execute(mode);
    expect(result.exitCode).toBe(1);
    expect(result.status).toMatchObject({ outcome: 'refused', writesStarted: false, reason });
    expect(result.commands).not.toMatch(/register-task-definition|run-task|record.sh put| apply |deploy release/u);
  });
  it('clones a stale state-bound template and executes only baseline then exact candidate images', () => {
    const result = execute('schema-template-stale');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.status).toMatchObject({ outcome: 'completed', schema: 89 });
    const images = result.commands.split('\n').filter(line => line.startsWith('reader image '));
    const repository = 'reader image 326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:';
    expect(images).toEqual([repository + '3'.repeat(64), repository + '3'.repeat(64), repository + '2'.repeat(64), repository + '2'.repeat(64)]);
    expect(result.commands).not.toContain(repository + '4'.repeat(64));
  });
  it.each([
    ['schema-candidate-image', 'off_reader_binding_changed', true],
    ['schema-reader-readback-image', 'registered_definition_changed', false],
    ['schema-reader-task-digest', 'task_failed_or_foreign', false],
  ] as const)('keeps %s fail-closed without migration or replay', (mode, reason, applied) => {
    const result = execute(mode);
    expect(result.exitCode).toBe(1);
    expect(result.status).toMatchObject({ outcome: 'repair-required', reason });
    expect(result.commands.includes(' apply ')).toBe(applied);
    expect(result.commands).not.toMatch(/deploy release|smoke /u);
  });
  it.each(['schema-pass', 'schema-terminal-writer', 'schema-shutdown-progress'])('pins covered quiescence before immutable apply/migration and checks OFF at four boundaries (%s)', mode => {
    const result = execute(mode);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.status).toMatchObject({ outcome: 'completed', schema: 89, recoveryPoint: { restoreTested: false } });
    const point = result.status.recoveryPoint!;
    expect(point.timestamp).toBe(result.status.quiescedAt);
    expect(Date.parse(point.earliest)).toBeLessThanOrEqual(Date.parse(point.timestamp));
    expect(Date.parse(point.latest)).toBeGreaterThanOrEqual(Date.parse(point.timestamp));
    const commands = result.commands.split('\n');
    const reads = commands.flatMap((line, i) => line === 'aws logs get-log-events' ? [i] : []);
    expect(reads).toHaveLength(4);
    const put = commands.findIndex(line => line.startsWith('record.sh put'));
    const stop = commands.indexOf('stop');
    const backup = commands.indexOf('aws rds describe-db-instance-automated-backups');
    const apply = commands.findIndex(line => line.includes(' apply '));
    const migrate = commands.findIndex(line => line.startsWith('deploy release'));
    expect(reads[0]).toBeLessThan(put);
    expect(stop).toBeLessThan(reads[1]!);
    expect(reads[1]).toBeLessThan(backup);
    if (mode === 'schema-shutdown-progress') {
      const postStop = commands.slice(reads[1]! + 1, backup);
      expect(postStop.filter(line => line === 'aws ecs describe-tasks')).toHaveLength(2);
      expect(postStop.filter(line => line === 'aws ecs describe-services')).toHaveLength(2);
      expect(postStop.some(line => line.includes(' apply ') || line.startsWith('deploy release'))).toBe(false);
    }
    expect(backup).toBeLessThan(apply);
    expect(apply).toBeLessThan(reads[2]!);
    expect(reads[2]).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(reads[3]!);
    expect(result.commands).not.toMatch(/terraform .* plan |sending.*enable|put-role-policy/u);
  });
  it.each([
    ['schema-stale-finalgate', 'sending_not_fresh_off', true, false],
    ['schema-stale-quiescence', 'sending_not_fresh_off', true, false],
    ['schema-stopping-writer', 'writers_still_running', false, false],
    ['schema-stopped-page', 'writers_still_running', false, false],
    ['schema-off-initial', 'sending_not_fresh_off', false, false],
    ['schema-off-poststop', 'sending_not_fresh_off', false, false],
    ['schema-off-premigrate', 'sending_not_fresh_off', true, false],
    ['schema-setting-change', 'owner_setting_changed', true, false],
    ['schema-off-postrestart', 'sending_not_fresh_off', true, true],
    ['schema-writer', 'writers_still_running', false, false],
    ['schema-backup-inactive', 'backup_window_binding_changed', false, false],
  ])('contains %s without advancing past its guard', (mode, reason, applied, migrated) => {
    const result = execute(mode);
    expect(result.exitCode).toBe(1);
    expect(result.status).toMatchObject({ outcome: 'repair-required', reason });
    expect(result.commands.includes(' apply ')).toBe(applied);
    expect(result.commands.includes('deploy release')).toBe(migrated);
    if (mode === 'schema-stopping-writer') {
      expect(result.commands.split('\n').filter(line => line === 'aws ecs describe-tasks')).toHaveLength(14);
      expect(result.status.recoveryPoint).toBeUndefined();
    }
    if (mode === 'schema-stale-finalgate') expect(result.commands).toContain('final-gate advanced 181s');
    if (mode === 'schema-stale-quiescence') expect(result.commands).toContain('final-quiescence advanced 181s');
    if (mode === 'schema-off-postrestart') {
      expect(result.runtimeStopped).toEqual([true, true]);
      expect(result.status.containment).toMatchObject({ outcome: 'stopped', reason: 'zero_services_and_no_writers' });
    } else expect(result.status.containment).toBeUndefined();
    if (mode === 'schema-off-initial') expect(result.commands).not.toContain('record.sh put');
    expect(result.commands).not.toContain('smoke ');
  });
});

describe('reviewed post-restart runtime containment', () => {
  it.each([
    ['schema-postrestart-setting', 'owner_setting_changed'],
    ['schema-postrestart-finishing', 'sending_not_fresh_off'],
    ['schema-postrestart-gate', 'deploy_failed'],
    ['schema-release-unknown', 'deploy_failed'],
  ])('stops both exact services on %s without replay or normal gate authority', (mode, reason) => {
    const result = execute(mode);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.status).toMatchObject({ outcome: 'repair-required', reason, containment: { outcome: 'stopped', reason: 'zero_services_and_no_writers', stopRequests: [
      { service: 'fss-prod-worker', outcome: 'accepted' }, { service: 'fss-prod-api', outcome: 'accepted' },
    ] } });
    expect(result.runtimeStopped).toEqual([true, true]);
    expect(result.commands).toContain('contain verify services');
    expect(result.commands.split('\n').filter(line => line.startsWith('deploy release'))).toHaveLength(1);
    expect(result.commands).not.toContain('smoke ');
    expect(result.commands.slice(result.commands.indexOf('contain stop'))).not.toContain('deploy ci gate');
  });
  it.each([
    ['schema-postrestart-unknown', 'task_outcome_unknown', 'writers_still_running', [true, true]],
    ['schema-containment-unknown', 'sending_not_fresh_off', 'containment_observation_unknown', [true, false]],
    ['schema-containment-stuck', 'sending_not_fresh_off', 'services_not_stopped', [false, false]],
  ] satisfies readonly (readonly [string, string, string, boolean[]])[])('preserves original failure and explicit unproven containment for %s', (mode, reason, containmentReason, stopped) => {
    const result = execute(mode);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.status).toMatchObject({ outcome: 'repair-required', reason, containment: { outcome: 'unknown', reason: containmentReason } });
    expect(result.status.containment?.stopRequests.map(request => request.service)).toEqual(['fss-prod-worker', 'fss-prod-api']);
    expect(result.runtimeStopped).toEqual(stopped);
    expect(result.commands).not.toContain('smoke ');
    if (mode === 'schema-postrestart-unknown') {
      expect(result.status.currentTaskArn).toContain('/reader');
      expect(result.status.currentTaskOwner).toContain('-off-4');
      expect(result.status.temporaryReaderDefinition).toContain(':99');
    }
    if (mode === 'schema-containment-stuck') expect(result.commands.split('\n').filter(line => line === 'contain verify services')).toHaveLength(40);
  });
});

describe('reviewed smoke child runtime', () => {
  it.each(['smoke-pass', 'smoke-fail'])('runs %s with explicit TypeScript flags and keeps child output private', mode => {
    const result = execute(mode);
    const line = result.commands.split('\n').find(entry => entry.startsWith('smoke '));
    expect(line, result.stderr).toBeDefined();
    const child = JSON.parse(line!.slice('smoke '.length)) as { flags: string[]; args: string[]; passed: boolean };
    expect(child).toEqual({ flags: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'], args: ['--origin', 'https://controlled.invalid', '--canary-age-seconds', '1', '--expect-sending', 'disabled', '--json'], passed: true });
    expect(result.stdout + result.stderr).not.toMatch(/private-smoke-(?:stdout|stderr)/u);
    expect(result.exitCode).toBe(mode === 'smoke-pass' ? 0 : 1);
    expect(result.status).toMatchObject(mode === 'smoke-pass'
      ? { phase: 'verified', outcome: 'completed', writesStarted: true, schema: 88 }
      : { phase: 'smoke', outcome: 'repair-required', writesStarted: true, schema: 88, reason: 'reviewed_smoke_failed' });
  });
});
