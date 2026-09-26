import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciGateReleaseRecordSchema, releaseRecordSchema, releaseRecordSource } from '@fss/contracts';
import { repositoryPath } from './support/coverage.ts';

/**
 * Lane g96: the release record the worker needs before it may send comes from the CI
 * gate that was green on the deployed commit (the owner's axiom 10B, 25 September 2026),
 * and `infra/scripts/release-record-from-ci.sh` is what writes it.
 *
 * The script is run for real against a stubbed `gh` placed first on PATH, the way an
 * operator's shell finds the real one. The stub answers `api` for one run and for the
 * images workflow's runs of a commit, in the REST shapes, and `run download`, from a
 * state file, and logs every call. An `aws` stub sits beside it and
 * logs anything that reaches it, so "no AWS call" is a count, not a reading of the code.
 *
 * ## The vacuous-pass traps, named
 *
 * **A record the worker would refuse.** "The script writes a record" is true of JSON the
 * operations task then refuses at the end of a deploy. So every record written here is
 * parsed with the contract `fss admin release-record put` applies, and the fields are
 * compared one by one.
 *
 * **A refusal that refuses everything.** A script that always failed would pass every
 * refusal case. So each refusal starts from the one world the positive control writes a
 * record in and changes exactly one fact — the gate's conclusion, its workflow file, its
 * commit, its event, its repository; the images run's presence, workflow file and
 * conclusion; the artifact's commit and each digest — and each must answer one `FAIL:`
 * line, exit non-zero and leave no file.
 *
 * **A gate known by its name (lane A1).** A second workflow can carry the display name
 * *Greenfield gate* and pass on the same push while the real gate fails. So the run is
 * judged by its `path`, and a green run of another file named *Greenfield gate* is
 * refused, while the real file under another display name is accepted.
 *
 * **Arguments judged after the fact.** A malformed argument is refused before `gh` is
 * asked anything, which the call log shows as zero calls.
 */

const SCRIPT = repositoryPath('infra/scripts/release-record-from-ci.sh');
const REPOSITORY = 'example-owner/example-repo';
const COMMIT = 'c0ffee'.repeat(6) + 'c0ff';
const OTHER_COMMIT = 'beef'.repeat(10);
const GATE_RUN = '41000000001';
const IMAGES_RUN = '41000000002';
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const API = digest('a');
const WORKER = digest('b');

const GH_PROGRAM = `#!/usr/bin/env python3
import json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "state.json")))
args = sys.argv[1:]
with open(os.path.join(here, "calls-gh.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\\n")
def value(flag):
    return args[args.index(flag) + 1] if flag in args else None
if args[:1] == ["api"]:
    endpoint = args[1]
    one = re.fullmatch(r"repos/[^/]+/[^/]+/actions/runs/([0-9]+)", endpoint)
    if one:
        run = (state.get("runs") or {}).get(one.group(1))
        if run is None:
            sys.stderr.write("gh: Not Found (HTTP 404)\\n")
            sys.exit(1)
        print(json.dumps(run))
        sys.exit(0)
    listed = re.fullmatch(r"repos/[^/]+/[^/]+/actions/workflows/greenfield-images\\.yml/runs\\?(.*)", endpoint)
    if listed:
        # GitHub filters by commit on the server; the script filters again.
        query = dict(part.split("=", 1) for part in listed.group(1).split("&"))
        print(json.dumps({"workflow_runs": [run for run in state.get("imagesRuns") or [] if run.get("head_sha") == query.get("head_sha")]}))
        sys.exit(0)
if args[:2] == ["run", "download"]:
    content = (state.get("downloads") or {}).get(args[2])
    if content is None:
        sys.stderr.write("no valid artifacts found to download\\n")
        sys.exit(1)
    directory = value("--dir")
    os.makedirs(directory, exist_ok=True)
    open(os.path.join(directory, "image-digests.json"), "w").write(content)
    sys.exit(0)
sys.stderr.write("the gh stub does not know: " + " ".join(args) + "\\n")
sys.exit(2)
`;

const AWS_PROGRAM = `#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "calls-aws.jsonl"), "a") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\\n")
sys.stderr.write("release-record-from-ci.sh must not call aws\\n")
sys.exit(3)
`;

type Run = Record<string, unknown>;

interface World {
  runs: Record<string, Run>;
  imagesRuns: Run[];
  downloads: Record<string, string>;
}

/** A run as `GET /repos/{owner}/{repo}/actions/runs/{id}` describes it. */
function gateRun(overrides: Run = {}): Run {
  return {
    id: Number(GATE_RUN),
    name: 'Greenfield gate',
    path: '.github/workflows/greenfield.yml',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    head_sha: COMMIT,
    head_branch: 'main',
    head_repository: { full_name: REPOSITORY },
    event: 'push',
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${GATE_RUN}`,
    updated_at: '2026-09-25T21:40:12Z',
    ...overrides,
  };
}

function imagesRun(overrides: Run = {}): Run {
  return {
    id: Number(IMAGES_RUN),
    name: 'Greenfield images',
    path: '.github/workflows/greenfield-images.yml',
    status: 'completed',
    conclusion: 'success',
    head_sha: COMMIT,
    head_branch: 'main',
    head_repository: { full_name: REPOSITORY },
    event: 'push',
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${IMAGES_RUN}`,
    created_at: '2026-09-25T21:31:00Z',
    ...overrides,
  };
}

/** `release-images.sh record`'s shape, as the images run uploads it. */
function imageDigests(overrides: { commit?: string; run?: string; api?: string; worker?: string } = {}): string {
  const commit = overrides.commit ?? COMMIT;
  return JSON.stringify({
    schema: 'fss.image-digests.v1',
    commit,
    workflowRunId: overrides.run ?? IMAGES_RUN,
    workflowRunAttempt: '1',
    recordedAt: '2026-09-25T21:38:00Z',
    images: {
      api: { repository: 'fss-rh-api', tag: `ci-${commit}`, digest: overrides.api ?? API },
      worker: { repository: 'fss-rh-worker', tag: `ci-${commit}`, digest: overrides.worker ?? WORKER },
    },
    imageInputs: ['apps', 'packages'],
  });
}

function greenWorld(): World {
  return {
    runs: { [GATE_RUN]: gateRun() },
    imagesRuns: [
      imagesRun(),
      // A pull-request run of the same commit, which published nothing: passed over.
      imagesRun({ id: 41000000003, event: 'pull_request', head_branch: 'g96/branch', conclusion: 'failure' }),
    ],
    downloads: { [IMAGES_RUN]: imageDigests() },
  };
}

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly gh: readonly (readonly string[])[];
  readonly aws: number;
  readonly out: string;
}

function run(world: World, args: readonly string[], environment: Record<string, string> = {}): Outcome {
  const home = mkdtempSync(join(tmpdir(), 'fss-ci-record-stub-'));
  writeFileSync(join(home, 'gh'), GH_PROGRAM);
  writeFileSync(join(home, 'aws'), AWS_PROGRAM);
  chmodSync(join(home, 'gh'), 0o755);
  chmodSync(join(home, 'aws'), 0o755);
  writeFileSync(join(home, 'state.json'), JSON.stringify(world));
  const out = join(home, 'out', 'release-record.json');
  const inherited = { ...process.env };
  // Actions sets these; each case says what it wants.
  delete inherited['GITHUB_REPOSITORY'];
  delete inherited['FSS_GH_COMMAND'];
  const result = spawnSync('bash', [SCRIPT, ...args.map(arg => (arg === '<out>' ? out : arg))], {
    encoding: 'utf8',
    env: { ...inherited, PATH: `${home}:${process.env['PATH'] ?? ''}`, ...environment },
  });
  const log = (name: string): string[] =>
    existsSync(join(home, `calls-${name}.jsonl`))
      ? readFileSync(join(home, `calls-${name}.jsonl`), 'utf8').split('\n').filter(line => line !== '')
      : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    gh: log('gh').map(line => JSON.parse(line) as string[]),
    aws: log('aws').length,
    out,
  };
}

const GREEN_ARGS = [GATE_RUN, COMMIT, API, WORKER] as const;

function expectRefusal(outcome: Outcome, phrase: string): void {
  expect(outcome.status, outcome.stderr).not.toBe(0);
  const lines = outcome.stderr.split('\n').filter(line => line !== '');
  expect(lines, outcome.stderr).toHaveLength(1);
  expect(lines[0]).toMatch(/^FAIL: /u);
  expect(lines[0]).toContain(phrase);
  expect(outcome.stdout).toBe('');
  expect(existsSync(outcome.out)).toBe(false);
  expect(outcome.aws).toBe(0);
}

describe('release-record-from-ci.sh writes the record from a green gate and its images', () => {
  it('writes a ci-gate record the worker stores, naming the run, the commit and the digests', () => {
    const outcome = run(greenWorld(), GREEN_ARGS);
    expect(outcome.status, outcome.stderr).toBe(0);
    const record = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(record).toEqual({
      schema: 'fss.release-record.v1',
      source: 'ci-gate',
      releaseGateReference: `ci-gate-${GATE_RUN}-${COMMIT.slice(0, 12)}`,
      recordedAt: '2026-09-25T21:40:12Z',
      suite: 'pass',
      commit: COMMIT,
      gateRunId: GATE_RUN,
      gateRunUrl: `https://github.com/${REPOSITORY}/actions/runs/${GATE_RUN}`,
      imagesRunId: IMAGES_RUN,
      artifacts: { api: API, worker: WORKER, desktopCommitStamp: COMMIT },
      enablesSending: false,
    });
    // The contract `fss admin release-record put` applies, both the union and the branch.
    const parsed = releaseRecordSchema.safeParse(record);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) expect(releaseRecordSource(parsed.data)).toBe('ci-gate');
    expect(ciGateReleaseRecordSchema.safeParse(record).success).toBe(true);
    // release-deploy.sh hands the record to the task as base64 and refuses above 6000.
    expect(Buffer.from(outcome.stdout).toString('base64').length).toBeLessThan(6000);
  });

  it('asks GitHub for exactly the gate run, the images runs of that commit and their digests, and never AWS', () => {
    const outcome = run(greenWorld(), GREEN_ARGS, { GITHUB_REPOSITORY: REPOSITORY });
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.aws).toBe(0);
    expect(outcome.gh).toEqual([
      ['api', `repos/${REPOSITORY}/actions/runs/${GATE_RUN}`],
      ['api', `repos/${REPOSITORY}/actions/workflows/greenfield-images.yml/runs?head_sha=${COMMIT}&event=push&branch=main&per_page=20`],
      expect.arrayContaining(['run', 'download', IMAGES_RUN, '--repo', REPOSITORY, '--name', 'fss-image-digests']),
    ]);
    // Without GITHUB_REPOSITORY, gh fills the repository from the checkout's remote.
    const local = run(greenWorld(), GREEN_ARGS);
    expect(local.status, local.stderr).toBe(0);
    expect(local.gh[0]).toEqual(['api', `repos/{owner}/{repo}/actions/runs/${GATE_RUN}`]);
    expect(local.gh[2]).not.toContain('--repo');
  });

  it('says enablesSending only when told to, and writes the same bytes twice to --out', () => {
    const first = run(greenWorld(), [...GREEN_ARGS, '--enables-sending', '--out', '<out>']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe('');
    expect(first.stderr).toContain(`ci-gate-${GATE_RUN}-${COMMIT.slice(0, 12)}`);
    const written = readFileSync(first.out, 'utf8');
    expect(JSON.parse(written)).toMatchObject({ source: 'ci-gate', enablesSending: true });
    expect(releaseRecordSchema.safeParse(JSON.parse(written)).success).toBe(true);

    // recordedAt is the gate's conclusion, not the clock: a rebuild is the same record,
    // so a second put of it is `existing` rather than `release_record_conflict`.
    const second = run(greenWorld(), [...GREEN_ARGS, '--enables-sending', '--out', '<out>']);
    expect(readFileSync(second.out, 'utf8')).toBe(written);
  });
});

describe('release-record-from-ci.sh refuses, in one line, anything that does not match', () => {
  const refuse = (change: (world: World) => void, phrase: string, args: readonly string[] = GREEN_ARGS): void => {
    const world = greenWorld();
    change(world);
    expectRefusal(run(world, [...args, '--out', '<out>']), phrase);
  };

  it('refuses a gate run that has not passed', () => {
    refuse(world => (world.runs[GATE_RUN] = gateRun({ conclusion: 'failure' })), 'not completed/success');
    refuse(world => (world.runs[GATE_RUN] = gateRun({ status: 'in_progress', conclusion: '' })), 'not completed/success');
  });

  it('refuses a green run of another workflow file, even one named Greenfield gate', () => {
    refuse(
      world => (world.runs[GATE_RUN] = gateRun({ path: '.github/workflows/greenfield-images.yml', name: 'Greenfield images' })),
      "not of .github/workflows/greenfield.yml, the Greenfield gate workflow",
    );
    refuse(
      world => (world.runs[GATE_RUN] = gateRun({ path: '.github/workflows/impostor.yml', name: 'Greenfield gate' })),
      "is a run of '.github/workflows/impostor.yml' (named 'Greenfield gate')",
    );
  });

  it('accepts the gate file under another display name, and a path with a ref', () => {
    for (const change of [{ name: 'Renamed gate' }, { path: '.github/workflows/greenfield.yml@refs/heads/main' }]) {
      const world = greenWorld();
      world.runs[GATE_RUN] = gateRun(change);
      const outcome = run(world, GREEN_ARGS);
      expect(outcome.status, outcome.stderr).toBe(0);
    }
  });

  it('refuses a gate run of a fork, or in another repository than the one asked for', () => {
    refuse(world => (world.runs[GATE_RUN] = gateRun({ head_repository: { full_name: 'someone/fork' } })), "built someone/fork's commit");
    const world = greenWorld();
    expectRefusal(run(world, [...GREEN_ARGS, '--out', '<out>'], { GITHUB_REPOSITORY: 'other-owner/other-repo' }), 'not other-owner/other-repo');
  });

  it('refuses a gate run on another commit, or not a push to main', () => {
    refuse(world => (world.runs[GATE_RUN] = gateRun({ head_sha: OTHER_COMMIT })), `ran on ${OTHER_COMMIT}`);
    refuse(
      world => (world.runs[GATE_RUN] = gateRun({ event: 'pull_request', head_branch: 'g96/branch' })),
      'not a push to main',
    );
  });

  it('refuses a gate run GitHub does not have', () => {
    refuse(world => delete world.runs[GATE_RUN], 'gh could not read run');
  });

  it('refuses a commit with no green images run of its own', () => {
    refuse(world => (world.imagesRuns = []), 'no Greenfield images run pushed to main');
    refuse(world => (world.imagesRuns = [imagesRun({ conclusion: 'failure' })]), 'not completed/success');
    refuse(
      world => (world.imagesRuns = [imagesRun({ path: '.github/workflows/impostor.yml' })]),
      'no Greenfield images run pushed to main',
    );
  });

  it('refuses digests the images run did not publish for this commit', () => {
    refuse(world => (world.downloads[IMAGES_RUN] = imageDigests({ api: digest('c') })), 'published the api digest');
    refuse(world => (world.downloads[IMAGES_RUN] = imageDigests({ worker: digest('c') })), 'published the worker digest');
    refuse(world => (world.downloads[IMAGES_RUN] = imageDigests({ commit: OTHER_COMMIT })), `name commit ${OTHER_COMMIT}`);
    refuse(world => delete world.downloads[IMAGES_RUN], 'has no fss-image-digests artifact');
  });

  it('refuses malformed arguments before asking GitHub anything', () => {
    for (const [args, phrase] of [
      [['not-a-run', COMMIT, API, WORKER], 'not a GitHub Actions run id'],
      [[GATE_RUN, COMMIT.slice(0, 12), API, WORKER], 'not a full forty-character commit'],
      [[GATE_RUN, COMMIT, 'latest', WORKER], 'not an image digest'],
      [[GATE_RUN, COMMIT, API, API], 'identical'],
      [[...GREEN_ARGS, '--sending'], "does not take '--sending'"],
    ] as const) {
      const outcome = run(greenWorld(), [...args, '--out', '<out>']);
      expectRefusal(outcome, phrase);
      expect(outcome.gh).toEqual([]);
    }
  });
});
