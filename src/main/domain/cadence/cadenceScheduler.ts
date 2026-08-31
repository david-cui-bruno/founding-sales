import type {
  CadenceActionComponent,
  CadenceStep,
  CallWindow,
} from './cadenceTypes';

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ChannelPolicyWindow = {
  readonly days: readonly Weekday[];
  readonly startMinute: number;
  readonly endMinute: number;
  readonly label: string;
};

export type ChannelPolicySnapshot = {
  readonly id: string;
  readonly windows: readonly ChannelPolicyWindow[];
};

export type ChannelPolicySnapshots = {
  readonly call: ChannelPolicySnapshot;
  readonly text: ChannelPolicySnapshot;
  readonly email: ChannelPolicySnapshot;
};

export type ScheduleComponentInput = {
  step: CadenceStep;
  component: CadenceActionComponent;
  anchorAt: string;
  evaluationAt: string;
  timezone: string;
  policies: ChannelPolicySnapshots;
  priorCallWindow: CallWindow | null;
};

export type ScheduledComponent = {
  dueAt: string;
  timezone: string;
  allowedWindow: string;
  slaDueAt: string | null;
};

const mondayToSaturday = [1, 2, 3, 4, 5, 6] as const;

export const FOUNDER_CHANNEL_POLICIES_V1: ChannelPolicySnapshots = deepFreeze({
  call: {
    id: 'founder_call_v1',
    windows: [
      { days: mondayToSaturday, startMinute: 9 * 60, endMinute: 12 * 60, label: 'morning' },
      { days: mondayToSaturday, startMinute: 13 * 60, endMinute: 17 * 60, label: 'afternoon' },
      { days: mondayToSaturday, startMinute: 17 * 60, endMinute: 20 * 60, label: 'evening' },
      { days: [0], startMinute: 13 * 60, endMinute: 17 * 60, label: 'afternoon' },
    ],
  },
  text: {
    id: 'founder_text_v1',
    windows: [
      { days: mondayToSaturday, startMinute: 9 * 60, endMinute: 20 * 60, label: 'mon-sat' },
      { days: [0], startMinute: 13 * 60, endMinute: 17 * 60, label: 'sunday' },
    ],
  },
  email: {
    id: 'founder_email_v1',
    windows: [
      { days: mondayToSaturday, startMinute: 8 * 60, endMinute: 20 * 60, label: 'mon-sat' },
      { days: [0], startMinute: 13 * 60, endMinute: 17 * 60, label: 'sunday' },
    ],
  },
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

type LocalDate = { year: number; month: number; day: number };
type LocalDateTime = LocalDate & { hour: number; minute: number; second: number; millisecond: number };

export function scheduleComponent(input: ScheduleComponentInput): ScheduledComponent {
  const anchorEpoch = parseInstant(input.anchorAt);
  const evaluationEpoch = parseInstant(input.evaluationAt);
  assertTimezone(input.timezone);
  validatePolicies(input.policies);
  if (!input.step.components.some(({ id }) => id === input.component.id)) {
    throw new CadenceSchedulingError('The component does not belong to the supplied step.');
  }

  const anchorDate = dateOnly(toLocal(anchorEpoch, input.timezone));
  const targetDate = addLocalDays(anchorDate, input.step.dayOffset);
  const policy = policyFor(input.component, input.policies);
  const desiredCallWindow = input.step.timing.differentCallWindow
    ? differentCallWindow(input.priorCallWindow)
    : null;
  const scheduled = findNextWindow({
    targetDate,
    evaluationEpoch,
    timezone: input.timezone,
    policy,
    desiredCallWindow,
  });

  const slaDueAt = input.step.timing.finalSlaDayOffset === null
    ? null
    : endOfFinalAllowedWindow(
      addLocalDays(anchorDate, input.step.timing.finalSlaDayOffset),
      input.timezone,
      input.policies.call,
    );
  return {
    dueAt: new Date(scheduled.epoch).toISOString(),
    timezone: input.timezone,
    allowedWindow: input.component.actionType === 'call'
      ? scheduled.window.label
      : `${policy.id}:${scheduled.window.label}`,
    slaDueAt,
  };
}

export function nextStrictFutureOctoberOne(input: {
  evaluationAt: string;
  timezone: string;
}): { dueAt: string; localDate: string } {
  const evaluationEpoch = parseInstant(input.evaluationAt);
  assertTimezone(input.timezone);
  const local = toLocal(evaluationEpoch, input.timezone);
  let year = local.year;
  let candidate = localToEpoch({ year, month: 10, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 }, input.timezone);
  if (candidate <= evaluationEpoch) {
    year += 1;
    candidate = localToEpoch({ year, month: 10, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 }, input.timezone);
  }
  return { dueAt: new Date(candidate).toISOString(), localDate: `${year}-10-01` };
}

export function assertCanonicalInstant(value: string, label: string): number {
  try {
    return parseInstant(value);
  } catch {
    throw new CadenceSchedulingError(`${label} must be a canonical UTC timestamp.`);
  }
}

export class CadenceSchedulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CadenceSchedulingError';
  }
}

function policyFor(
  component: CadenceActionComponent,
  policies: ChannelPolicySnapshots,
): ChannelPolicySnapshot {
  if (component.actionType === 'call' || component.actionType === 'voicemail') return policies.call;
  return component.actionType === 'text' ? policies.text : policies.email;
}

function differentCallWindow(prior: CallWindow | null): CallWindow | null {
  if (prior === null) return null;
  return prior === 'morning' ? 'afternoon' : 'morning';
}

function findNextWindow(input: {
  targetDate: LocalDate;
  evaluationEpoch: number;
  timezone: string;
  policy: ChannelPolicySnapshot;
  desiredCallWindow: CallWindow | null;
}): { epoch: number; window: ChannelPolicyWindow } {
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = addLocalDays(input.targetDate, offset);
    const weekday = weekdayFor(date);
    const windows = input.policy.windows
      .filter((window) => window.days.includes(weekday))
      .filter((window) => input.desiredCallWindow === null || window.label === input.desiredCallWindow)
      .sort((left, right) => left.startMinute - right.startMinute);
    for (const window of windows) {
      const start = localAtMinute(date, window.startMinute, input.timezone);
      const end = localAtMinute(date, window.endMinute, input.timezone);
      if (input.evaluationEpoch < end) {
        return { epoch: Math.max(start, input.evaluationEpoch), window };
      }
    }
  }
  throw new CadenceSchedulingError('No allowed channel window exists in the policy horizon.');
}

function endOfFinalAllowedWindow(
  date: LocalDate,
  timezone: string,
  policy: ChannelPolicySnapshot,
): string {
  const weekday = weekdayFor(date);
  const windows = policy.windows
    .filter((window) => window.days.includes(weekday))
    .sort((left, right) => left.endMinute - right.endMinute);
  const finalWindow = windows.at(-1);
  if (finalWindow === undefined) {
    throw new CadenceSchedulingError('The SLA date has no allowed call window.');
  }
  return new Date(localAtMinute(date, finalWindow.endMinute, timezone)).toISOString();
}

function validatePolicies(policies: ChannelPolicySnapshots): void {
  for (const [expected, policy] of Object.entries(policies)) {
    if (policy.id.trim().length === 0 || policy.windows.length === 0) {
      throw new CadenceSchedulingError(`The ${expected} policy is invalid.`);
    }
    for (const window of policy.windows) {
      if (window.days.length === 0 || window.label.trim().length === 0
        || window.startMinute < 0 || window.endMinute > 24 * 60
        || window.startMinute >= window.endMinute
        || window.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new CadenceSchedulingError(`The ${expected} policy has an invalid window.`);
      }
    }
  }
}

function parseInstant(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new CadenceSchedulingError('Invalid timestamp.');
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new CadenceSchedulingError('Invalid timestamp.');
  }
  return epoch;
}

function assertTimezone(timezone: string): void {
  if (timezone.trim().length === 0) throw new CadenceSchedulingError('Timezone is required.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new CadenceSchedulingError('Timezone must be a valid IANA identifier.');
  }
}

function toLocal(epoch: number, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-US-u-hc-h23', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(epoch);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw new CadenceSchedulingError('Timezone conversion failed.');
    return Number(value);
  };
  return {
    year: read('year'), month: read('month'), day: read('day'),
    hour: read('hour'), minute: read('minute'), second: read('second'),
    millisecond: new Date(epoch).getUTCMilliseconds(),
  };
}

function localToEpoch(local: LocalDateTime, timezone: string): number {
  const wanted = Date.UTC(
    local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.millisecond,
  );
  let candidate = wanted;
  for (let index = 0; index < 5; index += 1) {
    const actual = toLocal(candidate, timezone);
    const actualAsUtc = Date.UTC(
      actual.year, actual.month - 1, actual.day,
      actual.hour, actual.minute, actual.second, actual.millisecond,
    );
    const difference = wanted - actualAsUtc;
    if (difference === 0) break;
    candidate += difference;
  }
  const roundtrip = toLocal(candidate, timezone);
  if (localKey(roundtrip) !== localKey(local)) {
    throw new CadenceSchedulingError('The local wall-clock time does not exist in the timezone.');
  }
  return candidate;
}

function localAtMinute(date: LocalDate, minute: number, timezone: string): number {
  const normalized = minute === 24 * 60 ? addLocalDays(date, 1) : date;
  const localMinute = minute === 24 * 60 ? 0 : minute;
  return localToEpoch({
    ...normalized,
    hour: Math.floor(localMinute / 60),
    minute: localMinute % 60,
    second: 0,
    millisecond: 0,
  }, timezone);
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function dateOnly(value: LocalDateTime): LocalDate {
  return { year: value.year, month: value.month, day: value.day };
}

function weekdayFor(date: LocalDate): Weekday {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() as Weekday;
}

function localKey(value: LocalDateTime): string {
  return [
    value.year, value.month, value.day, value.hour,
    value.minute, value.second, value.millisecond,
  ].join('|');
}
