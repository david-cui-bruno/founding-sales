import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * The two deployment roles' policies are code, and the Terraform tree is what judges them.
 *
 * David's fourth credentialed rehearsal (Actions run 35628963637, 21 September 2026,
 * `stage = create`) planned cleanly, applied, reported 25 errors in six classes, and then
 * failed its teardown. Every one of the six was an IAM action nothing in this repository
 * had ever compared with the Terraform it was meant to apply, because the policy was
 * prose in a runbook — "may act only on resources whose name begins `fss-rh-`" — and
 * David wrote both roles from that prose.
 *
 * So the policy ships: `infra/policies/deployment-role-policy.json.tftpl` rendered by
 * `infra/scripts/render-deployment-role-policy.sh <prefix>`, and
 * `infra/policies/terraform-resource-actions.json` as the reviewable map from every
 * `resource "aws_*"` type in `infra/modules` and `infra/roots` to the actions Terraform
 * needs for it.
 *
 * ## The vacuous-pass trap
 *
 * Three shapes of nothing, each of which a careless version of this file would report as
 * a pass:
 *
 *   1. **A map that is asserted against itself.** Listing `aws_kms_alias` in the map and
 *      then checking the map mentions `aws_kms_alias` proves nothing. Closed by deriving
 *      the type set from the Terraform files on disk and requiring the map's keys to
 *      equal it exactly — a lane that adds a resource type and forgets the map turns this
 *      red, which is the whole point, and a stale key for a type that has been deleted
 *      turns it red too.
 *   2. **"The policy mentions the action."** A string search would pass against an action
 *      named inside a `Deny`, which is exactly what happened to the eight Secrets Manager
 *      entries: `kms:GenerateDataKey*` was in a blanket deny, so the allow it also had
 *      was worth nothing. Closed by evaluating each action the way IAM does — a matching
 *      `Allow`, and no `Deny` that matches it with `Resource: "*"` and no condition — and
 *      by requiring every type whose actions survive only a *scoped* deny to name that
 *      deny in the map.
 *   3. **A scoping check that accepts everything.** Requiring each statement to "be
 *      scoped" passes trivially if `Resource: "*"` counts. Closed by requiring every
 *      `Allow` to name the namespace in every one of its resource ARNs, or to carry a
 *      condition that names it, or to have its Sid in the map's `unconditional_sids`
 *      with a written reason — which is a list a reviewer reads, not a test that passes.
 *
 * And the floors: the renderer must produce a document with more statements than the
 * number this file asserts about, the tree walk must find more resource types than a
 * handful, and the six error classes of run 35628963637 must each be allowed.
 */

interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Action: string | readonly string[];
  readonly Resource?: string | readonly string[];
  readonly NotResource?: string | readonly string[];
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface PolicyDocument {
  readonly Version: string;
  readonly Statement: readonly PolicyStatement[];
}

interface ResourceEntry {
  readonly service: string;
  readonly scope: 'arn' | 'tag' | 'none';
  readonly actions: readonly string[];
  readonly deny_carve_out?: string;
}

interface ActionGroup {
  readonly name: string;
  readonly roles: readonly string[];
  readonly why: string;
  readonly actions: readonly string[];
}

interface ActionMap {
  readonly unconditional_sids: Readonly<Record<string, string>>;
  readonly terraform_resources: Readonly<Record<string, ResourceEntry>>;
  readonly action_groups: readonly ActionGroup[];
  readonly denied_in_production: Readonly<Record<string, string>>;
  readonly run_35628963637: Readonly<Record<string, readonly string[]>>;
}

const PREFIXES = ['fss-rh', 'fss-prod'] as const;
type Prefix = (typeof PREFIXES)[number];

/** The state key space each namespace owns, which is the other token a statement may be scoped by. */
const STATE_KEY_TOKEN: Record<Prefix, string> = {
  'fss-rh': 'fss/greenfield/rehearsal',
  'fss-prod': 'fss/greenfield/production',
};

function render(prefix: Prefix, mode = '--compact'): PolicyDocument {
  const result = spawnSync(repositoryPath('infra/scripts/render-deployment-role-policy.sh'), [prefix, mode], {
    encoding: 'utf8',
  });
  expect(result.status, `rendering ${prefix}: ${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as PolicyDocument;
}

function actionMap(): ActionMap {
  return JSON.parse(readRepositoryFile('infra/policies/terraform-resource-actions.json')) as ActionMap;
}

function asList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

/** IAM's action glob: `*` matches any run of characters, `?` a single one. */
function actionMatches(pattern: string, action: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.');
  return new RegExp(`^${expression}$`, 'iu').test(action);
}

function statementCovers(statement: PolicyStatement, action: string): boolean {
  return asList(statement.Action).some(pattern => actionMatches(pattern, action));
}

/**
 * How a statement is narrowed: by the ARNs it names, by a condition that names the
 * namespace, or not at all.
 *
 * A resource string with no wildcard in it names exactly one thing and is therefore
 * scoped however it is spelled — that is how the Terraform state KMS key and the lock
 * table qualify. A resource string with a wildcard has to carry one of the namespace
 * tokens. `Resource: "*"` carries neither, so such a statement is scoped only if its
 * condition names the namespace.
 */
function scopeOf(statement: PolicyStatement, tokens: readonly string[]): 'arn' | 'condition' | 'unconditional' {
  const resources = asList(statement.Resource);
  const scopedByArn =
    resources.length > 0 &&
    resources.every(resource => !resource.includes('*') || tokens.some(token => resource.includes(token)));
  if (scopedByArn) return 'arn';
  const condition = statement.Condition === undefined ? '' : JSON.stringify(statement.Condition);
  if (condition !== '' && tokens.some(token => condition.includes(token))) return 'condition';
  return 'unconditional';
}

/** A Deny that applies to every resource with no condition: the action is gone. */
function killedByABlanketDeny(policy: PolicyDocument, action: string): PolicyStatement | undefined {
  return policy.Statement.find(
    statement =>
      statement.Effect === 'Deny' &&
      statementCovers(statement, action) &&
      statement.Condition === undefined &&
      statement.NotResource === undefined &&
      asList(statement.Resource).includes('*'),
  );
}

/** A Deny that applies to this action but is narrowed by a condition or a NotResource. */
function scopedDeniesFor(policy: PolicyDocument, action: string): readonly PolicyStatement[] {
  return policy.Statement.filter(
    statement =>
      statement.Effect === 'Deny' &&
      statementCovers(statement, action) &&
      (statement.Condition !== undefined || statement.NotResource !== undefined),
  );
}

function allowsFor(policy: PolicyDocument, action: string): readonly PolicyStatement[] {
  return policy.Statement.filter(statement => statement.Effect === 'Allow' && statementCovers(statement, action));
}

/** Every `resource "aws_*"` type declared under infra/modules and infra/roots. */
function terraformResourceTypes(): readonly string[] {
  const types = new Set<string>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(repositoryPath(relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        // `tests/` holds tftest harnesses — resources no apply ever creates in the
        // account, so a deployment role needs no permission for them.
        if (entry.name === 'tests') continue;
        walk(child);
        continue;
      }
      if (!entry.name.endsWith('.tf')) continue;
      for (const match of readRepositoryFile(child).matchAll(/^resource\s+"(aws_[a-z0-9_]+)"/gmu)) {
        types.add(match[1] as string);
      }
    }
  };
  walk('infra/modules');
  walk('infra/roots');
  return [...types].sort();
}

describe('the deployment-role policy is code, and the Terraform tree judges it', () => {
  const map = actionMap();
  const rendered: Record<Prefix, PolicyDocument> = {
    'fss-rh': render('fss-rh'),
    'fss-prod': render('fss-prod'),
  };

  it('finds a real Terraform tree, so everything below is about something', () => {
    const types = terraformResourceTypes();
    expect(types.length, 'the walk over infra/ found almost no aws_* resource types').toBeGreaterThan(40);
    expect(types).toContain('aws_vpc_security_group_ingress_rule');
    expect(types).toContain('aws_cloudwatch_composite_alarm');
    expect(types).toContain('aws_kms_alias');
    for (const prefix of PREFIXES) {
      expect(rendered[prefix].Statement.length, `${prefix} rendered almost nothing`).toBeGreaterThan(12);
      expect(rendered[prefix].Version).toBe('2012-10-17');
    }
  });

  it('maps exactly the resource types the tree declares, with no stale key and none missing', () => {
    // The assertion this whole file stands on. A lane that adds a resource type and does
    // not say which actions it needs finds out here rather than in a credentialed run.
    expect(Object.keys(map.terraform_resources).sort()).toEqual([...terraformResourceTypes()]);
  });

  it('names actions, a service and a scope for every type, and no empty entry', () => {
    for (const [type, entry] of Object.entries(map.terraform_resources)) {
      expect(entry.actions.length, `${type} names no action`).toBeGreaterThan(0);
      expect(['arn', 'tag', 'none'], `${type} has an unknown scope`).toContain(entry.scope);
      for (const action of entry.actions) {
        expect(action, `${type} names ${action}, which is not a <service>:<Action>`).toMatch(
          /^[a-z0-9-]+:[A-Za-z0-9*]+$/u,
        );
        expect(action.startsWith(`${entry.service}:`) || ['iam:PassRole', 'kms:CreateGrant', 'kms:DescribeKey', 'kms:GenerateDataKey', 'kms:Decrypt', 'acm:DescribeCertificate'].includes(action), `${type} names ${action} outside its own service without being one of the documented cross-service calls`).toBe(true);
      }
    }
  });

  for (const prefix of PREFIXES) {
    describe(`${prefix}-deploy-scope`, () => {
      const policy = rendered[prefix];
      const tokens = [prefix, STATE_KEY_TOKEN[prefix]];

      it('allows every action every resource type in the tree needs', () => {
        const uncovered: string[] = [];
        for (const [type, entry] of Object.entries(map.terraform_resources)) {
          for (const action of entry.actions) {
            if (allowsFor(policy, action).length === 0) uncovered.push(`${type} needs ${action}`);
          }
        }
        expect(uncovered, `${prefix} has no Allow for these`).toEqual([]);
      });

      it('has no blanket deny that cancels an action the tree needs', () => {
        // The eight Secrets Manager entries, in one assertion. `kms:GenerateDataKey*` was
        // allowed and then denied on every key but the Terraform state key, so
        // `CreateSecret` failed with "Access to KMS is not allowed" while the policy
        // looked, to a reader, as though it permitted it.
        const killed: string[] = [];
        for (const [type, entry] of Object.entries(map.terraform_resources)) {
          for (const action of entry.actions) {
            const deny = killedByABlanketDeny(policy, action);
            if (deny !== undefined) killed.push(`${type} needs ${action}, killed by ${deny.Sid}`);
          }
        }
        expect(killed, `${prefix} denies these outright`).toEqual([]);
      });

      it('makes every type that survives only a scoped deny name that deny in the map', () => {
        const unnamed: string[] = [];
        for (const [type, entry] of Object.entries(map.terraform_resources)) {
          const scoped = new Set<string>();
          for (const action of entry.actions) {
            for (const deny of scopedDeniesFor(policy, action)) scoped.add(deny.Sid);
          }
          if (scoped.size === 0) continue;
          if (entry.deny_carve_out === undefined || !scoped.has(entry.deny_carve_out)) {
            unnamed.push(`${type} is narrowed by ${[...scoped].join(', ')} and names ${String(entry.deny_carve_out)}`);
          }
        }
        expect(unnamed, 'a scoped deny nobody declared is a denial waiting for a credentialed run').toEqual([]);
      });

      it('scopes every Allow by ARN or by a condition, or says in the map why it cannot', () => {
        const unexplained: string[] = [];
        for (const statement of policy.Statement) {
          if (statement.Effect !== 'Allow') continue;
          if (scopeOf(statement, tokens) !== 'unconditional') continue;
          const reason = map.unconditional_sids[statement.Sid];
          if (reason === undefined) unexplained.push(statement.Sid);
        }
        expect(unexplained, 'every unscoped Allow needs an entry in unconditional_sids').toEqual([]);
      });

      it('gives every unscoped Sid a reason long enough to be a reason', () => {
        for (const [sid, reason] of Object.entries(map.unconditional_sids)) {
          expect(reason.length, `${sid}'s reason is a phrase, not a reason`).toBeGreaterThan(80);
        }
        // And the list is not padded with Sids that are in fact scoped: each one must
        // really be a statement this render could not narrow.
        const unconditional = new Set(
          policy.Statement.filter(
            statement => statement.Effect === 'Allow' && scopeOf(statement, tokens) === 'unconditional',
          ).map(statement => statement.Sid),
        );
        for (const sid of Object.keys(map.unconditional_sids)) {
          const statement = policy.Statement.find(candidate => candidate.Sid === sid);
          if (statement === undefined) continue;
          expect(unconditional.has(sid), `${sid} is listed as unscoped and is in fact scoped; remove the excuse`).toBe(
            true,
          );
        }
      });

      it('never names the other namespace anywhere', () => {
        const other = prefix === 'fss-rh' ? 'fss-prod' : 'fss-rh';
        const text = JSON.stringify(policy);
        // `fss-prod` contains no `fss-rh`, and `fss-rh` contains no `fss-prod`, so this
        // is Appendix G 39 read off the policy itself.
        expect(text.includes(other), `${prefix}'s policy names ${other}`).toBe(false);
      });

      it('allows what every stage of the release needs outside Terraform', () => {
        const missing: string[] = [];
        for (const group of map.action_groups) {
          if (!group.roles.includes(prefix)) continue;
          expect(group.why.length, `${group.name} says nothing about why`).toBeGreaterThan(60);
          for (const action of group.actions) {
            if (allowsFor(policy, action).length === 0 || killedByABlanketDeny(policy, action) !== undefined) {
              missing.push(`${group.name} needs ${action}`);
            }
          }
        }
        expect(missing).toEqual([]);
      });

      it('fits inside IAM’s inline-policy limit with room to read', () => {
        const measured = JSON.stringify(policy).replace(/\s/gu, '').length;
        expect(measured, 'IAM measures an inline role policy at 10240 non-white-space characters').toBeLessThan(10_240);
      });
    });
  }

  it('allows every action of run 35628963637 for the role that was refused it', () => {
    // Six classes, twenty-five errors, one credentialed run. The rehearsal role is the
    // one that was refused them, so it is the one asked.
    const stillRefused: string[] = [];
    for (const [error, actions] of Object.entries(map.run_35628963637)) {
      for (const action of actions) {
        const allowed = allowsFor(rendered['fss-rh'], action).length > 0;
        const killed = killedByABlanketDeny(rendered['fss-rh'], action) !== undefined;
        if (!allowed || killed) stillRefused.push(`${action} (${error})`);
      }
    }
    expect(stillRefused).toEqual([]);
    // The floor: the six classes are all there, so a map that lost one would be red.
    expect(Object.keys(map.run_35628963637).length).toBeGreaterThanOrEqual(7);
  });

  it('keeps the three actions production must never hold', () => {
    // docs/greenfield/release.md 1.2: bypass-governance must never be on the production
    // role, or the suppression journal stops being an append-only record and Appendix E
    // step 2 stops being a recovery.
    for (const [action, why] of Object.entries(map.denied_in_production)) {
      expect(why.length, `${action} is listed with no reason`).toBeGreaterThan(40);
      const deny = killedByABlanketDeny(rendered['fss-prod'], action);
      expect(deny, `production still allows ${action}`).toBeDefined();
      // The positive control: the rehearsal role holds the two it needs, so "denied
      // everywhere" is not what makes the assertion above true.
      if (action === 's3:BypassGovernanceRetention' || action === 'secretsmanager:PutSecretValue') {
        expect(allowsFor(rendered['fss-rh'], action).length, `the rehearsal needs ${action}`).toBeGreaterThan(0);
        expect(killedByABlanketDeny(rendered['fss-rh'], action)).toBeUndefined();
      }
    }
    expect(Object.keys(map.denied_in_production)).toContain('s3:BypassGovernanceRetention');
  });

  it('differs between the two roles only in the prefix and the statements named per role', () => {
    // "The prefix as the only difference", checked rather than claimed. Every statement
    // both roles carry must be the production one with the namespace substituted.
    const shared = (policy: PolicyDocument, sids: ReadonlySet<string>): readonly PolicyStatement[] =>
      policy.Statement.filter(statement => sids.has(statement.Sid));
    const rehearsalSids = new Set(rendered['fss-rh'].Statement.map(statement => statement.Sid));
    const productionSids = new Set(rendered['fss-prod'].Statement.map(statement => statement.Sid));
    const common = new Set([...rehearsalSids].filter(sid => productionSids.has(sid)));

    expect(common.size, 'the two roles share almost no statement, which cannot be right').toBeGreaterThan(10);
    const translated = JSON.stringify(shared(rendered['fss-rh'], common))
      .replaceAll('fss-rh', 'fss-prod')
      .replaceAll('fss/greenfield/rehearsal', 'fss/greenfield/production');
    expect(JSON.parse(translated)).toEqual(shared(rendered['fss-prod'], common));

    // And the differences are exactly the ones the renderer names.
    const rehearsalOnly = [...rehearsalSids].filter(sid => !productionSids.has(sid)).sort();
    const productionOnly = [...productionSids].filter(sid => !rehearsalSids.has(sid)).sort();
    expect(rehearsalOnly).toEqual([
      'BypassGovernanceOnRehearsalBucketsOnly',
      'FillThisNamespacesDatabaseEntries',
      'NoDeploymentS3DataAccessOutsideTerraformState',
      'NoDeploymentSecretValueAccessButTheRdsManagedMasterSecret',
      'ReadTheRdsManagedMasterSecretOfThisNamespacesInstance',
      'ThisNamespacesStateDynamoLock',
      'ThisNamespacesStateList',
      'ThisNamespacesStateLockFileCleanup',
      'ThisNamespacesStateObjects',
      'UseTerraformStateKmsKey',
    ]);
    expect(productionOnly).toEqual(['NoDeploymentDataAccess']);
  });

  it('cannot be used to widen the role that holds it', () => {
    // `iam:*` on `role/<prefix>*` matches the deployment role itself, so without this
    // deny either role could write itself a policy granting anything in the account.
    for (const prefix of PREFIXES) {
      const deny = rendered[prefix].Statement.find(
        statement => statement.Sid === 'NoSelfModificationOfTheDeploymentRole',
      );
      expect(deny?.Effect).toBe('Deny');
      expect(asList(deny?.Resource)).toEqual([`arn:aws:iam::326255650484:role/${prefix}-deploy`]);
      expect(statementCovers(deny as PolicyStatement, 'iam:PutRolePolicy')).toBe(true);
    }
  });

  it('attaches only the managed policies the modules actually name', () => {
    // Derived from the tree, so a lane that attaches a third managed policy turns this
    // red rather than discovering the deny in a credentialed run.
    const attached = new Set<string>();
    for (const module of readdirSync(repositoryPath('infra/modules'))) {
      const path = `infra/modules/${module}/main.tf`;
      if (!existsSync(repositoryPath(path))) continue;
      for (const match of readRepositoryFile(path).matchAll(/policy_arn\s*=\s*"(arn:aws:iam::aws:[^"]+)"/gu)) {
        attached.add(match[1] as string);
      }
    }
    expect(attached.size, 'no managed policy attachment was found in the tree at all').toBeGreaterThan(0);
    for (const prefix of PREFIXES) {
      const deny = rendered[prefix].Statement.find(
        statement => statement.Sid === 'NoManagedPolicyButTheOnesTheStackAttaches',
      );
      const permitted = deny?.Condition?.ArnNotEquals?.['iam:PolicyARN'] as readonly string[] | undefined;
      expect([...(permitted ?? [])].sort()).toEqual([...attached].sort());
    }
  });
});

/**
 * The other half of "the deployer can remove what it created": the bucket policy.
 *
 * `infra/modules/journal/tests/object_lock.tftest.hcl` and the two roots'
 * `journal_teardown.tftest.hcl` are the real checks and they read the rendered policy
 * statement by statement — but `terraform test` runs in `infra/scripts/offline-gate.sh`
 * and not in `npm run test:release`, so a mutation of any one of these lines would leave
 * this suite green. Each is a single expression and each is the whole of one half of the
 * fix, which is the same reason scenario 22 asserts two lines of
 * `infra/modules/cluster/main.tf` here as well as in Terraform.
 *
 * ## The vacuous-pass trap
 *
 * Asserting that the module *mentions* `administrative_principal_arns` would pass
 * against a module that took the variable and never used it, and asserting that the
 * rehearsal root passes something would pass against a root passing `[]`. Closed by
 * asserting the merge expressions verbatim on the two denies that had their own
 * condition, the conditional-key expression on the one that did not, the transport
 * deny's absence from all of it, and the two roots' opposite arguments.
 */
describe('the journal deny exempts its deployer, and production keeps its posture', () => {
  const journal = readRepositoryFile('infra/modules/journal/main.tf');

  it('builds the exemption only when the root named somebody', () => {
    expect(journal).toContain(
      'administrative_exemption = length(var.administrative_principal_arns) == 0 ? {} : {',
    );
    expect(journal).toContain('ArnNotEquals = { "aws:PrincipalArn" = var.administrative_principal_arns }');
  });

  it('merges it into the two denies that carry a condition of their own, rather than replacing it', () => {
    // Conditions inside one statement are conjunctive, so a deny carrying both keys
    // fires only for a principal that is neither a writer nor an administrator. A
    // replacement would have opened the journal to everything that is not the deployer.
    expect(journal).toContain(
      'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.writer_principal_patterns } }, local.administrative_exemption)',
    );
    expect(journal).toContain(
      'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }, local.administrative_exemption)',
    );
  });

  it('omits the condition key entirely on the deletion deny when nobody is named', () => {
    // `"Condition": {}` is a statement that claims a condition and has none, and a
    // reader of a production bucket policy should see no exemption rather than an empty
    // one.
    expect(journal).toContain(
      'length(local.administrative_exemption) == 0 ? {} : { Condition = local.administrative_exemption }',
    );
  });

  it('never exempts anybody from the transport deny', () => {
    const transport = journal.slice(journal.indexOf('Sid       = "DenyUnencryptedTransport"'));
    const statement = transport.slice(0, transport.indexOf('Sid       = "DenyAnyDeletionOrLockWeakening"'));
    expect(statement).toContain('Condition = { Bool = { "aws:SecureTransport" = ["false"] } }');
    expect(statement, 'the transport deny must apply to the deployer too').not.toContain('administrative_exemption');
  });

  it('is passed the deployment role by the rehearsal root and nothing by production', () => {
    expect(readRepositoryFile('infra/roots/rehearsal/main.tf')).toContain(
      'journal_administrative_principal_arns = [local.deployment_role_arn]',
    );
    expect(readRepositoryFile('infra/roots/production/main.tf')).toContain(
      'journal_administrative_principal_arns = var.journal_administrative_principal_arns',
    );
    expect(readRepositoryFile('infra/roots/production/variables.tf')).toMatch(
      /variable "journal_administrative_principal_arns"[\s\S]*?default\s*=\s*\[\]/u,
    );
  });

  it('needs the deployment role to hold bypass-governance as well, which only the rehearsal does', () => {
    // Three things have to be true for a destroy to remove an object-locked bucket that
    // holds objects inside their retention: force_destroy, the bucket policy, and
    // s3:BypassGovernanceRetention in IAM. The bucket policy is above; this is the third.
    const rehearsal = render('fss-rh');
    const production = render('fss-prod');
    expect(allowsFor(rehearsal, 's3:BypassGovernanceRetention').length).toBeGreaterThan(0);
    expect(killedByABlanketDeny(production, 's3:BypassGovernanceRetention')).toBeDefined();
    expect(readRepositoryFile('infra/modules/journal/main.tf')).toContain('force_destroy       = var.force_destroy');
  });
});

describe('the renderer refuses what it cannot render', () => {
  const script = repositoryPath('infra/scripts/render-deployment-role-policy.sh');
  const run = (args: readonly string[]): { readonly code: number; readonly output: string } => {
    const result = spawnSync(script, [...args], { encoding: 'utf8' });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  };

  it('refuses a namespace that is not one of the two roles', () => {
    for (const bad of ['', 'fss', 'fss-rh-202609211659', 'fss-prodigy', 'FSS-PROD']) {
      const { code, output } = run([bad]);
      expect(code, `it rendered a policy for '${bad}': ${output}`).toBe(2);
      expect(output).toContain('is not a deployment namespace');
    }
  });

  it('refuses a mode it does not have', () => {
    const { code, output } = run(['fss-rh', '--all']);
    expect(code).toBe(2);
    expect(output).toContain('is not a mode');
  });

  it('carries no commentary into IAM and no unsubstituted placeholder', () => {
    for (const prefix of PREFIXES) {
      const { code, output } = run([prefix]);
      expect(code, output).toBe(0);
      expect(output).not.toContain('Comment');
      expect(output, 'a $ in the output is a placeholder the renderer did not substitute').not.toContain('$');
    }
  });

  it('takes the certificate ARN from the environment rather than shipping it', () => {
    // The exact ARNs are the `rehearsal` environment secret and its production
    // counterpart. A repository that held them would hold a value the workflow
    // deliberately keeps out of it, so the default is a wildcard and this is the override.
    const template = readRepositoryFile('infra/policies/deployment-role-policy.json.tftpl');
    expect(template).not.toMatch(/certificate\/[0-9a-f]{8}-/u);
    const narrowed = spawnSync(script, ['fss-rh'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSS_POLICY_CERTIFICATE_ARN: 'arn:aws:acm:us-east-1:326255650484:certificate/00000000-1111-4222-8333-444444444444',
      },
    });
    expect(narrowed.status, narrowed.stderr).toBe(0);
    expect(narrowed.stdout).toContain('certificate/00000000-1111-4222-8333-444444444444');
    expect(narrowed.stdout).not.toContain('certificate/*');
  });

  it('lists the Sids it emits, with their effect, for both roles', () => {
    const rehearsal = run(['fss-rh', '--sids']);
    const production = run(['fss-prod', '--sids']);
    expect(rehearsal.code).toBe(0);
    expect(production.code).toBe(0);
    expect(rehearsal.output).toContain('Allow  BypassGovernanceOnRehearsalBucketsOnly');
    expect(production.output).not.toContain('BypassGovernanceOnRehearsalBucketsOnly');
    expect(production.output).toContain('Deny   NoDeploymentDataAccess');
  });
});

/**
 * `infra/scripts/check-deployment-role.sh` is the command David runs before an apply.
 *
 * It calls `aws iam simulate-principal-policy`, which this lane has no credential for and
 * must not obtain one for. What is tested here is everything around the call: the
 * argument handling, the plan it prints without making one, and how it reads the answer —
 * including the two answers that must not look like a pass.
 *
 * ## The vacuous-pass trap
 *
 * A checker that exits 0 when the CLI returns nothing is worse than no checker, because
 * it is the one thing an operator will trust just before an apply. Closed by driving the
 * script with three stubs: one that allows everything, one that denies the action the
 * fourth rehearsal was refused, and one that answers with silence.
 */
describe('the read-only check David runs before an apply', () => {
  const script = repositoryPath('infra/scripts/check-deployment-role.sh');

  function stub(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'fss-simulate-'));
    const path = join(directory, 'aws');
    writeFileSync(path, `#!/usr/bin/env bash\nset -uo pipefail\n${body}\nexit 0\n`);
    chmodSync(path, 0o755);
    return path;
  }

  /** Echoes one `<action>\tallowed` line per `--action-names` value, as the CLI's text output does. */
  const ANSWER_EVERY_ACTION = `
collect=0
for word in "$@"; do
  case "$word" in
    --action-names) collect=1; continue ;;
    --*) collect=0; continue ;;
  esac
  if [ "$collect" = 1 ]; then printf '%s\\tDECISION\\n' "$word"; fi
done`;

  function check(
    args: readonly string[],
    options: { readonly aws?: string; readonly dryRun?: boolean } = {},
  ): { readonly code: number; readonly output: string } {
    const environment: Record<string, string> = { ...process.env } as Record<string, string>;
    if (options.aws !== undefined) environment.FSS_CHECK_ROLE_AWS = options.aws;
    if (options.dryRun === true) environment.FSS_CHECK_ROLE_DRY_RUN = '1';
    const result = spawnSync(script, [...args], { encoding: 'utf8', env: environment });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  }

  it('refuses a role that is not one of the two', () => {
    const { code, output } = check(['admin', 'fss-rh']);
    expect(code).toBe(2);
    expect(output).toContain('is not a deployment role');
  });

  it('refuses a role asked about the other namespace, which would report the boundary as a wall of denials', () => {
    for (const pair of [
      ['fss-rh-deploy', 'fss-prod'],
      ['fss-prod-deploy', 'fss-rh'],
    ]) {
      const { code, output } = check(pair);
      expect(code).toBe(2);
      expect(output).toContain('Each role is asked only about its own');
    }
  });

  it('prints the plan and makes no call at all in dry-run mode', () => {
    const exploding = stub('echo "the check made a call in dry-run mode" >&2; exit 9');
    const { code, output } = check(['fss-rh-deploy', 'fss-rh'], { aws: exploding, dryRun: true });
    expect(code, output).toBe(0);
    expect(output).not.toContain('made a call');
    expect(output).toContain('no call was made');
    // Every action of the fourth credentialed run is in the table it prints.
    for (const action of [
      'cloudwatch:PutCompositeAlarm',
      'kms:CreateAlias',
      'kms:GenerateDataKey',
      'ec2:AuthorizeSecurityGroupIngress',
      'ec2:AuthorizeSecurityGroupEgress',
      'cloudfront:CreateOriginAccessControl',
      's3:DeleteBucketPolicy',
      's3:PutBucketObjectLockConfiguration',
    ]) {
      expect(output, `the check never asks about ${action}`).toContain(action);
    }
    // And the sample ARNs are of the namespace it was asked about, never the other one.
    expect(output).not.toContain('fss-prod');
  });

  it('passes and counts when every action is allowed', () => {
    const allowing = stub(ANSWER_EVERY_ACTION.replace('DECISION', 'allowed'));
    const { code, output } = check(['fss-prod-deploy', 'fss-prod'], { aws: allowing });
    expect(code, output).toBe(0);
    expect(output).toMatch(/\d+ action\(s\) evaluated for fss-prod-deploy: \d+ allowed, 0 denied/u);
    expect(output).toContain('allowed cloudwatch:PutCompositeAlarm');
  });

  it('fails and names the action when one is denied', () => {
    const denyingOne = stub(
      ANSWER_EVERY_ACTION.replace(
        "printf '%s\\tDECISION\\n' \"$word\"",
        `case "$word" in
          cloudwatch:PutCompositeAlarm) printf '%s\\timplicitDeny\\n' "$word" ;;
          *) printf '%s\\tallowed\\n' "$word" ;;
        esac`,
      ),
    );
    const { code, output } = check(['fss-rh-deploy', 'fss-rh'], { aws: denyingOne });
    expect(code).toBe(1);
    expect(output).toContain('DENIED  cloudwatch:PutCompositeAlarm (implicitDeny)');
    expect(output).toContain('action(s) the next apply needs are denied');
    expect(output).toContain('render-deployment-role-policy.sh fss-rh');
  });

  it('fails rather than passes when the simulation answers nothing', () => {
    const silent = stub('exit 0');
    const { code, output } = check(['fss-rh-deploy', 'fss-rh'], { aws: silent });
    expect(code).toBe(1);
    expect(output).toContain('returned no evaluation');
    expect(output).toContain('An empty answer is not a pass');
  });

  it('is named in the runbook beside the two put-role-policy commands', () => {
    const runbook = readRepositoryFile('docs/greenfield/infra-apply-runbook.md');
    expect(runbook).toContain(
      'aws iam put-role-policy --role-name fss-rh-deploy --policy-name fss-rh-deploy-scope',
    );
    expect(runbook).toContain(
      'aws iam put-role-policy --role-name fss-prod-deploy --policy-name fss-prod-deploy-scope',
    );
    expect(runbook).toContain('infra/scripts/check-deployment-role.sh fss-rh-deploy fss-rh');
    expect(runbook).toContain('infra/scripts/check-deployment-role.sh fss-prod-deploy fss-prod');
    expect(runbook).toContain('infra/scripts/render-deployment-role-policy.sh');
  });
});
