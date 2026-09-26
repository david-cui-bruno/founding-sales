import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * P7 (27 September 2026): `infra/scripts/policy.sh` renders, checks and puts the two
 * deployment roles' inline policy. `deploymentRolePolicy.check.ts` holds what the rendered
 * document allows and how `check` reads the simulator; this holds `put`, which is new, and
 * the old names (`render-deployment-role-policy.sh`, `check-deployment-role.sh`) to the new.
 *
 * ## The vacuous-pass traps, named
 *
 * **A put that is not the rendered document.** The stub IAM keeps what was put; the test
 * compares it with `policy.sh render --compact` byte for byte, and a stub that hands back
 * something else on the read-back must fail the put.
 *
 * **A put in the wrong place.** A session in another account, and production not named
 * out loud, are refused before any IAM call.
 */

const SCRIPT = repositoryPath('infra/scripts/policy.sh');
const ACCOUNT = '326255650484';

/** `aws` as far as `put` asks it: the caller's account, and one role's inline policy. */
const STUB = String.raw`#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "state.json")))
args = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\n")
def value(flag):
    return args[args.index(flag) + 1]
if args[:2] == ["sts", "get-caller-identity"]:
    print(state["account"])
    sys.exit(0)
if args[:2] == ["iam", "get-role-policy"]:
    held = state["policies"].get(value("--role-name") + "/" + value("--policy-name"))
    if held is None:
        sys.stderr.write("An error occurred (NoSuchEntity) when calling the GetRolePolicy operation: not found\n")
        sys.exit(254)
    print(json.dumps(state.get("tampered") or held))
    sys.exit(0)
if args[:2] == ["iam", "put-role-policy"]:
    document = open(value("--policy-document")[len("file://"):]).read()
    state["policies"][value("--role-name") + "/" + value("--policy-name")] = json.loads(document)
    state["put"] = document
    json.dump(state, open(os.path.join(here, "state.json"), "w"))
    sys.exit(0)
sys.stderr.write("the aws stub does not know: " + " ".join(args) + "\n")
sys.exit(2)
`;

interface Run {
  readonly code: number;
  readonly output: string;
}

/** One statement of the rendered document, as far as the put's widening test reads it. */
interface Statement {
  readonly Sid: string;
  readonly Effect: string;
  readonly Action?: string | readonly string[];
  readonly Resource?: string | readonly string[];
  readonly Condition?: Record<string, unknown>;
}

function world(options: { readonly account?: string; readonly held?: unknown; readonly tampered?: unknown } = {}): {
  readonly aws: string;
  readonly calls: () => readonly string[][];
  readonly put: () => string | undefined;
} {
  const home = mkdtempSync(join(tmpdir(), 'fss-policy-'));
  writeFileSync(
    join(home, 'state.json'),
    JSON.stringify({
      account: options.account ?? ACCOUNT,
      policies: options.held === undefined ? {} : { 'fss-rh-deploy/fss-rh-deploy-scope': options.held },
      tampered: options.tampered ?? null,
    }),
  );
  writeFileSync(join(home, 'aws'), STUB);
  chmodSync(join(home, 'aws'), 0o755);
  return {
    aws: join(home, 'aws'),
    calls: () =>
      existsSync(join(home, 'calls.jsonl'))
        ? readFileSync(join(home, 'calls.jsonl'), 'utf8')
            .split('\n')
            .filter(line => line !== '')
            .map(line => JSON.parse(line) as string[])
        : [],
    put: () => (JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as { put?: string }).put,
  };
}

function policy(args: readonly string[], environment: Readonly<Record<string, string>> = {}, script = SCRIPT): Run {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('FSS_')) env[name] = value;
  }
  const result = spawnSync(script, [...args], { encoding: 'utf8', env: { ...env, ...environment } });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const rendered = (prefix: string): string => policy(['render', prefix, '--compact']).output;

describe('policy.sh put: the rendered document, put and read back, in the account it was rendered for', () => {
  it('puts exactly what render --compact prints, says what it adds, and reads it back', () => {
    const stub = world();
    const run = policy(['put', 'fss-rh'], { FSS_POLICY_AWS: stub.aws });
    expect(run.code, run.output).toBe(0);
    expect(stub.put()).toBe(rendered('fss-rh'));
    expect(stub.calls().map(call => call.slice(0, 2).join(' '))).toEqual([
      'sts get-caller-identity',
      'iam get-role-policy',
      'iam put-role-policy',
      'iam get-role-policy',
    ]);
    const put = stub.calls()[2] ?? [];
    expect(put.slice(2, 6)).toEqual(['--role-name', 'fss-rh-deploy', '--policy-name', 'fss-rh-deploy-scope']);
    expect(run.output).toContain('adds BypassGovernanceOnRehearsalBucketsOnly');
    expect(run.output).toContain('fss-rh-deploy-scope is not on fss-rh-deploy yet; this put is the first one');
    expect(run.output).toContain(`put fss-rh-deploy-scope on fss-rh-deploy in account ${ACCOUNT}, and read it back unchanged`);
    expect(run.output).toContain('next, before any apply: infra/scripts/policy.sh check fss-rh-deploy fss-rh');
  });

  it('names what changes against the policy the role holds, and nothing when it holds this document', () => {
    // A narrowing: the role holds an Allow this document does not, so the put removes it.
    const document = JSON.parse(rendered('fss-rh')) as { readonly Statement: Statement[] };
    const extra = { Sid: 'AnOldStatement', Effect: 'Allow', Action: 's3:GetObject', Resource: '*' };
    const held = { ...document, Statement: [...document.Statement, extra] };
    const narrowing = policy(['put', 'fss-rh'], { FSS_POLICY_AWS: world({ held }).aws });
    expect(narrowing.code, narrowing.output).toBe(0);
    expect(narrowing.output).toContain('removes AnOldStatement');
    const same = policy(['put', 'fss-rh'], { FSS_POLICY_AWS: world({ held: document }).aws });
    expect(same.code, same.output).toBe(0);
    expect(same.output).toContain('the role already holds this document; putting it again changes nothing');
  });

  it('refuses a put that would widen the role, in every shape of widening, and puts nothing', () => {
    // The diff was a courtesy: it printed what a put added and then put it. A document
    // that grants more than the role holds is a review, not a re-put (review of PR 292).
    const document = JSON.parse(rendered('fss-rh')) as { readonly Statement: Statement[] };
    const allow = document.Statement.find(statement => statement.Effect === 'Allow' && Array.isArray(statement.Action));
    const deny = document.Statement.find(statement => statement.Effect === 'Deny');
    const unconditioned = document.Statement.find(statement => statement.Condition === undefined);
    if (allow === undefined || deny === undefined || unconditioned === undefined) throw new Error('the rendered document lost its shapes');
    const without = (sid: string): Statement[] => document.Statement.filter(statement => statement.Sid !== sid);
    const replacing = (sid: string, change: Partial<Statement>): Statement[] =>
      document.Statement.map(statement => (statement.Sid === sid ? { ...statement, ...change } : statement));
    for (const [what, held, named] of [
      // The role holds neither this Allow nor this Deny's removal yet.
      ['an Allow the role does not hold', { ...document, Statement: without(allow.Sid) }, `adds the Allow ${allow.Sid}`],
      ['a Deny the document drops', { ...document, Statement: [...document.Statement, { Sid: 'AnOldDeny', Effect: 'Deny', Action: 's3:*', Resource: '*' }] }, 'removes the Deny AnOldDeny'],
      [
        'an action added to an Allow',
        { ...document, Statement: replacing(allow.Sid, { Action: (allow.Action as string[]).slice(1) }) },
        `Action of ${allow.Sid} gains ${(allow.Action as string[])[0] ?? ''}`,
      ],
      [
        'an action taken from a Deny',
        { ...document, Statement: replacing(deny.Sid, { Action: [...(Array.isArray(deny.Action) ? deny.Action : [deny.Action as string]), 'iam:PassRole'] }) },
        `Action of ${deny.Sid} gains iam:PassRole`,
      ],
      [
        'a Condition the role holds and the document drops',
        { ...document, Statement: replacing(unconditioned.Sid, { Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } } }) },
        `${unconditioned.Sid} loses its Condition`,
      ],
      ['an Allow that was a Deny', { ...document, Statement: replacing(allow.Sid, { Effect: 'Deny' }) }, `changes the effect of ${allow.Sid} from Deny to Allow`],
    ] as const) {
      const stub = world({ held });
      const refused = policy(['put', 'fss-rh'], { FSS_POLICY_AWS: stub.aws });
      expect(refused.code, what).toBe(1);
      expect(refused.output, what).toContain('this put would widen the role');
      expect(refused.output, what).toContain(named);
      expect(refused.output, what).toContain('put it again with --allow-widening');
      expect(stub.calls().filter(call => call[1] === 'put-role-policy'), what).toEqual([]);
      // Named on purpose, the same put goes through and says what it widened.
      const allowed = policy(['put', 'fss-rh', '--allow-widening'], { FSS_POLICY_AWS: world({ held }).aws });
      expect(allowed.code, what).toBe(0);
      expect(allowed.output, what).toContain('widening, put on purpose (--allow-widening)');
      expect(allowed.output, what).toContain(named);
    }
  });

  it('refuses production unless it is named, and puts it when it is', () => {
    const unnamed = world();
    const refused = policy(['put', 'fss-prod'], { FSS_POLICY_AWS: unnamed.aws });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('name production out loud: policy.sh put fss-prod --environment production');
    expect(unnamed.calls()).toEqual([]);
    const named = world();
    const run = policy(['put', 'fss-prod', '--environment', 'production'], { FSS_POLICY_AWS: named.aws });
    expect(run.code, run.output).toBe(0);
    expect(named.put()).toBe(rendered('fss-prod'));
    expect(named.calls()[2]?.slice(2, 6)).toEqual(['--role-name', 'fss-prod-deploy', '--policy-name', 'fss-prod-deploy-scope']);
  });

  it('refuses a session in another account before any IAM call, and a read-back that is not what it put', () => {
    const elsewhere = world({ account: '111111111111' });
    const refused = policy(['put', 'fss-rh'], { FSS_POLICY_AWS: elsewhere.aws });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(`this session is in account 111111111111, and the document is rendered for ${ACCOUNT}`);
    expect(elsewhere.calls().map(call => call[0])).toEqual(['sts']);
    const tampered = world({ tampered: { Version: '2012-10-17', Statement: [] } });
    const run = policy(['put', 'fss-rh'], { FSS_POLICY_AWS: tampered.aws });
    expect(run.code).toBe(1);
    expect(run.output).toContain('holds a fss-rh-deploy-scope that is not the document just put');
  });

  it('refuses a namespace that is not one of the two, and an option it does not have', () => {
    expect(policy(['put', 'fss-rh-202609271200']).code).toBe(2);
    expect(policy(['put', 'fss-rh', '--environment', 'production']).output).toContain('fss-rh is the rehearsal');
    expect(policy(['put', 'fss-rh', '--force']).output).toContain("policy.sh put does not take '--force'");
  });
});

describe('the old names are policy.sh render and policy.sh check', () => {
  it('renders the same bytes through render-deployment-role-policy.sh, for both roles and every mode', () => {
    for (const prefix of ['fss-rh', 'fss-prod']) {
      for (const mode of ['--pretty', '--compact', '--sids']) {
        const now = policy(['render', prefix, mode]);
        const old = policy([prefix, mode], {}, repositoryPath('infra/scripts/render-deployment-role-policy.sh'));
        expect(now.code).toBe(0);
        expect(old).toEqual(now);
      }
    }
    expect(policy(['fss'], {}, repositoryPath('infra/scripts/render-deployment-role-policy.sh')).code).toBe(2);
  });

  it('plans the same simulation, and refuses the same way, through check-deployment-role.sh', () => {
    const old = repositoryPath('infra/scripts/check-deployment-role.sh');
    for (const pair of [
      ['fss-rh-deploy', 'fss-rh'],
      ['fss-prod-deploy', 'fss-prod'],
      ['fss-rh-deploy', 'fss-prod'],
      ['admin', 'fss-rh'],
    ]) {
      const now = policy(['check', ...pair], { FSS_CHECK_ROLE_DRY_RUN: '1' });
      expect(policy(pair, { FSS_CHECK_ROLE_DRY_RUN: '1' }, old), pair.join(' ')).toEqual(now);
    }
    // The drill's actions went with the scripts that made them (W3-S8, P7).
    const plan = policy(['check', 'fss-rh-deploy', 'fss-rh'], { FSS_CHECK_ROLE_DRY_RUN: '1' }).output;
    for (const gone of ['rds:RestoreDBInstanceToPointInTime', 'rds:CreateDBSnapshot', 'cloudwatch:DescribeAlarmHistory']) {
      expect(plan, gone).not.toContain(gone);
    }
    // The rehearsal guard reads what the run left behind, so the check asks about those
    // reads too; dropping them from the table was the P1 of the review of PR 292.
    for (const read of ['tag:GetResources', 'rds:DescribeDBInstances', 'rds:DescribeDBSnapshots', 'cloudfront:ListDistributions', 'logs:DescribeLogGroups']) {
      expect(plan, read).toContain(`plan:   ${read}`);
    }
  });

  it('asks about as many actions as the header says, for each role', () => {
    // The header of policy.sh names the table's size. A row added or lost without a word
    // there is a table nobody can reason about from the outside (review of PR 292).
    const header = readFileSync(repositoryPath('infra/scripts/policy.sh'), 'utf8');
    expect(header).toContain('The table is 25 groups, 115 action entries over');
    expect(header).toContain('108 distinct actions, for production; the rehearsal adds one group (116 entries, the same');
    const counted = (prefix: string): { groups: number; entries: number; distinct: number } => {
      const lines = policy(['check', `${prefix}-deploy`, prefix], { FSS_CHECK_ROLE_DRY_RUN: '1' }).output.split('\n');
      const actions = lines.flatMap(line => /^plan: {3}([a-z0-9-]+:[A-Za-z]+)$/.exec(line)?.slice(1) ?? []);
      return {
        groups: lines.filter(line => /^plan: [a-z]/.test(line) && line !== 'plan: no call was made').length,
        entries: actions.length,
        distinct: new Set(actions).size,
      };
    };
    expect(counted('fss-prod')).toEqual({ groups: 25, entries: 115, distinct: 108 });
    expect(counted('fss-rh')).toEqual({ groups: 26, entries: 116, distinct: 108 });
  });
});
