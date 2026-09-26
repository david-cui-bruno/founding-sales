import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseRecordSchema } from '@fss/contracts';
import { repositoryPath } from './support/repository.ts';
import { registryStubs } from './support/cliStubs.ts';

/**
 * Lane g74, audit O09: one release manifest per green full rehearsal, binding the
 * checkout, the run, both image digests and where they came from, the desktop stamp and
 * version, the release record — and, after the operator's deploy, what production runs.
 * And O17's other half: production gets those digests by a copy, never a rebuild.
 *
 * ## The vacuous-pass traps, named
 *
 * **A manifest that restates whatever it is given.** Writing a file is easy; binding is
 * the refusals. So `verify` is run against a record changed after the manifest was
 * written (its SHA-256 no longer matches), and `write` against a pinned run whose
 * checkout, stamp or image inputs disagree — each must be refused, with the positive
 * control beside it. A mutation drops the SHA-256 comparison and requires this file to
 * go red.
 *
 * **A record whose shape moved.** Production stores the release record through a strict
 * contract (`releaseRecordSchema`), so the manifest must not become a reason to change
 * it: the record the dry run writes still parses, and the manifest carries its reference
 * rather than new fields in it.
 *
 * **A copy that trusts itself.** `release-promote.sh` is run against a stubbed ECR in
 * which the copy changes the digest; it must fail naming both. With a faithful copy it
 * must succeed, never write to a rehearsal repository, and do nothing the second time. A
 * mutation removes the read-back and requires this file to go red.
 *
 * **A deployment nobody compared.** `release-manifest.sh deployed` is run against stubbed
 * ECS answers in which production runs the manifest's digests, and one in which the
 * worker runs another; the second must write nothing.
 */

const MANIFEST = repositoryPath('infra/scripts/release-manifest.sh');
const RECORD = repositoryPath('infra/scripts/rehearsal-release-record.sh');
const PROMOTE = repositoryPath('infra/scripts/release-promote.sh');
const IMAGES = repositoryPath('infra/scripts/release-images.sh');

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

function run(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  cwd?: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, [...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function commitFile(repository: string, path: string, content: string): string {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), content);
  git(repository, 'add', path);
  git(repository, 'commit', '-q', '-m', `change ${path}`);
  return git(repository, 'rev-parse', 'HEAD');
}

/** A history with an image change, a documentation commit on top, and an unpublished image change. */
function history(): { readonly repository: string; readonly image: string; readonly docs: string; readonly later: string } {
  const repository = mkdtempSync(join(tmpdir(), 'fss-manifest-history-'));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.email', 'lane-g74@example.invalid');
  git(repository, 'config', 'user.name', 'lane g74');
  git(repository, 'config', 'commit.gpgsign', 'false');
  const image = commitFile(repository, 'apps/worker/src/main.ts', 'export {};\n');
  const docs = commitFile(repository, 'docs/greenfield/notes.md', 'prose\n');
  const later = commitFile(repository, 'certs/rds-global-bundle.pem', 'a new bundle\n');
  return { repository, image, docs, later };
}

/** The release record, written by the real script in dry-run mode. */
function releaseRecord(stamp: string, api = digest('a'), worker = digest('b')): { readonly reports: string; readonly record: string } {
  const reports = mkdtempSync(join(tmpdir(), 'fss-manifest-reports-'));
  for (const report of ['restore-drill.txt', 'schema-ranges.txt', 'prefix-guard.txt']) {
    writeFileSync(join(reports, report), 'prefix=fss-rh-case\n');
  }
  const record = join(reports, 'release-record.json');
  const result = run(RECORD, ['fss-rh-case', api, worker, stamp, 'pass', record], {
    FSS_REHEARSAL_REPORTS: reports,
    FSS_REHEARSAL_DRY_RUN: '1',
  });
  expect(result.code, result.stderr).toBe(0);
  return { reports, record };
}

function write(
  record: string,
  out: string,
  checkout: string,
  extra: readonly string[] = [],
  cwd?: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  return run(
    MANIFEST,
    [
      'write',
      record,
      out,
      '--checkout',
      checkout,
      '--run',
      '4242',
      '--attempt',
      '1',
      '--run-url',
      'https://github.com/example-owner/example-repo/actions/runs/4242',
      '--event',
      extra.includes('--pinned-commit') ? 'schedule' : 'workflow_dispatch',
      ...extra,
    ],
    {},
    cwd,
  );
}

interface Manifest {
  schema: string;
  releaseGateReference: string;
  releaseRecord: { sha256: string; releaseGateReference: string };
  checkout: { commit: string };
  run: { id: string; trigger: string; url: string };
  pinned: boolean;
  images: {
    api: { digest: string };
    worker: { digest: string };
    provenance: { source: string; workflowRunId: string | null; commit: string | null; inputsMatchCheckout: boolean | null };
  };
  desktop: { commitStamp: string; stampIsCheckout: boolean; appVersion: string | null };
  deployed: null | Record<string, unknown>;
}

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;

describe('the release manifest binds a green full rehearsal’s artifacts (O09)', () => {
  const { repository, image, docs, later } = history();

  it('leaves the release record’s contract alone: what the rehearsal writes still parses', () => {
    const { record } = releaseRecord(docs);
    expect(releaseRecordSchema.safeParse(JSON.parse(readFileSync(record, 'utf8'))).success).toBe(true);
  });

  it('writes a dispatched run’s manifest, and says it did not check where the images came from', () => {
    const { reports, record } = releaseRecord(docs);
    const out = join(reports, 'release-manifest.json');
    const result = write(record, out, docs, ['--desktop-app-version', '1.0.4'], repository);
    expect(result.code, result.stderr).toBe(0);
    const manifest = readManifest(out);
    const reference = (JSON.parse(readFileSync(record, 'utf8')) as { releaseGateReference: string }).releaseGateReference;
    expect(manifest.schema).toBe('fss.release-manifest.v1');
    expect(manifest.releaseGateReference).toBe(reference);
    expect(manifest.releaseRecord.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.checkout.commit).toBe(docs);
    expect(manifest.run).toMatchObject({ id: '4242', trigger: 'dispatch' });
    expect(manifest.pinned).toBe(false);
    expect(manifest.images.api.digest).toBe(digest('a'));
    expect(manifest.images.worker.digest).toBe(digest('b'));
    expect(manifest.images.provenance).toEqual({ source: 'dispatch-input', workflowRunId: null, commit: null, inputsMatchCheckout: null });
    expect(manifest.desktop).toEqual({ commitStamp: docs, stampIsCheckout: true, appVersion: '1.0.4' });
    expect(manifest.deployed).toBeNull();
    expect(run(MANIFEST, ['verify', out, record]).code).toBe(0);
  });

  it('writes a pinned run’s manifest only when the images’ inputs are the checkout’s', () => {
    const { reports, record } = releaseRecord(docs);
    const out = join(reports, 'release-manifest.json');
    const pinned = ['--pinned-commit', docs, '--images-run', '77', '--images-commit', image];
    const result = write(record, out, docs, pinned, repository);
    expect(result.code, result.stderr).toBe(0);
    const manifest = readManifest(out);
    expect(manifest.pinned).toBe(true);
    expect(manifest.run.trigger).toBe('weekly');
    expect(manifest.images.provenance).toEqual({ source: 'ci', workflowRunId: '77', commit: image, inputsMatchCheckout: true });
    const verified = run(MANIFEST, ['verify', out, record]);
    expect(verified.code, verified.stderr).toBe(0);
  });

  it('refuses a pinned run whose images were built before an image input changed', () => {
    const { reports, record } = releaseRecord(later);
    const result = write(record, join(reports, 'm.json'), later, ['--pinned-commit', later, '--images-run', '77', '--images-commit', image], repository);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the image inputs differ');
    expect(existsSync(join(reports, 'm.json'))).toBe(false);
  });

  it('refuses a pinned run whose checkout, or whose record’s desktop stamp, is not the pin', () => {
    const { reports, record } = releaseRecord(docs);
    const elsewhere = write(record, join(reports, 'a.json'), docs, ['--pinned-commit', later, '--images-run', '77', '--images-commit', image], repository);
    expect(elsewhere.code).not.toBe(0);
    const stamped = releaseRecord(image);
    const stamp = write(stamped.record, join(stamped.reports, 'b.json'), docs, ['--pinned-commit', docs, '--images-run', '77', '--images-commit', image], repository);
    expect(stamp.code).not.toBe(0);
    expect(stamp.stderr).toContain("desktop commit stamp must be its checkout");
  });

  it('refuses a pinned run that cannot name the CI run its images came from', () => {
    const { reports, record } = releaseRecord(docs);
    const result = write(record, join(reports, 'c.json'), docs, ['--pinned-commit', docs], repository);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('names the run that built them');
  });

  it('refuses a record that is not a pass, and a checkout that is not a commit', () => {
    const { reports, record } = releaseRecord(docs);
    const failing = join(reports, 'failing-record.json');
    writeFileSync(failing, readFileSync(record, 'utf8').replace('"suite": "pass"', '"suite": "fail"'));
    expect(write(failing, join(reports, 'd.json'), docs, [], repository).code).not.toBe(0);
    expect(write(record, join(reports, 'e.json'), 'main', [], repository).code).not.toBe(0);
  });

  it('refuses, at verify, a record changed after the manifest was written', () => {
    const { reports, record } = releaseRecord(docs);
    const out = join(reports, 'release-manifest.json');
    expect(write(record, out, docs, [], repository).code).toBe(0);
    // The same reference and the same digests; one flag flipped. Only the SHA-256 notices.
    const altered = join(reports, 'altered-record.json');
    writeFileSync(altered, readFileSync(record, 'utf8').replace('"enablesSending": false', '"enablesSending": true'));
    const result = run(MANIFEST, ['verify', out, altered]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SHA-256 differs');
  });

  it('refuses, at verify, a manifest whose digests were edited to match another deployment', () => {
    const { reports, record } = releaseRecord(docs);
    const out = join(reports, 'release-manifest.json');
    expect(write(record, out, docs, [], repository).code).toBe(0);
    writeFileSync(out, readFileSync(out, 'utf8').replace(digest('b'), digest('c')));
    const result = run(MANIFEST, ['verify', out, record]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not the record's");
  });
});

// ---------------------------------------------------------------------------
// deployed
// ---------------------------------------------------------------------------

function production(workerDigest: string): Readonly<Record<string, unknown>> {
  const arn = (family: string, revision: number): string =>
    `arn:aws:ecs:us-east-1:123456789012:task-definition/${family}:${String(revision)}`;
  return {
    services: {
      'fss-prod-api': { status: 'ACTIVE', taskDefinition: arn('fss-prod-api', 41) },
      'fss-prod-worker': { status: 'ACTIVE', taskDefinition: arn('fss-prod-worker', 38) },
    },
    taskDefinitions: {
      [arn('fss-prod-api', 41)]: {
        containerDefinitions: [{ name: 'api', image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@${digest('a')}` }],
      },
      [arn('fss-prod-worker', 38)]: {
        containerDefinitions: [{ name: 'worker', image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@${workerDigest}` }],
      },
    },
  };
}

describe('after the deploy, the manifest records what production runs, or nothing', () => {
  const { repository, docs } = history();

  function manifestFile(): { readonly out: string; readonly record: string } {
    const { reports, record } = releaseRecord(docs);
    const out = join(reports, 'release-manifest.json');
    expect(write(record, out, docs, [], repository).code).toBe(0);
    return { out, record };
  }

  it('adds both task definitions and their digests when they are the manifest’s', () => {
    const { out, record } = manifestFile();
    const { aws } = registryStubs(production(digest('b')));
    const deployed = join(dirname(out), 'deployed.json');
    const result = run(MANIFEST, ['deployed', out, deployed], { FSS_REHEARSAL_AWS_COMMAND: aws.command });
    expect(result.code, result.stderr).toBe(0);
    const manifest = readManifest(deployed);
    expect(manifest.deployed).toMatchObject({
      environment: 'production',
      cluster: 'fss-prod-cluster',
      matchesManifest: true,
      api: { service: 'fss-prod-api', digest: digest('a') },
      worker: { service: 'fss-prod-worker', digest: digest('b') },
    });
    expect(String((manifest.deployed?.['api'] as { taskDefinition: string }).taskDefinition)).toContain('task-definition/fss-prod-api:41');
    // Reads only.
    for (const call of aws.calls()) expect(call.args[1] ?? '', call.args.join(' ')).toMatch(/^describe-/u);
    expect(run(MANIFEST, ['verify', deployed, record]).code).toBe(0);
  });

  it('writes nothing when production runs another image than the manifest names', () => {
    const { out } = manifestFile();
    const { aws } = registryStubs(production(digest('c')));
    const deployed = join(dirname(out), 'deployed.json');
    const result = run(MANIFEST, ['deployed', out, deployed], { FSS_REHEARSAL_AWS_COMMAND: aws.command });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('production does not run what this manifest rehearsed');
    expect(existsSync(deployed)).toBe(false);
  });

  it('describes production only', () => {
    const { out } = manifestFile();
    const { aws } = registryStubs(production(digest('b')));
    for (const args of [
      ['--environment', 'rehearsal'],
      ['--cluster', 'fss-rh-202609270923-cluster'],
    ]) {
      const result = run(MANIFEST, ['deployed', out, join(dirname(out), 'x.json'), ...args], { FSS_REHEARSAL_AWS_COMMAND: aws.command });
      expect(result.code, args.join(' ')).not.toBe(0);
    }
    expect(aws.calls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

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

function digestsFile(commit: string, api = digest('a'), worker = digest('b')): string {
  const directory = mkdtempSync(join(tmpdir(), 'fss-promote-input-'));
  const out = join(directory, 'image-digests.json');
  const result = run(IMAGES, ['record', commit, '55', '1', api, worker, out]);
  expect(result.code, result.stderr).toBe(0);
  return out;
}

function promote(
  input: string,
  args: readonly string[],
  state: Readonly<Record<string, unknown>>,
): { readonly code: number; readonly stdout: string; readonly stderr: string; readonly aws: ReturnType<typeof registryStubs>['aws']; readonly docker: ReturnType<typeof registryStubs>['docker'] } {
  const { aws, docker } = registryStubs(state);
  const result = run(PROMOTE, [input, ...args], { FSS_REHEARSAL_AWS_COMMAND: aws.command, FSS_DOCKER_COMMAND: docker.command });
  return { ...result, aws, docker };
}

describe('production gets the rehearsed digests by a copy, never a rebuild (O17)', () => {
  const commit = 'ab'.repeat(20);
  const tag = `ci-${commit}`;

  it('copies both digests into production and reads each back', () => {
    const result = promote(digestsFile(commit), ['--app-only'], registry());
    expect(result.code, result.stderr).toBe(0);
    const repositories = result.docker.state()['repositories'] as Record<string, { tags: Record<string, string> }>;
    expect(repositories['fss-prod-api']?.tags[tag]).toBe(digest('a'));
    expect(repositories['fss-prod-worker']?.tags[tag]).toBe(digest('b'));
    // Never a write to a rehearsal repository, never a build, never a push by tag.
    const docker = result.docker.calls().map(call => call.args.join(' '));
    expect(docker.filter(call => call.startsWith('buildx imagetools create'))).toEqual([
      `buildx imagetools create --tag 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api:${tag} --prefer-index=false 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@${digest('a')}`,
      `buildx imagetools create --tag 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker:${tag} --prefer-index=false 123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${digest('b')}`,
    ]);
    expect(docker.some(call => /\bbuild\b|\bpush\b/u.test(call.replace('buildx imagetools', '')))).toBe(false);
    // The login password went through stdin, not an argument.
    expect(result.docker.calls().find(call => call.args[0] === 'login')?.stdin).toContain('not-a-real-password');
    for (const call of result.aws.calls()) expect(call.args.join(' ')).not.toContain('put-image');
  });

  it('fails, naming both, when the copy changed the digest and the image itself is not in production', () => {
    const result = promote(digestsFile(commit), ['--app-only'], registry({ copyChangesDigest: true }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the digest changed in the copy');
    expect(result.stderr).toContain(`${digest('a')} itself is not in fss-prod-api`);
    expect(result.aws.calls().some(call => call.args.includes('put-image'))).toBe(false);
  });

  // Lane g86. CI's publish job pushes a bare OCI image manifest, and buildx's default
  // for one source is to wrap it in a new index, so the tag named another digest and the
  // promotion of e220f468 was refused on 25 September.
  const PUT = (calls: readonly { readonly args: readonly string[] }[]) => calls.filter(call => call.args[1] === 'put-image');
  const option = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it('copies a bare manifest as itself, so the tag names the digest that passed', () => {
    const result = promote(digestsFile(commit), ['--app-only'], registry({ realisticBuildx: true }));
    expect(result.code, result.stderr).toBe(0);
    const repositories = result.docker.state()['repositories'] as Record<string, { tags: Record<string, string> }>;
    expect(repositories['fss-prod-api']?.tags).toEqual({ [tag]: digest('a') });
    expect(repositories['fss-prod-worker']?.tags).toEqual({ [tag]: digest('b') });
    expect(result.stdout).toContain(`api fss-prod-api ${digest('a')} copied`);
    expect(PUT(result.aws.calls())).toEqual([]);
  });

  it('tags the image itself when the copy wraps it in an index, and says which tag', () => {
    const manifest = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{},"layers":[]}';
    const state = registry({ wraps: true });
    const repositories = state['repositories'] as Record<string, Record<string, unknown>>;
    for (const name of ['fss-prod-api', 'fss-prod-worker']) repositories[name] = { ...repositories[name], manifests: { [digest('a')]: manifest, [digest('b')]: manifest } };
    const result = promote(digestsFile(commit), ['--app-only'], state);
    expect(result.code, result.stderr).toBe(0);
    const after = result.docker.state()['repositories'] as Record<string, { tags: Record<string, string> }>;
    // The release's tag is the wrapper's now; the image itself carries `<tag>-image`.
    expect(after['fss-prod-api']?.tags).toEqual({ [tag]: digest('e'), [`${tag}-image`]: digest('a') });
    expect(after['fss-prod-worker']?.tags).toEqual({ [tag]: digest('e'), [`${tag}-image`]: digest('b') });
    expect(result.stdout).toContain(`api fss-prod-api ${digest('a')} copied-and-tagged ${tag}-image`);
    const puts = PUT(result.aws.calls());
    expect(puts.map(call => option(call.args, '--repository-name'))).toEqual(['fss-prod-api', 'fss-prod-worker']);
    expect(puts.map(call => option(call.args, '--image-digest'))).toEqual([digest('a'), digest('b')]);
    for (const call of puts) {
      expect(option(call.args, '--image-manifest-media-type')).toBe('application/vnd.oci.image.manifest.v1+json');
      // The manifest as ECR returned it, byte for byte, so the digest cannot move.
      expect((call as { readonly files?: Readonly<Record<string, string>> }).files?.['--image-manifest']).toBe(manifest);
    }
    const reads = result.aws.calls().filter(call => call.args[1] === 'batch-get-image');
    expect(reads.map(call => option(call.args, '--repository-name'))).toEqual(['fss-prod-api', 'fss-prod-worker']);
    expect(reads.every(call => option(call.args, '--accepted-media-types') === 'application/vnd.oci.image.manifest.v1+json')).toBe(true);
  });

  it('tags an image an earlier wrapping copy left in production untagged, and copies nothing', () => {
    const state = registry({
      repositories: {
        'fss-rh-api': { digests: [digest('a')], tags: {} },
        'fss-rh-worker': { digests: [digest('b')], tags: {} },
        'fss-prod-api': { digests: [digest('a'), digest('e')], tags: { [tag]: digest('e') } },
        'fss-prod-worker': { digests: [digest('b')], tags: { [tag]: digest('b') } },
      },
    });
    const result = promote(digestsFile(commit), ['--app-only'], state);
    expect(result.code, result.stderr).toBe(0);
    expect(result.docker.calls().filter(call => call.args[0] === 'buildx')).toHaveLength(0);
    expect(result.stdout).toContain(`api fss-prod-api ${digest('a')} tagged-in-place ${tag}-image`);
    expect(result.stdout).toContain(`worker fss-prod-worker ${digest('b')} already-present`);
    const after = result.docker.state()['repositories'] as Record<string, { tags: Record<string, string> }>;
    expect(after['fss-prod-api']?.tags[`${tag}-image`]).toBe(digest('a'));
  });

  it('refuses to tag the image in place when both tags it may use name other images', () => {
    const state = registry({
      repositories: {
        'fss-rh-api': { digests: [digest('a')], tags: {} },
        'fss-rh-worker': { digests: [digest('b')], tags: {} },
        'fss-prod-api': { digests: [digest('a'), digest('e'), digest('c')], tags: { [tag]: digest('e'), [`${tag}-image`]: digest('c') } },
        'fss-prod-worker': { digests: [], tags: {} },
      },
    });
    const result = promote(digestsFile(commit), ['--app-only'], state);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('has no free tag');
    expect(PUT(result.aws.calls())).toEqual([]);
  });

  it('does nothing the second time', () => {
    const state = registry({
      repositories: {
        'fss-rh-api': { digests: [digest('a')], tags: {} },
        'fss-rh-worker': { digests: [digest('b')], tags: {} },
        'fss-prod-api': { digests: [digest('a')], tags: { [tag]: digest('a') } },
        'fss-prod-worker': { digests: [digest('b')], tags: { [tag]: digest('b') } },
      },
    });
    const result = promote(digestsFile(commit), ['--app-only'], state);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('already-present');
    expect(result.docker.calls().filter(call => call.args[0] === 'buildx')).toHaveLength(0);
  });

  it('refuses a digest the rehearsal repository does not hold, and a tag that names another image', () => {
    const missing = promote(digestsFile(commit, digest('c')), ['--app-only'], registry());
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('fss-rh-api has no image');
    const taken = registry({
      repositories: {
        'fss-rh-api': { digests: [digest('a')], tags: {} },
        'fss-rh-worker': { digests: [digest('b')], tags: {} },
        'fss-prod-api': { digests: [digest('e')], tags: { [tag]: digest('e') } },
        'fss-prod-worker': { digests: [], tags: {} },
      },
    });
    const result = promote(digestsFile(commit), ['--app-only'], taken);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('tags are immutable');
    expect(result.docker.calls().filter(call => call.args[0] === 'buildx')).toHaveLength(0);
  });

  it('refuses CI digests without --app-only, and --app-only with a rehearsed manifest', () => {
    const unrehearsed = promote(digestsFile(commit), [], registry());
    expect(unrehearsed.code).not.toBe(0);
    expect(unrehearsed.stderr).toContain('no full rehearsal has passed with them');
    expect(unrehearsed.aws.calls()).toHaveLength(0);

    const { repository, docs } = history();
    const { reports, record } = releaseRecord(docs);
    const manifest = join(reports, 'release-manifest.json');
    expect(write(record, manifest, docs, [], repository).code).toBe(0);
    expect(promote(manifest, ['--app-only'], registry()).code).not.toBe(0);
    // A dispatched run's images carry no ci- tag, so the operator names one.
    expect(promote(manifest, [], registry()).stderr).toContain('name one with --tag');
    const named = promote(manifest, ['--tag', 'release-2026-09-27'], registry());
    expect(named.code, named.stderr).toBe(0);
  });

  it('refuses an input that is neither file, a mutable tag, and one image under both names', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-promote-bad-'));
    const other = join(directory, 'other.json');
    writeFileSync(other, JSON.stringify({ schema: 'fss.release-record.v1' }));
    expect(promote(other, ['--app-only'], registry()).code).not.toBe(0);
    const tagged = join(directory, 'tagged.json');
    writeFileSync(tagged, readFileSync(digestsFile(commit), 'utf8').replace(digest('a'), 'fss-rh-api:latest'));
    expect(promote(tagged, ['--app-only'], registry()).code).not.toBe(0);
    const same = join(directory, 'same.json');
    writeFileSync(same, readFileSync(digestsFile(commit), 'utf8').replace(digest('b'), digest('a')));
    expect(promote(same, ['--app-only'], registry()).code).not.toBe(0);
  });

});
