// The daily alarm digest (lane g99; the owner's decision 11C of 25 September 2026).
//
// No alarm e-mails anybody when it trips. Once a day, at 07:00 America/New_York, this
// reads every alarm of one environment and the last 24 hours of their history, and
// publishes one plain-text message to the environment's alert topic: what is not OK now,
// then every state change of the day in time order, or one line when nothing happened.
//
// It takes no input and keeps no state. The same alarms and the same history give the
// same message, so a retried invocation sends the same digest again and nothing else.
//
// Plain JavaScript with no build step and no dependency of its own. `index.mjs` hands it
// the three AWS calls; `test/release/alarmDigest.check.ts` hands it fakes.

export const DEFAULT_TIME_ZONE = 'America/New_York';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 50;
const TRANSITION_LINE_LIMIT = 300;
const REASON_LIMIT = 200;
const STATE_ORDER = { ALARM: 0, INSUFFICIENT_DATA: 1 };

function fieldsOf(date, timeZone) {
  const fields = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  for (const part of format.formatToParts(date)) fields[part.type] = part.value;
  return fields;
}

/** `2026-09-25`, the calendar date in the digest's time zone. */
export function localDate(date, timeZone = DEFAULT_TIME_ZONE) {
  const fields = fieldsOf(date, timeZone);
  return `${fields.year}-${fields.month}-${fields.day}`;
}

/** `2026-09-25 07:00 EDT`. */
export function localTime(date, timeZone = DEFAULT_TIME_ZONE) {
  const fields = fieldsOf(date, timeZone);
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute} ${fields.timeZoneName}`;
}

export function subjectFor(now, timeZone = DEFAULT_TIME_ZONE) {
  return `Callie daily alarm digest — ${localDate(now, timeZone)}`;
}

/** The same subject in ASCII, for an SNS that refuses the dash. */
function asciiSubjectFor(now, timeZone) {
  return `Callie daily alarm digest - ${localDate(now, timeZone)}`;
}

function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function alarmOf(alarm, type) {
  return {
    name: alarm.AlarmName,
    type,
    state: alarm.StateValue ?? 'INSUFFICIENT_DATA',
    since: alarm.StateUpdatedTimestamp === undefined ? undefined : new Date(alarm.StateUpdatedTimestamp),
    reason: oneLine(alarm.StateReason, REASON_LIMIT),
  };
}

/** One StateUpdate history item as a transition: which alarm, when, from what, to what. */
export function transitionOf(item) {
  let from;
  let to;
  try {
    const data = JSON.parse(item.HistoryData ?? '');
    from = data?.oldState?.stateValue;
    to = data?.newState?.stateValue;
  } catch {
    // HistoryData is documented as JSON; the summary below is the fallback when it is not.
  }
  if (typeof from !== 'string' || typeof to !== 'string') {
    const match = /from ([A-Z_]+) to ([A-Z_]+)/u.exec(item.HistorySummary ?? '');
    from = match?.[1];
    to = match?.[2];
  }
  return { name: item.AlarmName, at: new Date(item.Timestamp), from: from ?? '?', to: to ?? '?' };
}

/** Every alarm, metric and composite, whose name starts with the prefix. */
export async function listAlarms(prefix, describeAlarms) {
  const alarms = [];
  let token;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const answer = await describeAlarms({
      AlarmNamePrefix: prefix,
      AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
      MaxRecords: 100,
      ...(token === undefined ? {} : { NextToken: token }),
    });
    for (const alarm of answer.MetricAlarms ?? []) alarms.push(alarmOf(alarm, 'metric'));
    for (const alarm of answer.CompositeAlarms ?? []) alarms.push(alarmOf(alarm, 'composite'));
    token = answer.NextToken;
    if (!token) return alarms.filter(alarm => typeof alarm.name === 'string' && alarm.name.startsWith(prefix));
  }
  throw new Error(`DescribeAlarms for ${prefix} was still paging after ${String(PAGE_LIMIT)} pages`);
}

/**
 * Every state change of the prefix's alarms in the 24 hours to `now`, oldest first.
 *
 * DescribeAlarmHistory has no name prefix, only one exact name, so it is read for the
 * whole account and region and filtered here: one paged read rather than one per alarm.
 */
export async function listTransitions(prefix, now, describeAlarmHistory) {
  const transitions = [];
  let token;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const answer = await describeAlarmHistory({
      AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
      HistoryItemType: 'StateUpdate',
      StartDate: new Date(now.getTime() - DAY_MS),
      EndDate: now,
      ScanBy: 'TimestampAscending',
      MaxRecords: 100,
      ...(token === undefined ? {} : { NextToken: token }),
    });
    for (const item of answer.AlarmHistoryItems ?? []) {
      if (typeof item.AlarmName === 'string' && item.AlarmName.startsWith(prefix)) transitions.push(transitionOf(item));
    }
    token = answer.NextToken;
    if (!token) return { transitions, complete: true };
  }
  return { transitions, complete: false };
}

function byStateThenName(left, right) {
  return (STATE_ORDER[left.state] ?? 2) - (STATE_ORDER[right.state] ?? 2) || left.name.localeCompare(right.name);
}

function byTimeThenName(left, right) {
  return left.at.getTime() - right.at.getTime() || left.name.localeCompare(right.name);
}

/** The message body. Pure: the same arguments give the same text. */
export function renderDigest({ prefix, timeZone = DEFAULT_TIME_ZONE, now, alarms, transitions, historyComplete = true }) {
  const notOk = alarms.filter(alarm => alarm.state !== 'OK').sort(byStateThenName);
  const changes = [...transitions].sort(byTimeThenName);
  const until = localTime(now, timeZone);

  if (alarms.length > 0 && notOk.length === 0 && changes.length === 0 && historyComplete) {
    return `All ${String(alarms.length)} alarms OK. None changed state in the 24 hours to ${until}.\n`;
  }

  const lines = [];
  if (alarms.length === 0) {
    lines.push(`No alarm whose name starts with ${prefix} exists. Nothing is watching this environment.`);
  } else if (notOk.length === 0) {
    lines.push(`Not OK now: none. All ${String(alarms.length)} alarms are OK.`);
  } else {
    lines.push(`Not OK now (${String(notOk.length)} of ${String(alarms.length)} alarms):`);
    for (const alarm of notOk) {
      const kind = alarm.type === 'composite' ? ' (composite)' : '';
      const since = alarm.since === undefined ? '' : `  since ${localTime(alarm.since, timeZone)}`;
      lines.push(`  ${alarm.state.padEnd(17)}  ${alarm.name}${kind}${since}`);
      if (alarm.reason !== '') lines.push(`  ${''.padEnd(17)}  ${alarm.reason}`);
    }
  }

  lines.push('');
  if (changes.length === 0) {
    lines.push(`No alarm changed state in the 24 hours to ${until}.`);
  } else {
    lines.push(`Changed state in the 24 hours to ${until} (${String(changes.length)}), oldest first:`);
    for (const change of changes.slice(0, TRANSITION_LINE_LIMIT)) {
      lines.push(`  ${localTime(change.at, timeZone)}  ${change.name}  ${change.from} → ${change.to}`);
    }
    if (changes.length > TRANSITION_LINE_LIMIT) {
      lines.push(`  … and ${String(changes.length - TRANSITION_LINE_LIMIT)} more.`);
    }
  }
  if (!historyComplete) {
    lines.push(`  The history was longer than ${String(PAGE_LIMIT)} pages; the list above is its oldest part.`);
  }

  lines.push('');
  lines.push('What is in ALARM this minute:');
  lines.push(`  aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix ${prefix}`);
  lines.push('Each alarm has a runbook page: docs/greenfield/runbooks/<alarm key>.md.');
  return `${lines.join('\n')}\n`;
}

function isSubjectRefusal(error) {
  return error?.name === 'InvalidParameterException' && /subject/iu.test(String(error?.message ?? ''));
}

/** Read, render, publish once. Returns counts, never alarm text, for the function's log. */
export async function runDigest({ prefix, topicArn, timeZone, now, describeAlarms, describeAlarmHistory, publish }) {
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9-]*-$/u.test(prefix)) {
    throw new Error('FSS_ALARM_PREFIX must be the environment prefix followed by a hyphen');
  }
  if (typeof topicArn !== 'string' || !topicArn.startsWith('arn:aws:sns:')) {
    throw new Error('FSS_ALERT_TOPIC_ARN must be an SNS topic ARN');
  }
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const at = now ?? new Date();

  const alarms = await listAlarms(prefix, describeAlarms);
  const { transitions, complete } = await listTransitions(prefix, at, describeAlarmHistory);
  const message = renderDigest({ prefix, timeZone: zone, now: at, alarms, transitions, historyComplete: complete });

  let subject = subjectFor(at, zone);
  try {
    await publish({ TopicArn: topicArn, Subject: subject, Message: message });
  } catch (error) {
    if (!isSubjectRefusal(error)) throw error;
    subject = asciiSubjectFor(at, zone);
    await publish({ TopicArn: topicArn, Subject: subject, Message: message });
  }

  return {
    subject,
    alarms: alarms.length,
    notOk: alarms.filter(alarm => alarm.state !== 'OK').length,
    transitions: transitions.length,
    historyComplete: complete,
  };
}
