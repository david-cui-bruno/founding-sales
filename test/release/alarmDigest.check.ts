import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * One daily digest e-mail, nothing immediate (lane g99; the owner's decision 11C of
 * 25 September 2026).
 *
 * Until this lane every composite alarm e-mailed the owner on its transitions (lanes
 * g62 and g81). Now no alarm carries an action, and once a day at 07:00
 * America/New_York one Lambda function lists every alarm of the environment, reads the
 * last 24 hours of their history and publishes one plain-text message to the alert
 * topic: what is not OK now, then the day's state changes in time order, or one line
 * when nothing happened.
 *
 * ## The vacuous-pass trap, named
 *
 * Two halves, each closed differently. The wiring is read as Terraform text, which
 * proves the declaration and not the plan, so every assertion reads the one line that
 * decides and asserts the old shape absent beside the new one; the plan itself is
 * `infra/modules/alerts/tests/digest.tftest.hcl`, in the offline gate. The behaviour is
 * the function's own code run against fake CloudWatch and SNS calls, so a digest that
 * rendered nothing, skipped a page or lost the order would be red here rather than in
 * the owner's inbox; the fakes answer in pages and out of order on purpose, and include
 * another environment's alarm that must not appear.
 */

interface Alarm {
  readonly AlarmName: string;
  readonly StateValue: string;
  readonly StateReason?: string;
  readonly StateUpdatedTimestamp?: Date;
}

interface HistoryItem {
  readonly AlarmName: string;
  readonly Timestamp: Date;
  readonly HistoryItemType: string;
  readonly HistorySummary?: string;
  readonly HistoryData?: string;
}

type Call = Readonly<Record<string, unknown>>;

interface Summary {
  readonly subject: string;
  readonly alarms: number;
  readonly notOk: number;
  readonly transitions: number;
  readonly historyComplete: boolean;
}

interface DigestModule {
  runDigest(options: {
    prefix: unknown;
    topicArn: unknown;
    timeZone?: string;
    now: Date;
    describeAlarms(input: Call): Promise<Record<string, unknown>>;
    describeAlarmHistory(input: Call): Promise<Record<string, unknown>>;
    publish(input: Call): Promise<unknown>;
  }): Promise<Summary>;
  localTime(date: Date, timeZone?: string): string;
}

// A computed specifier, as in mutationRunner.check.ts: plain ESM with no declarations.
const DIGEST_PATH = repositoryPath('infra/lambdas/alarm-digest/digest.mjs');
const digest = (await import(DIGEST_PATH)) as DigestModule;

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:fss-test-alerts';
// 07:00 in New York on 25 September 2026 (EDT, UTC-4).
const NOW = new Date('2026-09-25T11:00:00Z');

function stateChange(name: string, at: string, from: string, to: string): HistoryItem {
  return {
    AlarmName: name,
    Timestamp: new Date(at),
    HistoryItemType: 'StateUpdate',
    HistorySummary: `Alarm updated from ${from} to ${to}`,
    HistoryData: JSON.stringify({ version: '1.0', oldState: { stateValue: from }, newState: { stateValue: to } }),
  };
}

interface Fakes {
  readonly calls: { alarms: Call[]; history: Call[]; published: Call[] };
  readonly describeAlarms: (input: Call) => Promise<Record<string, unknown>>;
  readonly describeAlarmHistory: (input: Call) => Promise<Record<string, unknown>>;
  readonly publish: (input: Call) => Promise<unknown>;
}

/** CloudWatch and SNS, answering in two pages each. */
function fakes(
  metric: readonly Alarm[],
  composite: readonly Alarm[],
  history: readonly HistoryItem[],
  publishError?: (attempt: number) => Error | undefined,
): Fakes {
  const calls = { alarms: [] as Call[], history: [] as Call[], published: [] as Call[] };
  return {
    calls,
    describeAlarms: async input => {
      calls.alarms.push(input);
      return input['NextToken'] === undefined
        ? { MetricAlarms: metric.slice(0, 1), CompositeAlarms: [], NextToken: 'alarms-2' }
        : { MetricAlarms: metric.slice(1), CompositeAlarms: composite };
    },
    describeAlarmHistory: async input => {
      calls.history.push(input);
      const half = Math.ceil(history.length / 2);
      return input['NextToken'] === undefined
        ? { AlarmHistoryItems: history.slice(0, half), NextToken: 'history-2' }
        : { AlarmHistoryItems: history.slice(half) };
    },
    publish: async input => {
      calls.published.push(input);
      const error = publishError?.(calls.published.length);
      if (error !== undefined) throw error;
      return { MessageId: 'm-1' };
    },
  };
}

async function run(f: Fakes, settings: { readonly prefix: unknown; readonly topicArn: unknown } = { prefix: 'fss-test-', topicArn: TOPIC }): Promise<Summary> {
  return digest.runDigest({
    prefix: settings.prefix,
    topicArn: settings.topicArn,
    now: NOW,
    describeAlarms: f.describeAlarms,
    describeAlarmHistory: f.describeAlarmHistory,
    publish: f.publish,
  });
}

const OK_ALARMS: readonly Alarm[] = [
  { AlarmName: 'fss-test-api-heartbeat-missed', StateValue: 'OK' },
  { AlarmName: 'fss-test-canary-stale', StateValue: 'OK' },
];
const OK_COMPOSITES: readonly Alarm[] = [{ AlarmName: 'fss-test-critical', StateValue: 'OK' }];

describe('g99: the digest reads every alarm of the environment and publishes one message', () => {
  it('says one line when nothing happened, under the dated subject, to the alert topic', async () => {
    const f = fakes(OK_ALARMS, OK_COMPOSITES, []);
    const summary = await run(f);
    expect(f.calls.published).toHaveLength(1);
    const published = f.calls.published[0]!;
    expect(published['TopicArn']).toBe(TOPIC);
    expect(published['Subject']).toBe('Callie daily alarm digest — 2026-09-25');
    expect(published['Message']).toBe('All 3 alarms OK. None changed state in the 24 hours to 2026-09-25 07:00 EDT.\n');
    expect(summary).toEqual({
      subject: 'Callie daily alarm digest — 2026-09-25',
      alarms: 3,
      notOk: 0,
      transitions: 0,
      historyComplete: true,
    });
  });

  it('asks for both alarm types by the prefix, and the last 24 hours of state changes, reading every page', async () => {
    const f = fakes(OK_ALARMS, OK_COMPOSITES, [stateChange('fss-test-canary-stale', '2026-09-25T01:00:00Z', 'OK', 'ALARM')]);
    await run(f);
    expect(f.calls.alarms).toHaveLength(2);
    for (const call of f.calls.alarms) {
      expect(call['AlarmNamePrefix']).toBe('fss-test-');
      expect(call['AlarmTypes']).toEqual(['MetricAlarm', 'CompositeAlarm']);
    }
    expect(f.calls.alarms[1]!['NextToken']).toBe('alarms-2');
    expect(f.calls.history).toHaveLength(2);
    for (const call of f.calls.history) {
      expect(call['AlarmTypes']).toEqual(['MetricAlarm', 'CompositeAlarm']);
      expect(call['HistoryItemType']).toBe('StateUpdate');
      expect((call['StartDate'] as Date).toISOString()).toBe('2026-09-24T11:00:00.000Z');
      expect((call['EndDate'] as Date).toISOString()).toBe('2026-09-25T11:00:00.000Z');
    }
    expect(f.calls.history[1]!['NextToken']).toBe('history-2');
  });

  it('puts what is not OK first, ALARM before INSUFFICIENT_DATA, then the day in time order, in New York time', async () => {
    const metric: Alarm[] = [
      { AlarmName: 'fss-test-api-heartbeat-missed', StateValue: 'OK' },
      {
        AlarmName: 'fss-test-worker-heartbeat-missed',
        StateValue: 'ALARM',
        StateReason: 'Threshold Crossed: 3 out of the last 3 datapoints were less than the threshold (1.0).',
        StateUpdatedTimestamp: new Date('2026-09-25T03:12:00Z'),
      },
      {
        AlarmName: 'fss-test-today-snapshot-absent',
        StateValue: 'INSUFFICIENT_DATA',
        StateUpdatedTimestamp: new Date('2026-09-24T12:00:00Z'),
      },
    ];
    const composite: Alarm[] = [
      { AlarmName: 'fss-test-critical', StateValue: 'ALARM', StateUpdatedTimestamp: new Date('2026-09-25T03:12:30Z') },
      { AlarmName: 'fss-test-warning', StateValue: 'OK' },
    ];
    const history: HistoryItem[] = [
      stateChange('fss-test-critical', '2026-09-25T03:12:30Z', 'OK', 'ALARM'),
      stateChange('fss-test-worker-heartbeat-missed', '2026-09-25T03:12:00Z', 'OK', 'ALARM'),
      // Another environment's alarm in the same account: DescribeAlarmHistory has no
      // prefix, so the function filters, and this line must not appear.
      stateChange('fss-rh-202609250100-canary-stale', '2026-09-25T02:00:00Z', 'OK', 'ALARM'),
      // HistoryData that is not JSON: the summary is the fallback.
      {
        AlarmName: 'fss-test-warning',
        Timestamp: new Date('2026-09-24T14:05:00Z'),
        HistoryItemType: 'StateUpdate',
        HistorySummary: 'Alarm updated from ALARM to OK',
        HistoryData: 'not json',
      },
      stateChange('fss-test-warning', '2026-09-24T13:00:00Z', 'OK', 'ALARM'),
    ];
    const f = fakes(metric, composite, history);
    const summary = await run(f);
    const message = String(f.calls.published[0]!['Message']);

    expect(summary).toMatchObject({ alarms: 5, notOk: 3, transitions: 4 });
    expect(message.startsWith('Not OK now (3 of 5 alarms):\n')).toBe(true);
    const order = [
      'ALARM              fss-test-critical (composite)  since 2026-09-24 23:12 EDT',
      'ALARM              fss-test-worker-heartbeat-missed  since 2026-09-24 23:12 EDT',
      'Threshold Crossed: 3 out of the last 3 datapoints were less than the threshold (1.0).',
      'INSUFFICIENT_DATA  fss-test-today-snapshot-absent  since 2026-09-24 08:00 EDT',
      'Changed state in the 24 hours to 2026-09-25 07:00 EDT (4), oldest first:',
      '2026-09-24 09:00 EDT  fss-test-warning  OK → ALARM',
      '2026-09-24 10:05 EDT  fss-test-warning  ALARM → OK',
      '2026-09-24 23:12 EDT  fss-test-worker-heartbeat-missed  OK → ALARM',
      '2026-09-24 23:12 EDT  fss-test-critical  OK → ALARM',
      'aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix fss-test-',
    ];
    let cursor = -1;
    for (const line of order) {
      const at = message.indexOf(line);
      expect(at, `missing or out of order: ${line}\n\n${message}`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(message).not.toContain('fss-rh-');
    expect(message).not.toContain('fss-test-api-heartbeat-missed');
    expect(message).not.toContain('All 5 alarms OK');
  });

  it('says the day changed even when everything is OK again by the morning', async () => {
    const f = fakes(OK_ALARMS, OK_COMPOSITES, [
      stateChange('fss-test-canary-stale', '2026-09-25T01:00:00Z', 'OK', 'ALARM'),
      stateChange('fss-test-canary-stale', '2026-09-25T01:04:00Z', 'ALARM', 'OK'),
    ]);
    await run(f);
    const message = String(f.calls.published[0]!['Message']);
    expect(message).toContain('Not OK now: none. All 3 alarms are OK.');
    expect(message).toContain('2026-09-24 21:00 EDT  fss-test-canary-stale  OK → ALARM');
    expect(message).toContain('2026-09-24 21:04 EDT  fss-test-canary-stale  ALARM → OK');
    expect(message).not.toMatch(/^All 3 alarms OK\./u);
  });

  it('says so when the environment has no alarm at all, rather than that all zero are OK', async () => {
    const f = fakes([], [], []);
    await run(f);
    const message = String(f.calls.published[0]!['Message']);
    expect(message).toContain('No alarm whose name starts with fss-test- exists.');
    expect(message).not.toContain('All 0 alarms OK');
  });

  it('is the same message for the same alarms and history, so a retry repeats itself and nothing else', async () => {
    const history = [stateChange('fss-test-canary-stale', '2026-09-25T01:00:00Z', 'OK', 'ALARM')];
    const first = fakes(OK_ALARMS, OK_COMPOSITES, history);
    const second = fakes(OK_ALARMS, OK_COMPOSITES, history);
    await run(first);
    await run(second);
    expect(first.calls.published).toEqual(second.calls.published);
  });

  it('writes EDT and EST on either side of the November change', () => {
    expect(digest.localTime(new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01 01:30 EDT');
    expect(digest.localTime(new Date('2026-11-01T06:30:00Z'))).toBe('2026-11-01 01:30 EST');
    expect(digest.localTime(new Date('2026-09-25T04:05:00Z'))).toBe('2026-09-25 00:05 EDT');
  });

  it('falls back to an ASCII subject only when SNS refuses the subject, and otherwise fails loudly', async () => {
    const refused = fakes(OK_ALARMS, OK_COMPOSITES, [], attempt =>
      attempt === 1 ? Object.assign(new Error('Invalid parameter: Subject'), { name: 'InvalidParameterException' }) : undefined,
    );
    const summary = await run(refused);
    expect(refused.calls.published.map(call => call['Subject'])).toEqual([
      'Callie daily alarm digest — 2026-09-25',
      'Callie daily alarm digest - 2026-09-25',
    ]);
    expect(summary.subject).toBe('Callie daily alarm digest - 2026-09-25');

    const denied = fakes(OK_ALARMS, OK_COMPOSITES, [], () =>
      Object.assign(new Error('not authorized to perform: SNS:Publish'), { name: 'AuthorizationErrorException' }),
    );
    await expect(run(denied)).rejects.toThrow('SNS:Publish');
    expect(denied.calls.published).toHaveLength(1);
  });

  it('refuses a missing prefix or topic before it reads or publishes anything', async () => {
    for (const [prefix, topicArn] of [
      [undefined, TOPIC],
      ['fss-test', TOPIC],
      ['fss-test-', undefined],
      ['fss-test-', 'arn:aws:sqs:us-east-1:123456789012:fss-test-alerts'],
    ] as const) {
      const f = fakes(OK_ALARMS, OK_COMPOSITES, []);
      await expect(run(f, { prefix, topicArn })).rejects.toThrow();
      expect(f.calls.alarms).toHaveLength(0);
      expect(f.calls.published).toHaveLength(0);
    }
  });
});

describe('g99: the Terraform around it', () => {
  const MODULE = 'infra/modules/alerts';
  const moduleFiles = readdirSync(repositoryPath(MODULE)).filter(name => name.endsWith('.tf'));
  const text = moduleFiles.map(name => readRepositoryFile(`${MODULE}/${name}`)).join('\n');
  const DIGEST_TF = readRepositoryFile(`${MODULE}/digest.tf`);

  it('finds the module, the digest and the alarms, so the assertions below read something', () => {
    expect(moduleFiles).toEqual(expect.arrayContaining(['main.tf', 'digest.tf']));
    expect(text.match(/^resource "aws_cloudwatch_(metric|composite)_alarm"/gmu)?.length).toBe(5);
  });

  it('gives no alarm an action: every action list in the module is empty', () => {
    const actions = [...text.matchAll(/^\s*(alarm_actions|ok_actions|insufficient_data_actions)\s*=\s*(.+)$/gmu)];
    expect(actions.length, 'the scan found no action argument at all').toBe(10);
    for (const [line, , value] of actions) expect(value, line).toBe('[]');
    expect(text).not.toMatch(/_actions\s*=\s*\[aws_sns_topic/u);
  });

  it('runs daily at 07:00 in New York, by Scheduler', () => {
    expect(DIGEST_TF).toContain('digest_schedule_expression = "cron(0 7 * * ? *)"');
    expect(DIGEST_TF).toContain('digest_time_zone           = "America/New_York"');
    expect(DIGEST_TF).toContain('schedule_expression_timezone = local.digest_time_zone');
    expect(DIGEST_TF).toContain('arn      = aws_lambda_function.digest.arn');
  });

  it('publishes to the one topic the module already had', () => {
    expect(text.match(/^resource "aws_sns_topic" /gmu)).toHaveLength(1);
    expect(DIGEST_TF).toContain('FSS_ALERT_TOPIC_ARN  = aws_sns_topic.alerts.arn');
    expect(DIGEST_TF).toContain('Resource = aws_sns_topic.alerts.arn');
    expect(DIGEST_TF).not.toMatch(/Principal\s*=\s*"\*"|AWS\s*=\s*"\*"/u);
  });

  it('hands the function the settings index.mjs reads, and zips every source file there is', () => {
    const index = readRepositoryFile('infra/lambdas/alarm-digest/index.mjs');
    const read = [...index.matchAll(/process\.env\.([A-Z_]+)/gu)].map(match => match[1]).sort();
    const block = DIGEST_TF.slice(DIGEST_TF.indexOf('  environment {'), DIGEST_TF.indexOf('  logging_config {'));
    const given = [...block.matchAll(/^\s+([A-Z_]+)\s+=/gmu)].map(match => match[1]).sort();
    expect(read).toEqual(['FSS_ALARM_PREFIX', 'FSS_ALERT_TOPIC_ARN', 'FSS_DIGEST_TIME_ZONE']);
    expect(given).toEqual(read);
    expect(index).toContain("import { runDigest } from './digest.mjs';");

    const sources = readdirSync(repositoryPath('infra/lambdas/alarm-digest')).sort();
    const zipped = [...DIGEST_TF.matchAll(/^\s+filename = "([^"]+)"$/gmu)].map(match => match[1]).sort();
    expect(zipped).toEqual(sources);
    expect(DIGEST_TF).toContain('handler       = "index.handler"');
  });

  it('encrypts the function environment with the namespace key, never the AWS-managed aws/lambda key', () => {
    // The first production apply of the digest (25 September 2026) was refused
    // CreateFunction: with no kms_key_arn, Lambda encrypts the environment with aws/lambda in
    // the caller's session, and the deployment role's KMS deny covers every untagged key.
    const block = DIGEST_TF.slice(DIGEST_TF.indexOf('resource "aws_lambda_function" "digest" {'));
    const body = block.slice(0, block.indexOf('\n}\n'));
    expect(body).toContain('  environment {');
    expect(body).toContain('  kms_key_arn = local.topic_key_arn\n');
  });
});
