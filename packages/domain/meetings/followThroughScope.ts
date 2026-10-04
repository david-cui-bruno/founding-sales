import { FOLLOW_UP_PERMISSION_WINDOW_DAYS, meetingFollowThroughScopeSchema, type MeetingFollowThroughScope, type MeetingOutcomesView } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readMeetingOutcomes } from './outcomes.ts';
import { checkedPromise } from './tasks.ts';
import { assembleMeetingAnalysisInput } from './analysisInput.ts';
import type { MeetingResult } from './outcomeTypes.ts';

/** Restrictions are subtractive. Unrecognized communication requests require a person to resolve them. */
export function meetingCommunicationTerms(outcomes: MeetingOutcomesView, sourceText: string): MeetingResult<Pick<MeetingFollowThroughScope, 'purposes' | 'maxMessages' | 'agreedReminder' | 'reminderEvidence'>> {
  const negative = /\b(?:not interested|no (?:more |further )?(?:emails?|follow[ -]?ups?|contact)|(?:do not|don't|don’t|stop|never)\s+(?:email|contact|send|follow|call)|unsubscribe|remove me)\b/iu;
  if (negative.test(sourceText)) return { ok: false, reason: 'scope_needs_review' };
  const reminders = outcomes.items.filter(item => item.provenance === 'stated' && (item.kind === 'next_step' || item.kind === 'commitment')
    && /\b(?:remind(?:er)?|follow[ -]?up|check[ -]?in|reach out)\b/iu.test(item.text));
  if (reminders.length > 1) return { ok: false, reason: 'scope_needs_review' };
  const reminder = reminders[0];
  if (reminder !== undefined) {
    if (reminder.owner !== 'you' || reminder.deadline === null || reminder.reviewReasons.length > 0) return { ok: false, reason: 'scope_needs_review' };
    return { ok: true, value: { purposes: ['reminder'], maxMessages: 1, agreedReminder: reminder.deadline, reminderEvidence: reminder.evidence } };
  }
  if (/\b(?:only|just|single|one)\b[^.\n]{0,80}\b(?:email|message|remind|follow[ -]?up|contact)\b|\b(?:email|contact|follow[ -]?up)\b[^.\n]{0,80}\b(?:later|next|after|until|once|only)\b/iu.test(sourceText)) return { ok: false, reason: 'scope_needs_review' };
  return { ok: true, value: { purposes: ['recap', 'nudge'], maxMessages: 3, agreedReminder: null, reminderEvidence: [] } };
}

export async function resolveMeetingFollowThroughScope(context: RepositoryContext, input: { meetingId: string; contactId: string; sourceHash: string }): Promise<MeetingResult<MeetingFollowThroughScope>> {
  const outcomes = await readMeetingOutcomes(context, input);
  if (outcomes === null) return { ok: false, reason: 'meeting_unknown' };
  if (outcomes.sourceHash !== input.sourceHash) return { ok: false, reason: 'source_changed' };
  const meeting = (await context.db.query<{ contact_id: string | null; current_booking_uid: string; ends_at: Date; attendance_confirmed_at: Date | null; attendance_source: string | null; calcom_absent_pending: boolean }>(
    'SELECT contact_id,current_booking_uid,ends_at,attendance_confirmed_at,attendance_source,calcom_absent_pending FROM meetings WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.meetingId])).rows[0];
  if (meeting === undefined || meeting.contact_id !== input.contactId) return { ok: false, reason: 'recipient_changed' };
  if (outcomes.attendance !== 'attended' || meeting.attendance_confirmed_at === null || meeting.attendance_source === null || meeting.calcom_absent_pending) return { ok: false, reason: 'attendance_unconfirmed' };
  const contact = (await context.db.query('SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 AND status=\'active\'', [context.scope.workspaceId, input.contactId, outcomes.firmId])).rows[0];
  if (contact === undefined) return { ok: false, reason: 'recipient_changed' };
  if (outcomes.state !== 'current' || outcomes.holds.some(h => h !== 'analysis_disabled') || outcomes.items.some(i => i.reviewReasons.length > 0)) return { ok: false, reason: 'notes_incomplete' };
  const sources = await assembleMeetingAnalysisInput(context, input);
  if (!sources.ok) return sources;
  if (sources.value.sourceHash !== input.sourceHash) return { ok: false, reason: 'source_changed' };
  if (!sources.value.complete && !outcomes.notes.sufficient) return { ok: false, reason: 'notes_incomplete' };
  const checked = { ...outcomes, items: outcomes.items.map(item => /\b(?:remind(?:er)?|follow[ -]?up|check[ -]?in|reach out)\b/iu.test(item.text) && ['next_step', 'commitment'].includes(item.kind) ? checkedPromise(item, sources.value) : item) };
  const terms = meetingCommunicationTerms(checked, [outcomes.notes.debrief, ...sources.value.utterances.map(u => u.text), ...outcomes.items.map(i => i.text)].join('\n'));
  if (!terms.ok) return terms;
  const expiresAt = new Date(meeting.ends_at.getTime() + FOLLOW_UP_PERMISSION_WINDOW_DAYS.booking_communications! * 86_400_000).toISOString();
  const deadline = terms.value.agreedReminder;
  if (deadline !== null && (deadline.precision === 'instant' ? Date.parse(deadline.at) >= Date.parse(expiresAt) : deadline.localDate >= expiresAt.slice(0, 10))) return { ok: false, reason: 'reminder_outside_scope' };
  return { ok: true, value: meetingFollowThroughScopeSchema.parse({ ...terms.value, meetingId: input.meetingId, contactId: input.contactId, bookingReference: meeting.current_booking_uid, expiresAt }) };
}
