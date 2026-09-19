import { US_STATE_CODES } from '../../../../src/shared/contracts/territoryClearanceContract';
import { CALL_NOTE_MAX, NEVER_CALL_REASON_MAX, TODAY_LANES, V1_CALL_OUTCOMES, type AddFirmCommand, type LogCallOutcomeCommand,
  type TodayCard, type TodayView, type V1CallOutcome, type V1StateCode } from '../../../../src/shared/contracts/v1Contract';

/**
 * The outcome form and the add-a-firm form, as pure models (FSS target design section 3; slice S2). No React and no
 * IPC here: what the ten buttons say, what a draft has to carry before it can be recorded, and the command each one
 * becomes. The worker decides everything that follows from an outcome; the form only says which one it was.
 *
 * Recording is not dialing and not sending. A never-call reason suppresses the firm permanently, which is why the
 * form refuses an empty one: a permanent decision is never taken without David's own words for it.
 */

export const OUTCOME_LABELS: Readonly<Record<V1CallOutcome, string>> = Object.freeze({
  answered_interested: 'Answered, interested',
  answered_not_interested: 'Answered, not interested',
  gatekeeper: 'Gatekeeper',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  busy: 'Busy',
  wrong_number: 'Wrong number',
  requested_info: 'Asked for information',
  callback: 'Callback',
  opt_out: 'Asked to stop',
});
/** The ten buttons, in the order the form shows them. */
export const OUTCOME_ORDER: readonly V1CallOutcome[] = Object.freeze([...V1_CALL_OUTCOMES]);

export type OutcomeDraft = {
  outcome: V1CallOutcome | null;
  note: string;
  /** `YYYY-MM-DD`, from the date field; empty until David picks one. */
  callbackOn: string;
  neverCall: boolean;
  neverCallReason: string;
};
export const emptyOutcomeDraft = (): OutcomeDraft => ({ outcome: null, note: '', callbackOn: '', neverCall: false, neverCallReason: '' });

export type OutcomeProblem = 'outcome_missing' | 'callback_date_missing' | 'callback_date_invalid' | 'never_call_reason_missing' | 'note_too_long' | 'never_call_reason_too_long';
export const OUTCOME_PROBLEM_SENTENCES: Readonly<Record<OutcomeProblem, string>> = Object.freeze({
  outcome_missing: 'Pick what happened on the call.',
  callback_date_missing: 'A callback needs the day you promised.',
  callback_date_invalid: 'That is not a day: use the date field.',
  never_call_reason_missing: 'Never calling a firm again is permanent. Say why.',
  note_too_long: `A note is at most ${CALL_NOTE_MAX} characters.`,
  never_call_reason_too_long: `A never-call reason is at most ${NEVER_CALL_REASON_MAX} characters.`,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** What stops this draft from being recorded, or null. Pure. */
export function outcomeProblem(draft: OutcomeDraft): OutcomeProblem | null {
  if (draft.outcome === null) return 'outcome_missing';
  if (draft.note.length > CALL_NOTE_MAX) return 'note_too_long';
  if (draft.outcome === 'callback') {
    if (draft.callbackOn.trim().length === 0) return 'callback_date_missing';
    if (!DATE.test(draft.callbackOn.trim()) || Number.isNaN(Date.parse(draft.callbackOn.trim()))) return 'callback_date_invalid';
  }
  if (draft.neverCall) {
    if (draft.neverCallReason.trim().length === 0) return 'never_call_reason_missing';
    if (draft.neverCallReason.trim().length > NEVER_CALL_REASON_MAX) return 'never_call_reason_too_long';
  }
  return null;
}

/** Whether recording this draft will suppress the firm for good. Pure; what the form's warning line reads. */
export const outcomeSuppresses = (draft: OutcomeDraft): boolean => draft.neverCall || draft.outcome === 'opt_out';

/**
 * The command one draft becomes, or the problem that stops it. `commandId` is the caller's, minted once per attempt
 * and reused on a retry, so a lost answer never records the call twice.
 */
export function logCallOutcomeCommand(input: { commandId: string; firmId: string; observedAt: string; draft: OutcomeDraft }):
{ command: LogCallOutcomeCommand } | { problem: OutcomeProblem } {
  const problem = outcomeProblem(input.draft);
  if (problem) return { problem };
  const note = input.draft.note.trim();
  const reason = input.draft.neverCallReason.trim();
  return { command: { commandId: input.commandId, kind: 'log_call_outcome', firmId: input.firmId, outcome: input.draft.outcome!,
    observedAt: input.observedAt,
    ...(note.length > 0 ? { note } : {}),
    ...(input.draft.outcome === 'callback' ? { callbackOn: input.draft.callbackOn.trim() } : {}),
    ...(input.draft.neverCall ? { neverCall: { reason } } : {}) } };
}

export type AddFirmDraft = { name: string; city: string; state: string; phone: string; email: string; site: string };
export const emptyAddFirmDraft = (): AddFirmDraft => ({ name: '', city: '', state: '', phone: '', email: '', site: '' });
export type AddFirmProblem = 'name_missing' | 'city_missing' | 'state_missing' | 'state_unknown' | 'route_missing' | 'both_routes';
export const ADD_FIRM_PROBLEM_SENTENCES: Readonly<Record<AddFirmProblem, string>> = Object.freeze({
  name_missing: 'A firm needs a name.',
  city_missing: 'A firm needs a city.',
  state_missing: 'A firm needs a state: the state decides its clock.',
  state_unknown: 'That is not a two-letter state code.',
  route_missing: 'Give a phone or a business email: a firm with neither cannot be reached.',
  both_routes: 'Give a phone or an email, not both. Admit the second one on the firm afterwards.',
});
/** The state codes the form offers, as the shared contract fixes them. */
export const ADD_FIRM_STATES: readonly V1StateCode[] = Object.freeze([...US_STATE_CODES]);

export function addFirmProblem(draft: AddFirmDraft): AddFirmProblem | null {
  if (draft.name.trim().length === 0) return 'name_missing';
  if (draft.city.trim().length === 0) return 'city_missing';
  const state = draft.state.trim().toUpperCase();
  if (state.length === 0) return 'state_missing';
  if (!(ADD_FIRM_STATES as readonly string[]).includes(state)) return 'state_unknown';
  const phone = draft.phone.trim(); const email = draft.email.trim();
  if (phone.length === 0 && email.length === 0) return 'route_missing';
  if (phone.length > 0 && email.length > 0) return 'both_routes';
  return null;
}

export function addFirmCommand(input: { commandId: string; draft: AddFirmDraft }): { command: AddFirmCommand } | { problem: AddFirmProblem } {
  const problem = addFirmProblem(input.draft);
  if (problem) return { problem };
  const phone = input.draft.phone.trim(); const email = input.draft.email.trim(); const site = input.draft.site.trim();
  return { command: { commandId: input.commandId, kind: 'add_firm', name: input.draft.name.trim(), city: input.draft.city.trim(),
    state: input.draft.state.trim().toUpperCase() as V1StateCode,
    ...(site.length > 0 ? { site } : {}), ...(phone.length > 0 ? { phone } : {}), ...(email.length > 0 ? { email } : {}) } };
}

/** The path of one firm's page, as the design names it. The client has one window, so this is a label and a test anchor. */
export const firmRoute = (firmId: string): string => `/firms/${firmId}`;

/**
 * The view with one firm's card replaced by the one a command returned, or removed when the command returned none
 * (a suppressed firm has left the list for good). Pure: the page updates from the worker's answer instead of
 * re-reading, and a firm the answer does not name is left exactly as it was.
 */
export function withCard(view: TodayView, firmId: string, card: TodayCard | null): TodayView {
  if (view.list === null) return view;
  const lanes = { ...view.list.lanes };
  let changed = false;
  for (const lane of TODAY_LANES) {
    const held = lanes[lane];
    if (!held.some(entry => entry.firmId === firmId)) continue;
    changed = true;
    lanes[lane] = card === null ? held.filter(entry => entry.firmId !== firmId)
      : held.map(entry => entry.firmId === firmId ? card : entry);
  }
  if (!changed) return view;
  const counts = { replies: lanes.replies.length, callbacks: lanes.callbacks.length, due: lanes.due.length, new: lanes.new.length };
  return { ...view, list: { ...view.list, header: { ...view.list.header, counts }, lanes } };
}
