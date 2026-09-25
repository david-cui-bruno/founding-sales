import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';
import { stepScript } from './support/releaseWorkflow.ts';

/**
 * The tree deploys into whatever AWS account it is pointed at.
 *
 * David decided on 22 September 2026 to move the rehearsal and production out of the
 * shared account `326255650484` — where they are kept apart only by the `fss-rh` and
 * `fss-prod` name prefixes — into two dedicated member accounts under Organizations,
 * before the first production release. `docs/greenfield/accounts.md` is the checklist
 * he performs by hand; this file is what makes the repository able to follow him.
 *
 * Three rules, and this file is all three:
 *
 *   1. no workflow names an account id, a state bucket or a lock table at all;
 *   2. a script under `infra/scripts` may name one only as a **default assignment** or
 *      in a comment documenting that default, so a caller who states an account gets
 *      that account and a caller who states nothing gets today's behaviour;
 *   3. every root reads its account from a variable and its backend from
 *      `-backend-config`, so a `.tf` file never decides which account an apply is in.
 *
 * ## The vacuous-pass trap
 *
 * Everything above is an assertion of **absence**, and the classic way to pass one is
 * to look at nothing: a glob that matched no file, a directory that moved, a scanner
 * whose pattern stopped matching the thing it was written for. Closed three ways —
 * every file list is asserted non-empty and to contain the files by name; the same
 * scanner is required to **find** the account id where it is still allowed (the roots'
 * variable defaults and the two scripts' `${VAR:-…}` lines), so "found none" cannot
 * mean "cannot see it"; and the workflow step that derives the account is extracted
 * and run against a stub, so the cross-check is exercised rather than described.
 */

/** The shared account this tree started in, and the backend that belongs to it. */
const SHARED_ACCOUNT_ID = '326255650484';
const SHARED_STATE_BUCKET = `callie-sourcing-tfstate-${SHARED_ACCOUNT_ID}`;
const SHARED_LOCK_TABLE = 'callie-sourcing-tflock';
const ACCOUNT_SPECIFIC = [SHARED_ACCOUNT_ID, SHARED_STATE_BUCKET, SHARED_LOCK_TABLE] as const;

const ROOTS = ['rehearsal', 'rehearsal-registry', 'production'] as const;

/**
 * Twelve digits standing alone: an AWS account id wherever one appears.
 *
 * Neither side may be a digit, a letter or a hyphen, because a rehearsal run prefix is
 * `fss-rh-<yyyymmddhhmm>` and its twelve-digit stamp is not an account. An account id
 * in this tree is always an ARN field, a registry hostname or an argument, so it is
 * always next to `:`, `.`, whitespace, a quote or the start of a line.
 */
const ACCOUNT_ID_PATTERN = /(?<![0-9A-Za-z-])[0-9]{12}(?![0-9A-Za-z-])/u;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function filesUnder(directory: string, matches: (name: string) => boolean): readonly string[] {
  return readdirSync(repositoryPath(directory))
    .filter(matches)
    .map(name => `${directory}/${name}`)
    .sort();
}

/** Every line of every file that names one of the shared account's values. */
function linesNaming(files: readonly string[], needles: readonly string[]): readonly Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = readRepositoryFile(file).split('\n');
    lines.forEach((text, index) => {
      if (needles.some(needle => text.includes(needle))) hits.push({ file, line: index + 1, text });
    });
  }
  return hits;
}

function describeHits(hits: readonly Hit[]): string {
  return hits.map(hit => `${hit.file}:${String(hit.line)}: ${hit.text.trim()}`).join('\n');
}

/**
 * A line that states a default and nothing else.
 *
 * `VAR=${OTHER:-value}` and `VAR="${OTHER:-value}"` are the shell's own "use what the
 * caller said, or this"; a `#` line is the documentation of one. Anything else naming
 * an account is a decision the file made on the caller's behalf.
 */
function isDefaultAssignmentOrComment(text: string): boolean {
  if (/^\s*#/u.test(text)) return true;
  return /\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}/u.test(text);
}

describe('no workflow decides which AWS account this tree deploys into', () => {
  const workflows = filesUnder('.github/workflows', name => name.endsWith('.yml') || name.endsWith('.yaml'));

  it('reads more than one workflow, and the two that hold a credential by name', () => {
    // The floor. A glob that matched nothing would make every assertion below true.
    expect(workflows.length).toBeGreaterThanOrEqual(5);
    expect(workflows).toContain('.github/workflows/greenfield-release.yml');
    expect(workflows).toContain('.github/workflows/greenfield-rehearsal-registry.yml');
  });

  it('names no account id, no state bucket and no lock table, anywhere', () => {
    const hits = linesNaming(workflows, ACCOUNT_SPECIFIC);
    expect(describeHits(hits), 'a workflow names a value that belongs to one account').toBe('');
  });

  it('names no twelve-digit account id but the documented offline fixture', () => {
    // `123456789012` is AWS's own example account and is what every mock provider,
    // every `terraform test` fixture and the credential-free dry-run job use. It is the
    // one twelve-digit number a workflow may carry, because it names no account at all.
    for (const file of workflows) {
      readRepositoryFile(file)
        .split('\n')
        .forEach((text, index) => {
          const found = ACCOUNT_ID_PATTERN.exec(text)?.[0];
          if (found === undefined) return;
          expect(found, `${file}:${String(index + 1)} names an account id: ${text.trim()}`).toBe('123456789012');
        });
    }
  });

  it('gives the two rehearsal workflows the account of the session they verified', () => {
    for (const file of [
      '.github/workflows/greenfield-release.yml',
      '.github/workflows/greenfield-rehearsal-registry.yml',
    ]) {
      const workflow = readRepositoryFile(file);
      // Derived, not configured: the account is whichever one the OIDC credential
      // belongs to, so moving the rehearsal is a GitHub change and a backend.hcl
      // change and never an edit here.
      expect(workflow, file).toContain('aws sts get-caller-identity --query Account --output text');
      expect(workflow, file).toContain('echo "TF_VAR_aws_account_id=${account}" >> "$GITHUB_ENV"');
      // And a second statement of the same fact, when the repository makes one.
      expect(workflow, file).toContain('vars.FSS_REHEARSAL_ACCOUNT_ID');
      // The region is a repository variable with a default assignment, never a literal
      // standing on its own.
      expect(workflow, file).toContain("AWS_REGION: ${{ vars.FSS_AWS_REGION || 'us-east-1' }}");
    }
  });

  it('takes the registry backend from the per-account file rather than from a copy', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-rehearsal-registry.yml');
    // Two copies of an account-specific value is how they come to disagree, so the
    // bucket and the table are read out of backend.hcl…
    expect(workflow).toContain("grep -E '^bucket ' infra/roots/rehearsal-registry/backend.hcl");
    expect(workflow).toContain("grep -E '^dynamodb_table ' infra/roots/rehearsal-registry/backend.hcl");
    // …and the state key, which names a root rather than an account, is the one
    // backend value the workflow states and checks against the file.
    expect(workflow).toContain('STATE_KEY: fss/greenfield/rehearsal-registry/terraform.tfstate');
    expect(workflow).toContain('grep -qF "key            = \\"${STATE_KEY}\\"" infra/roots/rehearsal-registry/backend.hcl');
    expect(workflow).toContain('vars.FSS_REHEARSAL_STATE_BUCKET');
  });
});

describe('the account step of the rehearsal job, run rather than read', () => {
  const STEP = 'The account this rehearsal is in, from the session that was just verified';

  function runStep(sessionAccount: string, declared: string): { readonly code: number; readonly output: string; readonly written: string } {
    const directory = mkdtempSync(join(tmpdir(), 'fss-account-'));
    const stub = join(directory, 'aws');
    writeFileSync(stub, `#!/usr/bin/env bash\nset -uo pipefail\nprintf '%s\\n' '${sessionAccount}'\nexit 0\n`);
    chmodSync(stub, 0o755);
    const githubEnv = join(directory, 'github.env');
    writeFileSync(githubEnv, '');
    const script = join(directory, 'step.sh');
    writeFileSync(script, stepScript(STEP));
    chmodSync(script, 0o755);
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env['PATH'] ?? ''}`,
        AWS_REGION: 'us-east-1',
        GITHUB_ENV: githubEnv,
        DECLARED_ACCOUNT: declared,
      },
    });
    return {
      code: result.status ?? 1,
      output: `${result.stdout}${result.stderr}`,
      written: readFileSync(githubEnv, 'utf8'),
    };
  }

  it('writes the session’s account as the Terraform variable, whatever account that is', () => {
    // Deliberately not the shared account: the point of the step is that the tree
    // follows the credential rather than a number somebody wrote down.
    const { code, output, written } = runStep('111122223333', '');
    expect(code, output).toBe(0);
    expect(written).toContain('TF_VAR_aws_account_id=111122223333');
    expect(written).toContain('TF_VAR_aws_region=us-east-1');
  });

  it('refuses when the environment declares one account and the session is in another', () => {
    const { code, output, written } = runStep('111122223333', '444455556666');
    expect(code).toBe(1);
    expect(output).toContain('declares account 444455556666');
    expect(output).toContain('111122223333');
    // And nothing is exported, so a later step cannot plan against the wrong account.
    expect(written).not.toContain('TF_VAR_aws_account_id');
  });

  it('accepts a declaration that agrees, which is what a configured repository has', () => {
    const { code, output, written } = runStep('111122223333', '111122223333');
    expect(code, output).toBe(0);
    expect(written).toContain('TF_VAR_aws_account_id=111122223333');
  });
});

describe('a script names an account only as the default a caller can replace', () => {
  const scripts = filesUnder('infra/scripts', name => name.endsWith('.sh'));

  it('reads every script in the directory', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(14);
    expect(scripts).toContain('infra/scripts/render-deployment-role-policy.sh');
    expect(scripts).toContain('infra/scripts/check-deployment-role.sh');
    expect(scripts).toContain('infra/scripts/rehearsal-common.sh');
  });

  it('carries every mention on a default-assignment or comment line', () => {
    const decisions = linesNaming(scripts, ACCOUNT_SPECIFIC).filter(hit => !isDefaultAssignmentOrComment(hit.text));
    expect(describeHits(decisions), 'a script decides an account instead of defaulting to one').toBe('');
  });

  it('is a scanner that can see the thing it is looking for', () => {
    // The closure of the absence trap: if the strings had been renamed, or the files
    // moved, the check above would pass by looking at nothing. These are the lines
    // that are supposed to be there.
    const render = linesNaming(['infra/scripts/render-deployment-role-policy.sh'], ACCOUNT_SPECIFIC);
    const check = linesNaming(['infra/scripts/check-deployment-role.sh'], [SHARED_ACCOUNT_ID]);
    expect(render.length).toBeGreaterThanOrEqual(4);
    expect(check.length).toBeGreaterThanOrEqual(2);
    expect(render.every(hit => isDefaultAssignmentOrComment(hit.text))).toBe(true);
    expect(check.every(hit => isDefaultAssignmentOrComment(hit.text))).toBe(true);
    // And each of the three values really is a default somebody can replace.
    for (const needle of ACCOUNT_SPECIFIC) {
      const assignments = linesNaming(scripts, [needle]).filter(hit => !/^\s*#/u.test(hit.text));
      expect(assignments.length, `${needle} is documented but is not any script's default`).toBeGreaterThanOrEqual(1);
    }
  });

  it('derives the account from the session wherever a session exists', () => {
    // The teardown has to name `<prefix>-suppression-journal-<account id>`, which the
    // journal module builds from the account. It reads it from the identity the
    // caller-identity check verified rather than from a constant, and refuses rather
    // than guessing when there is none (G17).
    const common = readRepositoryFile('infra/scripts/rehearsal-common.sh');
    expect(common).toContain('REHEARSAL_SESSION_ACCOUNT=');
    expect(common).toContain('REHEARSAL_SESSION_ACCOUNT="${identity#arn:*:sts::}"');
    const teardown = readRepositoryFile('infra/scripts/rehearsal-teardown.sh');
    expect(teardown).toContain('JOURNAL_BUCKET="${PREFIX}-suppression-journal-${REHEARSAL_SESSION_ACCOUNT}"');
    // The release scripts do the same on their side.
    const releaseCommon = readRepositoryFile('infra/scripts/release-common.sh');
    expect(releaseCommon).toContain('release_caller_account()');
    expect(readRepositoryFile('infra/scripts/release-deploy.sh')).toContain(
      'ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"',
    );
  });

  it('builds the state key ARN in whatever account it is rendering for', () => {
    const render = readRepositoryFile('infra/scripts/render-deployment-role-policy.sh');
    // The key *id* is a per-account value with a documented default; the ARN around it
    // is assembled from the account and region being rendered, so a render for another
    // account cannot emit the shared account's ARN.
    expect(render).toContain('FSS_POLICY_STATE_KMS_KEY_ID="${FSS_POLICY_STATE_KMS_KEY_ID:-a321a083-4058-4130-b060-b950e4aa1404}"');
    expect(render).toContain('or f"arn:aws:kms:{region}:{account}:key/{env[\'FSS_POLICY_STATE_KMS_KEY_ID\']}"');
    expect(render).not.toContain('key/a321a083-4058-4130-b060-b950e4aa1404"');
  });

  it('refuses an account id that is not twelve digits before it simulates anything', () => {
    const result = spawnSync(repositoryPath('infra/scripts/check-deployment-role.sh'), ['fss-rh-deploy', 'fss-rh'], {
      encoding: 'utf8',
      env: { ...process.env, FSS_CHECK_ROLE_ACCOUNT_ID: 'my-account', FSS_CHECK_ROLE_DRY_RUN: '1' },
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('an AWS account id is twelve digits');
  });

  it('renders the same document as before when nobody states an account', () => {
    // The whole promise of this lane: parameterised, and unchanged by default.
    const rendered = spawnSync(repositoryPath('infra/scripts/render-deployment-role-policy.sh'), ['fss-rh', '--compact'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    expect(rendered.status, rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain(`arn:aws:iam::${SHARED_ACCOUNT_ID}:role/fss-rh-deploy`);
    expect(rendered.stdout).toContain(`arn:aws:s3:::${SHARED_STATE_BUCKET}`);
    expect(rendered.stdout).toContain('key/a321a083-4058-4130-b060-b950e4aa1404');

    // And a different account renders that account, with no shared value left in it.
    const elsewhere = spawnSync(repositoryPath('infra/scripts/render-deployment-role-policy.sh'), ['fss-rh', '--compact'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSS_POLICY_ACCOUNT_ID: '111122223333',
        FSS_POLICY_STATE_BUCKET: 'callie-tfstate-111122223333',
        FSS_POLICY_LOCK_TABLE: 'callie-tflock',
        FSS_POLICY_STATE_KMS_KEY_ID: '00000000-1111-4222-8333-444444444444',
      },
    });
    expect(elsewhere.status, elsewhere.stderr).toBe(0);
    expect(elsewhere.stdout).toContain('arn:aws:iam::111122223333:role/fss-rh-deploy');
    expect(elsewhere.stdout).toContain('arn:aws:s3:::callie-tfstate-111122223333');
    expect(elsewhere.stdout).toContain('key/00000000-1111-4222-8333-444444444444');
    for (const shared of ACCOUNT_SPECIFIC) {
      expect(elsewhere.stdout, `a render for another account still names ${shared}`).not.toContain(shared);
    }
  });
});

describe('every root reads its account from a variable and its backend from a file', () => {
  it('takes the account as a variable, validates it, and builds every ARN from it', () => {
    for (const root of ROOTS) {
      const variables = readRepositoryFile(`infra/roots/${root}/variables.tf`);
      const providers = readRepositoryFile(`infra/roots/${root}/providers.tf`);

      expect(variables, root).toContain('variable "aws_account_id"');
      expect(variables, root).toContain('variable "aws_region"');
      // Twelve digits, refused before a provider is configured: a typo in a tfvars
      // file is otherwise an `allowed_account_ids` mismatch four modules away.
      expect(variables, root).toContain('can(regex("^[0-9]{12}$", var.aws_account_id))');
      // Defaults, so a caller who states nothing gets today's account.
      expect(variables, root).toMatch(/variable "aws_account_id"[\s\S]*?default {5}= "326255650484"/u);

      // And the provider follows the variable, never a literal.
      expect(providers, root).toContain('region              = var.aws_region');
      expect(providers, root).toContain('allowed_account_ids = [var.aws_account_id]');
      expect(providers, root).toContain(
        'role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"',
      );
      expect(ACCOUNT_ID_PATTERN.test(providers), `${root}/providers.tf names an account id`).toBe(false);
    }
  });

  it('names an account id in no Terraform file but a variable default', () => {
    const offenders: Hit[] = [];
    for (const area of ['infra/modules', 'infra/roots']) {
      for (const entry of readdirSync(repositoryPath(area))) {
        for (const name of readdirSync(repositoryPath(`${area}/${entry}`))) {
          if (!name.endsWith('.tf')) continue;
          const file = `${area}/${entry}/${name}`;
          readRepositoryFile(file)
            .split('\n')
            .forEach((text, index) => {
              if (!ACCOUNT_ID_PATTERN.test(text)) return;
              if (/^\s*default\s+=/u.test(text)) return;
              offenders.push({ file, line: index + 1, text });
            });
        }
      }
    }
    expect(describeHits(offenders), 'a Terraform file decides which account an apply is in').toBe('');
  });

  it('declares no backend in code, so the backend is an argument', () => {
    for (const root of ROOTS) {
      for (const name of readdirSync(repositoryPath(`infra/roots/${root}`))) {
        if (!name.endsWith('.tf')) continue;
        const text = readRepositoryFile(`infra/roots/${root}/${name}`);
        // A literal `backend "s3" { bucket = … }` would pin the account in code. The
        // roots declare the backend with no arguments at all and take every one of
        // them from `-backend-config`.
        expect(text, `${root}/${name}`).not.toMatch(/backend\s+"s3"\s*\{[^}]*bucket/u);
      }
    }
  });

  it('gives every root a per-account backend file that names all four values', () => {
    for (const root of ROOTS) {
      const backend = readRepositoryFile(`infra/roots/${root}/backend.hcl`);
      for (const setting of ['bucket', 'key', 'region', 'dynamodb_table']) {
        expect(backend, `${root}/backend.hcl names no ${setting}`).toMatch(new RegExp(`^${setting} +=`, 'mu'));
      }
    }
  });

  it('has the offline gate check both of those without a credential', () => {
    const scan = "account_literals=$(grep -rInE '[0-9]{12}' --include='*.tf' infra/modules infra/roots";
    const gate = readRepositoryFile('infra/scripts/offline-gate.sh');
    expect(gate).toContain(scan);
    expect(gate).toContain('for backend_setting in bucket region dynamodb_table key; do');
    // The workflow runs the same two, because CI is where a pull request is judged.
    const infra = readRepositoryFile('.github/workflows/greenfield-infra.yml');
    expect(infra).toContain(scan);
    expect(infra).toContain('for backend_setting in bucket region dynamodb_table key; do');
  });
});

describe('the per-account checklist the owner performs by hand', () => {
  const document = 'docs/greenfield/accounts.md';

  it('pins the OIDC subject exactly, with no wildcard', () => {
    const text = readRepositoryFile(document);
    expect(text).toContain(
      '"token.actions.githubusercontent.com:sub": "repo:david-cui-bruno/founding-sales:environment:rehearsal"',
    );
    // `StringLike` on the subject, or a `*` in it, admits every branch of every pull
    // request and is the whole boundary gone. The condition operator is asserted as
    // the JSON key it would be, so the prose warning against it is not the thing found.
    expect(text).not.toContain('"StringLike"');
    expect(text).not.toContain(
      '"token.actions.githubusercontent.com:sub": "repo:david-cui-bruno/founding-sales:*"',
    );
    expect(text).toContain('"StringEquals": {');
  });

  it('names the eight production secret entries, created empty', () => {
    const text = readRepositoryFile(document);
    // Derived from the module rather than repeated from memory: a lane that adds a
    // ninth entry has to add it to the checklist too.
    const defaults = readRepositoryFile('infra/modules/secrets/variables.tf');
    const block = defaults.slice(defaults.indexOf('default = ['), defaults.indexOf(']', defaults.indexOf('default = [')));
    const names = [...block.matchAll(/"([a-z][a-z0-9-]+)"/gu)].map(match => match[1] as string);
    expect(names.length).toBe(8);
    for (const name of names) expect(text, `${document} does not name the secret entry ${name}`).toContain(name);
  });
});
