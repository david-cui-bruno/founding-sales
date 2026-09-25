import {
  callbackInstant,
  localParts,
  type PostureCitationDto,
  type SettingsSnapshot,
  type StatePostureView,
} from '@fss/contracts';
import { readErrorSentence } from './readError.ts';
import type { AdminState, RecordPostureInput } from './settingsContract.ts';

/**
 * The postures form, as a value (lane g84, audit item G04).
 *
 * 9.2 step 6 refuses a call to a firm whose state has no posture in force, and until g84
 * Settings answered that with the text "/postures — G4 policy". This is the form that
 * replaces it: a state, the day it takes effect and its review date, the four statements
 * `statePosture.ts` asks the founder to confirm, the rule quoted for the state where the
 * release carries one, and a note. It sends the same command, `POST /postures/record`,
 * that the path named.
 *
 * Invariant 7 — "Software records and enforces legal posture; it does not invent it" —
 * is why nothing here writes a statement or a source: the texts are the reference read,
 * shown as the server sent them, and the server copies the sources itself. The checks
 * below are courtesies that say before sending what the server would refuse; the server
 * refuses them anyway, and its answer is what the page shows.
 */

export interface PostureRowView {
  readonly id: string;
  readonly state: string;
  readonly line: string;
  readonly tag: { readonly text: string; readonly tone: 'ok' | 'stop' | 'none' };
  readonly canRevoke: boolean;
}

export interface PostureRuleView {
  readonly summary: string;
  readonly citations: readonly PostureCitationDto[];
}

export interface PosturesSectionView {
  /** One sentence: why postures matter, and which states have one. */
  readonly summary: string;
  /** The grey line and Retry when a read failed, or null. */
  readonly unread: string | null;
  readonly rows: readonly PostureRowView[];
  /** The states the form offers: those with a quoted rule first, then every other. */
  readonly stateOptions: readonly { readonly value: string; readonly label: string; readonly quoted: boolean }[];
  readonly statements: readonly { readonly key: string; readonly text: string }[];
  readonly rules: Readonly<Record<string, PostureRuleView | null>>;
  readonly editable: boolean;
  /** Why the controls are inert, as a sentence, or null. */
  readonly notEditableBecause: string | null;
  /** Every recorded posture as the API returned it, for the JSON disclosure. */
  readonly json: string;
  /** The same records, for the form's overlap check before sending. */
  readonly recordsForCheck: readonly StatePostureView[];
  /** The business zone the form's dates are days in. */
  readonly zone: string;
}

export const POSTURES_HEADING = 'Calling postures';
export const POSTURES_UNREAD = 'Callie could not read the postures.';
export const POSTURE_HINT =
  'Callie records what you confirmed, with the sources quoted for the state. It does not decide the posture for you.';

/** Why the form is inert, in words; a read that failed says so on its own line instead. */
const INERT_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'Callie is offline. A posture can be recorded once it is back online.',
  upgrade_required: 'Update Callie to record or revoke a posture.',
  admin_only: 'Only an admin can record or revoke a posture.',
});

/** The posture refusals as sentences, for the page's notice line. */
export const POSTURE_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  posture_recorded: 'Posture recorded.',
  posture_revoked: 'Posture revoked. Calls to that state wait until a new one is recorded.',
  posture_overlapping:
    'That state already has a posture in force for part of that time. Revoke it first, or start the new one after it ends.',
  posture_unknown: 'That posture is no longer here.',
  posture_already_revoked: 'That posture was already revoked.',
  posture_date_invalid: 'That is not a date Callie can read.',
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

function statusOf(posture: StatePostureView, now: number, zone: string): PostureRowView['tag'] {
  if (posture.revokedAt !== null) return { text: 'Revoked', tone: 'none' };
  if (Date.parse(posture.effectiveFrom) > now) return { text: `Starts ${dayIn(posture.effectiveFrom, zone)}`, tone: 'none' };
  if (posture.effectiveTo !== null && Date.parse(posture.effectiveTo) <= now) return { text: 'Ended', tone: 'none' };
  if (Date.parse(posture.reviewAt) <= now) return { text: 'Review overdue', tone: 'stop' };
  return { text: 'In force', tone: 'ok' };
}

export function postureSection(state: AdminState, zone: string, now: Date = new Date()): PosturesSectionView | null {
  const postures = state.postures;
  if (postures === undefined || postures === null) return null;
  const reason = !state.online ? 'offline' : !state.mayMutate ? 'upgrade_required' : state.role !== 'admin' ? 'admin_only' : null;
  const reference = postures.reference;
  const records = postures.records ?? [];
  const names = new Map((reference?.states ?? []).map(entry => [entry.state, entry.name] as const));
  const at = now.getTime();

  const rows = [...records]
    .sort((left, right) => left.state.localeCompare(right.state) || right.revision - left.revision)
    .map(posture => {
      const name = names.get(posture.state) ?? posture.state;
      const revoked = posture.revokedAt === null ? '' : `, revoked ${dayIn(posture.revokedAt, zone)}`;
      return {
        id: posture.id,
        state: posture.state,
        line: `${name} (${posture.state}) · revision ${String(posture.revision)} · from ${dayIn(posture.effectiveFrom, zone)} · review by ${dayIn(posture.reviewAt, zone)}${revoked}`,
        tag: statusOf(posture, at, zone),
        canRevoke: reason === null && posture.revokedAt === null,
      };
    });

  const inForce = rows.filter(row => row.tag.tone === 'ok').map(row => row.state);
  const summary =
    postures.records === null
      ? 'Callie places a call only to a firm whose state has a posture you recorded.'
      : inForce.length === 0
        ? 'Callie places a call only to a firm whose state has a posture you recorded, and none is in force yet.'
        : `Callie places a call only to a firm whose state has a posture you recorded. In force: ${inForce.join(', ')}.`;

  const quoted = (reference?.states ?? []).filter(entry => entry.rule !== null);
  const rest = (reference?.states ?? []).filter(entry => entry.rule === null);
  return {
    summary,
    unread: postures.readError === null ? null : `${POSTURES_UNREAD} ${readErrorSentence(postures.readError)}`,
    rows,
    stateOptions: [
      ...quoted.map(entry => ({ value: entry.state, label: `${entry.name} (rule quoted)`, quoted: true })),
      ...rest.map(entry => ({ value: entry.state, label: entry.name, quoted: false })),
    ],
    statements: reference?.statements ?? [],
    rules: Object.fromEntries((reference?.states ?? []).map(entry => [entry.state, entry.rule] as const)),
    // Without the statements there is nothing to confirm, so nothing to record.
    editable: reason === null && reference !== null && postures.records !== null,
    notEditableBecause: reason === null ? null : (INERT_SENTENCES[reason] ?? reason),
    json: JSON.stringify(postures.records ?? [], null, 2),
    recordsForCheck: records,
    zone,
  };
}

export type PostureField = 'state' | 'effectiveFrom' | 'reviewDate' | 'statements' | 'note';

export interface PostureIssue {
  readonly field: PostureField;
  readonly text: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * What the server would refuse, said before sending (lane g84). Every one of these is
 * also the server's refusal — `invalid_input` for a state, a date or a missing statement,
 * `posture_overlapping` for a range that meets one in force — so the form is a courtesy,
 * and a test holds both halves.
 */
export function postureFormIssues(
  input: RecordPostureInput,
  context: { readonly statementCount: number; readonly records: readonly StatePostureView[]; readonly zone: string },
): readonly PostureIssue[] {
  const issues: PostureIssue[] = [];
  const state = input.state.trim().toUpperCase();
  if (state === '') issues.push({ field: 'state', text: 'Choose a state.' });
  const from = input.effectiveFromDate.trim();
  if (!DATE.test(from)) issues.push({ field: 'effectiveFrom', text: 'Choose the day it takes effect.' });
  const review = input.reviewDate.trim();
  if (review !== '' && (!DATE.test(review) || (DATE.test(from) && review <= from))) {
    issues.push({ field: 'reviewDate', text: 'The review date must be after the day it takes effect.' });
  }
  if (new Set(input.confirmedStatements).size < context.statementCount) {
    issues.push({ field: 'statements', text: 'Tick every statement. A partial confirmation is not a posture.' });
  }
  if (input.note.trim().length > 1000) issues.push({ field: 'note', text: 'Keep the note to 1,000 characters.' });

  const startsAt = state === '' || !DATE.test(from) ? null : callbackInstant(from, '00:00', context.zone);
  if (startsAt !== null) {
    // The exclusion constraint's question, asked of the list on screen: an unrevoked
    // posture for the state whose range is still open when the new one would start.
    const meets = context.records.some(
      posture =>
        posture.state === state &&
        posture.revokedAt === null &&
        (posture.effectiveTo === null || Date.parse(posture.effectiveTo) > Date.parse(startsAt)),
    );
    if (meets) {
      issues.push({ field: 'state', text: `${state} already has a posture in force. Revoke it first, or start this one after it ends.` });
    }
  }
  return issues;
}
