import type { MeetingDeadline, MeetingFollowThroughScope } from '@fss/contracts';
import { addBusinessDays, type WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';
import { addCalendarDays, localDate, localInstant, localParts } from '../src/rules/localClock.ts';
import { placeEmailSend } from '../src/rules/sendingWindow.ts';
export interface MeetingDelivery { ordinal: number; sentAt: string; messageId?: string; }
export type FollowThroughAction = { kind: 'wait'; until: string | null } | { kind: 'nudge'; ordinal: number; dueAt: string }
  | { kind: 'task'; dueAt: string; deadline: MeetingDeadline } | { kind: 'review'; reason: string } | { kind: 'complete' };
export function nextMeetingFollowThroughAction(input: {
  plan: { scope: MeetingFollowThroughScope | null; maxMessages: number }; deliveryHistory: readonly MeetingDelivery[];
  at: string; calendar: WorkspaceHolidayCalendar; zone: string;
}): FollowThroughAction {
  const { scope } = input.plan, history = [...input.deliveryHistory].sort((a,b) => a.ordinal-b.ordinal);
  if (scope === null) return { kind: 'review', reason: 'permission_missing' };
  const reminder = scope.agreedReminder, max = Math.min(input.plan.maxMessages, scope.maxMessages);
  const task = (): FollowThroughAction => {
    const last = history.at(-1); if (last === undefined) return { kind: 'complete' };
    const date = addBusinessDays(localDate(last.sentAt, input.zone), 2, input.calendar);
    return { kind: 'task', dueAt: localInstant(date, { hour: 8, minute: 0 }, input.zone), deadline: { precision: 'date', localDate: date, zone: input.zone } };
  };
  if (reminder !== null && history.length > 0) return { kind: 'complete' };
  if (history.length >= max) return task();
  let ordinal: number, intended: string;
  if (reminder !== null) {
    ordinal = 1;
    intended = reminder.precision === 'instant' ? reminder.at : localInstant(reminder.localDate, { hour: 8, minute: 0 }, reminder.zone);
  } else {
    const recap = history.find(d => d.ordinal === 1);
    if (recap === undefined) return { kind: 'wait', until: null };
    ordinal = (history.at(-1)?.ordinal ?? 1) + 1;
    if (ordinal > max) return task();
    const parts = localParts(recap.sentAt, input.zone);
    intended = localInstant(addCalendarDays(parts.date, ordinal === 2 ? 7 : 14), { hour: parts.hour, minute: parts.minute }, input.zone);
  }
  const placed = placeEmailSend(intended, input.zone, { calendar: input.calendar });
  const firstNudge = history.find(d => d.ordinal === 2);
  if (ordinal === 3 && firstNudge !== undefined && placed.localDate <= localDate(firstNudge.sentAt, input.zone)) return task();
  if (Date.parse(placed.sendAt) >= Date.parse(scope.expiresAt) || Date.parse(input.at) >= Date.parse(scope.expiresAt)) return { kind: 'review', reason: 'follow_up_expired' };
  if (localDate(input.at, input.zone) > addBusinessDays(placed.localDate, 2, input.calendar)) return { kind: 'review', reason: 'nudge_obsolete' };
  return { kind: 'nudge', ordinal, dueAt: placed.sendAt };
}
export function recapIsStale(endsAt: string, at: string, zone: string, calendar: WorkspaceHolidayCalendar): boolean {
  return localDate(at, zone) > addBusinessDays(localDate(endsAt, zone), 2, calendar);
}
