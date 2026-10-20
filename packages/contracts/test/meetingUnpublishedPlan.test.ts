import { describe, expect, it } from 'vitest';
import { meetingUnpublishedPlanSchema, saveMeetingUnpublishedPlanSchema, meetingFollowThroughScopeSchema } from '../src/meetingFollowThrough.ts';

const message = { subject: '', body: '', held: true as const, unknownFields: ['subject', 'body'] };
const plan = {
  schemaVersion: 1, state: 'unpublished', cadence: 'post_demo_3_7_14', sourceHash: 'a'.repeat(64),
  notesRevision: 0, revision: 1, savedAt: '2026-10-20T22:55:00.000Z',
  messages: [0, 3, 7, 14].map((elapsedDays, index) => ({ ...message, ordinal: index + 1, elapsedDays })),
};

describe('unpublished meeting plan boundary', () => {
  it('retains four held drafts and explicit blank human-entry fields', () => {
    expect(meetingUnpublishedPlanSchema.parse(plan)).toEqual(plan);
  });
  it('refuses publication, unheld content, altered cadence and extra authority', () => {
    for (const changed of [
      { ...plan, state: 'published' },
      { ...plan, messages: plan.messages.map((m, i) => i === 0 ? { ...m, held: false } : m) },
      { ...plan, messages: plan.messages.map((m, i) => i === 1 ? { ...m, elapsedDays: 7 } : m) },
      { ...plan, permissionId: '00000000-0000-4000-8000-000000000001' },
    ]) expect(meetingUnpublishedPlanSchema.safeParse(changed).success).toBe(false);
  });
  it('accepts only exact four-message input with optimistic concurrency', () => {
    const input = { meetingId: '00000000-0000-4000-8000-000000000001', expectedSourceHash: 'a'.repeat(64),
      expectedNotesRevision: 0, expectedPlanVersion: 0, expectedUnpublishedRevision: 0,
      messages: plan.messages.map(({ subject, body }) => ({ subject, body })) };
    expect(saveMeetingUnpublishedPlanSchema.safeParse(input).success).toBe(true);
    expect(saveMeetingUnpublishedPlanSchema.safeParse({ ...input, messages: input.messages.slice(0, 3) }).success).toBe(false);
    expect(saveMeetingUnpublishedPlanSchema.safeParse({ ...input, messages: input.messages.map(m => ({ ...m, held: false })) }).success).toBe(false);
    expect(saveMeetingUnpublishedPlanSchema.safeParse({ ...input, expectedPlanVersion: -1 }).success).toBe(false);
  });
  it('does not widen the existing send permission limit', () => {
    expect(meetingFollowThroughScopeSchema.shape.maxMessages.safeParse(3).success).toBe(true);
    expect(meetingFollowThroughScopeSchema.shape.maxMessages.safeParse(4).success).toBe(false);
  });
});
