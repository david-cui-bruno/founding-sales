import { createHash } from 'node:crypto';
import {
  CALL_ANALYSIS_QUALIFYING_SIGNALS,
  CALL_POLICY_VERSION,
  callbackInstant,
  isKnownTimeZone,
  localParts,
  type CallAnalysisQuoteRef,
  type CallAnalysisObjectionCategory,
  type CallAnalysisResult,
  type CallProposal,
  type CallProposalKind,
} from '@fss/contracts';
import { parseSpokenTime } from './analysisConfirm.ts';
import { fold } from './summaryModel.ts';

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
 * | a confirmed stop | `outcome: do_not_call` on the dialled number only; a wider or unclear scope adds `stop_scope` (review); an e-mail request with it adds `stop_with_email` (review) and never a `follow_up` |
 * | an unconfirmed stop, or stop language the model missed | `outcome_unclear` and `stop_scope` (review) only |
 * | a referral | `outcome: referral_or_wrong_person`; `referral_contact` (review) |
 * | a callback | `outcome: callback_requested`; an exact one adds `callback` at `resolveSpokenCallback`, or `callback_zone_unknown` (review) when the firm has no zone |
 * | a confirmed buying signal | `outcome: interested` (unless a callback set the outcome); `buying_signal`. Unconfirmed: `buying_signal` (review) only |
 * | a confirmed e-mail request | `outcome: interested` (unless a callback set it); `follow_up`; an overview request adds the task "Send overview to <contact>". Unconfirmed: `follow_up` (review) only |
 * | a soft rejection | `outcome: not_interested`; `park`. Never a callback, never Lost |
 * | anything else | no outcome; `outcome_unclear` (review) |
 * | a You commitment | `task:<first 16 hex of sha256(fold(quote))>`, except under a stop or a wrong number |
 *
 * The rows are tried top to bottom and the first of the first six that applies decides the
 * outcome; a callback, a buying signal and an e-mail request compose.
 *
 * WHITELIST (reviews S3A1 and S3A1F, 2 October 2026; call_policy.5): a stop, a buying
 * signal, an e-mail request, a callback and its agreement, an exact callback time and day,
 * and a promised task are `apply` only when the confirmer (`analysisConfirm.ts`) found the
 * whole speaker line built from its known simple forms; anything else is review. The reader
 * records the verdicts on the result, and this table reads them. An unconfirmed callback is
 * `outcome_unclear` (review); an unconfirmed stop is `outcome_unclear` and `stop_scope`, with
 * `stop_with_email` beside an e-mail request.
 */

export interface CallPolicyContext {
  /** When the call started (an instant): the anchor for "tomorrow" and "Tuesday". */
  readonly callStartedAt: string;
  /** The firm's IANA zone, or null when Callie has none for it. */
  readonly firmTimeZone: string | null;
  /** The contact the call was placed to, when one is named: a follow-up needs a named person. */
  readonly contactName: string | null;
  /** Whether the firm has an open opportunity now (the overview task no longer depends on it; Q4). */
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

export { parseSpokenTime };

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
 * It resolves only for a confirmed callback whose clauses name exactly one bare weekday,
 * today or tomorrow with no qualifier word (`dayQualifier` null) and exactly one complete
 * time token (`confirmedTime`; call_policy.5). A bare weekday is the next one strictly after
 * the call's local date (said on Monday, "Tuesday" is tomorrow); a bare hour 1-6 is PM, 7-11
 * AM, 12 noon; the instant comes from `callbackInstant`, and must be after the call. Anything
 * else is a vague callback (David sets the time).
 */
export function resolveSpokenCallback(
  callback: NonNullable<CallAnalysisResult['callback']>,
  context: { readonly callStartedAt: string; readonly firmTimeZone: string | null },
): ResolvedCallback | null {
  const zone = context.firmTimeZone;
  // The model's `exact` flag is not consulted: whether a day and a time were said is decided
  // here from the verified words (C2: "Call me Tuesday at 2" was flagged not exact).
  if (!callback.confirmed || callback.day === null || callback.dateText === null || callback.confirmedTime === null) return null;
  if (zone === null || !isKnownTimeZone(zone)) return null;
  const dateWords = fold(callback.dateText);
  // Only a bare day resolves: any qualifier, in the clauses or the model's date words, does not.
  if (callback.dayQualifier !== null) return null;
  if (/\b(?:next|this|after|following|week|weeks|in|not|coming|from)\b/u.test(dateWords)) return null;
  // The day words must name the day the model chose.
  const dayWord = callback.day;
  if (!new RegExp(`\\b${dayWord.slice(0, 3)}`, 'u').test(dateWords)) return null;

  const localTime = callback.confirmedTime;
  const call = localParts(context.callStartedAt, zone);
  let localDate: string;
  if (dayWord === 'today') localDate = call.date;
  else if (dayWord === 'tomorrow') localDate = addDays(call.date, 1);
  else {
    // A bare weekday: the next one strictly after the call's date.
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

/** Objections that decline: with a neutral reading and unanswered, a soft rejection. */
const SOFT_REJECTIONS: ReadonlySet<CallAnalysisObjectionCategory> = new Set(['no_need', 'has_solution', 'timing', 'too_small', 'brush_off']);

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
export function proposeEffects(
  result: CallAnalysisResult,
  context: CallPolicyContext,
): ProposalSet {
  const proposals: CallProposal[] = [];
  const outcome = (value: Extract<CallProposal, { kind: 'outcome' }>): void => {
    proposals.push(value);
  };
  let tasksAllowed = true;
  // A verified Them quote of a wrong number or a stop means a person answered, whatever
  // `reached` says (C2: a wrong number read as `none`).
  const machine =
    (result.reached === 'machine' || result.reached === 'none') &&
    result.wrongNumber === null &&
    result.stop === null &&
    result.stopPhrases.length === 0;

  if (machine) {
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
  } else if (result.stop !== null && result.stop.confirmed) {
    tasksAllowed = false;
    outcome({
      key: 'outcome',
      kind: 'outcome',
      mode: 'apply',
      reason: 'They asked not to be called.',
      params: { outcome: 'do_not_call', doNotCallCoversAllContact: false, evidence: evidenceOf(result.stop.ref) },
    });
    // Words that do not name only the speaker or this number ("I don't want these calls")
    // leave the scope to David, whatever scope the model read.
    const general = result.stopPhrases.find(phrase => phrase.general);
    const spokenScope = result.stop.scope !== 'this_number' ? result.stop.scope : general !== undefined ? 'unclear' : null;
    if (spokenScope !== null) {
      proposals.push({
        key: 'stop_scope',
        kind: 'stop_scope',
        mode: 'review',
        reason: spokenScope === 'all_contact' ? 'They may have asked for no contact with the firm at all.' : 'How far the stop reaches is unclear.',
        params: { spokenScope, evidence: evidenceOf(result.stop.ref, general?.ref) },
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
  } else if (result.stop !== null || result.stopPhrases.length > 0) {
    // CONFIRM OR REVIEW, and the safety net: a stop the model read that its whole line does
    // not confirm, or stop language on a Them line that the model did not read as a stop.
    // Nothing is proposed for applying — no park, no rejection, no callback, no follow-up,
    // no task — only the two review items, so David decides what was said.
    tasksAllowed = false;
    const evidence = evidenceOf(result.stop?.ref, ...result.stopPhrases.map(phrase => phrase.ref));
    proposals.push({
      key: 'outcome_unclear',
      kind: 'outcome_unclear',
      mode: 'review',
      reason: 'They may have asked not to be called.',
      params: { evidence },
    });
    proposals.push({
      key: 'stop_scope',
      kind: 'stop_scope',
      mode: 'review',
      reason: 'They may have asked not to be called; how far that reaches is unclear.',
      params: { spokenScope: 'unclear', evidence },
    });
    // With an e-mail request beside it, that too is David's to read, never a follow-up.
    const request = emailRequest(result);
    if (request !== null) {
      proposals.push({
        key: 'stop_with_email',
        kind: 'stop_with_email',
        mode: 'review',
        reason: 'They may have asked not to be called but to be e-mailed.',
        params: { requestKind: request.kind, evidence: evidenceOf(result.stop?.ref, request.ref) },
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
    // A buying signal is a verified qualifying signal in a call the model read as interested
    // (`buying_signal`, or `curious` with a demo request or the like; C2: the model's level and
    // its signals disagreed on a plain demo request). The reader has already turned an
    // unqualified `buying_signal` level into `unclear`.
    // CONFIRM OR REVIEW: only signals whose whole line the confirmer confirmed are applied;
    // the others are a buying signal to review.
    const qualifying = new Set(CALL_ANALYSIS_QUALIFYING_SIGNALS);
    const claimed =
      result.interest.level === 'buying_signal' || result.interest.level === 'curious'
        ? result.interest.signals.filter(signal => qualifying.has(signal.kind))
        : [];
    const signals = claimed.filter(signal => signal.confirmed);
    const buying = signals.length > 0;
    const buyingToReview = !buying && claimed.length > 0;
    const anyRequest = emailRequest(result);
    const request = anyRequest !== null && result.followUpRequest?.confirmed === true ? anyRequest : null;
    // A soft rejection: they declined (`not_interested`), or a neutral call with an
    // unanswered objection of the declining kinds (C2: "maybe next year" read as neutral).
    // Never beside anything still to review.
    const declining = result.objections.filter(objection => SOFT_REJECTIONS.has(objection.category) && objection.answered === null);
    // A callback the confirmer did not confirm is not a callback: it is David's to read.
    const confirmedCallback = callback !== null && callback.confirmed ? callback : null;
    const callbackToReview = callback !== null && !callback.confirmed;
    const soft =
      !buying &&
      !buyingToReview &&
      !callbackToReview &&
      result.followUpRequest === null &&
      ((result.interest.level === 'not_interested' && result.objections.length > 0) ||
        (result.interest.level === 'neutral' && declining.length > 0));

    if (confirmedCallback !== null) {
      const callback = confirmedCallback;
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
      } else if (
        context.firmTimeZone === null &&
        callback.day !== null &&
        callback.dateText !== null &&
        callback.confirmedTime !== null &&
        callback.dayQualifier === null
      ) {
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
        reason: callbackToReview ? 'They may have asked to be called back; the words do not confirm it.' : 'The call does not say clearly how it went.',
        params: {
          evidence: evidenceOf(
            callback?.phrase,
            ...result.objections.map(objection => objection.ref),
            ...result.interest.signals.map(signal => signal.ref),
          ),
        },
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
    } else if (buyingToReview) {
      proposals.push({
        key: 'buying_signal',
        kind: 'buying_signal',
        mode: 'review',
        reason: 'Possibly a buying signal; the words do not confirm it.',
        params: { evidence: evidenceOf(...claimed.map(signal => signal.ref)) },
      });
    }
    if (request === null && anyRequest !== null && context.contactName !== null) {
      proposals.push({
        key: 'follow_up',
        kind: 'follow_up',
        mode: 'review',
        reason: 'Possibly asked to be e-mailed; the words do not confirm it.',
        params: { requestKind: anyRequest.kind, evidence: evidenceOf(anyRequest.ref) },
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
      // Confirming an overview request records the permission and creates the follow-up
      // task, whether or not an opportunity is open (David, Q4, 2 October 2026).
      if (request.kind === 'overview_email') {
        proposals.push({
          key: taskKey(request.ref.quote),
          kind: 'task',
          mode: 'apply',
          reason: 'They asked for an overview.',
          params: { text: `Send overview to ${context.contactName}`.slice(0, 300), quote: request.ref.quote, duePhrase: null, evidence: evidenceOf(request.ref) },
        });
      }
    }
  }

  if (tasksAllowed) {
    for (const commitment of result.commitments) {
      if (commitment.speaker !== 'you') continue;
      // "I'll call you Thursday at 10" beside a callback is the callback, not a second task.
      if (result.callback !== null && /\bcall\b/u.test(fold(commitment.ref.quote))) continue;
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
