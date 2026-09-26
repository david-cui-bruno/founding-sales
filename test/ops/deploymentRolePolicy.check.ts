import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

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
 * `infra/scripts/policy.sh render <prefix>` (P7; the old name render-deployment-role-policy.sh execs it), and
 * `infra/policies/terraform-resource-actions.json` as the reviewable map from every AWS
 * service the tree creates resources in to the `Deny` statements that narrow what the
 * role may do in it, per role.
 *
 * Until 27 September 2026 that map was per resource type, with the actions each needs:
 * 47 entries and 562 lines, a second copy of the policy kept by hand. The check is the
 * same at service granularity, and one thing is knowingly given up: a lane that adds a
 * resource type inside a service already named there no longer turns this red. The
 * rehearsal's own deployment-role policy — the exact one production gets — is what
 * catches a missing action for it, one credentialed run before production.
 *
 * ## The vacuous-pass trap
 *
 * Four shapes of nothing, each of which a careless version of this file would report as
 * a pass:
 *
 *   1. **A map that is asserted against itself.** Listing `kms` in the map and then
 *      checking the map mentions `kms` proves nothing. Closed by deriving each resource
 *      type's service from the Terraform files on disk and requiring the map's keys to
 *      equal that set exactly — a lane that reaches into a new service and forgets the
 *      map turns this red, and a stale key for a service nothing creates any more turns
 *      it red too.
 *   2. **A service name that is not a service.** The derivation guesses `aws_<service>_`
 *      for everything the table below does not name, so a wrong guess would put a key in
 *      the map that no policy could ever contradict. Closed by requiring every service in
 *      the map to have an `Allow` of its own in both renders.
 *   3. **"The policy mentions the action."** A string search would pass against an action
 *      named inside a `Deny`, which is exactly what happened to the eight Secrets Manager
 *      entries: `kms:GenerateDataKey*` was in a blanket deny, so the allow it also had
 *      was worth nothing. Closed by replaying both credentialed runs' own refusals
 *      through IAM's rules — a matching `Allow`, and no `Deny` that matches it with
 *      `Resource: "*"` and no condition — and by comparing the `Deny` statements that
 *      narrow each service with the map's list for that role, equal in both directions,
 *      so a new deny over any service is red until a reviewer writes it down.
 *   4. **A scoping check that accepts everything.** Requiring each statement to "be
 *      scoped" passes trivially if `Resource: "*"` counts. Closed by requiring every
 *      `Allow` to name the namespace in every one of its resource ARNs, or to carry a
 *      condition that names it, or to have its Sid in the map's `unconditional_sids`
 *      with a written reason — which is a list a reviewer reads, not a test that passes.
 *
 * And the floors: the renderer must produce a document with more statements than the
 * number this file asserts about, and the tree walk must find more resource types than a
 * handful.
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

interface ActionGroup {
  readonly name: string;
  readonly roles: readonly string[];
  readonly why: string;
  readonly actions: readonly string[];
}

interface ActionMap {
  readonly unconditional_sids: Readonly<Record<string, string>>;
  readonly services: Readonly<Record<string, Readonly<Record<Prefix, readonly string[]>>>>;
  readonly action_groups: readonly ActionGroup[];
  readonly denied_in_production: Readonly<Record<string, string>>;
  readonly run_35628963637: Readonly<Record<string, readonly string[]>>;
  readonly run_35679472666: Readonly<Record<string, readonly string[]>>;
}

const PREFIXES = ['fss-rh', 'fss-prod'] as const;
type Prefix = (typeof PREFIXES)[number];

/** The state key space each namespace owns, which is the other token a statement may be scoped by. */
const STATE_KEY_TOKEN: Record<Prefix, string> = {
  'fss-rh': 'fss/greenfield/rehearsal',
  'fss-prod': 'fss/greenfield/production',
};

function render(prefix: Prefix, mode = '--compact'): PolicyDocument {
  const result = spawnSync(repositoryPath('infra/scripts/policy.sh'), ['render', prefix, mode], {
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

function allowsFor(policy: PolicyDocument, action: string): readonly PolicyStatement[] {
  return policy.Statement.filter(statement => statement.Effect === 'Allow' && statementCovers(statement, action));
}

/**
 * The AWS service a resource type belongs to. `aws_<service>_<thing>` is the rule; the
 * table holds the names where the provider's prefix is not the service's — the load
 * balancer, the database, the network types EC2 owns, and CloudWatch Logs, which IAM
 * calls `logs` and not `cloudwatch`. It reproduces all 47 mappings the per-type
 * inventory carried by hand until 27 September 2026.
 */
const SERVICE_OF_PREFIX: readonly (readonly [string, string])[] = [
  ['lb', 'elasticloadbalancing'],
  ['db_', 'rds'],
  ['vpc', 'ec2'],
  ['subnet', 'ec2'],
  ['route', 'ec2'],
  ['internet_gateway', 'ec2'],
  ['security_group', 'ec2'],
  ['default_security_group', 'ec2'],
  ['cloudwatch_log', 'logs'],
];

function serviceOf(type: string): string {
  const rest = type.slice('aws_'.length);
  for (const [prefix, service] of SERVICE_OF_PREFIX) if (rest.startsWith(prefix)) return service;
  return rest.split('_')[0] as string;
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

  it('names exactly the services the tree creates resources in, with no stale key and none missing', () => {
    // The assertion this whole file stands on. A lane that reaches into a service the
    // deployment role has never held finds out here rather than in a credentialed run.
    expect(Object.keys(map.services).sort()).toEqual([...new Set(terraformResourceTypes().map(serviceOf))].sort());
  });

  for (const prefix of PREFIXES) {
    describe(`${prefix}-deploy-scope`, () => {
      const policy = rendered[prefix];
      const tokens = [prefix, STATE_KEY_TOKEN[prefix]];

      it('holds an Allow of its own in every service the tree creates resources in', () => {
        // Which is also what stops the service derivation from inventing a key: `lb` is
        // not an IAM service, so a map that carried it would have no Allow to point at.
        const silent = Object.keys(map.services).filter(
          service =>
            !policy.Statement.some(
              statement =>
                statement.Effect === 'Allow' && asList(statement.Action).some(action => action.startsWith(`${service}:`)),
            ),
        );
        expect(silent, `${prefix} allows nothing at all in these services`).toEqual([]);
      });

      it('still allows what both credentialed runs were refused, and denies none of it outright', () => {
        // The six error classes of run 35628963637 and the one of 35679472666, replayed.
        // `kms:GenerateDataKey*` was allowed and then denied on every key but the
        // Terraform state key, so `CreateSecret` failed with "Access to KMS is not
        // allowed" while the policy looked, to a reader, as though it permitted it.
        const failing: string[] = [];
        for (const [failure, actions] of [
          ...Object.entries(map.run_35628963637),
          ...Object.entries(map.run_35679472666),
        ]) {
          for (const action of actions) {
            // The two the production role is meant not to hold; `denied_in_production`
            // is asserted separately, with the rehearsal as its positive control.
            if (prefix === 'fss-prod' && action in map.denied_in_production) continue;
            if (allowsFor(policy, action).length === 0) failing.push(`${failure}: no Allow for ${action}`);
            const deny = killedByABlanketDeny(policy, action);
            if (deny !== undefined) failing.push(`${failure}: ${action} killed by ${deny.Sid}`);
          }
        }
        expect(failing, `${prefix} would be refused these again`).toEqual([]);
      });

      it('names exactly the denies that narrow each service, per role', () => {
        // Equal in both directions: a deny nobody declared is a denial waiting for a
        // credentialed run, and a declared one the render no longer emits is a reader
        // being told the role is narrower than it is. An empty list is an assertion.
        const observed = Object.fromEntries(
          Object.keys(map.services).map(service => [
            service,
            policy.Statement.filter(
              statement =>
                statement.Effect === 'Deny' &&
                asList(statement.Action).some(action => action === '*' || action.split(':')[0] === service),
            )
              .map(statement => statement.Sid)
              .sort(),
          ]),
        );
        const declared = Object.fromEntries(
          Object.entries(map.services).map(([service, byRole]) => [service, [...byRole[prefix]].sort()]),
        );
        expect(observed).toEqual(declared);
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

      it('lets RDS create the managed master secret of this namespace, tagged with the instance ARN, and no other rds! secret', () => {
        // Run 35679472666 (22 September): CreateDBInstance answered "The user isn't
        // authorized to create a secret in AWS Secrets Manager". RDS creates the master
        // secret `rds!db-<uuid>` in the caller's own session, and the only secrets the role
        // could create were the namespace's own, by name. The statement that fixes it is
        // narrowed by the one tag RDS puts on the request, whose value is the instance ARN
        // and therefore carries the namespace; no caller but a service can set an `aws:` tag.
        const creators = allowsFor(policy, 'secretsmanager:CreateSecret').filter(statement =>
          asList(statement.Resource).some(resource => resource.includes(':secret:rds!db-')),
        );
        expect(creators.map(statement => statement.Sid)).toEqual(['LetRdsCreateThisNamespacesManagedMasterSecret']);
        const statement = creators[0]!;
        expect(statementCovers(statement, 'secretsmanager:TagResource')).toBe(true);
        expect(asList(statement.Action)).toHaveLength(2);
        const like = statement.Condition?.['StringLike'] as Record<string, string> | undefined;
        expect(like?.['aws:RequestTag/aws:rds:primaryDBInstanceArn']).toMatch(
          new RegExp(`^arn:aws:rds:[a-z0-9-]+:\\d{12}:db:${prefix}\\*$`, 'u'),
        );
        for (const action of ['secretsmanager:CreateSecret', 'secretsmanager:TagResource']) {
          expect(killedByABlanketDeny(policy, action), `${prefix} denies ${action} outright`).toBeUndefined();
        }
        // The value of that secret stays out of reach of the production role, as before.
        if (prefix === 'fss-prod') {
          expect(killedByABlanketDeny(policy, 'secretsmanager:GetSecretValue')).toBeDefined();
        }
      });

      it('reads the master secret, and denies every other value read, by the global tag key', () => {
        // Step 0 at 01968250 (22 September): the check's first simulation of the read
        // statement was an implicit deny under `secretsmanager:ResourceTag/aws:rds:...`
        // while the creation rows under `aws:RequestTag/aws:rds:...` were allowed. Secrets
        // Manager honours both keys on DescribeSecret and GetSecretValue (the service
        // reference lists both), so the policy uses the one the simulator evaluates.
        const key = 'aws:ResourceTag/aws:rds:primaryDBInstanceArn';
        const read = policy.Statement.find(s => s.Sid === 'ReadTheRdsManagedMasterSecretOfThisNamespacesInstance');
        const deny = policy.Statement.find(s => s.Sid === 'NoDeploymentSecretValueAccessButTheRdsManagedMasterSecret');
        if (prefix === 'fss-rh') {
          // The rehearsal reads the one tagged secret and carves it out of its value-read deny.
          expect(read?.Condition?.['StringLike']?.[key]).toMatch(new RegExp(`:db:${prefix}\\*$`, 'u'));
          expect(deny?.Condition?.['StringNotLike']?.[key]).toMatch(new RegExp(`:db:${prefix}\\*$`, 'u'));
        } else {
          // Production holds neither statement: it keeps the blanket deny and reads no secret.
          expect(read).toBeUndefined();
          expect(deny).toBeUndefined();
          expect(killedByABlanketDeny(policy, 'secretsmanager:GetSecretValue')?.Sid).toBe('NoDeploymentDataAccess');
        }
        expect(JSON.stringify(policy)).not.toContain('secretsmanager:ResourceTag/');
      });

      it('fits inside IAM’s inline-policy limit with room to read', () => {
        const measured = JSON.stringify(policy).replace(/\s/gu, '').length;
        expect(measured, 'IAM measures an inline role policy at 10240 non-white-space characters').toBeLessThan(10_240);
      });
    });
  }

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
      const permitted = deny?.Condition?.['ArnNotEquals']?.['iam:PolicyARN'] as readonly string[] | undefined;
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
 * and not in `npm run test:ops`, so a mutation of any one of these lines would leave
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

  it('splits the reads deny so that seeing the bucket is not reading it', () => {
    // 23 September 2026: `fss-prod-deploy` created the bucket and was then refused its own
    // `HeadBucket`, which S3 authorises as `s3:ListBucket`. The AWS provider reads a 403
    // there as "the bucket is gone", so the next plan dropped `aws_s3_bucket.journal` from
    // state and proposed to create it again; applying that plan deleted the
    // server-side-encryption configuration and the ownership controls before the policy
    // and the object lock refused to go.
    expect(journal).toContain('Sid       = "DenyObjectReadsFromAnyoneButTheTaskRoles"');
    expect(journal).toContain('Sid       = "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer"');

    const reads = journal.slice(journal.indexOf('Sid       = "DenyObjectReadsFromAnyoneButTheTaskRoles"'));
    const objectReads = reads.slice(0, reads.indexOf('Sid       = "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer"'));
    expect(objectReads).toContain('Action    = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucketVersions"]');
    expect(objectReads, 'a listing action left in the object-reads deny would refuse HeadBucket again').not.toContain(
      's3:ListBucket"',
    );

    // Listing is a bucket-level action: `arn:aws:s3:::bucket/*` is not a resource
    // `s3:ListBucket` is ever evaluated against.
    const listing = reads.slice(reads.indexOf('Sid       = "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer"'));
    expect(listing).toContain('Action    = ["s3:ListBucket"]');
    expect(listing).toContain('Resource  = [aws_s3_bucket.journal.arn]');
    expect(listing).toContain(
      'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }, local.listing_exemption)',
    );
  });

  it('builds one ArnNotEquals for the listing deny out of both lists', () => {
    // Two exemptions, one condition key. `merge` of two maps that both carry
    // `ArnNotEquals` keeps the last and drops the other without saying so, so the two
    // lists are combined before the condition is built.
    expect(journal).toContain(
      'listing_deny_exempt_arns = distinct(concat(var.administrative_principal_arns, var.bucket_listing_principal_arns))',
    );
    expect(journal).toContain('listing_exemption = length(local.listing_deny_exempt_arns) == 0 ? {} : {');
    expect(journal).toContain('ArnNotEquals = { "aws:PrincipalArn" = local.listing_deny_exempt_arns }');
  });

  it('still denies the production deployer every object in the journal', () => {
    // Listing is not reading, in the bucket policy and in IAM both.
    const production = render('fss-prod');
    expect(killedByABlanketDeny(production, 's3:GetObject')).toBeDefined();

    // And the other half of the fix: the bucket policy letting the deployer list is
    // worth nothing unless IAM allows the action too. `NoDeploymentDataAccess` denies
    // `s3:GetObject*` and says nothing about listing.
    expect(allowsFor(production, 's3:ListBucket').length).toBeGreaterThan(0);
    expect(killedByABlanketDeny(production, 's3:ListBucket')).toBeUndefined();
    expect(journal).toContain(
      'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }, local.administrative_exemption)',
    );
  });

});

describe('the renderer refuses what it cannot render', () => {
  const script = repositoryPath('infra/scripts/policy.sh');
  const run = (args: readonly string[]): { readonly code: number; readonly output: string } => {
    const result = spawnSync(script, ['render', ...args], { encoding: 'utf8' });
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
    const narrowed = spawnSync(script, ['render', 'fss-rh'], {
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
 * `infra/scripts/policy.sh check` (P7; the old name check-deployment-role.sh execs it) is the command David runs before an apply.
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
  const script = repositoryPath('infra/scripts/policy.sh');

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
    if (options.aws !== undefined) environment['FSS_CHECK_ROLE_AWS'] = options.aws;
    if (options.dryRun === true) environment['FSS_CHECK_ROLE_DRY_RUN'] = '1';
    const result = spawnSync(script, ['check', ...args], { encoding: 'utf8', env: environment });
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
    // The groups whose actions take no resource pass no `--resource-arns` rather than
    // the literal `*`: the parameter documents its own default as every resource and
    // does not document `*` as a legal element, and finding that out from the CLI in
    // front of an apply is what this command exists to avoid.
    expect(output).toContain('with no --resource-arns, because these actions take no resource');
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
    expect(output).toContain('policy.sh put fss-rh');
  });

  it('simulates one action per call, each against the resource it is really authorized on', () => {
    // The first real run of this check (21 September) taught three things: AWS refuses to
    // simulate, in one call, actions that need different authorization information
    // (a distribution creation beside GetDistribution → InvalidInput); ec2:CreateRoute
    // judged against a VPC ARN is an implicit deny because its resource is the route
    // table; and kms:CreateKey takes no resource at all. A stub records every call.
    const recording = mkdtempSync(join(tmpdir(), 'fss-simulate-calls-'));
    const record = stub(
      `printf '%s\\n' "$*" >> "${join(recording, 'calls.txt')}"\n${ANSWER_EVERY_ACTION.replace('DECISION', 'allowed')}`,
    );
    const { code, output } = check(['fss-rh-deploy', 'fss-rh'], { aws: record });
    expect(code, output).toBe(0);
    const calls = readFileSync(join(recording, 'calls.txt'), 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(80);
    const actionsOf = (call: string): string[] => {
      const words = call.split(' ');
      const at = words.indexOf('--action-names');
      const names: string[] = [];
      for (let i = at + 1; i < words.length && !words[i]!.startsWith('--'); i += 1) names.push(words[i]!);
      return names;
    };
    for (const call of calls) {
      expect(actionsOf(call), `a call carried more than one action: ${call}`).toHaveLength(1);
    }
    const callFor = (action: string): string => {
      const found = calls.find(call => actionsOf(call)[0] === action);
      expect(found, `no call simulated ${action}`).toBeDefined();
      return found ?? '';
    };
    expect(callFor('ec2:CreateRoute')).toContain(':route-table/');
    expect(callFor('ec2:CreateRoute')).not.toContain(':vpc/');
    expect(callFor('ec2:AssociateRouteTable')).toContain(':route-table/');
    expect(callFor('kms:CreateKey')).not.toContain('--resource-arns');
    expect(callFor('kms:CreateKey')).toContain('aws:RequestTag/NamePrefix');
    expect(callFor('cloudfront:CreateDistribution')).not.toContain('--resource-arns');
    expect(callFor('cloudfront:CreateDistribution')).toContain('aws:RequestTag/NamePrefix');
    expect(callFor('cloudfront:GetDistribution')).toContain(':distribution/');
    // ECS: the seven denials of David's second run. Each action is judged on its own
    // resource type, never on the cluster.
    for (const action of ['ecs:CreateService', 'ecs:UpdateService', 'ecs:DeleteService']) {
      expect(callFor(action)).toContain(':service/');
      expect(callFor(action)).not.toContain(':cluster/');
    }
    expect(callFor('ecs:RunTask')).toContain(':task-definition/');
    expect(callFor('ecs:ListTasks')).toContain(':container-instance/');
    for (const call of calls.filter(call => actionsOf(call)[0] === 'ecs:DescribeTasks')) {
      expect(call).toContain(':task/');
    }
    expect(callFor('elasticloadbalancing:CreateTargetGroup')).toContain(':targetgroup/');
    expect(callFor('elasticloadbalancing:CreateTargetGroup')).not.toContain(':loadbalancer/');
    expect(callFor('elasticloadbalancing:CreateTargetGroup')).toContain('aws:RequestTag/NamePrefix');
    // The composite-alarm action appears in two groups; every call for it is judged
    // against alarm:*, because that is the resource CloudWatch authorizes it on.
    const compositeCalls = calls.filter(call => actionsOf(call)[0] === 'cloudwatch:PutCompositeAlarm');
    expect(compositeCalls.length).toBeGreaterThan(0);
    for (const call of compositeCalls) expect(call).toContain(':alarm:*');
    // The master secret RDS creates on the caller's behalf (refused 22 September) is judged
    // on an rds! secret ARN with the request tag RDS sends, and the read afterwards with
    // the resource tag the secret then carries.
    expect(callFor('secretsmanager:CreateSecret')).toContain(':secret:fss-rh-example/');
    const rdsSecretCalls = calls.filter(call => call.includes(':secret:rds!db-'));
    expect(rdsSecretCalls.map(actionsOf).flat().sort()).toEqual([
      'secretsmanager:CreateSecret',
      'secretsmanager:DescribeSecret',
      'secretsmanager:TagResource',
    ]);
    for (const call of rdsSecretCalls.filter(call => !actionsOf(call)[0]!.endsWith('DescribeSecret'))) {
      expect(call).toContain('ContextKeyName=aws:RequestTag/aws:rds:primaryDBInstanceArn,');
      expect(call).toContain('ContextKeyValues=arn:aws:rds:');
      expect(call).toContain(':db:fss-rh-example-pg');
    }
    // The read is judged under the global tag key: the simulator refused the same row under
    // secretsmanager:ResourceTag/... on 22 September while allowing the request-tag rows.
    expect(rdsSecretCalls.find(call => actionsOf(call)[0] === 'secretsmanager:DescribeSecret')).toContain(
      'ContextKeyName=aws:ResourceTag/aws:rds:primaryDBInstanceArn,',
    );
  });

  it('prints the context the simulator says it lacked, so a denial explains itself', () => {
    // The 22 September denial of the read row was reported bare; the third column of the
    // query is MissingContextValues, and the script prints it under the denial.
    const explaining = stub(`
collect=0
for word in "$@"; do
  case "$word" in
    --action-names) collect=1; continue ;;
    --*) collect=0; continue ;;
  esac
  if [ "$collect" = 1 ]; then
    if [ "$word" = secretsmanager:DescribeSecret ]; then
      printf '%s\\timplicitDeny\\t["aws:ResourceTag/aws:rds:primaryDBInstanceArn"]\\n' "$word"
    else
      printf '%s\\tallowed\\tnull\\n' "$word"
    fi
  fi
done`);
    const { code, output } = check(['fss-rh-deploy', 'fss-rh'], { aws: explaining });
    expect(code).toBe(1);
    expect(output).toContain('DENIED  secretsmanager:DescribeSecret (implicitDeny)');
    expect(output).toContain('missing context: ["aws:ResourceTag/aws:rds:primaryDBInstanceArn"]');
    // An allowed line with `null` in the third column prints nothing extra.
    expect(output).not.toContain('missing context: null');
  });

  it('asks the rehearsal role alone about reading the master secret, which production never holds', () => {
    const rehearsal = check(['fss-rh-deploy', 'fss-rh'], { dryRun: true });
    const production = check(['fss-prod-deploy', 'fss-prod'], { dryRun: true });
    expect(rehearsal.code).toBe(0);
    expect(production.code).toBe(0);
    expect(rehearsal.output).toContain('plan:   secretsmanager:DescribeSecret');
    expect(rehearsal.output).toContain('with aws:ResourceTag/aws:rds:primaryDBInstanceArn=arn:aws:rds:');
    // Production creates the rds! secret through RDS like the rehearsal (the common row), but
    // describes only its own named entries: one DescribeSecret row against two.
    const describes = (output: string): number => output.split('\n').filter(line => line === 'plan:   secretsmanager:DescribeSecret').length;
    expect(describes(rehearsal.output)).toBe(2);
    expect(describes(production.output)).toBe(1);
    expect(production.output).not.toContain('aws:ResourceTag/aws:rds:primaryDBInstanceArn');
    const rows = (output: string): number => output.split('\n').filter(line => /^plan: {3}[a-z0-9-]+:[A-Za-z]/u.test(line)).length;
    // Three rows the rehearsal asks and production does not: the master secret it reads,
    // and the two lock records of its own Terraform state that the guard reads after a
    // teardown (review of PR 292; production keeps no state statements at all).
    expect(rows(rehearsal.output) - rows(production.output)).toBe(3);
  });

  it('fails rather than passes when the simulation answers nothing', () => {
    const silent = stub('exit 0');
    const { code, output } = check(['fss-rh-deploy', 'fss-rh'], { aws: silent });
    expect(code).toBe(1);
    expect(output).toContain('returned no evaluation');
    expect(output).toContain('An empty answer is not a pass');
  });
});
