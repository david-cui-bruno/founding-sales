import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';
import { ghStub, registryStubs } from './support/cliStubs.ts';

/**
 * `infra/scripts/images.sh`, run: `pin` in a real git history against a stub `gh`, and
 * `promote` against a stub ECR and a stub `docker` sharing one state, so a copy `docker`
 * makes is what `aws` reads back.
 *
 * `pin` must choose the last images run whose inputs are the commit's (a script-only
 * commit pins the image commit before it), name that commit's green gate run, and refuse
 * when the inputs changed since or no gate run is green. `promote` must copy by digest and
 * read each tag back: a copy that changed the digest fails naming both, a copy that
 * wrapped a bare manifest in an index is answered by tagging the digest itself, a second
 * run copies nothing, and a rehearsal repository is never written.
 */

const IMAGES = repositoryPath('infra/scripts/images.sh');
const REPOSITORY = 'example-owner/example-repo';
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

function run(args: readonly string[], env: Readonly<Record<string, string>> = {}, cwd?: string, script = IMAGES): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(script, [...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe('images.sh inputs is the images workflow’s push paths', () => {
  it('lists exactly the paths whose change publishes new images', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-images.yml');
    const push = workflow.slice(workflow.indexOf('\n  push:\n'), workflow.indexOf('\npermissions:'));
    const globs = [...push.matchAll(/^ {6}- '([^']+)'$/gmu)].map(match => (match[1] ?? '').replace(/\/\*\*$/u, ''));
    expect(run(['inputs']).stdout.trim().split('\n')).toEqual(globs);
  });
});

// ---------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function commitFile(repository: string, path: string): string {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), `${path}\n`);
  git(repository, 'add', path);
  git(repository, 'commit', '-q', '-m', `change ${path}`);
  return git(repository, 'rev-parse', 'HEAD');
}

/** An image commit, a script-only commit on top, and an image change nobody published. */
const HISTORY = (() => {
  const repository = mkdtempSync(join(tmpdir(), 'fss-pin-history-'));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.email', 'pin@example.invalid');
  git(repository, 'config', 'user.name', 'pin');
  git(repository, 'config', 'commit.gpgsign', 'false');
  const image = commitFile(repository, 'apps/worker/src/main.ts');
  const scripts = commitFile(repository, 'infra/scripts/lib.sh');
  const later = commitFile(repository, 'certs/rds-global-bundle.pem');
  return { repository, image, scripts, later };
})();

function digestsFor(commit: string, runId = '55', api = digest('a'), worker = digest('b')): string {
  return JSON.stringify({
    schema: 'fss.image-digests.v1',
    commit,
    workflowRunId: runId,
    workflowRunAttempt: '1',
    images: {
      api: { repository: 'fss-rh-api', tag: `ci-${commit}`, digest: api },
      worker: { repository: 'fss-rh-worker', tag: `ci-${commit}`, digest: worker },
    },
  });
}

function pin(commit: string, gateRuns: readonly Record<string, unknown>[]): { readonly code: number; readonly stdout: string; readonly stderr: string; readonly out: string } {
  const gh = ghStub({
    routes: {
      [`GET repos/${REPOSITORY}/actions/workflows/greenfield-images.yml/runs`]: {
        workflow_runs: [
          { id: 55, head_sha: HISTORY.image, conclusion: 'success', event: 'push', head_branch: 'main', created_at: '2026-09-26T10:00:00Z' },
          { id: 56, head_sha: HISTORY.later, conclusion: 'failure', event: 'push', head_branch: 'main', created_at: '2026-09-26T12:00:00Z' },
        ],
      },
      [`GET repos/${REPOSITORY}/actions/workflows/greenfield.yml/runs`]: { workflow_runs: gateRuns },
    },
    downloads: { '55': digestsFor(HISTORY.image) },
  });
  const out = join(mkdtempSync(join(tmpdir(), 'fss-pin-out-')), 'image-pin.json');
  return { ...run(['pin', commit, out], { GITHUB_REPOSITORY: REPOSITORY, FSS_GH_COMMAND: gh.command }, HISTORY.repository), out };
}

const gate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 77,
  path: '.github/workflows/greenfield.yml',
  head_sha: HISTORY.image,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-09-26T10:01:00Z',
  ...overrides,
});

describe('images.sh pin names the last image commit of a commit, and its green gate run', () => {
  it('pins a script-only commit to the image commit before it, with that commit’s gate run', () => {
    const result = pin(HISTORY.scripts, [gate({ id: 70, conclusion: 'failure' }), gate()]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `api_digest=${digest('a')}\nworker_digest=${digest('b')}\nimages_run_id=55\nimages_commit=${HISTORY.image}\ngate_run_id=77\n`,
    );
    expect(JSON.parse(readFileSync(result.out, 'utf8'))).toMatchObject({
      schema: 'fss.image-pin.v1',
      commit: HISTORY.scripts,
      imagesCommit: HISTORY.image,
      imagesRunId: '55',
      gateRunId: '77',
      images: { api: { tag: `ci-${HISTORY.image}`, digest: digest('a') } },
    });
  });

  it('refuses a commit whose image inputs changed since the last published images', () => {
    const result = pin(HISTORY.later, [gate()]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('whose inputs are those of');
  });

  it('refuses when the image commit has no green gate run of a push to main', () => {
    for (const runs of [[], [gate({ conclusion: 'failure' })], [gate({ event: 'pull_request' })], [gate({ path: '.github/workflows/other.yml' })]]) {
      const result = pin(HISTORY.scripts, runs);
      expect(result.code, JSON.stringify(runs)).not.toBe(0);
      expect(result.stderr).toContain('no green Greenfield gate run');
    }
  });
});

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

const COMMIT = 'ab'.repeat(20);
const TAG = `ci-${COMMIT}`;

function registry(extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    repositories: {
      'fss-rh-api': { digests: [digest('a')], tags: {} },
      'fss-rh-worker': { digests: [digest('b')], tags: {} },
      'fss-prod-api': { digests: [], tags: {} },
      'fss-prod-worker': { digests: [], tags: {} },
    },
    ...extra,
  };
}

function inputFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'fss-promote-input-')), 'input.json');
  writeFileSync(path, content);
  return path;
}

function promote(input: string, state: Readonly<Record<string, unknown>>, args: readonly string[] = [], script = IMAGES) {
  const { aws, docker } = registryStubs(state);
  const prefix = script === IMAGES ? ['promote'] : [];
  const result = run([...prefix, input, ...args], { FSS_REHEARSAL_AWS_COMMAND: aws.command, FSS_DOCKER_COMMAND: docker.command }, undefined, script);
  return { ...result, aws, docker };
}

const tagsOf = (docker: { state(): Record<string, unknown> }, name: string): Record<string, string> =>
  ((docker.state()['repositories'] as Record<string, { tags: Record<string, string> }>)[name]?.tags ?? {});
const puts = (calls: readonly { readonly args: readonly string[] }[]) => calls.filter(call => call.args[1] === 'put-image');
const builds = (calls: readonly { readonly args: readonly string[] }[]) => calls.filter(call => call.args[0] === 'buildx');

describe('images.sh promote copies the CI digests into production by digest, never rebuilding', () => {
  it('copies both, reads each back, logs in through stdin, and never writes a rehearsal repository', () => {
    const result = promote(inputFile(digestsFor(COMMIT)), registry());
    expect(result.code, result.stderr).toBe(0);
    expect(tagsOf(result.docker, 'fss-prod-api')[TAG]).toBe(digest('a'));
    expect(tagsOf(result.docker, 'fss-prod-worker')[TAG]).toBe(digest('b'));
    expect(builds(result.docker.calls()).map(call => call.args.join(' '))).toEqual([
      `buildx imagetools create --tag 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api:${TAG} --prefer-index=false 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@${digest('a')}`,
      `buildx imagetools create --tag 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker:${TAG} --prefer-index=false 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${digest('b')}`,
    ]);
    expect(result.docker.calls().find(call => call.args[0] === 'login')?.stdin).toContain('not-a-real-password');
    expect(puts(result.aws.calls())).toEqual([]);
    expect(result.stdout).toContain(`api fss-prod-api ${digest('a')} copied`);
  });

  it('is what release-promote.sh runs, and takes --app-only', () => {
    const result = promote(inputFile(digestsFor(COMMIT)), registry(), ['--app-only'], repositoryPath('infra/scripts/release-promote.sh'));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`worker fss-prod-worker ${digest('b')} copied`);
  });

  it('promotes a pin under the image commit’s tag', () => {
    const images = 'cd'.repeat(20);
    const pinned = JSON.stringify({
      schema: 'fss.image-pin.v1',
      commit: COMMIT,
      imagesCommit: images,
      imagesRunId: '55',
      gateRunId: '77',
      images: {
        api: { repository: 'fss-rh-api', tag: `ci-${images}`, digest: digest('a') },
        worker: { repository: 'fss-rh-worker', tag: `ci-${images}`, digest: digest('b') },
      },
    });
    const result = promote(inputFile(pinned), registry());
    expect(result.code, result.stderr).toBe(0);
    expect(tagsOf(result.docker, 'fss-prod-api')[`ci-${images}`]).toBe(digest('a'));
  });

  it('copies a bare manifest as itself, so the tag names the digest', () => {
    const result = promote(inputFile(digestsFor(COMMIT)), registry({ realisticBuildx: true }));
    expect(result.code, result.stderr).toBe(0);
    expect(tagsOf(result.docker, 'fss-prod-api')).toEqual({ [TAG]: digest('a') });
    expect(puts(result.aws.calls())).toEqual([]);
  });

  it('fails, naming both, when the copy changed the digest and the image itself is not in production', () => {
    const result = promote(inputFile(digestsFor(COMMIT)), registry({ copyChangesDigest: true }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the digest changed in the copy');
    expect(result.stderr).toContain(`${digest('a')} itself is not in fss-prod-api`);
    expect(puts(result.aws.calls())).toEqual([]);
  });

  it('tags the image itself, from its own manifest bytes, when the copy wrapped it in an index', () => {
    const manifest = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{},"layers":[]}';
    const state = registry({ wraps: true });
    const repositories = state['repositories'] as Record<string, Record<string, unknown>>;
    for (const name of ['fss-prod-api', 'fss-prod-worker']) repositories[name] = { ...repositories[name], manifests: { [digest('a')]: manifest, [digest('b')]: manifest } };
    const result = promote(inputFile(digestsFor(COMMIT)), state);
    expect(result.code, result.stderr).toBe(0);
    expect(tagsOf(result.docker, 'fss-prod-api')).toEqual({ [TAG]: digest('e'), [`${TAG}-image`]: digest('a') });
    expect(result.stdout).toContain(`api fss-prod-api ${digest('a')} copied-and-tagged ${TAG}-image`);
    const put = puts(result.aws.calls());
    expect(put.map(call => call.args[call.args.indexOf('--image-digest') + 1])).toEqual([digest('a'), digest('b')]);
    for (const call of put) expect((call as { readonly files?: Readonly<Record<string, string>> }).files?.['--image-manifest']).toBe(manifest);
  });

  it('copies nothing when production already holds the digests: tagged, or untagged from an earlier wrapping copy', () => {
    const state = registry({
      repositories: {
        'fss-rh-api': { digests: [digest('a')], tags: {} },
        'fss-rh-worker': { digests: [digest('b')], tags: {} },
        'fss-prod-api': { digests: [digest('a'), digest('e')], tags: { [TAG]: digest('e') } },
        'fss-prod-worker': { digests: [digest('b')], tags: { [TAG]: digest('b') } },
      },
    });
    const result = promote(inputFile(digestsFor(COMMIT)), state);
    expect(result.code, result.stderr).toBe(0);
    expect(builds(result.docker.calls())).toHaveLength(0);
    expect(result.stdout).toContain(`api fss-prod-api ${digest('a')} tagged-in-place ${TAG}-image`);
    expect(result.stdout).toContain(`worker fss-prod-worker ${digest('b')} already-present`);
  });

  it('refuses a digest the rehearsal repository lacks, a tag naming another image, and no free tag', () => {
    const missing = promote(inputFile(digestsFor(COMMIT, '55', digest('c'))), registry());
    expect(missing.stderr).toContain('fss-rh-api has no image');
    const taken = promote(
      inputFile(digestsFor(COMMIT)),
      registry({
        repositories: {
          'fss-rh-api': { digests: [digest('a')], tags: {} },
          'fss-rh-worker': { digests: [digest('b')], tags: {} },
          'fss-prod-api': { digests: [digest('e')], tags: { [TAG]: digest('e') } },
          'fss-prod-worker': { digests: [], tags: {} },
        },
      }),
    );
    expect(taken.stderr).toContain('tags are immutable');
    const full = promote(
      inputFile(digestsFor(COMMIT)),
      registry({
        repositories: {
          'fss-rh-api': { digests: [digest('a')], tags: {} },
          'fss-rh-worker': { digests: [digest('b')], tags: {} },
          'fss-prod-api': { digests: [digest('a'), digest('e'), digest('c')], tags: { [TAG]: digest('e'), [`${TAG}-image`]: digest('c') } },
          'fss-prod-worker': { digests: [], tags: {} },
        },
      }),
    );
    expect(full.stderr).toContain('has no free tag');
    for (const result of [missing, taken, full]) {
      expect(result.code).not.toBe(0);
      expect(puts(result.aws.calls())).toEqual([]);
    }
  });

  it('refuses an input that is neither file, a mutable tag, and one image under both names, before any call', () => {
    for (const content of [
      JSON.stringify({ schema: 'fss.release-record.v1' }),
      digestsFor(COMMIT).replace(digest('a'), 'fss-rh-api:latest'),
      digestsFor(COMMIT).replace(digest('b'), digest('a')),
    ]) {
      const result = promote(inputFile(content), registry());
      expect(result.code).not.toBe(0);
      expect(result.aws.calls()).toHaveLength(0);
    }
  });
});
