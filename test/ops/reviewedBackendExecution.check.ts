import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const COMMIT = 'b'.repeat(40);
const API = `sha256:${'1'.repeat(64)}`;
const WORKER = `sha256:${'2'.repeat(64)}`;
// Real reviewed execute, manifest validator and encrypted transport. Cloud, public
// health, Terraform and gate commands are controlled processes, never live tools.
function execute(mode: string) {
  const smoke = mode.startsWith('smoke-');
  const directory = mkdtempSync(join(tmpdir(), 'reviewed-backend-execute-'));
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const scripts = join(directory, 'infra/scripts'); mkdirSync(scripts, { recursive: true });
    mkdirSync(join(directory, 'infra/roots/production'), { recursive: true });
    mkdirSync(join(directory, 'infra/policies'), { recursive: true });
    for (const name of ['backend.hcl', 'providers.tf', 'versions.tf', 'main.tf']) copyFileSync(repositoryPath(`infra/roots/production/${name}`), join(directory, 'infra/roots/production', name));
    copyFileSync(repositoryPath('infra/policies/production-backend-plan.json'), join(directory, 'infra/policies/production-backend-plan.json'));
    copyFileSync(repositoryPath('infra/scripts/diagnostic-plan.mjs'), join(scripts, 'diagnostic-plan.mjs'));
    // diagnostic-plan imports its static source-schema validators before seal/decrypt.
    for (const name of ['diagnostic-schema.mjs']) copyFileSync(repositoryPath(`infra/scripts/${name}`), join(scripts, name));
    mkdirSync(join(directory, 'packages/domain/db'), { recursive: true });
    copyFileSync(repositoryPath('packages/domain/db/schemaRange.ts'), join(directory, 'packages/domain/db/schemaRange.ts'));
    const log = join(directory, 'commands'); writeFileSync(log, '');
    const executable = (path: string, source: string) => { writeFileSync(path, `#!${process.execPath}\n${source}`); chmodSync(path, 0o755); return path; };
    executable(join(bin, 'aws'), `const fs=require('fs'),a=process.argv.slice(2).join(' '); fs.appendFileSync(process.env.LOG,'aws '+a+'\\n'); if(a.startsWith('sts ')) console.log(JSON.stringify({Account:'326255650484',Arn:'arn:aws:sts::326255650484:assumed-role/'+(process.env.MODE==='identity'?'fss-prod-ci-deploy':'fss-prod-deploy')+'/controlled'})); else if(a.startsWith('ecs describe-task-definition ')) console.log(JSON.stringify({taskDefinition:{containerDefinitions:[{environment:[{name:'FSS_SENDING_ENABLED',value:'false'}]}]}})); else if(a.startsWith('ecs ')) console.log(JSON.stringify({services:['api','worker'].map(n=>({serviceName:'fss-prod-'+n,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:n+':1'}))})); else if(a.startsWith('rds ')) console.log(JSON.stringify({DBInstances:[{DBInstanceIdentifier:'fss-prod-pg',DBInstanceStatus:'available',BackupRetentionPeriod:35,LatestRestorableTime:'2026-10-17T00:00:00Z'}]})); else process.exit(99);`);
    executable(join(bin, 'curl'), `const fs=require('fs'),file=process.env.LOG+'.health',n=fs.existsSync(file)?1:0;fs.writeFileSync(file,'read');console.log(JSON.stringify({status:'serving',build:{commit:(n?'b':'a').repeat(40)},schema:{accepted:true,databaseVersion:88}}));`);
    const terraform = executable(join(bin, 'terraform'), `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,'terraform '+a.join(' ')+'\\n'); if(a.includes('init')) {if(['lock-denied','read-denied'].includes(process.env.MODE))process.exit(1);} else if(a.includes('state'))console.log(JSON.stringify({lineage:process.env.MODE==='lineage'?'foreign':'lineage',serial:process.env.MODE==='serial'?8:7}));else if(a.includes('show'))console.log(JSON.stringify({variables:{assume_deployment_role:{value:process.env.MODE==='provider'},api_image:{value:'326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@${API}'},worker_image:{value:'326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@${WORKER}'}}}));else if(process.env.MODE.startsWith('smoke-')&&a.includes('output'))console.log(JSON.stringify({api:{declared_desired_count:1},worker:{declared_desired_count:1}}));else if(!(process.env.MODE.startsWith('smoke-')&&a.includes('apply')))process.exit(99);`);
    executable(join(scripts, 'deploy.sh'), `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,'deploy '+a.join(' ')+'\\n');if(a[0]==='ci'&&a[1]==='gate')process.exit(0);if(!process.env.MODE.startsWith('smoke-'))process.exit(99);if(a[0]==='ci'&&a[1]==='canary')console.log('canary_age=1');else if(a[0]!=='release')process.exit(99);`);
    if (smoke) {
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
    const manifest = { version: 'fss.reviewed-production-plan.v1', commit: COMMIT, from: 'a'.repeat(40), fromSchema: 88, toSchema: 88, imagesRunId: '1', gateRunId: '2', planSha256: hash(readFileSync(saved)), recipientPublicKeySha256: fingerprint, digests: { api: API, worker: WORKER }, bindings: { apiTaskDefinition: 'api:1', workerTaskDefinition: 'worker:1' }, stateLineage: 'lineage', stateSerial: 7 };
    const manifestPath = join(directory, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(directory, 'images.json'), JSON.stringify({ schema: 'fss.image-digests.v1', commit: COMMIT, workflowRunId: '1', workflowRunAttempt: '1', images: {
      api: { repository: 'fss-rh-api', tag: `ci-${COMMIT}`, digest: API, schemaRange: { minimum: 88, maximum: 88 } },
      worker: { repository: 'fss-rh-worker', tag: `ci-${COMMIT}`, digest: WORKER, schemaRange: { minimum: 88, maximum: 88 } },
    } }));
    const envelope = join(directory, 'envelope.json');
    const sealed = spawnSync(process.execPath, [repositoryPath('infra/scripts/diagnostic-plan.mjs'), 'seal', saved, manifestPath, publicPath, fingerprint, envelope], { encoding: 'utf8' });
    expect(sealed.status, sealed.stderr).toBe(0);
    if (mode === 'plan') {
      const packet = JSON.parse(readFileSync(envelope, 'utf8')) as { ciphertext: string }; packet.ciphertext = Buffer.from('changed ciphertext').toString('base64');
      writeFileSync(envelope, JSON.stringify(packet, null, 2) + '\n');
    }
    const output = join(directory, 'out');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, TERRAFORM: terraform, LOG: log, MODE: mode, COMMIT: mode === 'source' ? 'c'.repeat(40) : COMMIT, RUN_ID: '1', RUN_ATTEMPT: '1', GATE_RUN_ID: '2', AWS_REGION: 'us-east-1', FSS_RELEASE_HOLD: 'false', FSS_PRODUCTION_ORIGIN: 'https://controlled.invalid', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'david-cui-bruno/founding-sales/.github/workflows/greenfield-deploy.yml@refs/heads/main' };
    delete env['FSS_REHEARSAL_AWS_COMMAND'];
    delete env['NODE_OPTIONS'];
    const result = spawnSync(process.execPath, [repositoryPath('infra/scripts/reviewed-release.mjs'), 'execute', manifestPath, hash(readFileSync(manifestPath)), envelope, privatePath, join(directory, 'images.json'), output], { cwd: directory, env, encoding: 'utf8' });
    const commands = readFileSync(log, 'utf8');
    if (!smoke) expect(commands).not.toMatch(/(?:^|\s)(?:apply|put|promote)(?:\s|$)/mu);
    const status = JSON.parse(readFileSync(join(output, 'status.json'), 'utf8')) as { writesStarted: boolean; outcome: string; reason: string };
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, commands, status };
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
