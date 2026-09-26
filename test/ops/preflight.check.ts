import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * P7 (27 September 2026): `infra/scripts/preflight.sh <root> <prefix> <migration>` runs
 * `fss admin schema-preflight <migration>` on the operations task before a schema release
 * stops anything, and exits 3 when the migration would refuse. `schema-preflight-0019.sh`
 * (lane W2-M) is its old name for 0019.
 *
 * ## The vacuous-pass traps, named
 *
 * **A revision left for the next plan to read.** When the registered operations image is
 * not the release's, the script registers one revision with only the image changed and
 * deregisters it on the way out, whatever happened; a deregistration ECS refuses fails the
 * script even after a count that passed. The stub ECS keeps every registration and
 * deregistration, and the registered document is compared with the running one.
 *
 * **A refusal that reads as a pass.** `refuses: true` is exit 3, and an answer that says
 * neither is a failure.
 *
 * **A summary line that lost a field when this script replaced 0019's.** 0019's report
 * carries ten fields beyond the schema version, `refuses` and the blocking counts, and the
 * coordinator's release helper greps four of them. A full 0019-shaped report must produce
 * the line `schema-preflight-0019.sh` wrote, field for field and in its order; another
 * migration must get the generic line and none of 0019's.
 */

const SCRIPT = repositoryPath('infra/scripts/preflight.sh');
const OLD_NAME = repositoryPath('infra/scripts/schema-preflight-0019.sh');
const ACCOUNT = '111111111111';
const PREFIX = 'fss-rh-pre';
const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/${PREFIX}-worker`;
const PREVIOUS = `sha256:${'9'.repeat(64)}`;
const RELEASE = `sha256:${'b'.repeat(64)}`;
const SECRET = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:${PREFIX}/app-runtime-database-bbbbbb`;
const HOST = `${PREFIX}-pg.example.com`;
const definitionArn = (revision: number): string => `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${PREFIX}-operations:${String(revision)}`;

/** ECS and CloudWatch Logs as far as the preflight asks them. */
const STUB = String.raw`#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "state.json")))
args = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\n")
def value(flag):
    return args[args.index(flag) + 1] if flag in args else None
def save():
    json.dump(state, open(os.path.join(here, "state.json"), "w"))
if args[:2] == ["ecs", "describe-task-definition"]:
    known = state["definitions"].get(value("--task-definition"))
    if known is None:
        sys.stderr.write("An error occurred (ClientException) when calling the DescribeTaskDefinition operation: Unable to describe task definition.\n")
        sys.exit(254)
    print(json.dumps(known["taskDefinition"] if value("--query") == "taskDefinition" else known))
    sys.exit(0)
if args[:2] == ["ecs", "register-task-definition"]:
    document = json.load(open(value("--cli-input-json")[len("file://"):]))
    arn = state["nextArn"]
    tags = document.pop("tags", [])
    state["registered"] = document
    state["definitions"][arn] = {"taskDefinition": dict(document, taskDefinitionArn=arn, status="ACTIVE"), "tags": tags}
    save()
    print(json.dumps({"taskDefinition": {"taskDefinitionArn": arn}}))
    sys.exit(0)
if args[:2] == ["ecs", "deregister-task-definition"]:
    if state.get("refuseDeregistration"):
        sys.stderr.write("An error occurred (AccessDeniedException) when calling the DeregisterTaskDefinition operation\n")
        sys.exit(254)
    state.setdefault("deregistered", []).append(value("--task-definition"))
    save()
    print("{}")
    sys.exit(0)
if args[:2] == ["ecs", "run-task"]:
    state["launched"] = value("--task-definition")
    save()
    print(json.dumps({"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:" + state["account"] + ":task/fss-rh-pre-cluster/0a1b"}], "failures": []}))
    sys.exit(0)
if args[:2] == ["ecs", "describe-tasks"]:
    print(json.dumps({"tasks": [{"lastStatus": "STOPPED", "stopCode": "EssentialContainerExited", "containers": [{"name": "operations", "exitCode": 0}]}]}))
    sys.exit(0)
if args[:2] == ["logs", "get-log-events"]:
    print(json.dumps({"events": [{"message": json.dumps(state["answer"])}]}))
    sys.exit(0)
sys.stderr.write("the aws stub does not know: " + " ".join(args) + "\n")
sys.exit(2)
`;

interface World {
  readonly home: string;
  readonly reports: string;
  state(): {
    readonly launched?: string;
    readonly registered?: Record<string, unknown>;
    readonly deregistered?: readonly string[];
  };
  calls(): readonly string[][];
}

function operations(image: string): Record<string, unknown> {
  return {
    taskDefinition: {
      taskDefinitionArn: definitionArn(3),
      family: `${PREFIX}-operations`,
      revision: 3,
      status: 'ACTIVE',
      networkMode: 'awsvpc',
      taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/${PREFIX}-worker-task`,
      executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/${PREFIX}-worker-execution`,
      registeredAt: '2026-09-26T10:00:00Z',
      containerDefinitions: [
        {
          name: 'operations',
          image,
          environment: [{ name: 'FSS_DATABASE_HOST', value: HOST }],
          secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: SECRET }],
        },
      ],
    },
    tags: [{ key: 'NamePrefix', value: PREFIX }],
  };
}

function world(options: { readonly running?: string; readonly refuses?: boolean | 'missing'; readonly refuseDeregistration?: boolean; readonly counts?: Record<string, unknown> } = {}): World {
  const home = mkdtempSync(join(tmpdir(), 'fss-preflight-'));
  const reports = mkdtempSync(join(tmpdir(), 'fss-preflight-reports-'));
  const answer: Record<string, unknown> = {
    schemaVersion: 18,
    counts: options.counts ?? { blocking: { linkedinMarkers: options.refuses === true ? 2 : 0, researchPages: 0 } },
  };
  if (options.refuses !== 'missing') answer['refuses'] = options.refuses === true;
  writeFileSync(
    join(home, 'state.json'),
    JSON.stringify({
      account: ACCOUNT,
      nextArn: definitionArn(4),
      definitions: { [definitionArn(3)]: operations(`${REGISTRY}@${options.running ?? PREVIOUS}`) },
      answer,
      refuseDeregistration: options.refuseDeregistration === true,
    }),
  );
  writeFileSync(join(home, 'aws'), STUB);
  chmodSync(join(home, 'aws'), 0o755);
  return {
    home,
    reports,
    state: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as ReturnType<World['state']>,
    calls: () =>
      existsSync(join(home, 'calls.jsonl'))
        ? readFileSync(join(home, 'calls.jsonl'), 'utf8')
            .split('\n')
            .filter(line => line !== '')
            .map(line => JSON.parse(line) as string[])
        : [],
  };
}

function preflight(stub: World, args: readonly string[] = ['infra/roots/rehearsal', PREFIX, '0019', '--worker-digest', RELEASE], script = SCRIPT, extra: Readonly<Record<string, string>> = {}, migration = '0019'): {
  readonly code: number;
  readonly output: string;
  readonly report: string | null;
} {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('FSS_')) env[name] = value;
  }
  const result = spawnSync(script, [...args], {
    encoding: 'utf8',
    env: {
      ...env,
      AWS_REGION: 'us-east-1',
      RELEASE_LOG_POLL_SECONDS: '0',
      FSS_REHEARSAL_AWS_COMMAND: join(stub.home, 'aws'),
      FSS_REHEARSAL_REPORTS: stub.reports,
      FSS_RELEASE_RUN_ID: 'preflight-check',
      FSS_RELEASE_ACCOUNT: ACCOUNT,
      FSS_RELEASE_CALLER_ACCOUNT: ACCOUNT,
      FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: 'rehearsal' }]),
      FSS_RELEASE_OUTPUT_CLUSTER_ARN: `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/${PREFIX}-cluster`,
      FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN: definitionArn(3),
      FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: SECRET,
      FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: `/fss/${PREFIX}/worker`,
      FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
        subnet_ids: ['subnet-0a'],
        security_group_id: 'sg-0a',
        assign_public_ip: 'ENABLED',
        database_host: HOST,
        inbound_rule_count: 0,
      }),
      ...extra,
    },
  });
  const report = join(stub.reports, `schema-preflight-${migration}.txt`);
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}`, report: existsSync(report) ? readFileSync(report, 'utf8').trim() : null };
}

describe('preflight.sh counts on the operations task, with the release’s worker image', () => {
  it('registers one revision with only the image changed, launches on it, and deregisters it after a count that passes', () => {
    const stub = world();
    const run = preflight(stub);
    expect(run.code, run.output).toBe(0);
    const state = stub.state();
    expect(state.launched).toBe(definitionArn(4));
    expect(state.deregistered).toEqual([definitionArn(4)]);
    const running = operations(`${REGISTRY}@${PREVIOUS}`)['taskDefinition'] as Record<string, unknown> & { containerDefinitions: Record<string, unknown>[] };
    const expected: Record<string, unknown> = { ...running, containerDefinitions: [{ ...running.containerDefinitions[0], image: `${REGISTRY}@${RELEASE}` }] };
    for (const field of ['taskDefinitionArn', 'revision', 'status', 'registeredAt']) delete expected[field];
    expect(state.registered).toEqual(expected);
    const launch = stub.calls().find(call => call[1] === 'run-task') ?? [];
    expect(launch.join(' ')).toContain('"command": ["admin", "schema-preflight", "0019", "--report", "/tmp/fss-preflight.json"]');
    // The whole line, with 0019's own fields, is the next test's; this is its generic half.
    expect(run.report).toContain(`prefix=${PREFIX} environment=rehearsal worker_digest=${RELEASE} schema=18 refuses=false blocking_linkedinMarkers=0 blocking_researchPages=0`);
    expect(run.output).toContain('0019 needs no decision');
  });

  it('launches the registered definition as it is when it already runs the release’s image, and registers nothing', () => {
    const stub = world({ running: RELEASE });
    const run = preflight(stub);
    expect(run.code, run.output).toBe(0);
    expect(stub.state().launched).toBe(definitionArn(3));
    expect(stub.calls().filter(call => call[1] === 'register-task-definition' || call[1] === 'deregister-task-definition')).toEqual([]);
  });

  it('exits 3 when the migration would refuse, still deregistering, and 1 when the answer says neither', () => {
    const refusing = world({ refuses: true });
    const run = preflight(refusing);
    expect(run.code, run.output).toBe(3);
    expect(run.output).toContain('FAIL: 0019 would refuse; the release stops here, before anything is stopped.');
    expect(run.report).toContain('refuses=true blocking_linkedinMarkers=2');
    expect(refusing.state().deregistered).toEqual([definitionArn(4)]);
    const silent = preflight(world({ refuses: 'missing' }));
    expect(silent.code).toBe(1);
    expect(silent.output).toContain('does not say whether 0019 would refuse');
  });

  it('fails a count that passed when ECS refuses to deregister its revision, which the next plan would read', () => {
    const stub = world({ refuseDeregistration: true });
    const run = preflight(stub);
    expect(run.code).toBe(1);
    expect(run.output).toContain(`could not deregister ${definitionArn(4)}`);
  });

  it('refuses a migration that is not a number, a dry run and a missing digest before any call', () => {
    for (const [args, extra, expected] of [
      [['infra/roots/rehearsal', PREFIX, '19', '--worker-digest', RELEASE], {}, "'19' is not a migration number"],
      [['infra/roots/rehearsal', PREFIX, '0019', '--worker-digest', RELEASE], { FSS_REHEARSAL_DRY_RUN: '1' }, 'preflight.sh has no dry run'],
      [['infra/roots/rehearsal', PREFIX, '0019'], {}, 'usage: preflight.sh'],
      [['infra/roots/production', PREFIX, '0019', '--worker-digest', RELEASE], {}, 'is not the rehearsal root'],
    ] as const) {
      const stub = world();
      const run = preflight(stub, args, SCRIPT, extra);
      expect(run.code, args.join(' ')).toBe(1);
      expect(run.output).toContain(expected);
      expect(stub.calls()).toEqual([]);
    }
  });

  it('writes 0019’s own ten fields, which no other migration gets', () => {
    // A report of the shape 0019 answers with, every field of it populated.
    const counts = {
      blocking: { linkedinMarkers: 0, researchPages: 3, researchProviderLedger: 1, firmLocations: 2, researchFirmRuns: 4, researchSuggestions: 5 },
      destroyed: {
        researchSeed: { firms: 7, contacts: 11 },
        directSentDays: 9,
        guardColumnsChanged: 2,
        alertThresholdsRows: 4,
        clientVersionRangeRows: 1,
      },
      archivedMergeEvents: 6,
      reasonCodeReferences: { domainCap: 8, deadJob: 0 },
      relaxed: { snoozesWithPlaceholderReason: 12 },
      reviewRequiredEnrollments: 13,
    };
    const stub = world({ counts });
    const run = preflight(stub);
    expect(run.code, run.output).toBe(0);
    expect(run.report).toBe(
      [
        `prefix=${PREFIX} environment=rehearsal worker_digest=${RELEASE}`,
        'schema=18 refuses=false',
        'blocking_firmLocations=2 blocking_linkedinMarkers=0 blocking_researchFirmRuns=4',
        'blocking_researchPages=3 blocking_researchProviderLedger=1 blocking_researchSuggestions=5',
        // 7 + 11 seed rows; 1 + 3 + 2 + 4 + 5 research rows; 4 + 1 retired setting rows.
        'research_seed_rows=18 research_data_rows=15 record_merge_events_archived=6',
        'direct_sent_days=9 guard_columns_changed=2 retired_setting_rows=5',
        'domain_cap_references=8 dead_job_references=0 snoozes_with_placeholder_reason=12',
        'review_required_enrollments=13',
      ].join(' '),
    );
    // The same report for another migration: the generic line, and not one 0019 field.
    const other = world({ counts });
    const next = preflight(other, ['infra/roots/rehearsal', PREFIX, '0020', '--worker-digest', RELEASE], SCRIPT, {}, '0020');
    expect(next.code, next.output).toBe(0);
    expect(next.report).toBe(
      `prefix=${PREFIX} environment=rehearsal worker_digest=${RELEASE} schema=18 refuses=false ` +
        'blocking_firmLocations=2 blocking_linkedinMarkers=0 blocking_researchFirmRuns=4 ' +
        'blocking_researchPages=3 blocking_researchProviderLedger=1 blocking_researchSuggestions=5',
    );
    expect(next.report).not.toContain('research_seed_rows');
    expect((other.calls().find(call => call[1] === 'run-task') ?? []).join(' ')).toContain(
      '"command": ["admin", "schema-preflight", "0020", "--report", "/tmp/fss-preflight.json"]',
    );
  });

  it('makes the same calls and writes the same report through schema-preflight-0019.sh', () => {
    // A full 0019 report, so the parity is of the whole line and not of its generic half.
    const counts = {
      blocking: { linkedinMarkers: 0, researchPages: 3 },
      destroyed: { researchSeed: { firms: 7 }, directSentDays: 9, guardColumnsChanged: 2, alertThresholdsRows: 4, clientVersionRangeRows: 1 },
      archivedMergeEvents: 6,
      reasonCodeReferences: { domainCap: 8, deadJob: 0 },
      relaxed: { snoozesWithPlaceholderReason: 12 },
      reviewRequiredEnrollments: 13,
    };
    const now = world({ counts });
    const old = world({ counts });
    const current = preflight(now);
    const legacy = preflight(old, ['infra/roots/rehearsal', PREFIX, '--worker-digest', RELEASE], OLD_NAME);
    expect(legacy.code, legacy.output).toBe(current.code);
    // The same calls, but for the name of the temporary directory each run makes.
    const scrubbed = (calls: ReturnType<World['calls']>): string =>
      JSON.stringify(calls).replace(/fss-preflight-0019\.[A-Za-z0-9]+/gu, 'fss-preflight-0019.<temporary>');
    expect(scrubbed(old.calls())).toBe(scrubbed(now.calls()));
    expect(legacy.report).toBe(current.report);
  });
});
