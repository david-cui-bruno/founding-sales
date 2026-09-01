import { describe, expect, it } from 'vitest';

import {
  attachTranscriptRequestSchema,
  conversationDetailRequestSchema,
  conversationDetailSchema,
  conversationRowSchema,
  conversationsListRequestSchema,
  conversationsListResponseSchema,
  transcriptUtteranceSchema,
} from '../../src/shared/contracts/conversationsContract';

const validRow = {
  activityId: 'activity-1',
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  personName: 'Kevin Landlord',
  kind: 'call',
  direction: 'outbound',
  occurredAt: '2026-08-30T12:00:00.000Z',
  durationSeconds: 480,
  recordingAvailable: false,
  transcriptAvailable: true,
  summary: 'Discovery call about weekend showings.',
} as const;

const validUtterance = {
  id: 'utterance-1',
  sequence: 0,
  speaker: 'founder',
  text: 'Thanks for taking the call.',
} as const;

const validDetail = {
  ...validRow,
  transcript: {
    transcriptId: 'transcript-1',
    source: 'manual_paste',
    createdAt: '2026-08-30T13:00:00.000Z',
    utterances: [validUtterance],
  },
} as const;

describe('conversation row contract', () => {
  it('accepts a complete call row', () => {
    expect(conversationRowSchema.parse(validRow)).toEqual(validRow);
  });

  it('accepts nullable salesCycleId, durationSeconds, and summary', () => {
    expect(conversationRowSchema.parse({
      ...validRow, salesCycleId: null, durationSeconds: null, summary: null,
    })).toMatchObject({ salesCycleId: null, durationSeconds: null, summary: null });
  });

  it('rejects extra keys strictly', () => {
    expect(() => conversationRowSchema.parse({ ...validRow, score: 90 })).toThrow();
  });

  it.each(['text', 'email', 'note', ''])('rejects non-conversation kind %s', (kind) => {
    expect(() => conversationRowSchema.parse({ ...validRow, kind })).toThrow();
  });

  it.each(['internal', ''])('rejects direction %s', (direction) => {
    expect(() => conversationRowSchema.parse({ ...validRow, direction })).toThrow();
  });

  it('rejects a non-integer duration', () => {
    expect(() => conversationRowSchema.parse({ ...validRow, durationSeconds: 1.5 })).toThrow();
  });

  it('rejects a timestamp without offset information', () => {
    expect(() => conversationRowSchema.parse({ ...validRow, occurredAt: '2026-08-30' })).toThrow();
  });
});

describe('conversations list request contract', () => {
  const validRequest = {
    query: '', filter: 'all', limit: 50, cursor: null as string | null,
  } as const;

  it('accepts an empty query and null cursor', () => {
    expect(conversationsListRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it.each(['all', 'with_recording', 'with_transcript', 'without_transcript'] as const)(
    'accepts filter %s',
    (filter) => {
      expect(conversationsListRequestSchema.parse({ ...validRequest, filter }))
        .toMatchObject({ filter });
    },
  );

  it('rejects an unknown filter', () => {
    expect(() => conversationsListRequestSchema.parse({
      ...validRequest, filter: 'with_summary',
    })).toThrow();
  });

  it('bounds the query at 200 characters', () => {
    expect(conversationsListRequestSchema.parse({
      ...validRequest, query: 'a'.repeat(200),
    })).toMatchObject({ query: 'a'.repeat(200) });
    expect(() => conversationsListRequestSchema.parse({
      ...validRequest, query: 'a'.repeat(201),
    })).toThrow();
  });

  it('bounds the limit to 1..200 integers', () => {
    expect(() => conversationsListRequestSchema.parse({ ...validRequest, limit: 0 })).toThrow();
    expect(() => conversationsListRequestSchema.parse({ ...validRequest, limit: 201 })).toThrow();
    expect(() => conversationsListRequestSchema.parse({ ...validRequest, limit: 1.5 })).toThrow();
    expect(conversationsListRequestSchema.parse({ ...validRequest, limit: 1 }))
      .toMatchObject({ limit: 1 });
    expect(conversationsListRequestSchema.parse({ ...validRequest, limit: 200 }))
      .toMatchObject({ limit: 200 });
  });

  it('rejects extra keys strictly', () => {
    expect(() => conversationsListRequestSchema.parse({
      ...validRequest, offset: 10,
    })).toThrow();
  });
});

describe('conversations list response contract', () => {
  it('accepts rows with pagination metadata', () => {
    expect(conversationsListResponseSchema.parse({
      rows: [validRow], total: 1, nextCursor: null, revision: 3,
    })).toMatchObject({ total: 1, nextCursor: null, revision: 3 });
  });

  it('rejects negative totals and revisions', () => {
    expect(() => conversationsListResponseSchema.parse({
      rows: [], total: -1, nextCursor: null, revision: 0,
    })).toThrow();
    expect(() => conversationsListResponseSchema.parse({
      rows: [], total: 0, nextCursor: null, revision: -1,
    })).toThrow();
  });

  it('rejects extra keys strictly', () => {
    expect(() => conversationsListResponseSchema.parse({
      rows: [], total: 0, nextCursor: null, revision: 0, hasMore: false,
    })).toThrow();
  });
});

describe('transcript utterance contract', () => {
  it.each(['founder', 'lead', 'unknown'] as const)('accepts speaker %s', (speaker) => {
    expect(transcriptUtteranceSchema.parse({ ...validUtterance, speaker }))
      .toMatchObject({ speaker });
  });

  it('rejects other speakers, empty text, and negative sequence', () => {
    expect(() => transcriptUtteranceSchema.parse({ ...validUtterance, speaker: 'me' })).toThrow();
    expect(() => transcriptUtteranceSchema.parse({ ...validUtterance, text: '' })).toThrow();
    expect(() => transcriptUtteranceSchema.parse({ ...validUtterance, sequence: -1 })).toThrow();
  });

  it('rejects extra keys strictly', () => {
    expect(() => transcriptUtteranceSchema.parse({
      ...validUtterance, html: '<b>bold</b>',
    })).toThrow();
  });
});

describe('conversation detail contract', () => {
  it('accepts a detail with a manual transcript', () => {
    expect(conversationDetailSchema.parse(validDetail)).toEqual(validDetail);
  });

  it('accepts a detail without a transcript', () => {
    expect(conversationDetailSchema.parse({ ...validRow, transcript: null }))
      .toMatchObject({ transcript: null });
  });

  it('rejects a transcript with zero utterances', () => {
    expect(() => conversationDetailSchema.parse({
      ...validDetail,
      transcript: { ...validDetail.transcript, utterances: [] },
    })).toThrow();
  });

  it('rejects transcript sources other than manual_paste', () => {
    expect(() => conversationDetailSchema.parse({
      ...validDetail,
      transcript: { ...validDetail.transcript, source: 'apple_bridge' },
    })).toThrow();
  });

  it('rejects extra transcript keys strictly', () => {
    expect(() => conversationDetailSchema.parse({
      ...validDetail,
      transcript: { ...validDetail.transcript, rawText: 'hello' },
    })).toThrow();
  });
});

describe('conversation detail request contract', () => {
  it('accepts an activity id', () => {
    expect(conversationDetailRequestSchema.parse({ activityId: 'activity-1' }))
      .toEqual({ activityId: 'activity-1' });
  });

  it('rejects an empty activity id and extra keys', () => {
    expect(() => conversationDetailRequestSchema.parse({ activityId: '' })).toThrow();
    expect(() => conversationDetailRequestSchema.parse({
      activityId: 'activity-1', personId: 'person-1',
    })).toThrow();
  });
});

describe('attach transcript request contract', () => {
  const validAttach = {
    activityId: 'activity-1', personId: 'person-1', rawText: 'me: hello',
  } as const;

  it('accepts a manual paste request', () => {
    expect(attachTranscriptRequestSchema.parse(validAttach)).toEqual(validAttach);
  });

  it('bounds rawText to 1..200000 characters', () => {
    expect(() => attachTranscriptRequestSchema.parse({ ...validAttach, rawText: '' })).toThrow();
    expect(attachTranscriptRequestSchema.parse({
      ...validAttach, rawText: 'a'.repeat(200_000),
    })).toMatchObject({ activityId: 'activity-1' });
    expect(() => attachTranscriptRequestSchema.parse({
      ...validAttach, rawText: 'a'.repeat(200_001),
    })).toThrow();
  });

  it('rejects extra keys strictly', () => {
    expect(() => attachTranscriptRequestSchema.parse({
      ...validAttach, source: 'manual_paste',
    })).toThrow();
  });
});
