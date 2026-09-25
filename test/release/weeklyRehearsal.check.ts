import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';
import { ghStub, type Stub } from './support/cliStubs.ts';
import { rehearsalJobSteps, stepScript } from './support/releaseWorkflow.ts';

/**
 * Lane g74: the weekly full rehearsal runs on a schedule with pinned artifacts (audit
 * O10), CI is where the image digests come from (O17), and a scheduled check that never
 * ran is noticed (O11).
 *
 * ## The vacuous-pass traps, named
 *
 * **A pin that pins nothing.** "The weekly run passes digests to the rehearsal" is true
 * of a pin that takes the newest images run whatever it built. So `release-images.sh
 * pin` is run against a real git history and a stubbed GitHub: a documentation commit
 * on top of an image change must pin that change's images, an image change nobody
 * published must be refused, a run on another branch must be passed over, and an
 * artifact that names another commit, or one image under both names, must be refused.
 * A mutation removes the input comparison and requires this file to go red.
 *
 * **A stamp that is not the commit.** The weekly caller must hand the rehearsal the
 * commit it runs at as the desktop stamp and as `pinned_commit`, and the called run must
 * refuse unless it checked out exactly that commit. The refusal is extracted from the
 * workflow and run, pinned and unpinned, rather than read.
 *
 * **A slot that is every hour, or none.** The slot decision is run at fixed instants:
 * before the hour, at it, after it with and without an earlier attempt, on a Saturday,
 * paused, and dispatched. A mutation makes the catch-up ignore earlier attempts.
 *
 * **A freshness check that cannot fail.** It is run against a stubbed GitHub at a fixed
 * present with a stale nightly, a fresh one, a never-run one, a paused weekly, and an
 * open issue; it must fail and open exactly one issue when stale, update rather than
 * open a second, and close it when fresh. A mutation inverts the age comparison.
 *
 * **Images CI never publishes.** The images workflow's `push.paths` are compared with
 * `release-images.sh inputs`, the list the pin compares history over, so a path that
 * changes an image and publishes nothing cannot pass unnoticed.
 */

const WEEKLY = '.github/workflows/greenfield-weekly-rehearsal.yml';
const IMAGES = '.github/workflows/greenfield-images.yml';
const FRESHNESS = '.github/workflows/greenfield-freshness.yml';
const RELEASE = '.github/workflows/greenfield-release.yml';
const IMAGES_SCRIPT = repositoryPath('infra/scripts/release-images.sh');
const SCHEDULE_SCRIPT = repositoryPath('infra/scripts/ci-schedule.sh');
const REPOSITORY = 'example-owner/example-repo';

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

/** Lines that are not YAML comments. */
function uncommented(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** A top-level block (`on:`, `jobs:`) or a job, by its exact header line, until the next line at that indent. */
function block(text: string, header: string): string {
  const lines = text.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`no line reads exactly ${JSON.stringify(header)}`);
  const indent = header.length - header.trimStart().length;
  const out = [header];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.trimStart().startsWith('#') && line.length - line.trimStart().length <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}

function run(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd?: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe('the weekly full rehearsal is scheduled, and pins what it rehearses (O10)', () => {
  const workflow = readRepositoryFile(WEEKLY);
  const on = block(workflow, 'on:');
  const pin = block(workflow, '  pin:');
  const call = block(workflow, '  rehearsal:');

  it('wakes every hour on Sunday, and can be dispatched, dry by default', () => {
    expect(uncommented(on).match(/- cron: /gu)).toHaveLength(1);
    expect(on).toContain("    - cron: '23 * * * 0'");
    expect(on).toContain('  workflow_dispatch:');
    expect(on).toMatch(/dry_run:[\s\S]*?type: boolean[\s\S]*?default: true/u);
    expect(on).not.toMatch(/^ {2}(push|pull_request|pull_request_target):/mu);
  });

  it('takes the slot hour from a repository variable, defaulting to 09:00 UTC', () => {
    expect(workflow).toContain('FSS_WEEKLY_REHEARSAL_HOUR_UTC: ${{ vars.FSS_WEEKLY_REHEARSAL_HOUR_UTC }}');
    expect(readFileSync(SCHEDULE_SCRIPT, 'utf8')).toContain('hour=${hour:-9}');
  });

  it('pins with no cloud credential: no environment, no id-token, and a refusal of any ambient one', () => {
    expect(pin).toContain('if: needs.slot.outputs.due == \'true\'');
    expect(pin).not.toContain('environment:');
    expect(pin).not.toContain('id-token');
    expect(pin).toContain('fetch-depth: 0');
    expect(pin).toContain('infra/scripts/release-images.sh pin "$GITHUB_SHA"');
    expect(pin).toContain('Pinning the weekly rehearsal\'s artifacts needs no cloud credential');
    // And the job's name is the one the slot decision looks for in earlier runs.
    expect(pin).toContain('    name: Pin the three artifacts to this commit');
    expect(readFileSync(SCHEDULE_SCRIPT, 'utf8')).toContain("PIN_JOB_NAME='Pin the three artifacts to this commit'");
  });

  it('calls the release workflow itself at this commit, full, with the three pinned artifacts', () => {
    expect(call).toContain('    uses: ./.github/workflows/greenfield-release.yml');
    expect(call).toContain('    secrets: inherit');
    expect(call).toContain('      stage: full');
    expect(call).toContain('      api_image_digest: ${{ needs.pin.outputs.api_digest }}');
    expect(call).toContain('      worker_image_digest: ${{ needs.pin.outputs.worker_digest }}');
    // The stamp and the pin are the commit this run is at, never something the pin computed.
    expect(call).toContain('      desktop_commit_stamp: ${{ github.sha }}');
    expect(call).toContain('      pinned_commit: ${{ github.sha }}');
    expect(call).toContain('      images_ci_run_id: ${{ needs.pin.outputs.images_run_id }}');
    expect(call).toContain('      images_ci_commit: ${{ needs.pin.outputs.images_commit }}');
    // Only when the pin succeeded, and never on a dry dispatch.
    expect(call).toContain("needs.pin.result == 'success'");
    expect(call).toContain("!(github.event_name == 'workflow_dispatch' && inputs.dry_run)");
    // The one credential the called job asks for, granted here and nowhere else.
    expect(call).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write/u);
  });

  it('never names production, and takes a concurrency group that is not the release workflow’s own', () => {
    expect(uncommented(workflow)).not.toContain('fss-prod');
    expect(uncommented(workflow)).not.toContain('release-promote.sh');
    expect(workflow).toContain('  group: greenfield-weekly-rehearsal');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(uncommented(workflow)).not.toContain('group: greenfield-rehearsal\n');
  });

  it('pins actions by the same commit the release workflow pins', () => {
    const release = readRepositoryFile(RELEASE);
    for (const file of [WEEKLY, IMAGES, FRESHNESS]) {
      const references = [...readRepositoryFile(file).matchAll(/uses:\s*(\S+)/gu)]
        .map(match => match[1] ?? '')
        .filter(reference => !reference.startsWith('./'));
      expect(references.length, file).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference, `${file}: ${reference}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u);
        expect(release, `${file}: ${reference}`).toContain(reference);
      }
    }
  });
});

describe('the release workflow can be called weekly, and refuses a pin it did not check out', () => {
  const release = readRepositoryFile(RELEASE);

  it('declares workflow_call with every dispatch input and the three the weekly caller adds', () => {
    const called = block(release, '  workflow_call:');
    for (const name of [
      'stage',
      'api_image_digest',
      'worker_image_digest',
      'desktop_commit_stamp',
      'run_suffix',
      'pinned_commit',
      'images_ci_run_id',
      'images_ci_commit',
    ]) {
      expect(called, name).toContain(`      ${name}:\n`);
    }
  });

  it('runs the credentialed job on a dispatch or the weekly call, and never on a push or a pull request', () => {
    const job = release.slice(release.indexOf('\n  rehearsal:\n'));
    expect(job).toContain("    if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'\n");
    expect(job).toContain('    environment: rehearsal');
  });

  function refusal(inputs: Readonly<Record<string, string>>, sha: string): { readonly code: number; readonly output: string } {
    let script = stepScript('Refuse anything that is not a digest');
    for (const [name, value] of Object.entries(inputs)) {
      script = script.replaceAll(`\${{ inputs.${name} }}`, value);
    }
    expect(script, 'an input the step reads was not supplied').not.toContain('${{');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sha } });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  }

  const sha = 'c'.repeat(40);
  const base = {
    api_image_digest: digest('a'),
    worker_image_digest: digest('b'),
    desktop_commit_stamp: sha,
    stage: 'full',
    pinned_commit: sha,
  };

  it('accepts a pinned run whose checkout, stamp and stage are the pin, which is the positive control', () => {
    const { code, output } = refusal(base, sha);
    expect(code, output).toBe(0);
    expect(output).toContain(`pinned to ${sha}`);
  });

  it('refuses a pinned run that checked out another commit', () => {
    const { code, output } = refusal(base, 'd'.repeat(40));
    expect(code).not.toBe(0);
    expect(output).toContain('was pinned to');
  });

  it('refuses a pinned run whose desktop stamp is not the pin, or that is not full', () => {
    expect(refusal({ ...base, desktop_commit_stamp: 'e'.repeat(40) }, sha).code).not.toBe(0);
    expect(refusal({ ...base, stage: 'deploy' }, sha).code).not.toBe(0);
  });

  it('leaves a dispatched run alone: no pin, any stamp', () => {
    const { code, output } = refusal({ ...base, pinned_commit: '', desktop_commit_stamp: 'e'.repeat(40) }, sha);
    expect(code, output).toBe(0);
  });

  it('checks out the whole history, which the manifest’s comparison needs', () => {
    const steps = rehearsalJobSteps();
    expect(steps[0]?.text).toContain('fetch-depth: 0');
  });
});

// ---------------------------------------------------------------------------
// The pin, over a real history.
// ---------------------------------------------------------------------------

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

function history(): { readonly repository: string; readonly image: string; readonly docs: string; readonly unpublished: string; readonly branch: string } {
  const repository = mkdtempSync(join(tmpdir(), 'fss-pin-history-'));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.email', 'lane-g74@example.invalid');
  git(repository, 'config', 'user.name', 'lane g74');
  git(repository, 'config', 'commit.gpgsign', 'false');
  commitFile(repository, 'README.md', 'start\n');
  const image = commitFile(repository, 'apps/api/src/server.ts', 'export const version = 1;\n');
  git(repository, 'checkout', '-q', '-b', 'side');
  const branch = commitFile(repository, 'apps/api/src/server.ts', 'export const version = 99;\n');
  git(repository, 'checkout', '-q', 'main');
  const docs = commitFile(repository, 'docs/notes.md', 'only prose\n');
  const unpublished = commitFile(repository, 'packages/domain/src/index.ts', 'export {};\n');
  return { repository, image, docs, unpublished, branch };
}

function imagesRun(id: number, headSha: string, createdAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, head_sha: headSha, created_at: createdAt, conclusion: 'success', event: 'push', head_branch: 'main', ...extra };
}

function digestsFile(commit: string, runId: number, api = digest('a'), worker = digest('b')): string {
  return JSON.stringify({
    schema: 'fss.image-digests.v1',
    commit,
    workflowRunId: String(runId),
    workflowRunAttempt: '1',
    images: {
      api: { repository: 'fss-rh-api', tag: `ci-${commit}`, digest: api },
      worker: { repository: 'fss-rh-worker', tag: `ci-${commit}`, digest: worker },
    },
  });
}

function pin(
  repository: string,
  commit: string,
  gh: Stub,
): { readonly code: number; readonly stdout: string; readonly stderr: string; readonly pinned: string } {
  const out = join(mkdtempSync(join(tmpdir(), 'fss-pin-out-')), 'image-pin.json');
  const result = run(IMAGES_SCRIPT, ['pin', commit, out], { FSS_GH_COMMAND: gh.command, GITHUB_REPOSITORY: REPOSITORY }, repository);
  let pinned = '';
  try {
    pinned = readFileSync(out, 'utf8');
  } catch {
    pinned = '';
  }
  return { ...result, pinned };
}

const RUNS_ROUTE = `GET repos/${REPOSITORY}/actions/workflows/greenfield-images.yml/runs`;

describe('the pin takes the images CI published for this commit’s image inputs, or nothing', () => {
  const { repository, image, docs, unpublished, branch } = history();

  it('pins a documentation commit to the images of the image change beneath it', () => {
    const gh = ghStub({
      routes: { [RUNS_ROUTE]: { workflow_runs: [imagesRun(11, image, '2026-09-20T10:00:00Z')] } },
      downloads: { '11': digestsFile(image, 11) },
    });
    const result = pin(repository, docs, gh);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`api_digest=${digest('a')}\n`);
    expect(result.stdout).toContain(`worker_digest=${digest('b')}\n`);
    expect(result.stdout).toContain(`images_commit=${image}\n`);
    expect(result.stdout).toContain('images_run_id=11\n');
    const pinned = JSON.parse(result.pinned) as Record<string, unknown>;
    expect(pinned['commit']).toBe(docs);
    expect(pinned['imagesCommit']).toBe(image);
    expect(pinned['imageInputsUnchanged']).toBe(true);
  });

  it('refuses a commit whose image inputs changed after the last published images', () => {
    const gh = ghStub({
      routes: { [RUNS_ROUTE]: { workflow_runs: [imagesRun(11, image, '2026-09-20T10:00:00Z')] } },
      downloads: { '11': digestsFile(image, 11) },
    });
    const result = pin(repository, unpublished, gh);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('whose inputs are those of');
    expect(result.pinned).toBe('');
    // It never downloaded anything: a run whose inputs differ is not a candidate.
    expect(gh.calls().some(call => call.args[0] === 'run')).toBe(false);
  });

  it('passes over a newer run from a commit that is not in this history', () => {
    const gh = ghStub({
      routes: {
        [RUNS_ROUTE]: {
          workflow_runs: [imagesRun(12, branch, '2026-09-21T10:00:00Z'), imagesRun(11, image, '2026-09-20T10:00:00Z')],
        },
      },
      downloads: { '11': digestsFile(image, 11), '12': digestsFile(branch, 12, digest('c'), digest('d')) },
    });
    const result = pin(repository, docs, gh);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('images_run_id=11\n');
  });

  it('refuses an artifact that names another commit, one image under both names, or no artifact', () => {
    const routes = { [RUNS_ROUTE]: { workflow_runs: [imagesRun(11, image, '2026-09-20T10:00:00Z')] } };
    const otherCommit = pin(repository, docs, ghStub({ routes, downloads: { '11': digestsFile(docs, 11) } }));
    expect(otherCommit.code).not.toBe(0);
    expect(otherCommit.stderr).toContain('names commit');
    const bothNames = pin(repository, docs, ghStub({ routes, downloads: { '11': digestsFile(image, 11, digest('a'), digest('a')) } }));
    expect(bothNames.code).not.toBe(0);
    expect(bothNames.stderr).toContain('one image was pushed under both names');
    const notDigest = pin(repository, docs, ghStub({ routes, downloads: { '11': digestsFile(image, 11, 'fss-rh-api:latest') } }));
    expect(notDigest.code).not.toBe(0);
    const missing = pin(repository, docs, ghStub({ routes, downloads: {} }));
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('has no fss-image-digests artifact');
  });

  it('refuses when no successful run exists at all, and ignores runs that did not succeed', () => {
    const failed = ghStub({
      routes: { [RUNS_ROUTE]: { workflow_runs: [imagesRun(11, image, '2026-09-20T10:00:00Z', { conclusion: 'failure' })] } },
      downloads: { '11': digestsFile(image, 11) },
    });
    expect(pin(repository, docs, failed).code).not.toBe(0);
    expect(pin(repository, docs, ghStub({ routes: { [RUNS_ROUTE]: { workflow_runs: [] } } })).code).not.toBe(0);
  });

  it('asks GitHub for successful push runs on main, and no deeper than the registry keeps', () => {
    const gh = ghStub({ routes: { [RUNS_ROUTE]: { workflow_runs: [] } } });
    pin(repository, docs, gh);
    const listing = gh.calls()[0]?.args ?? [];
    for (const field of ['branch=main', 'event=push', 'status=success', 'per_page=25']) {
      expect(listing, field).toContain(field);
    }
  });
});

describe('the images CI publishes are the images of exactly the inputs the pin compares (O17)', () => {
  const workflow = readRepositoryFile(IMAGES);
  const inputs = execFileSync(IMAGES_SCRIPT, ['inputs'], { encoding: 'utf8' }).trim().split('\n');

  function paths(trigger: string): string[] {
    const section = block(block(workflow, 'on:'), `  ${trigger}:`);
    return [...section.matchAll(/^ {6}- '([^']+)'$/gmu)].map(match => (match[1] ?? '').replace(/\/\*\*$/u, ''));
  }

  it('publishes on a push to main exactly when an image input changed', () => {
    expect(inputs.length).toBeGreaterThanOrEqual(8);
    expect(paths('push').sort()).toEqual([...inputs].sort());
    // A certificate the images copy is an input; before g74 the push list missed it.
    expect(inputs).toContain('certs');
  });

  it('builds on a pull request for every input too', () => {
    const pullRequest = paths('pull_request');
    for (const input of inputs) expect(pullRequest, input).toContain(input);
  });

  it('builds on a pull request with no credential, and publishes on main through the rehearsal role only', () => {
    const images = block(workflow, '  images:');
    const publish = block(workflow, '  publish:');
    expect(images).toContain("    if: github.event_name == 'pull_request'");
    expect(images).not.toContain('environment:');
    expect(images).not.toContain('id-token');
    expect(publish).toContain("    if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(publish).toContain('    environment: rehearsal');
    expect(publish).toContain('role-to-assume: ${{ secrets.FSS_REHEARSAL_ROLE_ARN }}');
    expect(publish).toContain('infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy');
    // The two stable rehearsal repositories, as ci-<commit>, and nothing in production.
    expect(publish).toContain('[ "${API_REPOSITORY##*/}" = fss-rh-api ]');
    expect(publish).toContain('[ "${WORKER_REPOSITORY##*/}" = fss-rh-worker ]');
    expect(publish).toContain('tag="ci-${GITHUB_SHA}"');
    expect(uncommented(workflow)).not.toContain('fss-prod');
  });

  it('verifies what the registry holds, by digest, before it records a digest', () => {
    const publish = block(workflow, '  publish:');
    const verifyAt = publish.indexOf('infra/scripts/release-images.sh verify "$API_REPOSITORY@$API_DIGEST"');
    const recordAt = publish.indexOf('infra/scripts/release-images.sh record');
    const keepAt = publish.indexOf('name: fss-image-digests');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(verifyAt);
    expect(keepAt).toBeGreaterThan(recordAt);
    expect(publish).toContain('if-no-files-found: error');
  });

  it('records digests the pin can read, and refuses ones it could not', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-record-'));
    const out = join(directory, 'image-digests.json');
    const commit = 'a1'.repeat(20);
    const good = run(IMAGES_SCRIPT, ['record', commit, '42', '1', digest('a'), digest('b'), out], {});
    expect(good.code, good.stderr).toBe(0);
    const recorded = JSON.parse(readFileSync(out, 'utf8')) as { images: Record<string, { tag: string; repository: string }> };
    expect(recorded.images['api']?.tag).toBe(`ci-${commit}`);
    expect(recorded.images['worker']?.repository).toBe('fss-rh-worker');
    // A registry host never appears: it carries the account.
    expect(readFileSync(out, 'utf8')).not.toMatch(/dkr\.ecr|amazonaws/u);
    for (const args of [
      [commit, '42', '1', digest('a'), digest('a'), out],
      [commit, '42', '1', 'fss-rh-api:latest', digest('b'), out],
      ['abc', '42', '1', digest('a'), digest('b'), out],
      [commit, 'forty-two', '1', digest('a'), digest('b'), out],
    ]) {
      expect(run(IMAGES_SCRIPT, ['record', ...args], {}).code, args.join(' ')).not.toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The slot.
// ---------------------------------------------------------------------------

const WEEKLY_RUNS_ROUTE = `GET repos/${REPOSITORY}/actions/workflows/greenfield-weekly-rehearsal.yml/runs`;

function slot(
  now: string,
  options: {
    readonly hour?: string;
    readonly event?: string;
    readonly runs?: readonly Record<string, unknown>[];
    readonly jobs?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  } = {},
): { readonly code: number; readonly due: string; readonly stderr: string; readonly gh: Stub } {
  const routes: Record<string, unknown> = { [WEEKLY_RUNS_ROUTE]: { workflow_runs: options.runs ?? [] } };
  for (const [id, jobs] of Object.entries(options.jobs ?? {})) {
    routes[`GET repos/${REPOSITORY}/actions/runs/${id}/jobs`] = { jobs };
  }
  const gh = ghStub({ routes });
  const env: Record<string, string> = {
    FSS_GH_COMMAND: gh.command,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: options.event ?? 'schedule',
    GITHUB_RUN_ID: '900',
    FSS_NOW: now,
    FSS_WEEKLY_REHEARSAL_HOUR_UTC: options.hour ?? '',
  };
  const result = run(SCHEDULE_SCRIPT, ['slot'], env);
  return { code: result.code, due: result.stdout.trim(), stderr: result.stderr, gh };
}

const PIN_JOB = 'Pin the three artifacts to this commit';

describe('the weekly slot is Sunday at the configured hour, caught up once, and never run twice (O10)', () => {
  // 27 September 2026 is a Sunday.
  it('is not due before the hour, or on another day, and asks GitHub nothing then', () => {
    for (const now of ['2026-09-27T08:23:00Z', '2026-09-26T09:23:00Z', '2026-09-28T09:23:00Z']) {
      const result = slot(now);
      expect(result.due, now).toBe('due=false');
      expect(result.gh.calls(), now).toHaveLength(0);
    }
  });

  it('is due at the hour when nothing has run since the slot began', () => {
    const result = slot('2026-09-27T09:23:00Z', {
      runs: [{ id: 800, created_at: '2026-09-27T08:23:00Z' }],
    });
    expect(result.due, result.stderr).toBe('due=true');
  });

  it('catches up a later hour when the slot’s own run never pinned', () => {
    const result = slot('2026-09-27T11:23:00Z', {
      runs: [{ id: 801, created_at: '2026-09-27T10:23:00Z' }],
      jobs: { '801': [{ name: PIN_JOB, conclusion: 'skipped' }] },
    });
    expect(result.due, result.stderr).toBe('due=true');
  });

  it('is not due again once a run since the slot pinned, passed, failed or is still going', () => {
    for (const conclusion of ['success', 'failure', null]) {
      const result = slot('2026-09-27T12:23:00Z', {
        runs: [{ id: 802, created_at: '2026-09-27T09:24:00Z' }],
        jobs: { '802': [{ name: 'Decide whether this hour is the weekly slot', conclusion: 'success' }, { name: PIN_JOB, conclusion }] },
      });
      expect(result.due, String(conclusion)).toBe('due=false');
      expect(result.stderr).toContain('already attempted');
    }
  });

  it('does not count its own run as an earlier attempt', () => {
    const result = slot('2026-09-27T09:23:00Z', {
      runs: [{ id: 900, created_at: '2026-09-27T09:23:00Z' }],
      jobs: { '900': [{ name: PIN_JOB, conclusion: null }] },
    });
    expect(result.due).toBe('due=true');
  });

  it('follows the variable: another hour, paused, and a value that is neither is a failure', () => {
    expect(slot('2026-09-27T09:23:00Z', { hour: '14' }).due).toBe('due=false');
    expect(slot('2026-09-27T14:23:00Z', { hour: '14' }).due).toBe('due=true');
    expect(slot('2026-09-27T09:23:00Z', { hour: 'off' }).due).toBe('due=false');
    expect(slot('2026-09-27T09:23:00Z', { hour: '25' }).code).not.toBe(0);
  });

  it('is due whenever it is dispatched by hand, even paused', () => {
    expect(slot('2026-09-23T03:00:00Z', { event: 'workflow_dispatch' }).due).toBe('due=true');
    expect(slot('2026-09-23T03:00:00Z', { event: 'workflow_dispatch', hour: 'off' }).due).toBe('due=true');
  });
});

// ---------------------------------------------------------------------------
// Freshness.
// ---------------------------------------------------------------------------

const NOW = '2026-09-26T21:41:00Z';
const MARKER = '<!-- fss-schedule-freshness -->';

function freshness(options: {
  readonly nightly?: readonly Record<string, unknown>[];
  readonly manifests?: readonly Record<string, unknown>[];
  readonly issues?: readonly Record<string, unknown>[];
  readonly nightlyCreated?: string;
  readonly weeklyCreated?: string;
  readonly paused?: boolean;
}): { readonly code: number; readonly stdout: string; readonly stderr: string; readonly gh: Stub } {
  const base = `repos/${REPOSITORY}`;
  const gh = ghStub({
    routes: {
      [`GET ${base}/actions/workflows/greenfield-nightly.yml`]: { created_at: options.nightlyCreated ?? '2026-09-25T05:00:00Z' },
      [`GET ${base}/actions/workflows/greenfield-nightly.yml/runs`]: { workflow_runs: options.nightly ?? [] },
      [`GET ${base}/actions/workflows/greenfield-weekly-rehearsal.yml`]: { created_at: options.weeklyCreated ?? '2026-09-25T18:00:00Z' },
      [`GET ${base}/actions/artifacts`]: { artifacts: options.manifests ?? [] },
      [`GET ${base}/issues`]: options.issues ?? [],
      [`POST ${base}/issues`]: { number: 31, node_id: 'I_kwDOexample' },
      [`PATCH ${base}/issues/31`]: { number: 31 },
      [`POST ${base}/issues/31/comments`]: { id: 1 },
    },
  });
  const summary = join(mkdtempSync(join(tmpdir(), 'fss-freshness-summary-')), 'summary.md');
  writeFileSync(summary, '');
  const result = run(SCHEDULE_SCRIPT, ['freshness'], {
    FSS_GH_COMMAND: gh.command,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_OWNER: 'example-owner',
    GITHUB_STEP_SUMMARY: summary,
    FSS_NOW: NOW,
    FSS_WEEKLY_REHEARSAL_HOUR_UTC: options.paused === true ? 'off' : '',
    FSS_NIGHTLY_MAX_AGE_HOURS: '30',
    FSS_WEEKLY_MAX_AGE_HOURS: '192',
    FSS_FRESHNESS_NOTIFY: '',
  });
  return { ...result, gh };
}

const nightlyRun = (at: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  conclusion: 'success',
  head_branch: 'main',
  created_at: at,
  run_started_at: at,
  ...extra,
});
const manifest = (at: string, branch = 'main'): Record<string, unknown> => ({
  name: 'fss-release-manifest',
  created_at: at,
  expired: false,
  workflow_run: { head_branch: branch },
});

function writes(gh: Stub): readonly string[] {
  return gh
    .calls()
    .filter(call => call.args.includes('POST') || call.args.includes('PATCH') || call.args[1] === 'graphql')
    .map(call => `${call.args[2] === 'POST' || call.args[2] === 'PATCH' ? call.args[2] : 'GRAPHQL'} ${call.args.find(arg => arg.startsWith('repos/')) ?? ''}`);
}

describe('a scheduled check that did not run is noticed, once, by an issue (O11)', () => {
  const freshNightly = [nightlyRun('2026-09-26T09:05:00Z')];
  const freshManifest = [manifest('2026-09-24T11:00:00Z')];

  it('passes quietly when the nightly ran today and a full rehearsal passed this week', () => {
    const result = freshness({ nightly: freshNightly, manifests: freshManifest });
    expect(result.code, result.stderr).toBe(0);
    expect(writes(result.gh)).toEqual([]);
    expect(result.stdout).toContain('every scheduled check is fresh');
  });

  it('fails and opens one issue, mentioning the owner, when the nightly is older than 30 hours', () => {
    const result = freshness({ nightly: [nightlyRun('2026-09-25T09:05:00Z')], manifests: freshManifest });
    expect(result.code).not.toBe(0);
    expect(writes(result.gh)).toEqual([`POST repos/${REPOSITORY}/issues`, 'GRAPHQL ']);
    const opened = result.gh.calls().find(call => call.args.includes('POST'));
    const body = opened?.files?.['body'] ?? '';
    expect(body).toContain(MARKER);
    expect(body).toContain('<!-- stale: nightly mutation check -->');
    expect(body).toContain('cc @example-owner');
    expect(opened?.args).toContain('title=Scheduled checks are stale: nightly mutation check');
  });

  it('counts a run on another branch, or one that failed, as no run', () => {
    const result = freshness({
      nightly: [nightlyRun('2026-09-26T09:05:00Z', { head_branch: 'g74/branch' }), nightlyRun('2026-09-26T10:05:00Z', { conclusion: 'failure' })],
      manifests: freshManifest,
    });
    expect(result.code).not.toBe(0);
  });

  it('treats a workflow that never ran as stale once it is older than its limit, and not before', () => {
    expect(freshness({ manifests: freshManifest, nightlyCreated: '2026-09-26T05:00:00Z' }).code).toBe(0);
    expect(freshness({ manifests: freshManifest, nightlyCreated: '2026-09-20T05:00:00Z' }).code).not.toBe(0);
  });

  it('alarms on a full rehearsal older than eight days, unless the weekly schedule is paused', () => {
    const old = [manifest('2026-09-17T11:00:00Z')];
    const stale = freshness({ nightly: freshNightly, manifests: old, weeklyCreated: '2026-09-10T00:00:00Z' });
    expect(stale.code).not.toBe(0);
    expect(stale.stdout).toContain('| full rehearsal | **no** |');
    const branch = freshness({ nightly: freshNightly, manifests: [manifest('2026-09-25T11:00:00Z', 'side')], weeklyCreated: '2026-09-10T00:00:00Z' });
    expect(branch.code).not.toBe(0);
    const paused = freshness({ nightly: freshNightly, manifests: old, weeklyCreated: '2026-09-10T00:00:00Z', paused: true });
    expect(paused.code, paused.stderr).toBe(0);
    expect(paused.stdout).toContain('paused');
  });

  it('updates the open issue instead of opening a second, and comments only when what is stale changed', () => {
    const open = (stale: string): Record<string, unknown> => ({ number: 31, body: `${MARKER}\n<!-- stale: ${stale} -->\nold` });
    const same = freshness({ nightly: [nightlyRun('2026-09-25T09:05:00Z')], manifests: freshManifest, issues: [open('nightly mutation check')] });
    expect(same.code).not.toBe(0);
    expect(writes(same.gh)).toEqual([`PATCH repos/${REPOSITORY}/issues/31`]);
    const more = freshness({
      nightly: [nightlyRun('2026-09-25T09:05:00Z')],
      manifests: [manifest('2026-09-10T11:00:00Z')],
      weeklyCreated: '2026-09-01T00:00:00Z',
      issues: [open('nightly mutation check')],
    });
    expect(writes(more.gh)).toEqual([`PATCH repos/${REPOSITORY}/issues/31`, `POST repos/${REPOSITORY}/issues/31/comments`]);
  });

  it('closes the issue when everything is fresh again', () => {
    const result = freshness({
      nightly: freshNightly,
      manifests: freshManifest,
      issues: [{ number: 5, body: 'an unrelated issue' }, { number: 31, body: `${MARKER}\n<!-- stale: nightly mutation check -->` }],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(writes(result.gh)).toEqual([`POST repos/${REPOSITORY}/issues/31/comments`, `PATCH repos/${REPOSITORY}/issues/31`]);
    const closing = result.gh.calls().find(call => call.args.includes('PATCH'));
    expect(closing?.args).toContain('state=closed');
  });
});

describe('the freshness workflow reads GitHub and nothing else', () => {
  const workflow = readRepositoryFile(FRESHNESS);

  it('runs twice a day, off the hour, hours after the nightly, and on demand', () => {
    const on = block(workflow, 'on:');
    expect(on).toContain("    - cron: '41 13 * * *'");
    expect(on).toContain("    - cron: '41 21 * * *'");
    expect(on).toContain('  workflow_dispatch:');
  });

  it('holds only actions: read and issues: write, and no cloud credential', () => {
    const job = block(workflow, '  freshness:');
    expect(job).toMatch(/permissions:\n {6}contents: read\n {6}actions: read\n {6}issues: write\n/u);
    expect(job).not.toContain('environment:');
    expect(job).not.toContain('id-token');
    expect(uncommented(workflow)).not.toMatch(/aws |cloudwatch|configure-aws-credentials/u);
    expect(job).toContain('run: infra/scripts/ci-schedule.sh freshness');
    expect(job).toContain("FSS_NIGHTLY_MAX_AGE_HOURS: ${{ vars.FSS_NIGHTLY_MAX_AGE_HOURS || '30' }}");
  });
});

describe('one workflow promotes to production, and only an app-only change', () => {
  it('names release-promote.sh in the release workflow’s credential-free dry run, and with a credential only in the deploy workflow', () => {
    const workflows = readdirSync(repositoryPath('.github/workflows')).filter(name => name.endsWith('.yml'));
    expect(workflows.length).toBeGreaterThanOrEqual(10);
    expect(workflows).toContain('greenfield-deploy.yml');
    for (const name of workflows) {
      const text = uncommented(readRepositoryFile(`.github/workflows/${name}`));
      // Lane g91: David's decision of 25 September 2026 that app-only changes deploy
      // themselves. The one credentialed promotion is that workflow's, as
      // fss-prod-ci-deploy through the production-deploy environment, with --app-only,
      // and only after `ci-deploy-app.sh check` has decided the change is app-only
      // (`test/release/ciDeploy.check.ts` holds the rest of its shape).
      if (name === 'greenfield-deploy.yml') {
        expect(text.match(/release-promote\.sh/gu), name).toHaveLength(1);
        const step = text.slice(text.lastIndexOf('- name:', text.indexOf('release-promote.sh')));
        expect(step.slice(0, step.indexOf('\n      - '))).toContain("if: steps.check.outputs.decision == 'deploy'");
        expect(step).toMatch(/release-promote\.sh "[^"]+" --app-only\n/u);
        expect(text).toContain('    environment: production-deploy');
        expect(text).toContain('role-to-assume: ${{ secrets.FSS_PRODUCTION_CI_ROLE_ARN }}');
        continue;
      }
      if (name !== 'greenfield-release.yml') {
        expect(text, name).not.toContain('release-promote.sh');
        continue;
      }
      const dryRun = text.slice(text.indexOf('\n  dry-run:\n'), text.indexOf('\n  rehearsal:\n'));
      const rest = text.slice(text.indexOf('\n  rehearsal:\n'));
      expect(dryRun).toContain('release-promote.sh');
      expect(rest).not.toContain('release-promote.sh');
      const step = dryRun.slice(dryRun.lastIndexOf('- name:', dryRun.indexOf('release-promote.sh')));
      expect(step.slice(0, step.indexOf('run: |'))).toContain("FSS_REHEARSAL_DRY_RUN: '1'");
    }
  });
});
