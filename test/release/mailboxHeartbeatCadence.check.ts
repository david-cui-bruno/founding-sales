import { describe, expect, it } from 'vitest';
import type { QueryOutcome, QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { HEARTBEAT_GRACE_SECONDS } from '@fss/domain/jobs';
import { MAILBOX_CHECK_INTERVAL_SECONDS, recordMailboxHeartbeat } from '@fss/domain/mail';
import { DEFAULT_SCHEDULER_INTERVAL_MILLISECONDS } from '../../apps/worker/src/bootstrap/config.ts';
import { mailSyncReconciliationSource } from '../../apps/worker/src/scheduler/mailSources.ts';
import { SCHEDULER_PASS_INTERVAL_MILLISECONDS } from '../../apps/worker/src/scheduler/schedulerPass.ts';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * The mailbox heartbeat, the check that writes it and the alarm that reads it say the
 * same thing (13.3, lane g58).
 *
 * The evidence is production on 24 September 2026, one connected mailbox, sending off:
 * `fss-prod-mailbox-heartbeat-missed` went ALARM and OK at 22:30–22:37Z and again at
 * 22:52–22:53Z on a healthy worker with no warning or error in its log. The alarm is
 * `MailboxCheckHeartbeat` Sum < 1 for three of three one-minute periods, and the
 * heartbeat promised sixty seconds, but the scheduler's reconciliation sweep only asked
 * for a check of a mailbox five minutes past its last sync. The metric was fresh when a
 * Gmail push happened to arrive — every two to four minutes — and the alarm fired in
 * every quiet stretch of three.
 *
 * Four numbers have to agree, and this file reads each from where it is enforced
 * rather than from a copy: the interval `recordMailboxHeartbeat` actually writes, the
 * scheduler's pass interval (the check's real cadence, now that every pass asks for
 * one), the alarm's period and its datapoints, and the grace `readHeartbeats` allows a
 * mailbox check.
 *
 * ## The vacuous-pass traps, named
 *
 * Three.
 *
 * Comparing `MAILBOX_CHECK_INTERVAL_SECONDS` with the alarm would pass while
 * `recordMailboxHeartbeat` wrote something else — the heartbeat default, or a sweep
 * interval somebody "aligned" it with. Closed by calling the real function against a
 * recording connection and reading the value bound to the `expected_interval_seconds`
 * column of the statement it sends.
 *
 * Comparing the heartbeat with the alarm would pass while the sweep still checked every
 * five minutes, which is the incident: both said sixty and the check did not keep it.
 * Closed by running the real sweep with a mailbox the database says was synced a
 * second ago and requiring a `mail.sync` for it, and by refusing any `last_synced_at`
 * term in the query it sends. `apps/worker/test/mailHandlers.test.ts` proves the same
 * against a real PostgreSQL, with a real sync before every pass.
 *
 * And the other way out of the disagreement — raising the alarm's period to the sweep's
 * five minutes — would pass a check that only compared the alarm with itself. Closed by
 * requiring period × datapoints to equal the promise × 13.3's three, and the period to
 * equal the promise. The mutation appended to `scripts/releaseMutationCheck.mjs` sets
 * the mailbox alarm's period to 300 and requires this file to go red.
 */

const ALERTS = readRepositoryFile('infra/modules/alerts/main.tf');
const ALERT_VARIABLES = readRepositoryFile('infra/modules/alerts/variables.tf');
const STACK = readRepositoryFile('infra/modules/stack/main.tf');

/** One entry of `local.alarms`, its attributes as written. */
function alarm(key: string): Readonly<Record<string, string>> {
  const start = ALERTS.indexOf(`    ${key} = {\n`);
  expect(start, `infra/modules/alerts/main.tf declares no ${key} alarm`).toBeGreaterThan(-1);
  const end = ALERTS.indexOf('\n    }', start);
  const attributes: Record<string, string> = {};
  for (const line of ALERTS.slice(start, end).split('\n').slice(1)) {
    const match = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) attributes[match[1]] = match[2];
  }
  return attributes;
}

/** A variable's literal default in `infra/modules/alerts/variables.tf`. */
function variableDefault(name: string): number {
  const start = ALERT_VARIABLES.indexOf(`variable "${name}" {`);
  expect(start, `infra/modules/alerts/variables.tf declares no ${name}`).toBeGreaterThan(-1);
  const block = ALERT_VARIABLES.slice(start, ALERT_VARIABLES.indexOf('\n}', start));
  const match = /\n\s*default\s*=\s*([0-9]+)[ \t]*(?:\n|$)/.exec(block);
  expect(match?.[1], `${name} has no literal numeric default`).toBeDefined();
  return Number(match?.[1]);
}

/** An alarm attribute that is a number, or a `var.` reference resolved to its default. */
function numeric(value: string | undefined): number {
  expect(value).toBeDefined();
  const reference = /^var\.([a-z_]+)$/.exec(value ?? '');
  return reference?.[1] === undefined ? Number(value) : variableDefault(reference[1]);
}

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A connection that records every statement and answers each from `answer`. */
function recordingSession(
  answer: (text: string) => readonly QueryResultRowLike[] = () => [],
): SessionQueryable & { readonly statements: Statement[] } {
  const statements: Statement[] = [];
  return {
    statements,
    query: async <Row extends QueryResultRowLike = QueryResultRowLike>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryOutcome<Row>> => {
      statements.push({ text, values });
      await Promise.resolve();
      const rows = answer(text) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
}

/** The text inside the balanced parentheses that open at the first `(` after `from`. */
function parenthesised(text: string, from: number): string {
  const open = text.indexOf('(', from);
  let depth = 0;
  for (let index = open; index >= 0 && index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') depth -= 1;
    if (depth === 0) return text.slice(open + 1, index);
  }
  return '';
}

/** Split a list on the commas that are not inside parentheses. */
function topLevelItems(list: string): readonly string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

/** The value `recordMailboxHeartbeat` binds to `expected_interval_seconds`. */
async function writtenMailboxInterval(): Promise<number> {
  const session = recordingSession();
  await recordMailboxHeartbeat(session, {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    mailboxId: '00000000-0000-4000-8000-000000000002',
  });
  const insert = session.statements.find(statement => statement.text.includes('INSERT INTO heartbeats'));
  expect(insert, 'recordMailboxHeartbeat sent no INSERT INTO heartbeats').toBeDefined();
  const text = insert?.text ?? '';
  const columns = topLevelItems(parenthesised(text, text.indexOf('INSERT INTO heartbeats')));
  const values = topLevelItems(parenthesised(text, text.indexOf('VALUES')));
  expect(columns.length, 'the heartbeat INSERT names as many columns as values').toBe(values.length);
  expect(columns).toContain('expected_interval_seconds');
  const placeholder = /^\$([0-9]+)/.exec(values[columns.indexOf('expected_interval_seconds')] ?? '');
  expect(placeholder?.[1], 'expected_interval_seconds is bound to a parameter').toBeDefined();
  return Number(insert?.values[Number(placeholder?.[1]) - 1]);
}

describe('g58: the mailbox check, its heartbeat and its alarm agree', () => {
  const missed = alarm('mailbox_heartbeat_missed');

  it('writes the heartbeat with the interval the check promises', async () => {
    expect(await writtenMailboxInterval()).toBe(MAILBOX_CHECK_INTERVAL_SECONDS);
    expect(MAILBOX_CHECK_INTERVAL_SECONDS).toBe(60);
  });

  it('keeps that promise: a check on every scheduler pass, and a pass a minute', async () => {
    // The sweep is the check's cadence, so the pass interval is the check interval.
    expect(SCHEDULER_PASS_INTERVAL_MILLISECONDS).toBe(MAILBOX_CHECK_INTERVAL_SECONDS * 1000);
    expect(DEFAULT_SCHEDULER_INTERVAL_MILLISECONDS).toBe(MAILBOX_CHECK_INTERVAL_SECONDS * 1000);

    // A mailbox the database says was synced a second ago is still asked for. The
    // recording connection answers the mailbox query whatever its WHERE says, so the
    // query text is read too: a "synced recently" term there is the five-minute sweep.
    const mailboxId = '00000000-0000-4000-8000-0000000000aa';
    const workspaceId = '00000000-0000-4000-8000-0000000000bb';
    const session = recordingSession(text => {
      if (/FROM mailboxes/.test(text)) {
        return [{ workspace_id: workspaceId, id: mailboxId, history_id: '1010', last_synced_at: new Date() }];
      }
      if (/INSERT INTO jobs/.test(text)) {
        return [{ id: 'job-1', state: 'queued', history_id: null, was_present: true, previous_state: 'done' }];
      }
      return [];
    });
    await mailSyncReconciliationSource().find(session, new Date().toISOString());

    const due = session.statements.find(statement => /FROM mailboxes/.test(statement.text));
    expect(due?.text).toContain("status = 'connected'");
    expect(due?.text).toContain("sync_state = 'ready'");
    expect(due?.text).not.toMatch(/last_synced_at|make_interval|interval '/);
    const asked = session.statements.filter(
      statement => /INSERT INTO jobs/.test(statement.text) && statement.text.includes("'mail.sync'"),
    );
    expect(asked.map(statement => statement.values[1])).toEqual([`mail-sync:${mailboxId}`]);
  });

  it('alarms on 13.3’s three missed one-minute checks: one datapoint per promised check', async () => {
    const written = await writtenMailboxInterval();
    const checks = variableDefault('heartbeat_missed_checks');
    expect(checks).toBe(3);
    expect(missed['metric_name']).toBe('"MailboxCheckHeartbeat"');
    expect(missed['statistic']).toBe('"Sum"');
    expect(missed['comparison']).toBe('"LessThanThreshold"');
    expect(numeric(missed['threshold'])).toBe(1);
    expect(missed['treat_missing_data']).toBe('"breaching"');
    expect(missed['description']).toBe('"Three missed one-minute mailbox checks."');

    // Each period is one promised check, and the alarm needs every one of three.
    expect(numeric(missed['period'])).toBe(written);
    expect(missed['evaluation_periods']).toBe('var.heartbeat_missed_checks');
    expect(missed['datapoints_to_alarm']).toBe('var.heartbeat_missed_checks');
    expect(numeric(missed['period']) * numeric(missed['datapoints_to_alarm'])).toBe(written * checks);
    expect(numeric(missed['evaluation_periods'])).toBe(numeric(missed['datapoints_to_alarm']));

    // Production deploys the module default: the stack does not override the count.
    const stackCall = STACK.slice(STACK.indexOf('module "alerts" {'), STACK.indexOf('module "updates" {'));
    expect(stackCall).toContain('source = "../alerts"');
    expect(stackCall).not.toContain('heartbeat_missed_checks');
  });

  it('allows the mailbox check and the scheduler pass less than one interval of lateness, and the api and worker none', async () => {
    const written = await writtenMailboxInterval();
    const grace = HEARTBEAT_GRACE_SECONDS.mailbox;
    // More than a claim's worth, so a healthy check a second behind its pass is not a
    // zero; less than an interval, so a check that never comes is a zero in its own
    // minute and three of them alarm within period × datapoints + grace of the last.
    expect(grace).toBeGreaterThanOrEqual(5);
    expect(grace).toBeLessThan(written);
    expect(grace).toBeLessThanOrEqual(numeric(missed['period']) / 2);

    // The scheduler pass has the same shape as the check it asks for: one fixed-delay
    // pass a minute, sampled by another fixed-delay loop. Same grace, same alarm shape.
    // Without it the metric read a running scheduler as stale for six minutes at a
    // stretch after each worker replacement (25 Sep 2026).
    expect(HEARTBEAT_GRACE_SECONDS.scheduler).toBe(grace);
    const scheduler = alarm('scheduler_heartbeat_missed');
    expect(numeric(scheduler['period'])).toBe(60);
    expect(scheduler['datapoints_to_alarm']).toBe('var.heartbeat_missed_checks');

    // The API and worker heartbeats keep the plain rule, on alarms of the same shape.
    for (const [component, key] of [
      ['api', 'api_heartbeat_missed'],
      ['worker', 'worker_heartbeat_missed'],
    ] as const) {
      expect(HEARTBEAT_GRACE_SECONDS[component], component).toBe(0);
      const other = alarm(key);
      expect(numeric(other['period']), key).toBe(60);
      expect(other['datapoints_to_alarm'], key).toBe('var.heartbeat_missed_checks');
    }
  });
});
