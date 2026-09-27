import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/repository.ts';

/**
 * Lane G-WIF: `infra/roots/production-google` is planned and applied by
 * `.github/workflows/greenfield-google.yml` and by no human login again (David,
 * 27 September 2026). Two identities, neither a key file: `fss-prod-ci-google` in AWS for
 * the S3 backend, and `fss-prod-google-ci` in Google Cloud through workload identity
 * federation from this repository's `production-deploy` subject.
 *
 * The workflow is read for its shape and **driven** for its three decisions, the way
 * `ciDeploy.check.ts` drives `greenfield-deploy.yml`'s protected-path guard: the
 * pre-credential guard, the two identity assertions (against stub `aws` and `gcloud`), and
 * the apply gate (against a stub `gh` and a prepared artifact). The Terraform the workflow
 * acts as lives in `infra/roots/production-google/tests/ci_identity.tftest.hcl` and
 * `infra/roots/production/tests/ci_google_role.tftest.hcl`; what only a real dispatch can
 * prove — that the exchange is accepted and that the granted read set is enough — is the
 * first `stage=plan` after the bootstrap.
 */

const WORKFLOW = '.github/workflows/greenfield-google.yml';
const workflow = readRepositoryFile(WORKFLOW);

const ROLE_ARN = 'arn:aws:iam::326255650484:role/fss-prod-ci-google';
const SERVICE_ACCOUNT = 'fss-prod-google-ci@callie-fss.iam.gserviceaccount.com';
const PROVIDER = 'projects/405930057974/locations/global/workloadIdentityPools/github/providers/github';
const STATE_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404';
const RUN_ID = '4242424242';
const PLAN_RUN_ID = '1717171717';
const SHA = 'a'.repeat(40);

/** Every credential name the guard refuses before this job holds one of its own. */
const AMBIENT = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CREDENTIALS',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_GHA_CREDS_PATH',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
] as const;

/** A job's steps, each from its `- name:` or `- uses:` line to the next. */
function steps(text: string): readonly { readonly name: string; readonly text: string }[] {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => (/^ {6}- (name|uses):/u.test(line) ? [index] : []));
  return starts.map((start, position) => {
    const body = lines.slice(start, starts[position + 1] ?? lines.length).join('\n');
    const name = /^ {6}- name: (.*)$/mu.exec(body)?.[1] ?? /^ {6}- uses: (.*)$/mu.exec(body)?.[1] ?? '';
    return { name, text: body };
  });
}

/** The `run: |` body of a step, unindented. */
function runBody(step: string): string {
  const at = step.indexOf('run: |');
  if (at < 0) throw new Error('the step has no run block');
  const lines = step
    .slice(at + 'run: |'.length)
    .split('\n')
    .slice(1);
  const end = lines.findIndex(line => line.trim() !== '' && !line.startsWith(' '.repeat(10)));
  return ['', ...(end < 0 ? lines : lines.slice(0, end))].map(line => line.slice(10)).join('\n');
}

const STEPS = steps(workflow);

function body(fragment: string): string {
  const step = STEPS.find(candidate => candidate.name.includes(fragment));
  if (!step) throw new Error(`no step whose name contains ${fragment}`);
  return runBody(step.text);
}

function stepText(fragment: string): string {
  const step = STEPS.find(candidate => candidate.name.includes(fragment));
  if (!step) throw new Error(`no step whose name contains ${fragment}`);
  return step.text;
}

type Run = { readonly code: number; readonly output: string; readonly workspace: string };

/** Run one step's shell with every ambient credential blank, as the runner has it. */
function shell(script: string, env: Readonly<Record<string, string>> = {}, bin?: string): Run {
  const temp = mkdtempSync(join(tmpdir(), 'fss-google-'));
  const workspace = join(temp, 'workspace');
  mkdirSync(join(workspace, 'infra/roots/production-google'), { recursive: true });
  const summary = join(temp, 'summary');
  writeFileSync(summary, '');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    cwd: workspace,
    env: {
      ...process.env,
      ...Object.fromEntries(AMBIENT.map(name => [name, ''])),
      PATH: `${bin ? `${bin}:` : ''}${process.env['PATH'] ?? ''}`,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_REPOSITORY: 'david-cui-bruno/founding-sales',
      GITHUB_WORKSPACE: workspace,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: temp,
      STAGE: 'plan',
      PLAN_RUN_ID: '',
      ROLE_ARN,
      GOOGLE_CI_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
      STATE_KMS_KEY_ARN,
      ...env,
    },
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}`, workspace };
}

function stub(name: string, script: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'fss-google-bin-'));
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  return bin;
}

describe('greenfield-google.yml is dispatch-only, in the production-deploy environment, and pinned', () => {
  it('is 240 lines or fewer, has one job, and can be started only by a dispatch from this repository', () => {
    expect(workflow.split('\n').length).toBeLessThanOrEqual(241);
    const jobs = [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z-]+):\n/gmu)].map(match => match[1]);
    expect(jobs).toEqual(['google-root']);
    const triggers = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));
    expect(triggers).toContain('workflow_dispatch:');
    // A push, a schedule or another workflow's completion would apply production Google
    // Cloud objects with nobody reading the plan.
    for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_run:', 'workflow_call:', 'repository_dispatch:']) {
      expect(triggers, trigger).not.toContain(trigger);
    }
    expect(triggers).toContain('options: [plan, apply]');
    expect(triggers).toContain('default: plan');
  });

  it('runs in production-deploy, holds three permissions, and serialises on one concurrency group', () => {
    expect(workflow).toContain('    environment: production-deploy');
    const permissions = /\n {4}permissions:\n((?: {6}.*\n|\s*#.*\n)+)/u.exec(workflow)?.[1] ?? '';
    // contents and id-token are the plan's two. actions: read is what a cross-run
    // `gh run download` needs, and the review boundary between the two dispatches IS that
    // download: the apply stage reads the plan run's own artifact.
    expect(
      permissions
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#')),
    ).toEqual(['contents: read', 'actions: read', 'id-token: write']);
    expect(workflow).toContain('  group: greenfield-google\n  cancel-in-progress: false');
    expect(workflow).toContain('    timeout-minutes: 30');
  });

  it('pins every action by commit sha, checks out first with no credential, and names one secret', () => {
    const uses = [...workflow.matchAll(/^ {6}- uses: (\S+)$|^ {8}uses: (\S+)$/gmu)].map(match => match[1] ?? match[2] ?? '');
    expect(uses).toEqual([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502',
      'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093',
      'hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ]);
    for (const action of uses) expect(action, action).toMatch(/@[0-9a-f]{40}$/u);
    // The checkout is the first step and carries no token into the job.
    expect(STEPS[0]?.name).toBe('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
    expect(STEPS[0]?.text).toContain('persist-credentials: false');
    expect(STEPS.indexOf(STEPS.find(step => step.name.includes('Refuse any ambient')) ?? STEPS[0]!)).toBe(1);
    expect([...new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map(match => match[1]))]).toEqual([
      'FSS_PRODUCTION_CI_GOOGLE_ROLE_ARN',
    ]);
    // A key file is the one thing this design exists to avoid; a token is never echoed.
    for (const forbidden of ['google_service_account_key', 'credentials_json', 'print-access-token', 'echo "$GOOGLE']) {
      expect(workflow, forbidden).not.toContain(forbidden);
    }
  });

  it('federates with a short-lived token it cleans up, and never uploads a directory', () => {
    const auth = stepText('Federate into Google Cloud');
    expect(auth).toContain(`workload_identity_provider: ${PROVIDER}`);
    expect(auth).toContain(`service_account: ${SERVICE_ACCOUNT}`);
    expect(auth).toContain('create_credentials_file: true');
    expect(auth).toContain('export_environment_variables: true');
    // An access token proves the impersonation before Terraform's first API call.
    expect(auth).toContain('token_format: access_token');
    expect(auth).toContain('cleanup_credentials: true');
    expect(readRepositoryFile('.gitignore')).toContain('gha-creds-*.json');
    // Exactly two paths. A directory would sweep the credential file into the artifact.
    const upload = stepText('Upload exactly the plan');
    expect(upload).toContain('name: google-plan');
    expect(upload).toContain('if-no-files-found: error');
    expect(/ {10}path: \|\n((?: {12}\S+\n)+)/u.exec(upload)?.[1]?.trim().split('\n').map(line => line.trim())).toEqual([
      'infra/roots/production-google/plan.txt',
      'infra/roots/production-google/google.tfplan',
    ]);
  });

  it('initialises the backend read-only against the committed lock and the state key, in both stages', () => {
    expect(workflow).toContain(`      STATE_KMS_KEY_ARN: ${STATE_KMS_KEY_ARN}`);
    for (const stage of ["Plan the Google root", 'Apply that exact saved plan']) {
      const text = stepText(stage);
      expect(text, stage).toContain('working-directory: infra/roots/production-google');
      expect(text, stage).toContain('-lockfile=readonly');
      expect(text, stage).toContain('-backend-config=backend.hcl');
      expect(text, stage).toContain('-backend-config="kms_key_id=$STATE_KMS_KEY_ARN"');
      expect(text, stage).toContain('-input=false');
    }
    expect(body('Plan the Google root')).toContain('terraform plan -input=false -detailed-exitcode -no-color -out=google.tfplan');
    expect(body('Apply that exact saved plan')).toContain('terraform apply -input=false -no-color google.tfplan');
    expect(stepText('Plan the Google root')).toContain("if: inputs.stage == 'plan'");
    for (const stage of ['Upload exactly the plan', 'takes no push object away', 'Apply that exact saved plan']) {
      expect(stepText(stage), stage).toContain(stage === 'Upload exactly the plan' ? "if: inputs.stage == 'plan'" : "if: inputs.stage == 'apply'");
    }
  });
});

describe('the guard refuses an ambient credential, another ref, and an apply with no plan', () => {
  const guard = body('Refuse any ambient');

  it('passes a plan dispatch from main with nothing set', () => {
    const run = shell(guard);
    expect(run.code, run.output).toBe(0);
  });

  it('refuses every AWS and Google credential name, one at a time, before anything is read', () => {
    for (const name of AMBIENT) {
      const run = shell(guard, { [name]: 'set-by-something-else' });
      expect(run.code, name).not.toBe(0);
      expect(run.output, name).toContain(`${name} is set before this job federated`);
      // The refusal never prints what the variable held.
      expect(run.output, name).not.toContain('set-by-something-else');
    }
  });

  it('refuses any ref but main, and a stage that is neither plan nor apply', () => {
    for (const ref of ['refs/heads/feature', 'refs/tags/v1', '']) {
      const run = shell(guard, { GITHUB_REF: ref });
      expect(run.code, ref).not.toBe(0);
      expect(run.output, ref).toContain('this root is planned and applied from main alone');
    }
    for (const stage of ['destroy', 'PLAN', '']) {
      const run = shell(guard, { STAGE: stage });
      expect(run.code, stage).not.toBe(0);
      expect(run.output, stage).toContain('is neither plan nor apply');
    }
  });

  it('refuses an apply that names no plan run, and admits one that names a plausible id', () => {
    for (const id of ['', 'latest', '0', '42; rm -rf /']) {
      const run = shell(guard, { STAGE: 'apply', PLAN_RUN_ID: id });
      expect(run.code, id).not.toBe(0);
      expect(run.output, id).toContain('stage=apply needs plan_run_id');
    }
    expect(shell(guard, { STAGE: 'apply', PLAN_RUN_ID }).code).toBe(0);
  });
});

describe('both identities are asserted rather than assumed', () => {
  const aws = body("this run's session of the state role");
  const google = body('The active Google account');
  const session = (arn: string): string => stub('aws', `echo '${arn}'`);

  it('accepts only this run’s own session of fss-prod-ci-google in the one account', () => {
    const good = `arn:aws:sts::326255650484:assumed-role/fss-prod-ci-google/fss-prod-ci-google-${RUN_ID}`;
    expect(shell(aws, {}, session(good)).code, 'the expected session was refused').toBe(0);
    for (const arn of [
      `arn:aws:sts::326255650484:assumed-role/fss-prod-ci-google/fss-prod-ci-google-999`,
      `arn:aws:sts::326255650484:assumed-role/fss-prod-ci-deploy/fss-prod-ci-deploy-${RUN_ID}`,
      `arn:aws:sts::111122223333:assumed-role/fss-prod-ci-google/fss-prod-ci-google-${RUN_ID}`,
      'arn:aws:iam::326255650484:user/david',
    ]) {
      const run = shell(aws, {}, session(arn));
      expect(run.code, arn).not.toBe(0);
      expect(run.output, arn).toContain("not this run's session of the state role");
    }
  });

  it('refuses a role secret that is not exactly this account’s fss-prod-ci-google', () => {
    const good = `arn:aws:sts::326255650484:assumed-role/fss-prod-ci-google/fss-prod-ci-google-${RUN_ID}`;
    for (const arn of [
      'arn:aws:iam::111122223333:role/fss-prod-ci-google',
      'arn:aws:iam::326255650484:role/fss-prod-ci-deploy',
      'arn:aws:iam::326255650484:role/fss-prod-deploy',
      'arn:aws:iam::326255650484:role/fss-prod-ci-google-admin',
      '',
    ]) {
      const run = shell(aws, { ROLE_ARN: arn }, session(good));
      expect(run.code, arn).not.toBe(0);
      expect(run.output, arn).toContain('is not arn:aws:iam::326255650484:role/fss-prod-ci-google');
    }
  });

  it('requires the active Google account to be the CI service account', () => {
    expect(shell(google, {}, stub('gcloud', `echo '${SERVICE_ACCOUNT}'`)).code).toBe(0);
    for (const account of ['fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com', 'callie@usecallie.com', '']) {
      const run = shell(google, {}, stub('gcloud', `echo '${account}'`));
      expect(run.code, account).not.toBe(0);
      expect(run.output, account).toContain(`not ${SERVICE_ACCOUNT}`);
    }
  });
});

describe('the apply stage applies the plan a person read, at this commit, and no other', () => {
  const gate = body('takes no push object away');
  const PLAN_BODY = [
    'Terraform used the selected providers to generate the following execution plan.',
    '',
    '  # google_project_iam_member.ci["roles/pubsub.admin"] will be created',
    '',
    'Plan: 1 to add, 0 to change, 0 to destroy.',
    '',
  ].join('\n');

  /** A plan run's artifact and the `gh` that serves it. */
  function artifact(options: { plan?: string; head?: string; commit?: string; path?: string; tamper?: boolean } = {}): string {
    const bin = mkdtempSync(join(tmpdir(), 'fss-google-gh-'));
    const store = join(bin, 'artifact');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'google.tfplan'), 'the saved plan, opaque bytes\n');
    const digest = spawnSync('sha256sum', [join(store, 'google.tfplan')], { encoding: 'utf8' }).stdout.split(' ')[0] ?? '';
    writeFileSync(
      join(store, 'plan.txt'),
      `plan-sha256 ${digest}\ncommit ${options.commit ?? SHA}\n${options.plan ?? PLAN_BODY}`,
    );
    if (options.tamper === true) writeFileSync(join(store, 'google.tfplan'), 'a different saved plan\n');
    writeFileSync(
      join(bin, 'run.json'),
      JSON.stringify({ path: options.path ?? '.github/workflows/greenfield-google.yml', head_sha: options.head ?? SHA }),
    );
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `if [ "$1" = api ]; then [ "$3" = --jq ] || exit 9; jq -r "$4" '${join(bin, 'run.json')}'; exit 0; fi`,
        'if [ "$1" = run ] && [ "$2" = download ]; then',
        '  dir=""',
        '  while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2 ;; *) shift ;; esac; done',
        `  mkdir -p "$dir"; cp ${store}/* "$dir/"; exit 0`,
        'fi',
        'exit 9',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    return bin;
  }

  const apply = (options: Parameters<typeof artifact>[0] = {}): Run => shell(gate, { STAGE: 'apply', PLAN_RUN_ID }, artifact(options));

  it('accepts the plan run of this workflow at this commit, and stages that exact file', () => {
    const run = apply();
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain(`applying the plan of run ${PLAN_RUN_ID}`);
    expect(spawnSync('cat', [join(run.workspace, 'infra/roots/production-google/google.tfplan')], { encoding: 'utf8' }).stdout).toBe(
      'the saved plan, opaque bytes\n',
    );
  });

  it('refuses a run of another workflow, another commit, or a plan.txt recording another commit', () => {
    const other = apply({ path: '.github/workflows/greenfield-deploy.yml' });
    expect(other.code).not.toBe(0);
    expect(other.output).toContain('not of this workflow');
    const moved = apply({ head: 'b'.repeat(40) });
    expect(moved.code).not.toBe(0);
    expect(moved.output).toContain('Plan again and read that one');
    const mislabelled = apply({ commit: 'c'.repeat(40) });
    expect(mislabelled.code).not.toBe(0);
    expect(mislabelled.output).toContain('records commit');
  });

  it('refuses an artifact whose saved plan is not the file the digest was taken of', () => {
    const tampered = apply({ tamper: true });
    expect(tampered.code).not.toBe(0);
    expect(tampered.output).toContain('the artifact is not the plan that was read');
  });

  it('refuses any destroy or replacement of a Gmail push object, and only of those', () => {
    for (const line of [
      '  # module.pubsub.google_pubsub_topic.gmail will be destroyed',
      '  # module.pubsub.google_pubsub_subscription.gmail_push must be replaced',
      '  # module.pubsub.google_pubsub_topic_iam_member.gmail_publisher will be replaced, as requested',
      '  # module.pubsub.google_service_account.push is tainted, so must be replaced',
    ]) {
      const run = apply({ plan: `${line}\n\nPlan: 0 to add, 0 to change, 1 to destroy.\n` });
      expect(run.code, line).not.toBe(0);
      expect(run.output, line).toContain('destroys or replaces a Gmail push object');
    }
    // The gate is about the four push objects, not about every destroy: the identity
    // resources are CI's own, and a plan that changed one is refused by Google, not here.
    const ours = apply({
      plan: '  # google_project_iam_member.ci["roles/pubsub.admin"] will be destroyed\n\nPlan: 0 to add, 0 to change, 1 to destroy.\n',
    });
    expect(ours.code, ours.output).toBe(0);
    // A mention of module.pubsub that is neither a destroy nor a replacement passes.
    const created = apply({ plan: '  # module.pubsub.google_pubsub_topic.gmail will be updated in-place\n\nPlan: 0 to add, 1 to change, 0 to destroy.\n' });
    expect(created.code, created.output).toBe(0);
  });
});

describe('the Google root holds no service-account key, and CI cannot mint one', () => {
  it('declares no google_service_account_key resource, and grants no role that could mint one', () => {
    for (const file of ['infra/roots/production-google/ci_identity.tf', 'infra/modules/pubsub/main.tf']) {
      // The file comment names the forbidden resource; a `resource` block of it is what
      // this refuses. A downloaded key is a long-lived credential no rotation reaches.
      expect(readRepositoryFile(file), file).not.toContain('resource "google_service_account_key"');
    }
    // roles/iam.serviceAccountKeyAdmin is the one role that would make one possible.
    expect(readRepositoryFile('infra/roots/production-google/ci_identity.tf')).not.toContain('KeyAdmin');
  });
});
