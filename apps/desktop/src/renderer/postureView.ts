import { localParts, reasonSentence, type PostureCitationDto, type SettingsSnapshot, type StatePostureView } from '@fss/contracts';
import { readErrorSentence } from './readError.ts';
import type { AdminState } from './settingsContract.ts';

/**
 * The "OK to call" list, as a value (lane g84, audit item G04; wave 2, S4.2 and D5).
 *
 * 9.2 step 6 refuses a call to a firm whose state has no posture in force. Until wave 2
 * recording one was a form per state: a day it took effect, a review date, and four
 * statements ticked one at a time. A posture has no expiry now and no review date, so
 * this is what is left of it — **the states you are willing to call, ticked together and
 * confirmed once**. `POST /postures/allow` records every statement of
 * `GET /postures/reference` as confirmed, with the domain's own citations.
 *
 * Invariant 7 — "Software records and enforces legal posture; it does not invent it" —
 * is why nothing here writes a statement or a source: the texts are the reference read,
 * shown as the server sent them, and the server copies the sources itself.
 */

export interface PostureRowView {
  readonly id: string;
  readonly state: string;
  /** "Rhode Island (RI) — allowed since 25 September", or why it is not in force. */
  readonly line: string;
  readonly allowed: boolean;
  readonly canRevoke: boolean;
}

export interface PostureRuleView {
  readonly summary: string;
  readonly citations: readonly PostureCitationDto[];
}

export interface PosturesSectionView {
  /** One sentence: why this matters, and which states are on the list. */
  readonly summary: string;
  /** The grey line and Retry when a read failed, or null. */
  readonly unread: string | null;
  readonly rows: readonly PostureRowView[];
  /** Every state, with the ones this release quotes a rule for first. */
  readonly stateOptions: readonly { readonly value: string; readonly label: string; readonly quoted: boolean }[];
  /** What the one confirmation says, in the release's own words. */
  readonly statements: readonly { readonly key: string; readonly text: string }[];
  readonly rules: Readonly<Record<string, PostureRuleView | null>>;
  readonly editable: boolean;
  /** Why the controls are inert, as a sentence, or null. */
  readonly notEditableBecause: string | null;
  /** The business zone the dates above are days in. */
  readonly zone: string;
}

export const POSTURES_HEADING = 'States you call';
export const POSTURES_UNREAD = 'Callie could not read which states you call.';
export const POSTURE_HINT =
  'Callie records that you confirmed this, with the sources quoted for each state. It does not decide for you.';

/** The one confirmation, above the button that sends it. */
export const POSTURE_CONFIRMATION = 'I have read the rules quoted below and these states are ones I am willing to call.';

/** Why the section is inert, in words; a read that failed says so on its own line instead. */
const INERT_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  upgrade_required: 'Update Callie to change this list.',
  admin_only: 'Only an admin can change this list.',
});

/** The posture refusals as sentences, for the page's notice line. */
export const POSTURE_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  posture_recorded: 'Added. Callie can call firms in those states now.',
  posture_already_allowed: 'Those states were already on the list.',
  posture_revoked: 'Removed. Calls to that state wait until it is added again.',
  posture_unknown: 'That state is no longer on the list.',
  posture_already_revoked: 'That state was already taken off the list.',
  invalid_input: 'Choose at least one state, and confirm you have read the rules.',
});

/**
 * The workspace's business zone as the settings snapshot has it, or New York — Appendix
 * D's initial value — before the snapshot has been read. A posture's dates are calendar
 * days in this zone, as every date the workspace keeps is.
 */
export function businessZoneOf(settings: SettingsSnapshot | null): string {
  const entry = settings?.settings.find(setting => setting.settingKey === 'business_time_zone');
  const zone = (entry?.value as { timeZone?: unknown } | undefined)?.timeZone;
  return typeof zone === 'string' && zone.length > 0 ? zone : 'America/New_York';
}

/** The calendar day an instant falls on in `zone`, or the instant itself if either is unreadable. */
export function dayIn(instant: string, zone: string): string {
  try {
    return localParts(instant, zone).date;
  } catch {
    return instant.slice(0, 10);
  }
}

/** Whether a recorded posture is the one in force for its state right now. */
export function inForce(posture: StatePostureView, now: number): boolean {
  if (posture.revokedAt !== null) return false;
  if (Date.parse(posture.effectiveFrom) > now) return false;
  return posture.effectiveTo === null || Date.parse(posture.effectiveTo) > now;
}

export function postureSection(state: AdminState, zone: string, now: Date = new Date()): PosturesSectionView | null {
  const postures = state.postures;
  if (postures === null) return null;
  // Offline is the page's banner, not a reason (wave 1).
  const reason = !state.mayMutate ? 'upgrade_required' : state.role !== 'admin' ? 'admin_only' : null;
  const reference = postures.reference;
  const records = postures.records ?? [];
  const names = new Map((reference?.states ?? []).map(entry => [entry.state, entry.name] as const));
  const at = now.getTime();

  // One row per state on the list. A state recorded twice — an older posture revoked and
  // a newer one in force — is one line, about the one in force.
  const rows = records
    .filter(posture => inForce(posture, at))
    .sort((left, right) => left.state.localeCompare(right.state))
    .map(posture => ({
      id: posture.id,
      state: posture.state,
      line: `${names.get(posture.state) ?? posture.state} (${posture.state}) — since ${dayIn(posture.effectiveFrom, zone)}`,
      allowed: true,
      canRevoke: reason === null,
    }));

  const listed = rows.map(row => row.state);
  const summary =
    postures.records === null
      ? 'Callie places a call only to a firm in a state you have put on this list.'
      : listed.length === 0
        ? 'Callie places a call only to a firm in a state you have put on this list, and the list is empty.'
        : `Callie places a call only to a firm in a state you have put on this list: ${listed.join(', ')}.`;

  const quoted = (reference?.states ?? []).filter(entry => entry.rule !== null);
  const rest = (reference?.states ?? []).filter(entry => entry.rule === null);
  const already = new Set(listed);
  return {
    summary,
    unread: postures.readError === null ? null : `${POSTURES_UNREAD} ${readErrorSentence(postures.readError)}`,
    rows,
    stateOptions: [
      ...quoted.map(entry => ({ value: entry.state, label: `${entry.name} (rule quoted)`, quoted: true })),
      ...rest.map(entry => ({ value: entry.state, label: entry.name, quoted: false })),
    ].filter(option => !already.has(option.value)),
    statements: reference?.statements ?? [],
    rules: Object.fromEntries((reference?.states ?? []).map(entry => [entry.state, entry.rule] as const)),
    // Without the statements there is nothing to confirm, so nothing to record.
    editable: reason === null && reference !== null && postures.records !== null,
    notEditableBecause: reason === null ? null : (INERT_SENTENCES[reason] ?? reasonSentence(reason)),
    zone,
  };
}

export interface PostureIssue {
  readonly field: 'states' | 'confirmed' | 'note';
  readonly text: string;
}

/**
 * What the server would refuse, said before sending. `allowCallingStates` refuses an
 * empty list and a body without `confirmed: true`, so this is a courtesy, and a test
 * holds both halves.
 */
export function allowStatesIssues(input: {
  readonly states: readonly string[];
  readonly confirmed: boolean;
  readonly note: string;
}): readonly PostureIssue[] {
  const issues: PostureIssue[] = [];
  if (input.states.length === 0) issues.push({ field: 'states', text: 'Choose at least one state.' });
  if (input.states.length > 60) issues.push({ field: 'states', text: 'Sixty states at a time is the most Callie sends.' });
  if (!input.confirmed) issues.push({ field: 'confirmed', text: 'Confirm that you have read the rules quoted for these states.' });
  if (input.note.trim().length > 1000) issues.push({ field: 'note', text: 'Keep the note to 1,000 characters.' });
  return issues;
}
