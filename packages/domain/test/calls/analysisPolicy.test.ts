import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CALL_POLICY_VERSION, callProposalSetSchema, type CallAnalysisResult, type CallTranscriptUtterance } from '@fss/contracts';
import { readCallAnalysisAnswer } from '../../calls/analysisModel.ts';
import {
  canonicalJson,
  parseSpokenTime,
  proposeEffects,
  resolveSpokenCallback,
  taskKey,
  type CallPolicyContext,
} from '../../calls/analysisPolicy.ts';
import {
  confirmBuyingSignal,
  confirmCallbackRequest,
  confirmFollowUpRequest,
  confirmStop,
  hasMarkers,
  plainYes,
} from '../../calls/analysisConfirm.ts';
import { effectLabels } from '../corpus/calls/evaluate.ts';
import { answer, lines } from './analysisFixtures.ts';

/**
 * Slice 3a, A-2: the policy table, its composition, task keys and the proposal hash, and
 * `resolveSpokenCallback`. Every test reads a fixture answer through the real reader first,
 * so a proposal is always computed from what the reader kept.
 */

// Monday 5 October 2026, 10:15 in New York.
const CONTEXT: CallPolicyContext = {
  callStartedAt: '2026-10-05T14:15:00Z',
  firmTimeZone: 'America/New_York',
  contactName: 'Dana Whitfield',
  hasOpenOpportunity: false,
};

function read(raw: string, utterances: readonly CallTranscriptUtterance[]): CallAnalysisResult {
  const result = readCallAnalysisAnswer(raw, utterances);
  if (!result.ok) throw new Error(`fixture answer failed: ${result.failure}`);
  return result.result;
}

function labels(raw: string, utterances: readonly CallTranscriptUtterance[], context: CallPolicyContext = CONTEXT): string[] {
  const set = proposeEffects(read(raw, utterances), context);
  expect(callProposalSetSchema.safeParse(set.proposals).success).toBe(true);
  return effectLabels(set.proposals);
}

describe('A-2: the policy table', () => {
  it('a verified buying signal: interested and buying_signal', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'We are evaluating tools. Can you show us a demo?']);
    expect(labels(answer({ interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] } }), call)).toEqual([
      'outcome:interested',
      'buying_signal',
    ]);
  });

  it('an overview request: interested, follow_up and the "Send overview" task, with or without an open opportunity (Q4), never a buying signal', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Just send me an overview by e-mail.']);
    const raw = answer({ interest: { level: 'curious', signals: [] }, follow_up_request: { kind: 'overview_email', quote: 'send me an overview', line: 2 } });
    expect(labels(raw, call)).toEqual(['outcome:interested', 'follow_up', 'task:overview']);
    const set = proposeEffects(read(raw, call), CONTEXT);
    expect(set.proposals.find(proposal => proposal.kind === 'task')).toMatchObject({ key: taskKey('send me an overview'), params: { text: 'Send overview to Dana Whitfield' } });
    expect(labels(raw, call, { ...CONTEXT, hasOpenOpportunity: true })).toEqual(['outcome:interested', 'follow_up', 'task:overview']);
    // No named contact: no follow-up, since an agreement needs a named person.
    expect(labels(raw, call, { ...CONTEXT, contactName: null })).toEqual(['outcome:interested']);
  });

  it('an exact callback: callback_requested and the resolved callback; with no firm zone, a review item instead', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Not now. Call me Tuesday at 2.']);
    const raw = answer({ callback: { requested: true, exact: true, phrase: 'Call me Tuesday at 2', line: 2, agreed_line: 0, day: 'tuesday', date_text: 'Tuesday', time: '2' } });
    expect(labels(raw, call)).toEqual(['outcome:callback_requested', 'callback:2026-10-06T14:00']);
    const set = proposeEffects(read(raw, call), CONTEXT);
    expect(set.proposals[1]).toMatchObject({ params: { dueAt: '2026-10-06T18:00:00.000Z', sourceTimeZone: 'America/New_York' } });
    expect(labels(raw, call, { ...CONTEXT, firmTimeZone: null })).toEqual(['outcome:callback_requested', 'callback_zone_unknown']);
  });

  it('a vague callback: callback_requested only', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Try me next week sometime.']);
    const raw = answer({ callback: { requested: true, exact: false, phrase: 'Try me next week sometime', line: 2, agreed_line: 0, day: 'none', date_text: '', time: '' } });
    expect(labels(raw, call)).toEqual(['outcome:callback_requested']);
  });

  it('a soft rejection: not_interested and park, never a callback; a level without a verified objection is unclear', () => {
    const call = lines(['Y', 'Hi.'], ['T', "No thanks, we're all set."]);
    const raw = answer({ interest: { level: 'not_interested', signals: [] }, objections: [{ category: 'no_need', quote: "we're all set", line: 2, answered_line: 0 }] });
    expect(labels(raw, call)).toEqual(['outcome:not_interested', 'park']);
    expect(labels(answer({ interest: { level: 'not_interested', signals: [] } }), call)).toEqual(['outcome_unclear']);
  });

  it('a confirmed stop: do_not_call on the number only; a wider scope adds stop_scope; a stop beside an e-mail request is all review, never a follow_up or task', () => {
    const call = lines(['Y', 'Hi. I will send you the overview today.'], ['T', 'Stop calling me.']);
    const stop = { requested: true, scope: 'this_number' as const, quote: 'Stop calling me', line: 2 };
    expect(labels(answer({ stop }), call)).toEqual(['outcome:do_not_call']);
    const set = proposeEffects(read(answer({ stop }), call), CONTEXT);
    expect(set.proposals[0]).toMatchObject({ params: { outcome: 'do_not_call', doNotCallCoversAllContact: false } });
    expect(labels(answer({ stop: { ...stop, scope: 'unclear' } }), call)).toEqual(['outcome:do_not_call', 'stop_scope']);
    expect(labels(answer({ stop: { ...stop, scope: 'all_contact' } }), call)).toEqual(['outcome:do_not_call', 'stop_scope']);
    const withEmail = lines(['Y', 'Hi. I will send you the overview today.'], ['T', 'Stop calling me, but send the overview by e-mail.']);
    const mixed = answer({
      stop,
      follow_up_request: { kind: 'overview_email', quote: 'send the overview by e-mail', line: 2 },
      interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'send the overview', line: 2 }] },
      commitments: [{ speaker: 'you', quote: 'I will send you the overview today', line: 1, due_phrase: 'today' }],
    });
    expect(labels(mixed, withEmail)).toEqual(['outcome_unclear', 'stop_scope', 'stop_with_email']);
  });

  it('a wrong number: wrong_number, plus corrected_number for a number they gave, and no task', () => {
    const call = lines(['Y', 'Is this Harbor Lane? I will call back.'], ['T', 'Wrong number, this is a dental office. Harbor Lane is 617 555 0199.']);
    const raw = answer({
      wrong_number: { is_wrong: true, quote: 'Wrong number', line: 2, other_number_given: '6175550199' },
      commitments: [{ speaker: 'you', quote: 'I will call back', line: 1, due_phrase: '' }],
    });
    expect(labels(raw, call)).toEqual(['outcome:wrong_number', 'corrected_number']);
  });

  it('a referral: referral_or_wrong_person and referral_contact for review', () => {
    const call = lines(['Y', 'May I speak with Bob?'], ['T', 'Bob left. Talk to Sarah Kim.']);
    expect(labels(answer({ referral: { given: true, name: 'Sarah Kim', role: '', quote: 'Talk to Sarah Kim', line: 2 } }), call)).toEqual([
      'outcome:referral_or_wrong_person',
      'referral_contact',
    ]);
  });

  it('a machine: voicemail_left, or no_answer when nothing was left', () => {
    const call = lines(['T', 'Leave a message after the tone.'], ['Y', 'Hi, David from Callie.']);
    expect(labels(answer({ reached: 'machine', voicemail_left: true }), call)).toEqual(['outcome:voicemail_left']);
    expect(labels(answer({ reached: 'machine', voicemail_left: false }), call)).toEqual(['outcome:no_answer']);
  });

  it('unclear: no outcome, outcome_unclear for review', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'We tried something like this, uh, [inaudible]']);
    expect(labels(answer({ interest: { level: 'unclear', signals: [] } }), call)).toEqual(['outcome_unclear']);
  });

  it('composes: an overview and an exact callback give callback_requested, the callback, the follow_up and the task, and no buying signal', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Send an overview and call me Thursday at 10.']);
    const raw = answer({
      interest: { level: 'curious', signals: [{ kind: 'information_request', quote: 'Send an overview', line: 2 }] },
      follow_up_request: { kind: 'overview_email', quote: 'Send an overview', line: 2 },
      callback: { requested: true, exact: true, phrase: 'call me Thursday at 10', line: 2, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '10' },
    });
    expect(labels(raw, call)).toEqual(['outcome:callback_requested', 'callback:2026-10-08T10:00', 'follow_up', 'task:overview']);
  });
});

describe('A-2: task keys and the hash', () => {
  it('keys a You commitment by its folded quote: the same promise on another line, in other case or punctuation, is one key; a Them promise is no task', () => {
    const first = lines(['Y', "I'll send pricing by Friday."], ['T', 'OK.']);
    const shifted = lines(['Y', 'Hi.'], ['T', 'OK.'], ['Y', "I'll send PRICING, by Friday!"]);
    const one = proposeEffects(read(answer({ commitments: [{ speaker: 'you', quote: "I'll send pricing by Friday", line: 1, due_phrase: 'by Friday' }] }), first), CONTEXT);
    const two = proposeEffects(read(answer({ commitments: [{ speaker: 'you', quote: "I'll send PRICING, by Friday", line: 3, due_phrase: '' }] }), shifted), CONTEXT);
    const keyOf = (set: typeof one) => set.proposals.find(proposal => proposal.kind === 'task')?.key;
    expect(keyOf(one)).toBe(taskKey("i'll send pricing by friday"));
    expect(keyOf(one)).toMatch(/^task:[0-9a-f]{16}$/u);
    expect(keyOf(two)).toBe(keyOf(one));
    expect(taskKey("I'll send pricing by Friday")).toBe(
      `task:${createHash('sha256').update("i'll send pricing by friday").digest('hex').slice(0, 16)}`,
    );
    const them = proposeEffects(read(answer({ commitments: [{ speaker: 'them', quote: 'OK', line: 2, due_phrase: '' }] }), first), CONTEXT);
    expect(them.proposals.some(proposal => proposal.kind === 'task')).toBe(false);
    // Two quotes of one promise in one answer: one task.
    const twice = proposeEffects(
      read(answer({ commitments: [
        { speaker: 'you', quote: "I'll send pricing by Friday", line: 1, due_phrase: '' },
        { speaker: 'you', quote: "i'll send pricing, by friday", line: 1, due_phrase: '' },
      ] }), first),
      CONTEXT,
    );
    expect(twice.proposals.filter(proposal => proposal.kind === 'task')).toHaveLength(1);
  });

  it('hashes the canonical proposal JSON followed by the policy version, and the same reading always gives the same bytes', () => {
    const call = lines(['Y', 'Hi.'], ['T', "No thanks, we're all set."]);
    const raw = answer({ interest: { level: 'not_interested', signals: [] }, objections: [{ category: 'no_need', quote: "we're all set", line: 2, answered_line: 0 }] });
    const set = proposeEffects(read(raw, call), CONTEXT);
    expect(set.policyVersion).toBe(CALL_POLICY_VERSION);
    expect(set.proposalHash).toBe(createHash('sha256').update(canonicalJson(set.proposals) + CALL_POLICY_VERSION).digest('hex'));
    expect(proposeEffects(read(raw, call), CONTEXT).proposalHash).toBe(set.proposalHash);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    const other = proposeEffects(read(answer({ ...JSON.parse(raw), interest: { level: 'unclear', signals: [] } } as never), call), CONTEXT);
    expect(other.proposalHash).not.toBe(set.proposalHash);
  });
});

describe('A-2: resolveSpokenCallback', () => {
  const at = (phrase: string, day: string, dateText: string, time: string, startedAt = CONTEXT.callStartedAt) => {
    const call = lines(['Y', 'Hi.'], ['T', phrase]);
    const result = read(answer({ callback: { requested: true, exact: true, phrase, line: 2, agreed_line: 0, day: day as 'tuesday', date_text: dateText, time } }), call);
    const resolved = result.callback === null ? null : resolveSpokenCallback(result.callback, { callStartedAt: startedAt, firmTimeZone: 'America/New_York' });
    return resolved === null ? null : `${resolved.localDate}T${resolved.localTime}`;
  };

  it('takes the next such weekday strictly after the call, and tomorrow and today from the call’s local date', () => {
    expect(at('Call me Tuesday at 2', 'tuesday', 'Tuesday', '2')).toBe('2026-10-06T14:00');
    // Said on a Tuesday, "Tuesday" is next week.
    expect(at('Call me Tuesday at 2', 'tuesday', 'Tuesday', '2', '2026-10-06T14:15:00Z')).toBe('2026-10-13T14:00');
    expect(at('Call me tomorrow at 9:30', 'tomorrow', 'Tomorrow', '9:30')).toBe('2026-10-06T09:30');
    expect(at('Call me today at 4', 'today', 'Today', '4')).toBe('2026-10-05T16:00');
    // Today at 9 has already passed at 10:15.
    expect(at('Call me today at 9', 'today', 'Today', '9')).toBeNull();
    // Words that are not a request to be called confirm no callback at all.
    expect(at('Tomorrow at 9:30 works', 'tomorrow', 'Tomorrow', '9:30')).toBeNull();
  });

  it('never resolves "next Tuesday", a day without a time, or day words that name another day', () => {
    expect(at('Call me next Tuesday at 10', 'tuesday', 'next Tuesday', '10')).toBeNull();
    expect(at('Call me Tuesday afternoon', 'tuesday', 'Tuesday', '')).toBeNull();
    expect(at('Call me Tuesday at 2', 'wednesday', 'Tuesday', '2')).toBeNull();
  });

  it('never resolves a corrected day or time: two times and a correction near a day are a vague callback (call_policy.4)', () => {
    expect(at('Tuesday at 2, no wait, Wednesday at 10', 'wednesday', 'Wednesday', '10')).toBeNull();
    expect(at('Tuesday at 2, no wait, Wednesday at 10', 'tuesday', 'Tuesday', '2')).toBeNull();
  });

  it('reads a bare hour 1-6 as afternoon, 7-11 as morning, 12 as noon; an explicit am or pm wins', () => {
    expect(parseSpokenTime('2')).toBe('14:00');
    expect(parseSpokenTime('6')).toBe('18:00');
    expect(parseSpokenTime('7')).toBe('07:00');
    expect(parseSpokenTime('11')).toBe('11:00');
    expect(parseSpokenTime('12')).toBe('12:00');
    expect(parseSpokenTime('noon')).toBe('12:00');
    // Only digit forms are exact (call_policy.5): number words never are.
    expect(parseSpokenTime('two thirty')).toBeNull();
    expect(parseSpokenTime('9:30')).toBe('09:30');
    expect(parseSpokenTime('at 8 pm')).toBe('20:00');
    expect(parseSpokenTime('3pm')).toBe('15:00');
    expect(parseSpokenTime('10 a.m.')).toBe('10:00');
    expect(parseSpokenTime('half past four')).toBeNull();
    expect(parseSpokenTime('half past 4')).toBe('16:30');
    expect(parseSpokenTime('2-ish')).toBeNull();
    expect(parseSpokenTime('9 30')).toBeNull();
    expect(parseSpokenTime('sometime')).toBeNull();
    expect(parseSpokenTime('14:00')).toBe('14:00');
  });
});

describe('A-2: the safety nets added after the first live run (C2)', () => {
  it('stop language the model did not read as a stop never becomes a park or a rejection: only outcome_unclear and stop_scope', () => {
    const call = lines(['Y', 'Hi. I will send you an overview today.'], ['T', "I don't want these calls."]);
    const raw = answer({
      interest: { level: 'not_interested', signals: [] },
      objections: [{ category: 'brush_off', quote: "I don't want these calls", line: 2, answered_line: 0 }],
      commitments: [{ speaker: 'you', quote: 'I will send you an overview today', line: 1, due_phrase: 'today' }],
    });
    expect(labels(raw, call)).toEqual(['outcome_unclear', 'stop_scope']);
  });

  it('a stop the model scoped to this number, in words that name more, also asks David for the scope', () => {
    const call = lines(['Y', 'Hi.'], ['T', "I don't want these calls."]);
    expect(labels(answer({ stop: { requested: true, scope: 'this_number', quote: "I don't want these calls", line: 2 } }), call)).toEqual([
      'outcome:do_not_call',
      'stop_scope',
    ]);
    const personal = lines(['Y', 'Hi.'], ['T', 'Take me off your list.']);
    expect(labels(answer({ stop: { requested: true, scope: 'this_number', quote: 'Take me off your list', line: 2 } }), personal)).toEqual([
      'outcome:do_not_call',
    ]);
  });

  it('a verified wrong number is a wrong number even when the model said nobody was reached', () => {
    const call = lines(['Y', 'Is this Harbor Lane?'], ['T', 'No, you have the wrong number.']);
    expect(labels(answer({ reached: 'none', wrong_number: { is_wrong: true, quote: 'you have the wrong number', line: 2, other_number_given: '' } }), call)).toEqual([
      'outcome:wrong_number',
    ]);
  });

  it('decides exactness from the verified words, not the model’s flag', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Not now. Call me Tuesday at 2.']);
    const raw = answer({ callback: { requested: true, exact: false, phrase: 'Call me Tuesday at 2', line: 2, agreed_line: 0, day: 'tuesday', date_text: 'Tuesday', time: '2' } });
    expect(labels(raw, call)).toEqual(['outcome:callback_requested', 'callback:2026-10-06T14:00']);
  });

  it('a qualifying signal makes a buying signal when the model read the call as interested or curious, not otherwise', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Could you show us a demo?']);
    const demo = [{ kind: 'demo_request' as const, quote: 'Could you show us a demo?', line: 2 }];
    expect(labels(answer({ interest: { level: 'curious', signals: demo } }), call)).toEqual(['outcome:interested', 'buying_signal']);
    expect(labels(answer({ interest: { level: 'neutral', signals: demo } }), call)).toEqual(['outcome_unclear']);
    // Q3 (David, 2 Oct): a bare pricing question is never a buying signal, whatever the level.
    const price = lines(['Y', 'Hi.'], ['T', 'What does it cost?']);
    for (const level of ['buying_signal', 'curious'] as const) {
      const raw = answer({ interest: { level, signals: [{ kind: 'pricing_question', quote: 'What does it cost?', line: 2 }] } });
      expect(labels(raw, price)).toEqual(['outcome_unclear']);
    }
  });

  it('a neutral call with an unanswered declining objection is a soft rejection; an answered one, or an unclear reading, is not', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'We just renewed, so maybe next year.'], ['Y', 'Most firms switch at renewal.']);
    const objection = { category: 'timing' as const, quote: 'maybe next year', line: 2, answered_line: 0 };
    expect(labels(answer({ interest: { level: 'neutral', signals: [] }, objections: [objection] }), call)).toEqual(['outcome:not_interested', 'park']);
    expect(labels(answer({ interest: { level: 'neutral', signals: [] }, objections: [{ ...objection, answered_line: 3 }] }), call)).toEqual(['outcome_unclear']);
    expect(labels(answer({ interest: { level: 'unclear', signals: [] }, objections: [objection] }), call)).toEqual(['outcome_unclear']);
  });

  it('David repeating the callback ("I\'ll call you then") is the callback, not a second task', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Call me Wednesday at 3.'], ['Y', "Great, Wednesday at 3 then. I'll call you then."]);
    const raw = answer({
      callback: { requested: true, exact: true, phrase: 'Call me Wednesday at 3', line: 2, agreed_line: 0, day: 'wednesday', date_text: 'Wednesday', time: '3' },
      commitments: [
        { speaker: 'you', quote: "I'll call you then", line: 3, due_phrase: '' },
        { speaker: 'you', quote: 'Great, Wednesday at 3 then', line: 3, due_phrase: 'Wednesday at 3' },
      ],
    });
    expect(labels(raw, call)).toEqual(['outcome:callback_requested', 'callback:2026-10-07T15:00']);
  });
});

describe('A-2: the day (call_policy.5): only a bare weekday, today or tomorrow resolves', () => {
  // Monday 5 to Sunday 11 October 2026, 10:15 in New York.
  const WEEK = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
  const resolve = (line: string, dateText: string, day: 'tuesday' | 'friday', date: string): string | null => {
    const call = lines(['Y', 'Hi.'], ['T', line]);
    const result = read(answer({ callback: { requested: true, exact: true, phrase: line.replace(/\.$/u, ''), line: 2, agreed_line: 0, day, date_text: dateText, time: '10' } }), call);
    if (result.callback === null) return null;
    const resolved = resolveSpokenCallback(result.callback, { callStartedAt: `${date}T14:15:00Z`, firmTimeZone: 'America/New_York' });
    return resolved === null ? null : resolved.localDate;
  };

  it('never resolves a qualified day, said on any day of the week, even when the model quotes only "Tuesday"', () => {
    for (const date of WEEK) {
      for (const line of [
        'Call me next Tuesday at 10.',
        'Call me next week Tuesday at 10.',
        'Call me Tuesday next week at 10.',
        'Call me this Tuesday at 10.',
        'Call me the Tuesday after next at 10.',
        'Call me Tuesday in two weeks at 10.',
        'Call me Tuesday or Friday at 10.',
      ]) {
        expect(resolve(line, 'Tuesday', 'tuesday', date), `${date}: ${line}`).toBeNull();
      }
      expect(resolve('Next Friday at 10 works.', 'Friday', 'friday', date), date).toBeNull();
    }
  });

  it('a bare weekday is the next one strictly after the call: "Tuesday" said on Monday is tomorrow', () => {
    const bare = ['2026-10-06', '2026-10-13', '2026-10-13', '2026-10-13', '2026-10-13', '2026-10-13', '2026-10-13'];
    WEEK.forEach((date, index) => {
      expect(resolve('Call me Tuesday at 10.', 'Tuesday', 'tuesday', date), date).toBe(bare[index]);
    });
  });

  it('records the qualifier from the callback’s whole clauses, so a quote that dropped "next" is still ambiguous', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Call me next Tuesday at 10.']);
    const raw = answer({ callback: { requested: true, exact: true, phrase: 'Tuesday at 10', line: 2, agreed_line: 0, day: 'tuesday', date_text: 'Tuesday', time: '10' } });
    expect(read(raw, call).callback?.dayQualifier).toBe('next');
    expect(labels(raw, call)).toEqual(['outcome:callback_requested']);
  });
});

/** The proposals offered for applying. */
function applies(raw: string, utterances: readonly CallTranscriptUtterance[], context: CallPolicyContext = CONTEXT): string[] {
  const set = proposeEffects(read(raw, utterances), context);
  expect(callProposalSetSchema.safeParse(set.proposals).success).toBe(true);
  return effectLabels(set.proposals.filter(proposal => proposal.mode === 'apply'));
}

describe('S3A1: the first review’s triggers (call_policy.5 reads)', () => {
  it('[1] a negated stop is never applied; a line with a stop and anything else is reviewed', () => {
    const call = lines(['Y', 'Should I take you off our list?'], ['T', "Don't take me off anything, just call later."]);
    const raw = answer({
      stop: { requested: true, scope: 'this_number', quote: 'take me off', line: 2 },
      callback: { requested: true, exact: false, phrase: 'just call later', line: 2, agreed_line: 0, day: 'none', date_text: '', time: '' },
    });
    expect(labels(raw, call)).toEqual(['outcome_unclear', 'stop_scope']);
    const mixed = lines(['Y', 'Hi.'], ['T', "Don't stop calling me. Actually, remove me."]);
    expect(labels(answer({ stop: { requested: true, scope: 'this_number', quote: 'remove me', line: 2 } }), mixed)).toEqual(['outcome_unclear', 'stop_scope']);
    const unspoken = lines(['Y', 'Hi.'], ['T', 'I am done with this conversation.']);
    expect(labels(answer({ stop: { requested: true, scope: 'this_number', quote: 'I am done with this conversation', line: 2 } }), unspoken)).toEqual([
      'outcome_unclear',
      'stop_scope',
    ]);
  });

  it('[2] a qualifying category on a price-only line is no buying signal; an unconfirmed qualifying line is a buying signal to review', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'What does it cost?']);
    const raw = answer({ interest: { level: 'buying_signal', signals: [{ kind: 'evaluation', quote: 'What does it cost?', line: 2 }] } });
    expect(labels(raw, call)).toEqual(['outcome_unclear']);
    expect(read(raw, call).interest.signals).toMatchObject([{ kind: 'pricing_question', confirmed: false }]);
    const vague = lines(['Y', 'Hi.'], ['T', 'Hm, that sounds pretty neat.']);
    expect(labels(answer({ interest: { level: 'buying_signal', signals: [{ kind: 'evaluation', quote: 'that sounds pretty neat', line: 2 }] } }), vague)).toEqual([
      'review:buying_signal',
      'outcome_unclear',
    ]);
  });

  it('[3] a refused request, a fragment of Them’s own offer, and an agreement taken back are never applied', () => {
    const refused = lines(['Y', 'Hi.'], ['T', 'Do not send me an overview by email.']);
    expect(applies(answer({ follow_up_request: { kind: 'overview_email', quote: 'send me an overview by email', line: 2 } }), refused)).toEqual([]);
    const ownOffer = lines(['Y', 'Hi.'], ['T', "I'll send you our unit list."]);
    expect(applies(answer({ follow_up_request: { kind: 'other_email', quote: 'send you our unit list', line: 2 } }), ownOffer)).toEqual([]);
    const takenBack = lines(['Y', 'Can I send you an overview by e-mail?'], ['T', 'Sure. Actually, scratch that.']);
    expect(
      applies(answer({ follow_up_request: { kind: 'overview_email', quote: 'Can I send you an overview by e-mail?', line: 1, agreed_line: 2 } }), takenBack),
    ).toEqual([]);
    const unclear = lines(['Y', 'Hi.'], ['T', "E-mail's fine, whatever."]);
    expect(labels(answer({ follow_up_request: { kind: 'overview_email', quote: "E-mail's fine", line: 2 } }), unclear)).toEqual(['review:follow_up', 'outcome_unclear']);
  });

  it('[4] a callback David offered is confirmed only by a plain yes: "No thanks" applies nothing', () => {
    const raw = answer({ callback: { requested: true, exact: true, phrase: 'Can I call you Tuesday at 2?', line: 1, agreed_line: 2, day: 'tuesday', date_text: 'Tuesday', time: '2' } });
    expect(applies(raw, lines(['Y', 'Can I call you Tuesday at 2?'], ['T', 'No thanks.']))).toEqual([]);
    expect(labels(raw, lines(['Y', 'Can I call you Tuesday at 2?'], ['T', 'Yes, that works.']))).toEqual(['outcome:callback_requested', 'callback:2026-10-06T14:00']);
  });

  it('[5] exact only for one complete time token, minutes kept', () => {
    const callback = (text: string, time: string): string[] => {
      const call = lines(['Y', 'Hi.'], ['T', text]);
      return labels(answer({ callback: { requested: true, exact: true, phrase: text, line: 2, agreed_line: 0, day: 'tuesday', date_text: 'Tuesday', time } }), call);
    };
    for (const [text, time] of [
      ['Call me Tuesday between 2 and 4.', '2'],
      ['Call me Tuesday at 2 or 3.', '2'],
      ['Call me Tuesday 2 to 4.', '2'],
      ['Call me Tuesday 2-4.', '2'],
      ['Call me Tuesday at 2, or maybe at 5.', '2'],
      ['Call me Tuesday between lunch and 3pm.', '3pm'],
    ] as const) {
      expect(callback(text, time).filter(label => label.startsWith('callback:')), text).toEqual([]);
    }
    expect(callback('Call me Tuesday at 9:30.', '9')).toEqual(['outcome:callback_requested', 'callback:2026-10-06T09:30']);
    expect(callback('Call me Tuesday at noon.', 'noon')).toEqual(['outcome:callback_requested', 'callback:2026-10-06T12:00']);
    expect(callback('Call me Tuesday at 3pm.', '3pm')).toEqual(['outcome:callback_requested', 'callback:2026-10-06T15:00']);
    expect(callback('Call me Tuesday at half past 4.', 'half past 4')).toEqual(['outcome:callback_requested', 'callback:2026-10-06T16:30']);
  });

  it('[6] "next <weekday>", or a negation or correction near a day, never resolves', () => {
    const callback = (text: string, quote: string, dateText: string): string[] => {
      const call = lines(['Y', 'Hi.'], ['T', text]);
      return labels(answer({ callback: { requested: true, exact: true, phrase: quote, line: 2, agreed_line: 0, day: 'tuesday', date_text: dateText, time: '10' } }), call);
    };
    for (const [text, quote, dateText] of [
      ['Not next week Tuesday. Call me next Tuesday at 10.', 'Call me next Tuesday at 10', 'next Tuesday'],
      ["Not next week Tuesday, I'm away. Call me Tuesday at 10.", 'Call me Tuesday at 10', 'Tuesday'],
      ['Monday, no wait, Tuesday at 10.', 'Tuesday at 10', 'Tuesday'],
      ['Sorry, I mean Tuesday at 10.', 'Tuesday at 10', 'Tuesday'],
      ['Tuesday at 10, actually.', 'Tuesday at 10', 'Tuesday'],
    ] as const) {
      expect(callback(text, quote, dateText).filter(label => label.startsWith('callback:')), text).toEqual([]);
    }
    // A preamble "Not now." does not reach the request.
    expect(callback('Not now. Call me Tuesday at 10.', 'Call me Tuesday at 10', 'Tuesday')).toEqual(['outcome:callback_requested', 'callback:2026-10-06T10:00']);
  });

  it('[8] a confirmed overview request gives follow_up and the task with an open opportunity too', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Just send me an overview by e-mail.']);
    const raw = answer({ follow_up_request: { kind: 'overview_email', quote: 'send me an overview', line: 2 } });
    expect(labels(raw, call, { ...CONTEXT, hasOpenOpportunity: true })).toEqual(['outcome:interested', 'follow_up', 'task:overview']);
  });
});

describe('S3A1F: the follow-up review’s triggers — none applies anything', () => {
  it('[1] a stop under a negation, or beside anything else, is reviewed, and nothing beside it is applied', () => {
    const negated = lines(['Y', 'Hi.'], ['T', "Don't, under any circumstances, remove me."]);
    expect(applies(answer({ stop: { requested: true, scope: 'this_number', quote: 'remove me', line: 2 } }), negated)).toEqual([]);
    const mixed = lines(['Y', 'Hi.'], ['T', "Don't take me off the email list but stop calling me. Send me an overview."]);
    const raw = answer({
      stop: { requested: true, scope: 'this_number', quote: 'stop calling me', line: 2 },
      follow_up_request: { kind: 'overview_email', quote: 'Send me an overview', line: 2 },
      interest: { level: 'curious', signals: [] },
    });
    expect(applies(raw, mixed)).toEqual([]);
    expect(labels(raw, mixed)).toEqual(['outcome_unclear', 'stop_scope', 'stop_with_email']);
  });

  it('[2] a rejected demo, or a negated evaluation, is never a buying signal to apply', () => {
    for (const text of ["A demo isn't needed.", "We aren't evaluating anything."]) {
      const call = lines(['Y', 'Hi.'], ['T', text]);
      const raw = answer({ interest: { level: 'buying_signal', signals: [{ kind: 'evaluation', quote: text.replace(/\.$/u, ''), line: 2 }] } });
      expect(applies(raw, call), text).toEqual([]);
    }
  });

  it('[3] the wrong sender, the wrong recipient, a selectively quoted overview and a withdrawn question are never applied', () => {
    const wrongSender = lines(['Y', 'Hi.'], ['T', 'Could I send an overview to you?']);
    expect(applies(answer({ follow_up_request: { kind: 'overview_email', quote: 'Could I send an overview to you?', line: 2 } }), wrongSender)).toEqual([]);
    const wrongRecipient = lines(['Y', 'Can you send me your unit list by email?'], ['T', 'Yes']);
    expect(
      applies(answer({ follow_up_request: { kind: 'other_email', quote: 'Can you send me your unit list by email?', line: 1, agreed_line: 2 } }), wrongRecipient),
    ).toEqual([]);
    const selective = lines(['Y', 'Hi.'], ['T', "Don't send me an overview. Send me the invoice."]);
    expect(applies(answer({ follow_up_request: { kind: 'overview_email', quote: 'send me an overview', line: 2 } }), selective)).toEqual([]);
    const withdrawnQuestion = lines(['Y', 'Hi.'], ['T', 'Forget it, I was only asking whether you could send me an overview.']);
    expect(applies(answer({ follow_up_request: { kind: 'overview_email', quote: 'you could send me an overview', line: 2 } }), withdrawnQuestion)).toEqual([]);
  });

  it('[4] literal refusals and conditional replies agree to nothing, for a callback or an e-mail', () => {
    for (const reply of ['Please refrain.', 'Absolutely never.', 'Sure, provided we agree on price.']) {
      const callback = answer({ callback: { requested: true, exact: true, phrase: 'Can I call you Tuesday at 2?', line: 1, agreed_line: 2, day: 'tuesday', date_text: 'Tuesday', time: '2' } });
      expect(applies(callback, lines(['Y', 'Can I call you Tuesday at 2?'], ['T', reply])), reply).toEqual([]);
      const email = answer({ follow_up_request: { kind: 'overview_email', quote: 'Can I send you an overview by e-mail?', line: 1, agreed_line: 2 } });
      expect(applies(email, lines(['Y', 'Can I send you an overview by e-mail?'], ['T', reply])), reply).toEqual([]);
    }
  });

  it('[5] a callback Them offers to make, or one taken back on the line or later, is never applied', () => {
    const at2 = (phrase: string, line = 2, agreed = 0) =>
      answer({ callback: { requested: true, exact: true, phrase, line, agreed_line: agreed, day: 'tuesday', date_text: 'Tuesday', time: '2' } });
    expect(applies(at2("I'll call you Tuesday at 2"), lines(['Y', 'Hi.'], ['T', "I'll call you Tuesday at 2."]))).toEqual([]);
    expect(applies(at2('Call me Tuesday at 2'), lines(['Y', 'Hi.'], ['T', 'Call me Tuesday at 2. Never mind.']))).toEqual([]);
    expect(applies(at2('Call me Tuesday at 2'), lines(['Y', 'Hi.'], ['T', 'Call me Tuesday at 2.'], ['Y', 'Will do.'], ['T', 'Never mind.']))).toEqual([]);
    expect(applies(at2('Can I call you Tuesday at 2?', 1, 2), lines(['Y', 'Can I call you Tuesday at 2?'], ['T', 'Sure. Actually, scratch that.']))).toEqual([]);
  });

  it('[6] incomplete, approximate, alternative or corrected times are never an exact callback', () => {
    for (const [text, time] of [
      ['Call me Tuesday at nine twenty.', 'nine'],
      ['Call me Tuesday at 9 30.', '9'],
      ['Call me Tuesday at 9 in the evening.', '9'],
      ['Call me Tuesday at 2, or 4.', '2'],
      ['Call me Tuesday after 2pm.', '2pm'],
      ['Call me Tuesday at 2-ish.', '2'],
      ['Call me Tuesday at 2. Actually, half two.', '2'],
    ] as const) {
      const call = lines(['Y', 'Hi.'], ['T', text]);
      const raw = answer({ callback: { requested: true, exact: true, phrase: 'Call me Tuesday', line: 2, agreed_line: 0, day: 'tuesday', date_text: 'Tuesday', time } });
      expect(applies(raw, call).filter(label => label.startsWith('callback:')), text).toEqual([]);
    }
  });

  it('[7] a day with any qualifier — after next, in two weeks, not this week, the following week — is never resolved', () => {
    for (const text of [
      'Call me the Tuesday after next at 2.',
      'Call me Tuesday in two weeks at 2.',
      'Call me Tuesday at 2, but not this week.',
      'Call me Tuesday at 2. I mean the following week.',
    ]) {
      const call = lines(['Y', 'Hi.'], ['T', text]);
      const raw = answer({ callback: { requested: true, exact: true, phrase: 'Tuesday', line: 2, agreed_line: 0, day: 'tuesday', date_text: 'Tuesday', time: '2' } });
      expect(applies(raw, call).filter(label => label.startsWith('callback:')), text).toEqual([]);
    }
  });

  it('[8] a conditional or negated promise is no task, whatever the model quoted', () => {
    const conditional = lines(['Y', 'If you agree, I will send you an overview.'], ['T', "E-mail's fine, whatever."]);
    const raw = answer({
      commitments: [{ speaker: 'you', quote: 'I will send you an overview', line: 1, due_phrase: '' }],
      follow_up_request: { kind: 'overview_email', quote: "E-mail's fine", line: 2 },
    });
    expect(applies(raw, conditional)).toEqual([]);
    const negated = lines(['Y', "Don't assume I will send you an overview."], ['T', 'Okay.']);
    expect(applies(answer({ commitments: [{ speaker: 'you', quote: 'I will send you an overview', line: 1, due_phrase: '' }] }), negated)).toEqual([]);
  });
});

describe('S3A1F: property — a confirmed line with any clause appended is review', () => {
  const SUFFIXES = [
    ', but not now',
    ' but only if you have to',
    ', unless it is expensive',
    ' unless you hear otherwise',
    '. Not really.',
    '. Actually, never mind.',
    ', actually',
    ', if that is okay',
    ' if you must',
    '. But I am not sure.',
    ', not yet',
    ' — or not',
    '. Wait, no.',
    ', I mean later',
    ', though I doubt it',
    '. Maybe.',
  ];
  // And clauses with no marker word at all: unknown is review too, not only a "but".
  const UNKNOWN = [', for my accountant', ' to the landlord', ', and the weather is nice', '. The office moved.', ', said my boss', '. Bob handles that.'];
  const forms = (line: string): string[] => [...SUFFIXES, ...UNKNOWN].map(suffix => `${line.replace(/[.?!]$/u, '')}${suffix}`);

  const STOPS = [
    'Take me off your list.',
    'Please take me off your list.',
    'Stop calling me.',
    'Stop calling.',
    "Don't call me again.",
    'Do not call me.',
    "Don't call this number.",
    'Remove me from your list.',
    'Please remove this number from your list.',
    'Remove my number.',
    "I don't want these calls.",
    'We do not want your calls.',
    'No more calls, please.',
    'We get too many of these. No more calls.',
    "Don't contact anyone here.",
    "Don't contact anyone here. We don't want any of this.",
    'Stop calling us.',
    'Take us off your list.',
    'Remove us from the call list.',
    "Not interested. Don't call me again.",
    'Put me on your do not call list.',
  ];
  const BUYING_LINES = [
    "We're evaluating a couple of tools right now. Can you show us a demo?",
    "We're evaluating a few options.",
    'We are comparing three vendors for this right now.',
    "We're comparing vendors. Put us down for a trial.",
    'Can you show us a demo?',
    'Could you give us a demo?',
    'Can we see a demo?',
    'Could we get a trial?',
    'Can we set up a pilot?',
    "I'd like to see a demo.",
    "We'd love to try it.",
    "We'd like to book a walkthrough.",
    'Put us down for a pilot.',
    "We're looking at switching our portal.",
    'We are considering replacing the system.',
    'How would our techs get work orders?',
    'How would our vendors get work orders? Would it replace our portal?',
    'Would it replace our portal?',
    "Good timing, actually. We're evaluating a couple of tools right now.",
    "I'm looking at a few vendors.",
    'Could I get a quick demo?',
  ];
  const FOLLOW_UPS = [
    'Just send me an overview by e-mail.',
    "Okay. I'm in the middle of something. Just send me an overview by e-mail and I'll look at it.",
    'Send me an overview.',
    'Can you send me an overview?',
    'Could you email me the details?',
    'Send us some info.',
    'Please send me the brochure.',
    'Email me.',
    'Send me something by email.',
    'Can you send me a quick overview by email?',
    'Send an overview.',
    'Send the overview by e-mail.',
    'Could you send me some information?',
    'Would you send us the deck?',
    'Shoot me the pricing.',
    'Send me more info.',
    'You can email me the one pager.',
    "I'm busy right now. Send me an overview.",
    'Email us the details.',
    'Email me something.',
    'Forward me the overview.',
  ];
  const CALLBACKS = [
    'Call me Tuesday at 2.',
    'Not right now. Call me Tuesday at 2.',
    'Call me back.',
    "I'm driving right now, call me back.",
    'Try me next week sometime.',
    'Call me back Tuesday afternoon.',
    'Can you call me tomorrow at 9:30?',
    'It is. Call me Wednesday at 3.',
    'Call me next Tuesday at 10.',
    'Give me a call tomorrow.',
    'Try me later.',
    'Call me back at 2.',
    "She's out of the office. Try later.",
    'Could you call me Thursday at 10?',
    'Call us back tomorrow morning.',
    'Ring me on Friday.',
    'Try me again tomorrow.',
    'Call me in an hour.',
    "I'm in a meeting. Call me back in a few minutes.",
    'Give us a ring Monday.',
    'Phone me tomorrow at noon.',
  ];
  const PROMISES = [
    "I'll send pricing by Friday.",
    'I will send you a calendar link today.',
    "That's a good fit for us. I'll send pricing by Friday.",
    "I'll email you the overview.",
    'Let me send you the deck.',
    "I'll call you Thursday.",
    'I will follow up next week.',
    "We'll put together a quote.",
    'I can send that over today.',
    "I'm going to send you a summary.",
    'I will check with my team.',
    "I'll get you the details by Monday.",
    'Let me look into that for you.',
    'We will set up the trial account.',
    "I'll text you the link.",
    "Absolutely. I'll send it now.",
    "I'll ask our engineer and get back to you.",
    'We can schedule the demo for Thursday.',
    "I'll send the contract tomorrow.",
    "I'll put it on your calendar.",
    'I will send the proposal by Friday.',
  ];

  it('the base lines confirm (the control), and every one with any clause appended does not', () => {
    for (const line of STOPS) {
      expect(confirmStop(line).confirmed, line).toBe(true);
      for (const form of forms(line)) expect(confirmStop(form).confirmed, form).toBe(false);
    }
    for (const line of BUYING_LINES) {
      expect(confirmBuyingSignal(line), line).toBe('confirmed');
      for (const form of forms(line)) expect(confirmBuyingSignal(form), form).not.toBe('confirmed');
    }
    for (const line of FOLLOW_UPS) {
      expect(confirmFollowUpRequest(line, []).kind, line).toBe('confirmed');
      for (const form of forms(line)) expect(confirmFollowUpRequest(form, []).kind, form).not.toBe('confirmed');
    }
    for (const line of CALLBACKS) {
      expect(confirmCallbackRequest(line, []).confirmed, line).toBe(true);
      for (const form of forms(line)) expect(confirmCallbackRequest(form, []).confirmed, form).toBe(false);
    }
    // A promise's rule is the coordinator's marker rule (no condition, negation or contrast
    // anywhere in the line), so only the marker suffixes apply to it.
    for (const line of PROMISES) {
      expect(hasMarkers(line), line).toBe(false);
      for (const suffix of SUFFIXES) {
        const form = `${line.replace(/[.?!]$/u, '')}${suffix}`;
        expect(hasMarkers(form), form).toBe(true);
      }
    }
    for (const reply of ['Yes.', 'Sure.', 'Yeah, sure.', 'Sure, that works.', 'Yes please.', 'Okay, thanks.', 'Sounds good.', 'Go ahead.', 'Yep.', 'Sure thing.']) {
      expect(plainYes(reply), reply).toBe(true);
      for (const form of forms(reply)) expect(plainYes(form), form).toBe(false);
    }
  });

  it('through the reader and the policy, an appended clause leaves nothing to apply for the action', () => {
    for (const line of CALLBACKS.slice(0, 6)) {
      for (const form of forms(line)) {
        const raw = answer({ callback: { requested: true, exact: false, phrase: form.split(/[.,?!]/u)[0] ?? form, line: 2, agreed_line: 0, day: 'none', date_text: '', time: '' } });
        const call = lines(['Y', 'Hi.'], ['T', form]);
        if (read(raw, call).callback === null) continue;
        expect(applies(raw, call), form).toEqual([]);
      }
    }
    for (const line of FOLLOW_UPS.slice(0, 6)) {
      for (const form of forms(line)) {
        const call = lines(['Y', 'Hi.'], ['T', form]);
        const raw = answer({ follow_up_request: { kind: 'overview_email', quote: form.split(/[.,?!]/u).find(piece => /send|mail/iu.test(piece))?.trim() ?? form, line: 2 } });
        expect(applies(raw, call).filter(label => label === 'follow_up' || label.startsWith('task:') || label === 'outcome:interested'), form).toEqual([]);
      }
    }
  });
});
