import type { ChannelPolicySnapshots } from '../cadence/cadenceScheduler';
import type { SourceEvent } from '../source/sourceTypes';
import { LifecycleEvidenceError } from '../support/domainErrors';
import type { InboundSla } from './lifecycleTypes';

export function deriveInboundSla(
  source: SourceEvent,
  timezone: string,
  policies: ChannelPolicySnapshots,
): InboundSla {
  if (source.channel === 'inbound_demo') {
    const dueAt = addPermittedMinutes(source.observedAt, 15, timezone, policies.text);
    return {
      kind: 'inbound_demo_permitted_minutes', dueAt, sourceEventId: source.id,
      provenance: {
        version: 1, sourceEventId: source.id, sourceObservedAt: source.observedAt,
        calculation: 'permitted_minutes', minutes: 15,
        policyId: policies.text.id, computedDueAt: dueAt,
      },
    };
  }
  if (source.channel === 'referral') {
    const dueAt = new Date(Date.parse(source.observedAt) + 48 * 60 * 60 * 1000).toISOString();
    return {
      kind: 'direct_referral_elapsed', dueAt, sourceEventId: source.id,
      provenance: {
        version: 1, sourceEventId: source.id, sourceObservedAt: source.observedAt,
        calculation: 'elapsed_hours', hours: 48, policyId: null, computedDueAt: dueAt,
      },
    };
  }
  return { kind: 'none', dueAt: null, sourceEventId: null, provenance: null };
}

function addPermittedMinutes(
  observedAt: string,
  minutes: number,
  timezone: string,
  policy: ChannelPolicySnapshots['text'],
): string {
  let cursor = Date.parse(observedAt);
  if (!Number.isFinite(cursor)) throw new LifecycleEvidenceError('Inbound source timestamp is invalid.');
  let remaining = minutes;
  for (let inspected = 0; inspected < 21 * 24 * 60 && remaining > 0; inspected += 1) {
    if (isPolicyPermitted(cursor, timezone, policy)) remaining -= 1;
    cursor += 60_000;
  }
  if (remaining > 0) throw new LifecycleEvidenceError('Inbound SLA policy has no usable window.');
  return new Date(cursor).toISOString();
}

function isPolicyPermitted(
  epoch: number,
  timezone: string,
  policy: ChannelPolicySnapshots['text'],
): boolean {
  const parts = new Intl.DateTimeFormat('en-US-u-hc-h23', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(epoch);
  const weekdayName = parts.find(({ type }) => type === 'weekday')?.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName ?? '');
  const hour = Number(parts.find(({ type }) => type === 'hour')?.value);
  const minute = Number(parts.find(({ type }) => type === 'minute')?.value);
  if (weekday < 0 || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new LifecycleEvidenceError('Inbound SLA timezone conversion failed.');
  }
  const minuteOfDay = hour * 60 + minute;
  return policy.windows.some((window) => window.days.includes(
    weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
  ) && minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute);
}
