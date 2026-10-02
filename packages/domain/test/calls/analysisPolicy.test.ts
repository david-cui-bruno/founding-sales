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

  it('an overview request: interested and follow_up, plus the "Send overview" task only without an open opportunity, never a buying signal', () => {
    const call = lines(['Y', 'Hi.'], ['T', 'Just send me an overview by e-mail.']);
    const raw = answer({ interest: { level: 'curious', signals: [] }, follow_up_request: { kind: 'overview_email', quote: 'send me an overview', line: 2 } });
    expect(labels(raw, call)).toEqual(['outcome:interested', 'follow_up', 'task:overview']);
    const set = proposeEffects(read(raw, call), CONTEXT);
    expect(set.proposals.find(proposal => proposal.kind === 'task')).toMatchObject({ key: taskKey('send me an overview'), params: { text: 'Send overview to Dana Whitfield' } });
    expect(labels(raw, call, { ...CONTEXT, hasOpenOpportunity: true })).toEqual(['outcome:interested', 'follow_up']);
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

  it('an explicit stop: do_not_call on the number only; a wider scope adds stop_scope; an e-mail request adds stop_with_email and never a follow_up or task', () => {
    const call = lines(['Y', 'Hi. I will send you the overview today.'], ['T', 'Stop calling me, but send the overview by e-mail.']);
    const stop = { requested: true, scope: 'this_number' as const, quote: 'Stop calling me', line: 2 };
    expect(labels(answer({ stop }), call)).toEqual(['outcome:do_not_call']);
    const set = proposeEffects(read(answer({ stop }), call), CONTEXT);
    expect(set.proposals[0]).toMatchObject({ params: { outcome: 'do_not_call', doNotCallCoversAllContact: false } });
    expect(labels(answer({ stop: { ...stop, scope: 'unclear' } }), call)).toEqual(['outcome:do_not_call', 'stop_scope']);
    expect(labels(answer({ stop: { ...stop, scope: 'all_contact' } }), call)).toEqual(['outcome:do_not_call', 'stop_scope']);
    const mixed = answer({
      stop,
      follow_up_request: { kind: 'overview_email', quote: 'send the overview by e-mail', line: 2 },
      interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'send the overview', line: 2 }] },
      commitments: [{ speaker: 'you', quote: 'I will send you the overview today', line: 1, due_phrase: 'today' }],
    });
    expect(labels(mixed, call)).toEqual(['outcome:do_not_call', 'stop_with_email']);
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
    expect(at('Tomorrow at 9:30 works', 'tomorrow', 'Tomorrow', '9:30')).toBe('2026-10-06T09:30');
    expect(at('Today at 4 is fine', 'today', 'Today', '4')).toBe('2026-10-05T16:00');
    // Today at 9 has already passed at 10:15.
    expect(at('Today at 9 is fine', 'today', 'Today', '9')).toBeNull();
  });

  it('never resolves "next Tuesday", a day without a time, or day words that name another day', () => {
    expect(at('Call me next Tuesday at 10', 'tuesday', 'next Tuesday', '10')).toBeNull();
    expect(at('Call me Tuesday afternoon', 'tuesday', 'Tuesday', '')).toBeNull();
    expect(at('Call me Tuesday at 2', 'wednesday', 'Tuesday', '2')).toBeNull();
  });

  it('uses what follows the last correction', () => {
    expect(at('Tuesday at 2, no wait, Wednesday at 10', 'wednesday', 'Wednesday', '10')).toBe('2026-10-07T10:00');
    expect(at('Tuesday at 2, no wait, Wednesday at 10', 'tuesday', 'Tuesday', '2')).toBeNull();
  });

  it('reads a bare hour 1-6 as afternoon, 7-11 as morning, 12 as noon; an explicit am or pm wins', () => {
    expect(parseSpokenTime('2')).toBe('14:00');
    expect(parseSpokenTime('6')).toBe('18:00');
    expect(parseSpokenTime('7')).toBe('07:00');
    expect(parseSpokenTime('11')).toBe('11:00');
    expect(parseSpokenTime('12')).toBe('12:00');
    expect(parseSpokenTime('noon')).toBe('12:00');
    expect(parseSpokenTime('two thirty')).toBe('14:30');
    expect(parseSpokenTime('9:30')).toBe('09:30');
    expect(parseSpokenTime('at 8 pm')).toBe('20:00');
    expect(parseSpokenTime('3pm')).toBe('15:00');
    expect(parseSpokenTime('10 a.m.')).toBe('10:00');
    expect(parseSpokenTime('half past four')).toBe('16:30');
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

