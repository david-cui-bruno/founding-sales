import { describe, expect, it } from 'vitest';
import { MEETING_BRIEF_SECTION_MAX, meetingBriefResponseSchema, type CallAnalysisResponse, type CallSummaryDto } from '@fss/contracts';
import { assembleMeetingBrief, type BriefCall, type MeetingBriefSources } from '../../meetings/brief.ts';

/**
 * Lane M2: the meeting brief's assembly, pure over its sources — every section with nothing
 * behind it, the caps, the de-duplication, and each item's source, date and provenance. No
 * real business or person.
 */

const MEETING_ID = '44444444-4444-4444-8444-444444444401';
const FIRM_ID = '44444444-4444-4444-8444-444444444402';
const SESSION = (n: number): string => `44444444-4444-4444-8444-4444444445${String(n).padStart(2, '0')}`;

const meeting: MeetingBriefSources['meeting'] = {
  id: MEETING_ID,
  firm_id: FIRM_ID,
  state: 'booked',
  starts_at: new Date('2026-10-08T15:00:00.000Z'),
  ends_at: new Date('2026-10-08T15:30:00.000Z'),
  event_title: 'Callie demo between David and Dana Example',
  attendee_name: 'Dana Example',
  booking_notes: null,
  booking_answers: null,
  location_type: 'zoom_video',
  created_at: new Date('2026-10-01T12:00:00.000Z'),
};

const empty: MeetingBriefSources = {
  meeting,
  calls: [],
  storedSummaries: new Map(),
  analysedSummaries: new Map(),
  analyses: new Map(),
  prepared: null,
  facts: [],
  threads: [],
  now: new Date('2026-10-03T12:00:00.000Z'),
};

const call = (n: number, outcome: string | null, at: string): BriefCall => ({ outcome, at: new Date(at), sessionId: SESSION(n) });

const summary = (text: string, extra: Partial<CallSummaryDto> = {}): CallSummaryDto => ({
  summary: text,
  nextSteps: [],
  commitments: [],
  model: 'claude-haiku-4-5-20251001',
  createdAt: '2026-10-01T12:00:00.000Z',
  ...extra,
});

/** An analysis read whose authoritative result carries `signals` and `objections`. */
function analysis(sessionId: string, signals: { kind: string; quote: string }[], objections: { category: string; quote: string }[] = []): CallAnalysisResponse {
  const ref = (quote: string) => ({ line: 2, side: 'them', start: 5, end: 9, quote });
  return {
    callSessionId: sessionId,
    authoritative: {
      result: {
        interest: { level: 'buying_signal', signals: signals.map(signal => ({ kind: signal.kind, ref: ref(signal.quote), confirmed: true })) },
        objections: objections.map(objection => ({ category: objection.category, ref: ref(objection.quote), answered: null })),
      },
    },
  } as unknown as CallAnalysisResponse;
}

describe('the meeting brief, assembled', () => {
  it('with no sources: every section empty, and a valid answer', () => {
    const brief = assembleMeetingBrief(empty);
    expect(meetingBriefResponseSchema.safeParse(brief).success).toBe(true);
    for (const key of ['whyThisDemo', 'firm', 'conversations', 'objections', 'commitments'] as const) {
      expect(brief.sections[key]).toEqual({ items: [], omitted: 0 });
    }
    expect(brief.meeting).toMatchObject({ title: 'Callie demo between David and Dana Example', attendeeName: 'Dana Example', locationType: 'zoom_video' });
  });

  it('why this demo: the booker s words, then the demo requests quoted from calls, then the summaries next steps', () => {
    const brief = assembleMeetingBrief({
      ...empty,
      meeting: { ...meeting, booking_notes: 'Requests come in by text.', booking_answers: { 'How many doors?': '300' } },
      calls: [call(1, 'interested', '2026-09-30T15:00:00.000Z'), call(2, 'callback_requested', '2026-09-25T15:00:00.000Z')],
      analyses: new Map([[SESSION(1), analysis(SESSION(1), [{ kind: 'demo_request', quote: 'Can you show us a demo?' }, { kind: 'evaluation', quote: 'We are looking' }])]]),
      storedSummaries: new Map([[SESSION(2), summary('They asked for a call back.', { nextSteps: [{ action: 'Send the calendar link', owner: 'you', due: 'today' }] })]]),
    });
    expect(brief.sections.whyThisDemo.items.map(entry => [entry.source, entry.provenance, entry.label, entry.text, entry.at])).toEqual([
      ['booking_notes', 'stated', 'Notes', 'Requests come in by text.', '2026-10-01T12:00:00.000Z'],
      ['booking_answer', 'stated', 'How many doors?', '300', '2026-10-01T12:00:00.000Z'],
      ['call_signal', 'observed', 'Asked for a demo', 'Can you show us a demo?', '2026-09-30T15:00:00.000Z'],
      ['call_next_step', 'inferred', 'Next step · You', 'Send the calendar link (today)', '2026-09-25T15:00:00.000Z'],
    ]);
  });

  it('firm: the prepared brief s first lines, unverified, then the software and workflow quotes; other facts are not the brief s', () => {
    const brief = assembleMeetingBrief({
      ...empty,
      prepared: {
        brief: 'Ask for Dana, the operations lead.\n\nUses AppFolio.\n240 doors.\nFourth line.',
        sources: [{ url: 'https://dana.example/about', label: 'About' }],
        observedOn: '2026-09-20',
        preparedBy: 'Research partner',
        updatedAt: '2026-09-20T12:00:00.000Z',
      },
      facts: [
        { id: 'f1', key: 'software_evidence', quote: 'Pay rent online through AppFolio', firstParty: true, sourceReference: 'https://dana.example/pay', retrievedAt: '2026-09-21T12:00:00.000Z', confidence: 0.9 },
        { id: 'f2', key: 'portfolio_size', quote: '240 doors', firstParty: true, sourceReference: 'https://dana.example', retrievedAt: '2026-09-21T12:00:00.000Z', confidence: 0.9 },
        { id: 'f3', key: 'maintenance_workflow', quote: 'Submit a request by text', firstParty: true, sourceReference: 'https://dana.example/m', retrievedAt: '2026-09-21T12:00:00.000Z', confidence: 0.8 },
      ],
    });
    expect(brief.sections.firm.items.map(entry => [entry.label, entry.text, entry.provenance, entry.at, entry.sourceUrl])).toEqual([
      ['Prepared research', 'Ask for Dana, the operations lead.', 'unverified', '2026-09-20', 'https://dana.example/about'],
      ['Prepared research', 'Uses AppFolio.', 'unverified', '2026-09-20', 'https://dana.example/about'],
      ['Prepared research', '240 doors.', 'unverified', '2026-09-20', 'https://dana.example/about'],
      ['Software', 'Pay rent online through AppFolio', 'observed', '2026-09-21T12:00:00.000Z', 'https://dana.example/pay'],
      ['Maintenance workflow', 'Submit a request by text', 'observed', '2026-09-21T12:00:00.000Z', 'https://dana.example/m'],
    ]);
  });

  it('previous conversations: the last three calls with a one-line summary, and the last two threads by subject', () => {
    const brief = assembleMeetingBrief({
      ...empty,
      calls: [
        call(1, 'interested', '2026-09-30T15:00:00.000Z'),
        { outcome: 'voicemail_left', at: new Date('2026-09-28T15:00:00.000Z'), sessionId: null },
        call(3, null, '2026-09-26T15:00:00.000Z'),
        call(4, 'no_answer', '2026-09-24T15:00:00.000Z'),
      ],
      analysedSummaries: new Map([[SESSION(1), summary('You reached Dana. She asked for a demo.\nMore detail.')]]),
      storedSummaries: new Map([[SESSION(1), summary('An older stored summary.')]]),
      threads: [
        { subject: 'Re: Callie demo', at: new Date('2026-10-01T09:00:00.000Z') },
        { subject: null, at: new Date('2026-09-29T09:00:00.000Z') },
        { subject: 'Third thread', at: new Date('2026-09-20T09:00:00.000Z') },
      ],
    });
    expect(brief.sections.conversations.items.map(entry => [entry.source, entry.label, entry.text, entry.provenance])).toEqual([
      ['call', 'interested', 'You reached Dana.', 'inferred'],
      ['call', 'voicemail_left', 'No summary', 'observed'],
      ['call', null, 'No summary', 'observed'],
      ['email_thread', 'E-mail', 'Re: Callie demo', 'observed'],
      ['email_thread', 'E-mail', '(no subject)', 'observed'],
    ]);
  });

  it('objections: one per category, the most recent quote; commitments de-duplicated', () => {
    const brief = assembleMeetingBrief({
      ...empty,
      calls: [call(1, 'interested', '2026-09-30T15:00:00.000Z'), call(2, 'interested', '2026-09-20T15:00:00.000Z')],
      analyses: new Map([
        [SESSION(1), analysis(SESSION(1), [], [{ category: 'price', quote: 'It sounds expensive' }])],
        [SESSION(2), analysis(SESSION(2), [], [{ category: 'price', quote: 'What does it cost?' }, { category: 'timing', quote: 'Not before spring' }])],
      ]),
      storedSummaries: new Map([
        [SESSION(1), summary('One.', { commitments: [{ speaker: 'you', quote: 'I will send the pricing sheet' }] })],
        [SESSION(2), summary('Two.', { commitments: [{ speaker: 'you', quote: 'I  will send the PRICING sheet' }, { speaker: 'them', quote: 'I will ask my partner' }] })],
      ]),
    });
    expect(brief.sections.objections.items.map(entry => [entry.label, entry.text, entry.at])).toEqual([
      ['price', 'It sounds expensive', '2026-09-30T15:00:00.000Z'],
      ['timing', 'Not before spring', '2026-09-20T15:00:00.000Z'],
    ]);
    expect(brief.sections.commitments.items.map(entry => [entry.label, entry.text])).toEqual([
      ['You', 'I will send the pricing sheet'],
      ['They', 'I will ask my partner'],
    ]);
  });

  it('caps each section and counts what it left out', () => {
    const answers = Object.fromEntries(Array.from({ length: MEETING_BRIEF_SECTION_MAX + 4 }, (_, index) => [`Question ${String(index)}`, 'Yes']));
    const brief = assembleMeetingBrief({ ...empty, meeting: { ...meeting, booking_answers: answers } });
    expect(brief.sections.whyThisDemo.items).toHaveLength(MEETING_BRIEF_SECTION_MAX);
    expect(brief.sections.whyThisDemo.omitted).toBe(4);
    expect(meetingBriefResponseSchema.safeParse(brief).success).toBe(true);
  });
});
