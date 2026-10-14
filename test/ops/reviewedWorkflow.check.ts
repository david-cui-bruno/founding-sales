import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

const WORKFLOW = readRepositoryFile('.github/workflows/greenfield-deploy.yml');
const REPOSITORY = 'david-cui-bruno/founding-sales';
const IMAGE_COMMIT = 'b'.repeat(40);
const DISPATCH_COMMIT = 'd'.repeat(40);
const IMAGE_RUN = '101';
const PREPARED_RUN = '202';
const GATE_RUN = '303';

function job(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing workflow job ${name}`);
  const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-z-]+:\n/u);
  return next < 0 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next);
}

function verificationBody(): string {
  const reviewed = job('reviewed');
  const step = reviewed.split('      - name: Verify the prepared run, exact manifest and encrypted artifact before credentials\n')[1]?.split('\n      - name:')[0];
  const body = step?.split('        run: |\n')[1];
  if (!body) throw new Error('Missing reviewed verification step');
  return body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

interface RunMetadata {
  path: string;
  event: string;
  conclusion: string;
  status: string;
  head_sha: string;
  head_branch: string;
  repository: string;
}

interface FixtureOptions {
  readonly run?: Partial<RunMetadata>;
  readonly sourceCommit?: string;
  readonly imagesRun?: string;
  readonly gateRun?: string;
  readonly wrongFingerprint?: boolean;
  readonly expiredImages?: boolean;
  readonly artifactCommit?: string;
  readonly currentDispatch?: string;
  readonly currentRef?: string;
}

/** Run the actual workflow shell, real manifest validator and real image-download script.
 * Only the external GitHub CLI is controlled. AWS/Terraform are deny-all sentinels.
 * No credentials, cloud calls, plans, provider operations or production resources are used.
 */
function verify(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'reviewed-workflow-'));
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const manifest = {
      version: 'fss.reviewed-production-plan.v1', commit: options.sourceCommit ?? IMAGE_COMMIT,
      from: 'a'.repeat(40), fromSchema: 88, toSchema: 116,
      planSha256: '1'.repeat(64), recipientPublicKeySha256: '2'.repeat(64),
      imagesRunId: options.imagesRun ?? IMAGE_RUN, gateRunId: options.gateRun ?? GATE_RUN,
      digests: { api: `sha256:${'3'.repeat(64)}`, worker: `sha256:${'4'.repeat(64)}` },
      bindings: { apiTaskDefinition: 'api:115', workerTaskDefinition: 'worker:116' },
    };
    const bytes = JSON.stringify(manifest);
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(directory, 'manifest.json'), bytes);
    const imageBytes = JSON.stringify({ schema: 'fss.image-digests.v1', commit: IMAGE_COMMIT, workflowRunId: IMAGE_RUN, workflowRunAttempt: '1', images: {
      api: { repository: 'fss-rh-api', tag: `ci-${IMAGE_COMMIT}`, digest: manifest.digests.api, schemaRange: { minimum: 116, maximum: 116 } },
      worker: { repository: 'fss-rh-worker', tag: `ci-${IMAGE_COMMIT}`, digest: manifest.digests.worker, schemaRange: { minimum: 116, maximum: 116 } },
    } });
    const archive = join(directory, 'images.zip');
    execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr("image-digests.json",sys.argv[2])', archive, imageBytes]);
    const archiveDigest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
    const run: RunMetadata = {
      path: '.github/workflows/greenfield-deploy.yml', event: 'workflow_dispatch', conclusion: 'success',
      status: 'completed', head_sha: DISPATCH_COMMIT, head_branch: 'main', repository: REPOSITORY, ...options.run,
    };
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ run, artifact: {
      id: 404, name: 'fss-image-digests', expired: options.expiredImages ?? false,
      created_at: '2026-10-14T06:45:36Z', digest: archiveDigest,
      workflow_run: { id: Number(IMAGE_RUN), head_sha: options.artifactCommit ?? IMAGE_COMMIT, head_branch: 'main' },
    } }));
    const executable = (name: string, code: string) => {
      const path = join(bin, name); writeFileSync(path, `#!${process.execPath}\n${code}`); chmodSync(path, 0o755);
    };
    executable('gh', `const fs=require('fs'),path=require('path'),a=process.argv.slice(2),d=process.env.FIXTURE;
const s=JSON.parse(fs.readFileSync(path.join(d,'state.json'),'utf8'));
fs.appendFileSync(path.join(d,'calls.jsonl'),JSON.stringify(a)+'\\n');
if(a[0]==='api'&&a[1]===${JSON.stringify(`repos/${REPOSITORY}/actions/runs/${PREPARED_RUN}`)}) console.log(JSON.stringify(s.run));
else if(a[0]==='run'&&a[1]==='download'&&a[2]===${JSON.stringify(PREPARED_RUN)}) { const out=a[a.indexOf('--dir')+1]; fs.mkdirSync(out,{recursive:true}); fs.copyFileSync(path.join(d,'manifest.json'),path.join(out,'manifest.json')); fs.writeFileSync(path.join(out,'plan.encrypted.json'),'controlled encrypted packet'); }
else if(a[0]==='api'&&a[1]===${JSON.stringify(`repos/${REPOSITORY}/actions/runs/${IMAGE_RUN}/artifacts?name=fss-image-digests&per_page=100`)}) console.log(JSON.stringify({artifacts:[s.artifact]}));
else if(a[0]==='api'&&a[1]===${JSON.stringify(`repos/${REPOSITORY}/actions/artifacts/404/zip`)}) process.stdout.write(fs.readFileSync(path.join(d,'images.zip')));
else {console.error('Unexpected GitHub command');process.exit(1);}`);
    for (const name of ['aws', 'terraform']) executable(name, "require('fs').appendFileSync(require('path').join(process.env.FIXTURE,'forbidden'),process.argv.join(' ')+'\\n');process.exit(1);");
    const result = spawnSync('/bin/bash', ['-c', verificationBody()], {
      cwd: repositoryPath('.'), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, FIXTURE: directory,
        RUNNER_TEMP: directory, TMPDIR: directory, PLAN_RUN: PREPARED_RUN,
        MANIFEST_HASH: options.wrongFingerprint ? 'f'.repeat(64) : fingerprint,
        COMMIT: IMAGE_COMMIT, RUN_ID: IMAGE_RUN, GATE_RUN_ID: GATE_RUN,
        GITHUB_SHA: options.currentDispatch ?? DISPATCH_COMMIT,
        GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: options.currentRef ?? 'refs/heads/main',
        GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/greenfield-deploy.yml@refs/heads/main`,
      },
    });
    let calls = '';
    try { calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8'); } catch { /* Refusal before metadata access is valid. */ }
    let forbidden = '';
    try { forbidden = readFileSync(join(directory, 'forbidden'), 'utf8'); } catch { /* No credentials or cloud operations. */ }
    expect(forbidden).toBe('');
    if (result.status === 0) expect(readFileSync(join(directory, 'image-digests.json'), 'utf8')).toBe(imageBytes);
    return { status: result.status, stderr: result.stderr, calls, imageBytes };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('reviewed workflow preparation provenance', () => {
  it('accepts the same main dispatch definition with older exact source images after a docs-only main update', () => {
    const result = verify();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`actions/artifacts/404/zip`);
  });

  it('also accepts matching dispatch and image commits without changing the source binding', () => {
    const result = verify({ currentDispatch: IMAGE_COMMIT, run: { head_sha: IMAGE_COMMIT } });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['another dispatch definition', { run: { head_sha: 'e'.repeat(40) } }],
    ['an images SHA substituted for the preparation dispatch SHA', { run: { head_sha: IMAGE_COMMIT } }],
    ['a newer main dispatch after preparation', { currentDispatch: 'e'.repeat(40) }],
    ['an unavailable current dispatch SHA', { currentDispatch: '' }],
    ['a non-main current dispatch', { currentRef: 'refs/heads/feature' }],
    ['a feature-branch preparation', { run: { head_branch: 'feature' } }],
    ['another workflow', { run: { path: '.github/workflows/greenfield-release.yml' } }],
    ['a push instead of a dispatch', { run: { event: 'push' } }],
    ['a failed preparation', { run: { conclusion: 'failure' } }],
    ['an unfinished preparation', { run: { status: 'in_progress' } }],
    ['another repository', { run: { repository: 'other/repository' } }],
  ] satisfies readonly (readonly [string, FixtureOptions])[])('refuses %s before packet download or credentials', (_name, options) => {
    const result = verify(options);
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toContain('"download"');
  });

  it.each([
    ['changed manifest fingerprint', { wrongFingerprint: true }],
    ['changed image source in the manifest', { sourceCommit: 'e'.repeat(40) }],
    ['changed images run in the manifest', { imagesRun: '999' }],
    ['changed gate run in the manifest', { gateRun: '999' }],
    ['expired image artifact', { expiredImages: true }],
    ['foreign image artifact commit', { artifactCommit: 'e'.repeat(40) }],
  ] satisfies readonly (readonly [string, FixtureOptions])[])('retains exact source and artifact refusal for %s', (_name, options) => {
    const result = verify(options);
    expect(result.status).not.toBe(0);
  });

  it('requests at most the existing reviewed deployment role one-hour maximum without modifying IAM', () => {
    const reviewed = job('reviewed');
    const roleStep = reviewed.split('      - name: Assume the existing deployment role under its explicitly reviewed OIDC trust\n')[1]?.split('\n      - name:')[0];
    expect(roleStep).toContain('role-to-assume: ${{ secrets.FSS_PRODUCTION_REVIEWED_ROLE_ARN }}');
    const seconds = Number(/role-duration-seconds: (\d+)/u.exec(roleStep ?? '')?.[1]);
    expect(seconds).toBe(3600);
  });
});
