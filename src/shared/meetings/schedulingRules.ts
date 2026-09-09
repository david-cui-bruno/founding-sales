import { meetingIntentSchema, schedulingRulesSchema, type MeetingIntent, type SchedulingRules, type BusyInterval } from '../contracts/meetingContract';
const minute = 60000;
function localAt(time: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(time);
  const part = (key: string) => parts.find(p => p.type === key)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
/** Compare wall time back through Intl. Never parse a wall time in the host zone. */
export function resolveLocalTime(local: string, timezone: string, offset: string | null): { kind: 'resolved'; instant: string } | { kind: 'clarification' } {
  const fail = { kind: 'clarification' as const };
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(local)) return fail;
  const nominal = Date.parse(`${local}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== local) return fail;
  try {
    if (offset !== null) {
      if (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset)) return fail;
      const instant = Date.parse(local + offset);
      return Number.isFinite(instant) && localAt(instant, timezone) === local ? { kind: 'resolved', instant: new Date(instant).toISOString() } : fail;
    }
    // Discover the zone's offsets on both sides of a transition, including half-hour DST.
    const offsets = new Set<number>();
    for (let h = -36; h <= 36; h += 3) {
      const sample = nominal + h * 3600000;
      offsets.add(Date.parse(localAt(sample, timezone) + 'Z') - sample);
    }
    const matches = [...offsets].map(delta => nominal - delta).filter(time => localAt(time, timezone) === local);
    return matches.length === 1 ? { kind: 'resolved', instant: new Date(matches[0]!).toISOString() } : fail;
  } catch { return fail; }
}
export function validateMeetingIntent(input: unknown, configuration: unknown, now: string): { allowed: true } | { allowed: false; reason: string } {
  const held = (reason: string) => ({ allowed: false as const, reason });
  const parsed = meetingIntentSchema.safeParse(input); const configured = schedulingRulesSchema.safeParse(configuration);
  if (!parsed.success || !configured.success || !Number.isFinite(Date.parse(now))) return held('invalid_meeting');
  const intent: MeetingIntent = parsed.data; const rules: SchedulingRules = configured.data;
  if (!rules.confirmed) return held('rules_unconfirmed');
  if (intent.rulesRevision !== rules.revision) return held('rules_changed');
  if (!rules.conflictCalendarIds.includes(rules.ownedCalendarId) || new Set(rules.conflictCalendarIds).size !== rules.conflictCalendarIds.length
    || rules.weeklyWindows.some(w => w.start >= w.end)) return held('invalid_rules');
  if (!intent.agreementEvidenceId || !intent.agreement) return held('slot_not_agreed');
  if (/[?]|\b(not|no|never|maybe|perhaps|unavailable|cannot|can't|don't|unsure)\b/i.test(intent.agreement.quote)) return held('agreement_unclear');
  if (intent.mixedReply && !intent.approvalId) return held('mixed_reply_requires_approval');
  if (intent.operation === 'cancel' && (intent.agreement.kind !== 'cancellation' || !/\bcancel\b/i.test(intent.agreement.quote))) return held('cancellation_not_agreed');
  if (intent.operation === 'cancel') return rules.allowCancel && intent.etag ? { allowed: true } : held('cancellation_not_allowed');
  if (intent.operation === 'update' && (!rules.allowReschedule || !intent.etag)) return held('reschedule_not_allowed');
  if (intent.agreement.kind === 'cancellation' || (intent.agreement.kind === 'delegated_choice' && !/\b(choose|pick|select)\b/i.test(intent.agreement.quote))) return held('agreement_unclear');
  if (intent.timezone !== rules.timezone) return held('timezone_mismatch');
  const resolved = resolveLocalTime(intent.localStart, intent.timezone, intent.offset);
  if (resolved.kind !== 'resolved' || Date.parse(resolved.instant) !== Date.parse(intent.start)) return held('time_clarification_required');
  const start = Date.parse(intent.start); const end = Date.parse(intent.end);
  if (end - start !== rules.durationMinutes * minute) return held('duration_mismatch');
  if (start < Date.parse(now) + rules.minimumNoticeMinutes * minute) return held('minimum_notice');
  if (end > Date.parse(now) + rules.horizonDays * 86400000) return held('outside_horizon');
  const agreement = intent.agreement;
  if (agreement.kind === 'explicit_slot' ? start !== Date.parse(agreement.start) || end !== Date.parse(agreement.end)
    : agreement.kind === 'delegated_choice' && (start < Date.parse(agreement.notBefore) || end > Date.parse(agreement.notAfter))) return held('outside_agreement');
  const localEnd = localAt(end, rules.timezone); const weekday = new Date(intent.localStart.slice(0, 10) + 'T00:00:00Z').getUTCDay();
  if (localEnd.slice(0, 10) !== intent.localStart.slice(0, 10) || !rules.weeklyWindows.some(w => w.weekday === weekday
    && intent.localStart.slice(11, 19) >= `${w.start}:00` && localEnd.slice(11, 19) <= `${w.end}:00`)) return held('outside_window');
  return { allowed: true };
}
export function overlapsWithBuffers(slot: BusyInterval, busy: readonly BusyInterval[], rules: Pick<SchedulingRules, 'bufferBeforeMinutes' | 'bufferAfterMinutes'>): boolean {
  const start = Date.parse(slot.start) - rules.bufferBeforeMinutes * minute; const end = Date.parse(slot.end) + rules.bufferAfterMinutes * minute;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return true;
  return busy.some(interval => {
    const a = Date.parse(interval.start); const b = Date.parse(interval.end);
    return !Number.isFinite(a) || !Number.isFinite(b) || b <= a || (a < end && b > start);
  });
}

/** Small explicit grammar, not sentiment analysis. The repository must separately
 * prove the offer was actually sent and is the current offer for this thread. */
export function matchOfferedReply(text: string, references: readonly string[], offer: { rfcMessageId: string; slots: { id: string; start: string; end: string; timezone: string }[] }): string[] {
  if (!references.includes(offer.rfcMessageId) || !offer.slots.length) return [];
  const normalized = text.toLowerCase().trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (normalized === 'any of those works, you choose') return offer.slots.map(slot => slot.id);
  if (/^(yes, )?that works( for me)?$/.test(normalized)) return offer.slots.length === 1 ? [offer.slots[0]!.id] : [];
  const matches = offer.slots.filter(slot => {
    try {
      const time = new Date(slot.start);
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: slot.timezone, weekday: 'long' }).format(time).toLowerCase();
      const clock = new Intl.DateTimeFormat('en-US', { timeZone: slot.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(time).toLowerCase().replace(':00', '').replace(/\s+/g, ' ');
      const zone = new Intl.DateTimeFormat('en-US', { timeZone: slot.timezone, timeZoneName: 'longGeneric' }).formatToParts(time).find(p => p.type === 'timeZoneName')!.value.toLowerCase().replace(/ time$/, '');
      return normalized === `${weekday} at ${clock} ${zone} works for me` || normalized === `${weekday} at ${clock} ${zone} works`;
    } catch { return false; }
  });
  return matches.length === 1 ? [matches[0]!.id] : [];
}

/** Rendered into the actual frozen offered email, then verified against its hash. */
export function offeredSlotText(slot: { start: string; end: string; timezone: string }): string {
  const date = new Intl.DateTimeFormat('en-US', { timeZone: slot.timezone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(slot.start));
  const clock = (instant: string) => new Intl.DateTimeFormat('en-US', { timeZone: slot.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(instant));
  return `${date} at ${clock(slot.start)} to ${clock(slot.end)} (${slot.timezone})`;
}
