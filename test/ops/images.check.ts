import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
 * run copies nothing, and a rehearsal repository is never written. With `--gate-run-id`
 * (the CI deploy's, review of PR 278) it reads the gate again, through `deploy.sh ci
 * gate` and a stub `gh` whose answer changes between reads, immediately before every
 * production write: a gate that changed after the API's copy stops the worker's, and one
 * that changed after a copy stops the in-place tag that would follow it.
 *
 * `pushed` and `attested` are the publish job's proof that an existing `ci-<commit>` tag
 * is its own run's: `attested` must find an EARLIER attempt's `fss-image-pushed-<attempt>`
 * artifact, bytes held to GitHub's digest, naming that digest, and refuse a first attempt,
 * an artifact of the same attempt or another run, another digest, and altered bytes.
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

describe('images.sh record writes the digests and the schema range each image declares (P6)', () => {
  const commit = 'a'.repeat(40);
  const recorded = (...extra: string[]): { readonly code: number; readonly stderr: string; readonly document: Record<string, unknown> | null } => {
    const out = join(mkdtempSync(join(tmpdir(), 'fss-record-digests-')), 'image-digests.json');
    const result = run(['record', commit, '4242', '1', digest('b'), digest('c'), out, ...extra]);
    let document: Record<string, unknown> | null = null;
    try {
      document = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    } catch {
      document = null;
    }
    return { code: result.code, stderr: result.stderr, document };
  };

  it('carries both ranges, which the CI deploy reads instead of running code from the images commit', () => {
    const written = recorded('--api-range', '20-20', '--worker-range', '19-20');
    expect(written.code, written.stderr).toBe(0);
    expect(written.document?.['images']).toEqual({
      api: { repository: 'fss-rh-api', tag: `ci-${commit}`, digest: digest('b'), schemaRange: { minimum: 20, maximum: 20 } },
      worker: { repository: 'fss-rh-worker', tag: `ci-${commit}`, digest: digest('c'), schemaRange: { minimum: 19, maximum: 20 } },
    });
  });

  it('refuses to write a digests file without both ranges', () => {
    for (const extra of [[], ['--api-range', '20-20'], ['--api-range', '20', '--worker-range', '20-20']]) {
      const refused = recorded(...extra);
      expect(refused.code, extra.join(' ')).toBe(1);
      expect(refused.stderr).toContain('record needs --api-range and --worker-range');
      expect(refused.document).toBeNull();
    }
  });

  it('is what the images workflow records, with the ranges it just verified the images against', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-images.yml');
    expect(workflow).toContain('--api-range "$API_SCHEMA_MIN-$API_SCHEMA_MAX" --worker-range "$WORKER_SCHEMA_MIN-$WORKER_SCHEMA_MAX"');
    // The names PR 5 deleted; a workflow naming one would fail at the first step.
    for (const gone of ['release-images.sh', 'release-promote.sh']) expect(workflow, gone).not.toContain(gone);
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

function promote(input: string, state: Readonly<Record<string, unknown>>, args: readonly string[] = []) {
  const { aws, docker } = registryStubs(state);
  const result = run(['promote', input, ...args], { FSS_REHEARSAL_AWS_COMMAND: aws.command, FSS_DOCKER_COMMAND: docker.command });
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

  it('takes --app-only, and copies the worker under it', () => {
    const result = promote(inputFile(digestsFor(COMMIT)), registry(), ['--app-only']);
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

// ---------------------------------------------------------------------------
// promote --gate-run-id: the gate read again before every production write
// ---------------------------------------------------------------------------

const GATE_RUN = '4100';

/** `gh` for `deploy.sh ci gate`: the gate's runs of the push, the n-th read changed by `script`, and main. */
const GATE_GH = String.raw`#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "gate-state.json")))
args = sys.argv[1:]
with open(os.path.join(here, "gate-calls.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\n")
if args[:1] == ["api"] and "/actions/workflows/greenfield.yml/runs?head_sha=" in args[1]:
    counter = os.path.join(here, "gate-reads")
    reads = int(open(counter).read()) if os.path.exists(counter) else 0
    open(counter, "w").write(str(reads + 1))
    script = state["script"] or [{}]
    print(json.dumps({"workflow_runs": [dict(state["run"], **script[min(reads, len(script) - 1)])]}))
    sys.exit(0)
if args[:1] == ["api"] and "/compare/main..." in args[1]:
    print(json.dumps({"status": "behind"}))
    sys.exit(0)
sys.stderr.write("the gate stub does not know: " + " ".join(args) + "\n")
sys.exit(2)
`;

function promoteHeld(input: string, state: Readonly<Record<string, unknown>>, script: readonly Record<string, unknown>[] = [], gateRunId = GATE_RUN) {
  const { aws, docker } = registryStubs(state);
  const home = mkdtempSync(join(tmpdir(), 'fss-promote-gate-'));
  writeFileSync(
    join(home, 'gate-state.json'),
    JSON.stringify({
      script,
      run: {
        id: Number(GATE_RUN),
        path: '.github/workflows/greenfield.yml',
        event: 'push',
        head_branch: 'main',
        head_sha: COMMIT,
        head_repository: { full_name: REPOSITORY },
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        created_at: '2026-09-26T10:01:00Z',
      },
    }),
  );
  writeFileSync(join(home, 'gh'), GATE_GH);
  chmodSync(join(home, 'gh'), 0o755);
  const result = run(['promote', input, '--gate-run-id', gateRunId], {
    FSS_REHEARSAL_AWS_COMMAND: aws.command,
    FSS_DOCKER_COMMAND: docker.command,
    FSS_GH_COMMAND: join(home, 'gh'),
    GITHUB_REPOSITORY: REPOSITORY,
  });
  const gateReads = existsSync(join(home, 'gate-calls.jsonl'))
    ? readFileSync(join(home, 'gate-calls.jsonl'), 'utf8').split('\n').filter(line => line.includes('greenfield.yml/runs?')).length
    : 0;
  return { ...result, aws, docker, gateReads };
}

describe('images.sh promote --gate-run-id reads the gate again immediately before each production write (review of PR 278)', () => {
  it('reads it before each image’s copy, and copies both while it holds', () => {
    const result = promoteHeld(inputFile(digestsFor(COMMIT)), registry());
    expect(result.code, result.stderr).toBe(0);
    expect(result.gateReads).toBe(2);
    for (const service of ['api', 'worker']) {
      expect(result.stderr).toContain(`before the copy of the ${service} image to fss-prod-${service}: Greenfield gate run ${GATE_RUN} is still the newest`);
    }
    expect(tagsOf(result.docker, 'fss-prod-api')[TAG]).toBe(digest('a'));
    expect(tagsOf(result.docker, 'fss-prod-worker')[TAG]).toBe(digest('b'));
  });

  it('stops before the worker’s copy when the gate changed after the API’s', () => {
    const result = promoteHeld(inputFile(digestsFor(COMMIT)), registry(), [{}, { id: 4200, created_at: '2026-09-26T11:00:00Z' }]);
    expect(result.code).toBe(1);
    expect(builds(result.docker.calls())).toHaveLength(1);
    expect(tagsOf(result.docker, 'fss-prod-api')[TAG]).toBe(digest('a'));
    expect(tagsOf(result.docker, 'fss-prod-worker')).toEqual({});
    expect(result.stderr).toContain(`the newest Greenfield gate run of the push is now 4200, not run ${GATE_RUN}`);
    expect(result.stderr).toContain('(the gate was read again before the copy of the worker image to fss-prod-worker)');
    // A gate already red before the first write copies nothing.
    const red = promoteHeld(inputFile(digestsFor(COMMIT)), registry(), [{ conclusion: 'failure' }]);
    expect(red.code).toBe(1);
    expect(builds(red.docker.calls())).toHaveLength(0);
    expect(red.stderr).toContain('(the gate was read again before the copy of the api image to fss-prod-api)');
  });

  it('stops before an in-place tag when the gate changed after the copy it follows', () => {
    const manifest = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{},"layers":[]}';
    const state = registry({ wraps: true });
    const repositories = state['repositories'] as Record<string, Record<string, unknown>>;
    for (const name of ['fss-prod-api', 'fss-prod-worker']) repositories[name] = { ...repositories[name], manifests: { [digest('a')]: manifest, [digest('b')]: manifest } };
    const result = promoteHeld(inputFile(digestsFor(COMMIT)), state, [{}, { conclusion: 'failure' }]);
    expect(result.code).toBe(1);
    expect(builds(result.docker.calls())).toHaveLength(1);
    expect(puts(result.aws.calls())).toEqual([]);
    expect(result.stderr).toContain(`(the gate was read again before tagging fss-prod-api@${digest('a')} as ${TAG}-image)`);
  });

  it('holds only an images run’s digests to a gate, and refuses a malformed run id, before any call', () => {
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
    const pin = promoteHeld(inputFile(pinned), registry());
    expect(pin.code).toBe(1);
    expect(pin.stderr).toContain('a pin is the hand path’s, which holds none'.replace('’', "'"));
    const malformed = promoteHeld(inputFile(digestsFor(COMMIT)), registry(), [], 'x');
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain("--gate-run-id 'x' is not a workflow run id");
    for (const result of [pin, malformed]) {
      expect(result.aws.calls()).toHaveLength(0);
      expect(result.gateReads).toBe(0);
    }
  });

  it('is how the deploy workflow promotes: one call, held to the gate run the gates job chose', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-deploy.yml');
    expect(workflow).toContain('infra/scripts/images.sh promote "$RUNNER_TEMP/image-digests.json" --gate-run-id "$GATE_RUN_ID"');
    expect(workflow).not.toContain('deploy.sh ci gate --commit');
  });
});

// ---------------------------------------------------------------------------
// pushed and attested: a re-run reuses a tag only as its own run's
// ---------------------------------------------------------------------------

const PUSH_RUN = '5151';

/**
 * `gh` for `attested`: the run's artifacts, each zipped (fixed timestamps) from a directory
 * `pushed` wrote, listed with the digest of those bytes unless `digest` overrides it; and
 * each zip by id.
 */
const ARTIFACTS_GH = String.raw`#!/usr/bin/env python3
import hashlib, json, os, re, sys, zipfile
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "artifacts-state.json")))
args = sys.argv[1:]
with open(os.path.join(here, "artifacts-calls.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\n")
def zipped(item):
    target = os.path.join(here, "artifact-{}.zip".format(item["id"]))
    with zipfile.ZipFile(target, "w") as archive:
        for name in sorted(os.listdir(item["directory"])):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            archive.writestr(info, open(os.path.join(item["directory"], name), "rb").read())
    return target
if args[:1] == ["api"] and re.fullmatch(r"repos/[^/]+/[^/]+/actions/runs/[0-9]+/artifacts\?per_page=100", args[1]):
    listed = []
    for item in state["artifacts"]:
        data = open(zipped(item), "rb").read()
        listed.append({"id": item["id"], "name": item["name"], "expired": item.get("expired", False),
                       "digest": item.get("digest") or "sha256:" + hashlib.sha256(data).hexdigest(),
                       "workflow_run": {"id": int(item.get("runId", state["runId"])), "head_sha": item.get("headSha", state["commit"])}})
    print(json.dumps({"total_count": len(listed), "artifacts": listed}))
    sys.exit(0)
one = re.fullmatch(r"repos/[^/]+/[^/]+/actions/artifacts/([0-9]+)/zip", args[1]) if args[:1] == ["api"] else None
if one:
    item = next(item for item in state["artifacts"] if str(item["id"]) == one.group(1))
    sys.stdout.buffer.write(open(os.path.join(here, "artifact-{}.zip".format(item["id"])), "rb").read())
    sys.exit(0)
sys.stderr.write("the artifacts stub does not know: " + " ".join(args) + "\n")
sys.exit(2)
`;

const runFacts = (attempt: string): Record<string, string> => ({
  GITHUB_SHA: COMMIT,
  GITHUB_RUN_ID: PUSH_RUN,
  GITHUB_RUN_ATTEMPT: attempt,
  GITHUB_REPOSITORY: REPOSITORY,
});

/** The directory an attempt's `pushed` calls wrote, as its fss-image-pushed-<attempt> artifact holds it. */
function pushedBy(attempt: string, images: Readonly<Partial<Record<'api' | 'worker', string>>>): string {
  const directory = mkdtempSync(join(tmpdir(), `fss-pushed-${attempt}-`));
  for (const [service, value] of Object.entries(images)) {
    const result = run(['pushed', service, value, directory], runFacts(attempt));
    if (result.code !== 0) throw new Error(result.stderr);
  }
  return directory;
}

interface Artifact {
  readonly id: number;
  readonly name: string;
  readonly directory: string;
  readonly runId?: string;
  readonly digest?: string;
  readonly expired?: boolean;
}

function attested(attempt: string, service: 'api' | 'worker', value: string, artifacts: readonly Artifact[]) {
  const home = mkdtempSync(join(tmpdir(), 'fss-attested-gh-'));
  writeFileSync(join(home, 'artifacts-state.json'), JSON.stringify({ runId: PUSH_RUN, commit: COMMIT, artifacts }));
  writeFileSync(join(home, 'gh'), ARTIFACTS_GH);
  chmodSync(join(home, 'gh'), 0o755);
  const result = run(['attested', service, value], { ...runFacts(attempt), FSS_GH_COMMAND: join(home, 'gh') });
  const calls = existsSync(join(home, 'artifacts-calls.jsonl'))
    ? readFileSync(join(home, 'artifacts-calls.jsonl'), 'utf8').split('\n').filter(line => line !== '')
    : [];
  return { ...result, calls };
}

describe('images.sh pushed and attested: a re-run reuses a tag only as its own run’s (review of PR 278)', () => {
  it('writes what an attempt pushed, and nothing it did not', () => {
    const directory = pushedBy('1', { api: digest('a') });
    expect(JSON.parse(readFileSync(join(directory, 'api.json'), 'utf8'))).toEqual({
      schema: 'fss.image-pushed.v1',
      commit: COMMIT,
      workflowRunId: PUSH_RUN,
      workflowRunAttempt: '1',
      service: 'api',
      repository: 'fss-rh-api',
      tag: `ci-${COMMIT}`,
      digest: digest('a'),
    });
    expect(existsSync(join(directory, 'worker.json'))).toBe(false);
  });

  it('attests a digest an earlier attempt of this run pushed, from any earlier attempt', () => {
    const first = pushedBy('1', { api: digest('a') });
    const second = pushedBy('2', { worker: digest('b') });
    const found = attested('2', 'api', digest('a'), [{ id: 901, name: 'fss-image-pushed-1', directory: first }]);
    expect(found.code, found.stderr).toBe(0);
    expect(found.stdout).toContain(`fss-rh-api:ci-${COMMIT} = ${digest('a')}, which attempt 1 of run ${PUSH_RUN} pushed`);
    const third = attested('3', 'api', digest('a'), [
      { id: 902, name: 'fss-image-pushed-2', directory: second },
      { id: 901, name: 'fss-image-pushed-1', directory: first },
    ]);
    expect(third.code, third.stderr).toBe(0);
  });

  it('refuses a first attempt before asking anything, and every tag no earlier attempt of this run attests', () => {
    const first = attested('1', 'api', digest('a'), []);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain('this is the first attempt of run 5151: another writer pushed it');
    expect(first.calls).toEqual([]);
    const mine = pushedBy('1', { api: digest('a') });
    const same = pushedBy('2', { api: digest('a') });
    for (const [label, service, value, artifacts] of [
      ['no artifact at all', 'api', digest('a'), []],
      ['another digest', 'api', digest('c'), [{ id: 901, name: 'fss-image-pushed-1', directory: mine }]],
      ['the other image', 'worker', digest('a'), [{ id: 901, name: 'fss-image-pushed-1', directory: mine }]],
      ['this same attempt’s artifact', 'api', digest('a'), [{ id: 903, name: 'fss-image-pushed-2', directory: same }]],
      ['another run’s artifact', 'api', digest('a'), [{ id: 904, name: 'fss-image-pushed-1', directory: mine, runId: '6161' }]],
      ['bytes that are not the listed digest', 'api', digest('a'), [{ id: 905, name: 'fss-image-pushed-1', directory: mine, digest: digest('f') }]],
      ['an expired artifact', 'api', digest('a'), [{ id: 906, name: 'fss-image-pushed-1', directory: mine, expired: true }]],
      ['an artifact of another name', 'api', digest('a'), [{ id: 907, name: 'fss-image-digests', directory: mine }]],
    ] as const) {
      const result = attested('2', service, value, artifacts);
      expect(result.code, label).toBe(1);
      expect(result.stderr, label).toContain(`no earlier attempt of run ${PUSH_RUN} attests pushing it`);
    }
  });

  it('is the only way the publish job reuses a tag, and each attempt uploads what it pushed whatever its end', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-images.yml');
    const publish = workflow.slice(workflow.indexOf('\n  publish:\n'));
    expect(publish).toMatch(/permissions:\n {6}contents: read\n {6}actions: read/u);
    expect(publish).toContain('infra/scripts/images.sh attested "$service" "$existing"');
    expect(publish).toContain('infra/scripts/images.sh pushed "$service" "$digest" "$RUNNER_TEMP/fss-image-pushed"');
    expect(publish).not.toContain('GITHUB_RUN_ATTEMPT:-1');
    const keep = publish.slice(publish.indexOf('      - name: Keep what this attempt pushed'));
    const step = keep.slice(0, keep.indexOf('\n\n'));
    expect(step).toContain('if: always()');
    expect(step).toContain('name: fss-image-pushed-${{ github.run_attempt }}');
    expect(step).toContain('path: ${{ runner.temp }}/fss-image-pushed/');
    expect(publish.indexOf('Push each image once')).toBeLessThan(publish.indexOf('Keep what this attempt pushed'));
    expect(publish.indexOf('Keep what this attempt pushed')).toBeLessThan(publish.indexOf('Verify the images the registry holds'));
  });
});
