import { createHash } from 'node:crypto';
import {
  CALL_POLICY_VERSION,
  callbackInstant,
  isKnownTimeZone,
  localParts,
  type CallAnalysisQuoteRef,
  type CallAnalysisResult,
  type CallProposal,
  type CallProposalKind,
} from '@fss/contracts';
import { fold, verbatimIn } from './summaryModel.ts';

/**
 * The post-call policy (slice 3a): a pure function from one read analysis and its call's
 * context to the proposal set David is shown, and that set's hash.
 *
 * Every proposal is applied only by David's click (`POST /calls/proposals/apply`, Lane B),
 * through an existing domain command; `mode` says whether it is a first-time Apply key
 * (`apply`) or a Needs review item that links to an existing surface (`review`). The hash
 * is stored with the analysis and an Apply must echo it, so a click applies exactly the set
 * that was shown.
 *
 * ## The table (rev-2 §2.2, with the 3a changes)
 *
 * | Analysis | Proposals |
 * |---|---|
 * | a machine | `outcome: voicemail_left`, or `no_answer` when nothing was left |
 * | a wrong number | `outcome: wrong_number`; a number they gave adds `corrected_number` (review) |
 * | an explicit stop | `outcome: do_not_call` on the dialled number only; a wider or unclear scope adds `stop_scope` (review); an e-mail request with it adds `stop_with_email` (review) and never a `follow_up` |
 * | a referral | `outcome: referral_or_wrong_person`; `referral_contact` (review) |
 * | a callback | `outcome: callback_requested`; an exact one adds `callback` at `resolveSpokenCallback`, or `callback_zone_unknown` (review) when the firm has no zone |
 * | a verified buying signal | `outcome: interested` (unless a callback set the outcome); `buying_signal` |
 * | an e-mail request | `outcome: interested` (unless a callback set it); `follow_up`; at a firm with no open opportunity an overview request adds the task "Send overview to <contact>" |
 * | a soft rejection | `outcome: not_interested`; `park`. Never a callback, never Lost |
 * | anything else | no outcome; `outcome_unclear` (review) |
 * | a You commitment | `task:<first 16 hex of sha256(fold(quote))>`, except under a stop or a wrong number |
 *
 * The rows are tried top to bottom and the first of the first five that applies decides the
 * outcome; a callback, a buying signal and an e-mail request compose.
 */

export interface CallPolicyContext {
  /** When the call started (an instant): the anchor for "tomorrow" and "Tuesday". */
  readonly callStartedAt: string;
  /** The firm's IANA zone, or null when Callie has none for it. */
  readonly firmTimeZone: string | null;
  /** The contact the call was placed to, when one is named: a follow-up needs a named person. */
  readonly contactName: string | null;
  /** Whether the firm has an open opportunity now: without one an overview also becomes a task. */
  readonly hasOpenOpportunity: boolean;
}

export interface ProposalSet {
  readonly proposals: readonly CallProposal[];
  /** `sha256(canonicalJson(proposals) ‖ CALL_POLICY_VERSION)`, hex. */
  readonly proposalHash: string;
  readonly policyVersion: string;
}

// ---------------------------------------------------------------------------
// Spoken callbacks
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
});
const MINUTE_WORDS: Readonly<Record<string, number>> = Object.freeze({
  "o'clock": 0,
  oclock: 0,
  fifteen: 15,
  thirty: 30,
  'forty five': 45,
  'forty-five': 45,
  fortyfive: 45,
});

/** Words that correct what was just said: the time after the last one is the one meant. */
const CORRECTION = /\b(no wait|wait no|actually|sorry|i mean|make that|or rather|scratch that)\b/gu;

/**
 * A spoken clock time as `HH:MM`, or null. An explicit am/pm wins; otherwise a bare hour
 * 1-6 is afternoon, 7-11 morning, 12 noon (the hours a sales callback is placed at).
 */
export function parseSpokenTime(words: string): string | null {
  let text = fold(words).replace(/(\d)([a-z])/gu, '$1 $2').replace(/\bat\b/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (text === 'noon' || text === 'midday') return '12:00';
  let meridiem: 'am' | 'pm' | null = null;
  const marker = /\b(a ?m|p ?m|in the morning|in the afternoon|in the evening)\b/u.exec(text);
  if (marker !== null) {
    meridiem = marker[1]?.startsWith('a') === true || marker[1] === 'in the morning' ? 'am' : 'pm';
    text = text.replace(marker[0], ' ').replace(/\s+/gu, ' ').trim();
  }
  let hour: number | null = null;
  let minute = 0;
  const digits = /^(\d{1,2})(?:[: ](\d{2}))?$/u.exec(text);
  if (digits !== null) {
    hour = Number(digits[1]);
    if (digits[2] !== undefined) minute = Number(digits[2]);
  } else {
    const half = /^half past (\w+)$/u.exec(text);
    const quarter = /^quarter past (\w+)$/u.exec(text);
    if (half !== null) {
      hour = NUMBER_WORDS[half[1] ?? ''] ?? null;
      minute = 30;
    } else if (quarter !== null) {
      hour = NUMBER_WORDS[quarter[1] ?? ''] ?? null;
      minute = 15;
    } else {
      const [first, ...rest] = text.split(' ');
      hour = NUMBER_WORDS[first ?? ''] ?? (first !== undefined && /^\d{1,2}$/u.test(first) ? Number(first) : null);
      const tail = rest.join(' ');
      if (tail.length > 0) {
        const m = MINUTE_WORDS[tail] ?? (/^\d{2}$/u.test(tail) ? Number(tail) : undefined);
        if (m === undefined) return null;
        minute = m;
      }
    }
  }
  if (hour === null || !Number.isInteger(hour) || minute < 0 || minute > 59) return null;
  if (hour > 23) return null;
  if (hour > 12) {
    if (meridiem === 'am') return null;
  } else if (meridiem === 'am') {
    if (hour === 12) hour = 0;
  } else if (meridiem === 'pm') {
    if (hour !== 12) hour += 12;
  } else if (hour >= 1 && hour <= 6) hour += 12;
  else if (hour === 0) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return moved.toISOString().slice(0, 10);
}

export interface ResolvedCallback {
  readonly localDate: string;
  readonly localTime: string;
  readonly dueAt: string;
  readonly sourceTimeZone: string;
}

/**
 * The instant an exact spoken callback names, or null when it does not name one.
 *
 * It resolves only when the model called it exact and both a day and a time were said in
 * the verified phrase or its agreed line (the reader keeps `dateText` and `time` only
 * then). The rules: a weekday is the next one strictly after the call's local date; "next
 * <weekday>" is ambiguous and never resolves; a correction ("no wait") uses what follows
 * the last one; a bare hour 1-6 is PM, 7-11 AM, 12 noon; the instant comes from
 * `callbackInstant`, and must be after the call.
 */
export function resolveSpokenCallback(
  callback: NonNullable<CallAnalysisResult['callback']>,
  context: { readonly callStartedAt: string; readonly firmTimeZone: string | null },
): ResolvedCallback | null {
  const zone = context.firmTimeZone;
  if (!callback.exact || callback.day === null || callback.dateText === null || callback.time === null) return null;
  if (zone === null || !isKnownTimeZone(zone)) return null;
  const dateWords = fold(callback.dateText);
  if (/\bnext\b/u.test(dateWords)) return null;
  // The day words must name the day the model chose.
  const dayWord = callback.day;
  if (!new RegExp(`\\b${dayWord.slice(0, 3)}`, 'u').test(dateWords)) return null;

  // After a correction in the phrase, only the words after the last one count.
  const phrase = fold(callback.phrase.quote);
  const markers = [...phrase.matchAll(CORRECTION)];
  const last = markers.at(-1);
  if (last !== undefined && verbatimIn(callback.time, phrase)) {
    const after = phrase.slice((last.index ?? 0) + last[0].length);
    if (!verbatimIn(callback.time, after) || !verbatimIn(callback.dateText, after)) return null;
  }

  const localTime = parseSpokenTime(callback.time);
  if (localTime === null) return null;
  const call = localParts(context.callStartedAt, zone);
  let localDate: string;
  if (dayWord === 'today') localDate = call.date;
  else if (dayWord === 'tomorrow') localDate = addDays(call.date, 1);
  else {
    const target = WEEKDAYS.indexOf(dayWord);
    const ahead = ((target - call.weekday + 7) % 7) || 7;
    localDate = addDays(call.date, ahead);
  }
  const dueAt = callbackInstant(localDate, localTime, zone);
  if (dueAt === null || Date.parse(dueAt) <= Date.parse(context.callStartedAt)) return null;
  return { localDate, localTime, dueAt, sourceTimeZone: zone };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/** `task:<first 16 hex of sha256(fold(quote))>`: one spoken promise, one key, whatever its line. */
export function taskKey(quote: string): `task:${string}` {
  return `task:${createHash('sha256').update(fold(quote), 'utf8').digest('hex').slice(0, 16)}`;
}

/** JSON with every object's keys sorted, no whitespace: the bytes the hash covers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

export function proposalHash(proposals: readonly CallProposal[]): string {
  return createHash('sha256').update(canonicalJson(proposals) + CALL_POLICY_VERSION, 'utf8').digest('hex');
}

const KIND_ORDER: readonly CallProposalKind[] = [
  'outcome',
  'callback',
  'follow_up',
  'buying_signal',
  'park',
  'task',
  'outcome_unclear',
  'stop_scope',
  'stop_with_email',
  'corrected_number',
  'referral_contact',
  'callback_zone_unknown',
];

function evidenceOf(...refs: readonly (CallAnalysisQuoteRef | null | undefined)[]): CallAnalysisQuoteRef[] {
  return refs.filter((ref): ref is CallAnalysisQuoteRef => ref !== null && ref !== undefined).slice(0, 10);
}

/** An e-mail request (an overview or something else by e-mail), or null. */
function emailRequest(result: CallAnalysisResult): { readonly kind: 'overview_email' | 'other_email'; readonly ref: CallAnalysisQuoteRef } | null {
  const request = result.followUpRequest;
  if (request === null || request.kind === 'other') return null;
  return { kind: request.kind, ref: request.ref };
}

/** The proposal set for one read analysis. Pure: the same inputs give the same bytes. */
export function proposeEffects(result: CallAnalysisResult, context: CallPolicyContext): ProposalSet {
  const proposals: CallProposal[] = [];
  const outcome = (value: Extract<CallProposal, { kind: 'outcome' }>): void => {
    proposals.push(value);
  };
  let tasksAllowed = true;

  if (result.reached === 'machine' || result.reached === 'none') {
    outcome({
      key: 'outcome',
      kind: 'outcome',
      mode: 'apply',
      reason: result.voicemailLeft ? 'A voicemail was left.' : 'Nobody answered in person.',
      params: { outcome: result.voicemailLeft ? 'voicemail_left' : 'no_answer', evidence: [] },
    });
  } else if (result.wrongNumber !== null) {
    tasksAllowed = false;
    outcome({
      key: 'outcome',
      kind: 'outcome',
      mode: 'apply',
      reason: 'The number does not reach this firm.',
      params: { outcome: 'wrong_number', evidence: evidenceOf(result.wrongNumber.ref) },
    });
    if (result.wrongNumber.otherNumberGiven !== null) {
      proposals.push({
        key: 'corrected_number',
        kind: 'corrected_number',
        mode: 'review',
        reason: 'They gave another number for the firm.',
        params: { spokenNumber: result.wrongNumber.otherNumberGiven, evidence: evidenceOf(result.wrongNumber.ref) },
      });
    }
  } else if (result.stop !== null) {
    tasksAllowed = false;
    outcome({
      key: 'outcome',
      kind: 'outcome',
      mode: 'apply',
      reason: 'They asked not to be called.',
      params: { outcome: 'do_not_call', doNotCallCoversAllContact: false, evidence: evidenceOf(result.stop.ref) },
    });
    if (result.stop.scope !== 'this_number') {
      proposals.push({
        key: 'stop_scope',
        kind: 'stop_scope',
        mode: 'review',
        reason: result.stop.scope === 'all_contact' ? 'They may have asked for no contact with the firm at all.' : 'How far the stop reaches is unclear.',
        params: { spokenScope: result.stop.scope, evidence: evidenceOf(result.stop.ref) },
      });
    }
    const request = emailRequest(result);
    if (request !== null) {
      proposals.push({
        key: 'stop_with_email',
        kind: 'stop_with_email',
        mode: 'review',
        reason: 'They asked not to be called but to be e-mailed.',
        params: { requestKind: request.kind, evidence: evidenceOf(result.stop.ref, request.ref) },
      });
    }
  } else if (result.referral !== null) {
    outcome({
      key: 'outcome',
      kind: 'outcome',
      mode: 'apply',
      reason: 'They pointed to someone else at the firm.',
      params: { outcome: 'referral_or_wrong_person', evidence: evidenceOf(result.referral.ref) },
    });
    proposals.push({
      key: 'referral_contact',
      kind: 'referral_contact',
      mode: 'review',
      reason: 'A person to talk to instead.',
      params: { name: result.referral.name, role: result.referral.role, evidence: evidenceOf(result.referral.ref) },
    });
  } else {
    const callback = result.callback;
    const signals = result.interest.level === 'buying_signal' ? result.interest.signals : [];
    const buying = signals.length > 0;
    const request = emailRequest(result);
    const soft = result.interest.level === 'not_interested' && result.objections.length > 0 && !buying && request === null;

    if (callback !== null) {
      outcome({
        key: 'outcome',
        kind: 'outcome',
        mode: 'apply',
        reason: 'They asked to be called back.',
        params: { outcome: 'callback_requested', evidence: evidenceOf(callback.phrase) },
      });
      const resolved = resolveSpokenCallback(callback, context);
      if (resolved !== null) {
        proposals.push({
          key: 'callback',
          kind: 'callback',
          mode: 'apply',
          reason: 'They named a day and a time.',
          params: { ...resolved, evidence: evidenceOf(callback.phrase) },
        });
      } else if (context.firmTimeZone === null && callback.exact && callback.day !== null && callback.time !== null) {
        proposals.push({
          key: 'callback_zone_unknown',
          kind: 'callback_zone_unknown',
          mode: 'review',
          reason: 'A callback time was said, but the firm has no time zone.',
          params: { phrase: callback.phrase.quote, evidence: evidenceOf(callback.phrase) },
        });
      }
    } else if (buying || request !== null) {
      outcome({
        key: 'outcome',
        kind: 'outcome',
        mode: 'apply',
        reason: buying ? 'They showed they are considering Callie.' : 'A conversation in which they asked to be sent something.',
        params: { outcome: 'interested', evidence: evidenceOf(...signals.map(signal => signal.ref), request?.ref) },
      });
    } else if (soft) {
      outcome({
        key: 'outcome',
        kind: 'outcome',
        mode: 'apply',
        reason: 'They declined for now.',
        params: { outcome: 'not_interested', evidence: evidenceOf(...result.objections.map(objection => objection.ref)) },
      });
      proposals.push({
        key: 'park',
        kind: 'park',
        mode: 'apply',
        reason: 'Pause the firm rather than mark it lost.',
        params: { evidence: evidenceOf(...result.objections.map(objection => objection.ref)) },
      });
    } else {
      proposals.push({
        key: 'outcome_unclear',
        kind: 'outcome_unclear',
        mode: 'review',
        reason: 'The call does not say clearly how it went.',
        params: { evidence: evidenceOf(...result.objections.map(objection => objection.ref), ...result.interest.signals.map(signal => signal.ref)) },
      });
    }

    if (buying) {
      proposals.push({
        key: 'buying_signal',
        kind: 'buying_signal',
        mode: 'apply',
        reason: 'A buying signal on the call.',
        params: { evidence: evidenceOf(...signals.map(signal => signal.ref)) },
      });
    }
    if (request !== null && context.contactName !== null) {
      proposals.push({
        key: 'follow_up',
        kind: 'follow_up',
        mode: 'apply',
        reason: request.kind === 'overview_email' ? 'They asked for an overview by e-mail.' : 'They asked to be e-mailed.',
        params: { requestKind: request.kind, evidence: evidenceOf(request.ref) },
      });
      if (request.kind === 'overview_email' && !context.hasOpenOpportunity) {
        proposals.push({
          key: taskKey(request.ref.quote),
          kind: 'task',
          mode: 'apply',
          reason: 'There is no open opportunity, so the overview has no send path yet.',
          params: { text: `Send overview to ${context.contactName}`.slice(0, 300), quote: request.ref.quote, duePhrase: null, evidence: evidenceOf(request.ref) },
        });
      }
    }
  }

  if (tasksAllowed) {
    for (const commitment of result.commitments) {
      if (commitment.speaker !== 'you') continue;
      const key = taskKey(commitment.ref.quote);
      if (proposals.some(proposal => proposal.key === key)) continue;
      proposals.push({
        key,
        kind: 'task',
        mode: 'apply',
        reason: 'You promised this on the call.',
        params: { text: commitment.ref.quote.slice(0, 300), quote: commitment.ref.quote, duePhrase: commitment.duePhrase, evidence: evidenceOf(commitment.ref) },
      });
    }
  }

  proposals.sort((left, right) => {
    const byKind = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
    return byKind !== 0 ? byKind : left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  return { proposals, proposalHash: proposalHash(proposals), policyVersion: CALL_POLICY_VERSION };
}
