import type { CallSessionRefusalCode } from './callSessions.ts';
import type { CrmRefusalCode } from './crm.ts';
import type { DialRefusalCode } from './dial.ts';
import type { GrantRefusalCode } from './mail.ts';
import type { HoldReasonCode } from './reasonCodes.ts';
import type { MeetingMatchRefusalCode } from './meetings.ts';
import type { TranscriptionRefusalCode } from './callSessions.ts';
import type { RESEARCH_REFUSAL_CODES } from './research.ts';

/**
 * Plain-language sentences for every code the Mac can show a person (call-to-booking A3).
 *
 * A refusal or a hold reaches a window as a stable code. Showing the code is a bug report
 * for somebody who cannot file one, and `inWords` ("firm zone unknown") is not a sentence
 * that says what to do next. This file is the one place a code becomes a sentence that
 * says what is blocked and what to do about it; every list of codes the views render is a
 * `Record` over that list's own type, so a code added to a contract without a sentence
 * stops the typecheck, and `test/reasonText.test.ts` fails on the lists that are values.
 *
 * Several families share a spelling (`firm_unknown`, `not_assigned`, `route_retired`): one
 * code must never say two things, so the shared ones are written once below and each
 * family's map points at them.
 *
 * The tone is the product's: short, grey, no blame, no internals. `reasonSentence` of a
 * code nothing here knows is a generic sentence that still includes the code in
 * parentheses, so a screenshot of it is useful to whoever reads it next.
 */

const FIRM_UNKNOWN = 'Callie cannot find this firm. Refresh the page; if it is still missing, it may have been merged.';
const NOT_ASSIGNED = 'This firm is assigned to somebody else. Ask an administrator to reassign it if it should be yours.';
const ADMIN_ONLY = 'Only an administrator can do that. Ask one to do it for you.';
const INVALID_INPUT = 'Callie could not use what was entered. Check the fields and try again.';
const ROUTE_RETIRED = 'That number or address was retired. Choose another one for this firm.';
const ROUTE_INVALID = 'That number or address failed its check. Correct it on the firm’s page.';
const ROUTE_VERSION_STALE = 'This page is out of date: the number or address changed since you opened it. Refresh and try again.';
const ZONE_UNRESOLVED = 'Callie does not know this firm’s time zone, so it cannot check the allowed hours. Set the time zone on the firm’s page.';
const FIRM_MERGED = 'This firm was merged into another. Open the firm it became and continue there.';
const FIRM_SUPPRESSED = 'This firm asked not to be contacted, so nothing is sent or called. There is nothing to do; leave it alone.';
const VERSION_UNKNOWN = 'That sequence is not one of this workspace’s. Refresh and choose again.';
const VERSION_NOT_PUBLISHED = 'That sequence version is not published. Publish it or choose a published one.';
const VERSION_HAS_NO_STEPS = 'That sequence has no steps. Add a step, then try again.';
const STEP_UNKNOWN = 'That step is no longer in the sequence. Refresh and choose again.';
const CONTACT_UNKNOWN = 'Callie cannot find that person at this firm. Refresh the page and choose again.';
const OPPORTUNITY_MANUAL = 'This firm is yours to work by hand, so Callie will not act on it automatically.';

// ---------------------------------------------------------------------------
// Holds (specification 15)
// ---------------------------------------------------------------------------

export const HOLD_REASON_SENTENCES: Readonly<Record<HoldReasonCode, string>> = Object.freeze({
  scoped_pause: 'Sending and calling are paused for this firm. Resume it when you are ready.',
  mailbox_disconnected: 'The sales mailbox is not connected, so Callie cannot send. Connect it in Settings, under Mailbox.',
  coverage_incomplete: 'Callie is still reading this mailbox and won’t send from it until it has caught up.',
  template_unapproved: 'The message template has not been approved. Ask an administrator to approve it.',
  optout_link: 'The message would carry a visible opt-out link, which Callie does not send. Edit the template or the sign-off and remove the link.',
  missing_variables: 'The message needs details this firm does not have yet. Fill them in on the firm’s page.',
  daily_cap: 'Today’s sending limit has been reached. Callie will continue when the limit resets.',
  route_missing: 'There is no usable number or address for this firm. Add one on the firm’s page.',
  route_candidate: 'The number or address has not been confirmed yet. Confirm it on the firm’s page.',
  route_invalid: ROUTE_INVALID,
  route_retired: ROUTE_RETIRED,
  outside_email_window: 'It is outside the hours Callie may e-mail this firm. It will send when the window opens.',
  outside_calling_window: 'It is outside the hours Callie may call this firm. Try again when the window opens.',
  posture_missing: 'This firm’s state is not on your “OK to call” list. Add it in Settings if you are cleared to call there.',
  posture_overlapping: 'Two call postures are in force for this firm’s state. Revoke one in Settings.',
  posture_overdue: 'This firm’s state posture needs reviewing. Review it in Settings.',
  firm_suppressed: FIRM_SUPPRESSED,
  handle_suppressed: 'This number or address is on the suppression list, so Callie will not contact it. Use a different contact at the firm.',
  manual_suppression_review: 'A suppression on this firm is waiting for review. An administrator needs to look at it first.',
  uncertain_reply: 'A reply from this firm has not been answered yet. Open Replies and decide what it means.',
  ambiguous_match: 'A reply here could belong to more than one conversation. Open Replies and choose which one.',
  reassignment: 'This firm is being reassigned. Wait for that to finish.',
  opportunity_manual: OPPORTUNITY_MANUAL,
  provider_refusal: 'The provider refused this message or call. Check the firm’s contact details; if they are right, try again later.',
  send_unknown_reconciling: 'Callie is checking whether the last message left the mailbox. It will not send another until it knows.',
  send_unknown_terminal: 'Callie could not confirm whether the last message left. Open Settings, Diagnostics, and record what happened.',
  long_hold_review: 'This firm has been on hold for a long time and needs a review. Decide whether to keep it, then release the hold.',
  restore_in_progress: 'A restore is under way. Sending and calling wait until it finishes.',
  cold_legacy: 'This enrollment predates recorded permission for follow-ups, so it can never send. Start a new enrollment once a valid request is recorded.',
  follow_up_not_permitted: 'Callie has no recorded permission to send this follow-up. Record the firm’s request, or grant the permission from the call or reply.',
  follow_up_expired: 'The permission for this follow-up has run out. Ask the person again; a new request is a new permission.',
  follow_up_scope_exhausted: 'The one e-mail this permission allowed has already gone. Nothing more is sent unless the person asks for more.',
  firm_already_enrolled: 'Another person at this firm is already in a live sequence. This one proceeds when that one ends.',
  cold_outreach_mailbox_required:
    'Prospecting e-mail doesn’t go out from Gmail. Call this firm instead, or record the prospect’s request for an e-mail.',
});

// ---------------------------------------------------------------------------
// Dial refusals (dial.ts)
// ---------------------------------------------------------------------------

export const DIAL_REFUSAL_SENTENCES: Readonly<Record<DialRefusalCode, string>> = Object.freeze({
  firm_suppressed: HOLD_REASON_SENTENCES.firm_suppressed,
  handle_suppressed: 'This number is suppressed, so Callie will not dial it. Try another number for the firm.',
  manual_suppression_review: HOLD_REASON_SENTENCES.manual_suppression_review,
  route_missing: 'That number is not this firm’s any more. Refresh the page and choose another.',
  route_candidate: HOLD_REASON_SENTENCES.route_candidate,
  route_invalid: 'This number is not a working number. Correct it on the firm’s page.',
  route_retired: ROUTE_RETIRED,
  outside_calling_window: 'It is outside this firm’s calling hours. Try again when they open.',
  posture_missing: HOLD_REASON_SENTENCES.posture_missing,
  posture_overlapping: HOLD_REASON_SENTENCES.posture_overlapping,
  posture_overdue: HOLD_REASON_SENTENCES.posture_overdue,
  scoped_pause: 'Calling is paused for this firm. Resume it when you are ready.',
  restore_in_progress: HOLD_REASON_SENTENCES.restore_in_progress,
  reassignment: HOLD_REASON_SENTENCES.reassignment,
  uncertain_reply: HOLD_REASON_SENTENCES.uncertain_reply,
  ambiguous_match: HOLD_REASON_SENTENCES.ambiguous_match,
  opportunity_manual: OPPORTUNITY_MANUAL,
  long_hold_review: HOLD_REASON_SENTENCES.long_hold_review,
  provider_refusal: 'The provider refused this call. Check the number; if it is right, try again later.',
  firm_unknown: FIRM_UNKNOWN,
  not_assigned: NOT_ASSIGNED,
  zone_unresolved: ZONE_UNRESOLVED,
  route_version_stale: ROUTE_VERSION_STALE,
  identity_missing: 'Callie has no calling number of yours. Add it in Settings, under Your calling number.',
  identity_not_owned: 'That calling number is not yours. Choose one of your own in Settings.',
  identity_unverified: 'That calling number has not been verified. Verify it in Settings.',
  identity_disabled: 'That calling number is switched off. Turn it on in Settings or choose another.',
  identity_shared_line_disabled: 'Calling from the shared line is switched off. Use your own number.',
  ticket_unknown: 'Callie does not recognise that call authorisation. Press Call again.',
  ticket_expired: 'That call authorisation ran out. Press Call again.',
  ticket_wrong_device: 'That call was authorised on another Mac. Press Call again on this one.',
  already_consumed: 'That call authorisation was already used. Press Call again for a new one.',
});

/** Shown by Today beside the dial reasons: not a server code, but the same one place for words. */
export const DIAL_ADVICE_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  dial_advice_unavailable: 'Callie could not check whether this number may be called. Try again.',
  not_callable: 'Callie will not place this call now. Check the reasons shown with the number.',
});

// ---------------------------------------------------------------------------
// CRM refusals (crm.ts)
// ---------------------------------------------------------------------------

export const CRM_REFUSAL_SENTENCES: Readonly<Record<CrmRefusalCode, string>> = Object.freeze({
  firm_unknown: FIRM_UNKNOWN,
  firm_merged: FIRM_MERGED,
  contact_unknown: CONTACT_UNKNOWN,
  contact_merged: 'That person was merged into another contact. Open the contact it became.',
  route_unknown: 'That number or address is no longer on this firm. Refresh and choose again.',
  route_retired: ROUTE_RETIRED,
  route_version_stale: ROUTE_VERSION_STALE,
  route_invalid: ROUTE_INVALID,
  evidence_unknown: 'Callie cannot find the evidence you named. Refresh the page and pick it again.',
  not_assigned: NOT_ASSIGNED,
  admin_only: ADMIN_ONLY,
  assignee_unknown: 'Callie cannot find that person to assign the firm to. Choose someone else.',
  stage_unknown: 'That stage does not exist. Choose one from the list.',
  stage_retired: 'That stage was retired. Choose an active stage.',
  stage_key_exists: 'A stage with that name already exists. Choose another name.',
  stage_terminal: 'Won and Lost are fixed stages and cannot be changed this way.',
  stage_last_active: 'This is the last active stage, and deals need somewhere to start. Add another stage first.',
  opportunity_unknown: 'Callie cannot find that deal. Refresh the page.',
  opportunity_closed: 'That deal is already closed. Reopen it first if you want to change it.',
  opportunity_open_exists: 'This firm already has an open deal. Finish that one first.',
  opportunity_not_closed: 'That deal is still open, so there is nothing to reopen.',
  lost_reason_required: 'Say why the deal was lost, then save.',
  zone_unresolved: ZONE_UNRESOLVED,
  merge_same_record: 'Those are the same record. Choose a different one to merge with.',
  merge_cross_firm: 'Those people belong to different firms and cannot be merged. Merge the firms first.',
  merge_conflicts: 'The two records disagree on details Callie cannot combine. Resolve the differences by hand, then merge.',
  merge_already_performed: 'That merge already happened. Refresh the page.',
  live_work_present:
    'This firm still has a live sequence or a pending step. Ask an administrator to end or finish it before releasing manual mode.',
  invalid_input: INVALID_INPUT,
});

// ---------------------------------------------------------------------------
// Research refusals (research.ts)
// ---------------------------------------------------------------------------

export const RESEARCH_REFUSAL_SENTENCES: Readonly<Record<(typeof RESEARCH_REFUSAL_CODES)[number], string>> = Object.freeze({
  invalid_input: INVALID_INPUT,
  research_disabled: 'Research is switched off for this workspace. An administrator can switch it on in Settings.',
  daily_firm_ceiling: 'Today’s limit on researched firms has been reached. Research continues tomorrow.',
  daily_cost_ceiling: 'Today’s research budget is spent. Research continues tomorrow, or an administrator can raise the limit in Settings.',
  monthly_cost_ceiling: 'This month’s research budget is spent. An administrator can raise the limit in Settings.',
  ceiling_reached: 'A research limit has been reached. An administrator can raise it in Settings.',
  firm_unknown: FIRM_UNKNOWN,
  firm_merged: FIRM_MERGED,
  firm_suppressed: FIRM_SUPPRESSED,
  not_assigned: NOT_ASSIGNED,
  admin_only: ADMIN_ONLY,
  run_in_progress: 'Research on this firm is already running. Wait for it to finish.',
  no_sources: 'There is nothing to research from yet. Add a website or link to the firm.',
  provider_failure: 'The research service failed. Try again in a few minutes.',
  lease_lost: 'The research run was interrupted and closed. Start it again.',
  link_not_permitted: 'Callie will not read that link. Add a different one.',
  model_unpriced: 'Research is not set up to be costed yet, so it will not run. Ask an administrator.',
  over_budget: 'This firm has used its research budget for today. Try again tomorrow.',
});

// ---------------------------------------------------------------------------
// Preview and follow-up permission refusals
// ---------------------------------------------------------------------------

/**
 * `FOLLOW_UP_PREVIEW_REFUSALS` lives in `@fss/domain`, which the desktop may not import
 * (14.2), so the list is repeated here as a `Record` and `test/reasonText.test.ts`
 * compares it to the domain's own list.
 */
export const FOLLOW_UP_PREVIEW_REFUSAL_SENTENCES = Object.freeze({
  firm_unknown: FIRM_UNKNOWN,
  not_assigned: NOT_ASSIGNED,
  contact_unknown: CONTACT_UNKNOWN,
  version_unknown: VERSION_UNKNOWN,
  version_not_published: VERSION_NOT_PUBLISHED,
  version_has_no_steps: VERSION_HAS_NO_STEPS,
  step_unknown: STEP_UNKNOWN,
  firm_zone_unknown: ZONE_UNRESOLVED,
  invalid_input: INVALID_INPUT,
} as const);

/**
 * The refusals around a follow-up permission that are not hold codes: the ones a sequence
 * migration or a permission-backed enrollment answers. (The hold codes `follow_up_*` and
 * `cold_legacy` are in `HOLD_REASON_SENTENCES`.)
 */
export const FOLLOW_UP_PERMISSION_REFUSAL_SENTENCES = Object.freeze({
  follow_up_not_permitted: HOLD_REASON_SENTENCES.follow_up_not_permitted,
  follow_up_expired: HOLD_REASON_SENTENCES.follow_up_expired,
  follow_up_scope_exhausted: HOLD_REASON_SENTENCES.follow_up_scope_exhausted,
  cold_legacy_never_revived: 'This enrollment predates recorded permission and cannot be moved. Start a new one once a valid request is recorded.',
  agreed_scope_bound: 'An agreed sequence cannot move on its original agreement. Record a new agreement for the new version.',
  permission_expires_before_step: 'The new permission would run out before the next e-mail could go. Choose a later start or a shorter sequence.',
  remainder_starts_with_call: 'The rest of that sequence starts with a call. Record a new agreement from the call card instead.',
  no_remaining_step: 'Nothing would be left to send after the steps already done. Choose a longer sequence.',
  enrollment_dispatching: 'A message from this enrollment is being sent right now. Try again in a few minutes.',
} as const);

// ---------------------------------------------------------------------------
// Mail refusals the Mac can meet
// ---------------------------------------------------------------------------

export const MAIL_REFUSAL_SENTENCES: Readonly<Record<GrantRefusalCode | 'mailbox_already_connected' | 'mailbox_not_connected', string>> =
  Object.freeze({
    mailbox_switch_not_requested:
      'Google returned a different account than the one connected, and no switch was requested. Your mailbox did not change. Use Switch mailbox in Settings if you meant to change it.',
    mailbox_switch_address_mismatch:
      'You chose a different Google account than the one you asked to switch to. Your mailbox did not change. Try again and choose the address shown in the dialog.',
    mailbox_switch_same_address: 'That is the mailbox that is already connected. Enter the other address to switch.',
    mailbox_switch_wrong_domain: 'That address is outside your workspace’s domain. Switch to an address on your own domain.',
    mailbox_switch_pending_sends: 'A message is still being sent from the current mailbox. Try again in a few minutes.',
    grant_refused: 'Callie couldn’t finish connecting that account. Your mailbox did not change. Try again in a minute.',
    mailbox_address_taken: 'That Google account is already connected to another workspace. Use a different account.',
    authorization_request_unknown: 'That Google sign-in expired or was not started by Callie. Start again from Settings.',
    mailbox_already_connected: 'A mailbox is already connected. To change it, use Switch mailbox in Settings.',
    mailbox_not_connected: 'No mailbox is connected yet. Connect Gmail first.',
  });

// ---------------------------------------------------------------------------
// Call-session refusals (callSessions.ts, call-to-booking slices W and C1)
// ---------------------------------------------------------------------------

export const CALL_SESSION_REFUSAL_SENTENCES: Readonly<Record<CallSessionRefusalCode, string>> = Object.freeze({
  call_attempts_exhausted:
    'Four calls to this firm went unanswered in the last 14 days, so calling it is parked for review. Resume calling when you want to try again.',
  call_attempt_today: 'This firm was already called today. Try again on another business day.',
  call_attempt_too_soon:
    'The last call was at about this time of day. Try at least two hours earlier or later in their day.',
  telephony_budget_disabled: 'Calling from Callie has no budget set. An administrator can set one in Settings, under Calling.',
  telephony_budget_exhausted: 'Calling paused: today’s calling budget is used.',
  caller_id_mismatch: 'Your calling number is not the one Callie’s calling service presents. Ask an administrator to check it.',
});

/**
 * The TwiML consumption's own refusals (slice W). No Mac route answers them today — the
 * caller hears the generic TwiML sentence — but a stored receipt (W's retired attempt
 * limit) can replay one, and each code keeps one sentence here.
 */
export const CALL_CONSUMPTION_REFUSAL_SENTENCES = Object.freeze({
  call_attempt_limit: 'This firm has had as many calls as Callie allows for now. Try again on another day.',
  reservation_closed: "The call couldn't be authorised because today's calling budget changed. Try again.",
} as const);

/**
 * The Mac's own refusals of a Call press (slice C1, fold 3): the start was given up — the
 * card closed, Hang up was pressed, a newer press or another person took over — or the
 * server said calling from Callie is off after the card offered it.
 */
export const CALL_START_REFUSAL_SENTENCES = Object.freeze({
  call_cancelled: 'The call was stopped before it rang. Press Call to try again.',
  calling_off: 'Calling from Callie is turned off. Close and reopen the firm to call from your phone instead.',
} as const);

// ---------------------------------------------------------------------------
// Stage review and the mailbox lock (call-to-booking W, R2)
// ---------------------------------------------------------------------------

/**
 * Why a piece of evidence (a call outcome, a booking) waits for a person instead of moving
 * a deal. `STAGE_REVIEW_REASONS` is the migration 0028 list; the test compares it to the
 * domain's `StageReviewReason` by reading the source.
 */
export const STAGE_REVIEW_REASONS = [
  'opportunity_closed',
  'no_opportunity',
  'stage_missing',
  'rule_missing',
  'firm_unmatched',
  'firm_ambiguous',
] as const;
export type StageReviewReasonCode = (typeof STAGE_REVIEW_REASONS)[number];

export const STAGE_REVIEW_SENTENCES: Readonly<Record<StageReviewReasonCode | 'stage_review', string>> = Object.freeze({
  stage_review: 'Callie needs you to look at this before it moves the deal. Open it from the firm’s page.',
  opportunity_closed: 'The deal was already closed, so Callie did not move it. Reopen it if this changes things.',
  no_opportunity: 'This firm has no open deal for Callie to move. Add the firm to the pipeline first.',
  stage_missing: 'The stage this would move the deal to no longer exists. Choose a stage by hand.',
  rule_missing: 'Callie has no rule for what this should do to the deal. Move the deal by hand.',
  firm_unmatched: 'Callie could not tell which firm this belongs to. Choose the firm.',
  firm_ambiguous: 'This could belong to more than one firm. Choose the right one.',
});

/** Details that ride on a refusal (not codes of their own). */
export const MAILBOX_DETAIL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  mailbox_busy: 'Callie is busy with the mailbox right now. Try again in a minute.',
});

/**
 * The `live_work_present` sentence with the enrollments named. `liveEnrollments` is what the
 * refusal carries; an empty or missing list falls back to the plain sentence.
 */
export function liveWorkPresentSentence(
  liveEnrollments: readonly { readonly sequenceName: string; readonly stepNumber?: number | null }[] | undefined,
): string {
  if (liveEnrollments === undefined || liveEnrollments.length === 0) return CRM_REFUSAL_SENTENCES.live_work_present;
  const named = liveEnrollments.map(item =>
    item.stepNumber === undefined || item.stepNumber === null ? item.sequenceName : `${item.sequenceName}, step ${String(item.stepNumber)}`,
  );
  const noun = named.length === 1 ? 'this sequence is' : 'these sequences are';
  return `This firm can’t go back to automatic while ${noun} still live: ${named.join('; ')}. Ask an administrator to end or finish ${named.length === 1 ? 'it' : 'them'}, then try again.`;
}

/**
 * "Sequence: <name>, step N" for a hold that concerns an enrollment, or null when it does
 * not (no line is shown for it). The step is left out when it is not known.
 */
export function holdEnrollmentLine(
  enrollment: { readonly sequenceName: string; readonly stepNumber: number | null } | null | undefined,
): string | null {
  if (enrollment === null || enrollment === undefined) return null;
  return enrollment.stepNumber === null
    ? `Sequence: ${enrollment.sequenceName}`
    : `Sequence: ${enrollment.sequenceName}, step ${String(enrollment.stepNumber)}`;
}

/**
 * The refusals a settings save can come back with, and the bridge's own words for "it did
 * not work" (slice S1, Settings → Calling & calendar). A block of its own, added beside
 * `ALL_SENTENCES` rather than inside another slice's map.
 */
const INTEGRATION_SETTINGS_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  invalid_value: 'Callie could not use that value. Check it and try again.',
  setting_version_conflict: 'Somebody changed this setting a moment ago. Refresh and try again.',
  offline: 'Callie cannot reach the server right now. Try again when the connection is back.',
  refused: 'Callie could not make that change. Refresh and try again.',
  unreadable_answer: 'Callie could not read the answer. Refresh and try again.',
});

// ---------------------------------------------------------------------------
// Slice M1: matching a Cal.com booking to a firm (`POST /meetings/match`)
// ---------------------------------------------------------------------------

export const MEETING_MATCH_REFUSAL_SENTENCES: Readonly<Record<MeetingMatchRefusalCode, string>> = Object.freeze({
  meeting_unknown: 'Callie cannot find that booking any more. Refresh the list.',
  meeting_already_matched: 'That booking is already attached to a firm. Refresh the list to see where.',
  firm_unknown: FIRM_UNKNOWN,
  firm_merged: FIRM_MERGED,
  not_assigned: NOT_ASSIGNED,
  invalid_input: INVALID_INPUT,
});

// ---------------------------------------------------------------------------
// Slice C2: call transcription (the job's refusals and the transcript read)
// ---------------------------------------------------------------------------

export const TRANSCRIPTION_REFUSAL_SENTENCES: Readonly<Record<TranscriptionRefusalCode, string>> = Object.freeze({
  transcription_off: 'Call transcription is off. An administrator can turn it on in Settings, under Calling & calendar.',
  transcription_unconfigured: 'Call transcription is not set up on the server yet, so this call was not transcribed.',
  transcription_budget_exhausted: 'Transcription paused: today’s transcription budget is used. Calls are transcribed again tomorrow.',
  transcription_not_eligible: 'Only answered calls of at least twenty seconds are transcribed.',
  transcription_failed: 'This call could not be transcribed.',
  transcript_unavailable: 'Callie could not read this transcript just now. Try again in a minute.',
});

/** Every map above, for the flat lookup. Shared spellings carry one sentence, so order is immaterial. */
const ALL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  ...INTEGRATION_SETTINGS_SENTENCES,
  ...HOLD_REASON_SENTENCES,
  ...DIAL_REFUSAL_SENTENCES,
  ...DIAL_ADVICE_SENTENCES,
  ...CRM_REFUSAL_SENTENCES,
  ...RESEARCH_REFUSAL_SENTENCES,
  ...FOLLOW_UP_PREVIEW_REFUSAL_SENTENCES,
  ...FOLLOW_UP_PERMISSION_REFUSAL_SENTENCES,
  ...MAIL_REFUSAL_SENTENCES,
  ...CALL_SESSION_REFUSAL_SENTENCES,
  ...CALL_CONSUMPTION_REFUSAL_SENTENCES,
  ...CALL_START_REFUSAL_SENTENCES,
  ...STAGE_REVIEW_SENTENCES,
  ...MAILBOX_DETAIL_SENTENCES,
  ...MEETING_MATCH_REFUSAL_SENTENCES,
  ...TRANSCRIPTION_REFUSAL_SENTENCES,
});

/** Whether `code` has a sentence of its own (not the generic one). */
export function hasReasonSentence(code: string): boolean {
  return Object.hasOwn(ALL_SENTENCES, code);
}

/**
 * The sentence for a code, or a generic one that still names the code in parentheses.
 * Never the raw code alone.
 */
export function reasonSentence(code: string): string {
  const known = Object.hasOwn(ALL_SENTENCES, code) ? ALL_SENTENCES[code] : undefined;
  return known ?? `Callie can’t do that right now (${code}). Refresh and try again; if it keeps happening, tell support.`;
}
