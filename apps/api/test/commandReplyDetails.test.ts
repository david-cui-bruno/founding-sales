import { describe, expect, it } from 'vitest';
import { commandReply } from '../src/routes/routeSupport.ts';

/** R2: a `live_work_present` refusal reaches the Mac with the enrollments named, and a replay does too. */
describe('commandReply', () => {
  const liveEnrollments = [{ id: '33333333-3333-4333-8333-333333333333', sequenceName: 'Spring follow-up', stepNumber: 2 }];

  it('carries the live enrollments of a refusal, fresh or replayed', () => {
    for (const replayed of [false, true]) {
      const reply = commandReply({ status: 'refused', replayed, reason: 'live_work_present', details: { liveEnrollments } });
      expect(reply.status).toBe(409);
      expect(reply.body).toEqual({ status: 'refused', replayed, reason: 'live_work_present', liveEnrollments });
    }
  });

  it('adds nothing to a refusal without them', () => {
    expect(commandReply({ status: 'refused', replayed: false, reason: 'invalid_input' }).body).toEqual({
      status: 'refused',
      replayed: false,
      reason: 'invalid_input',
    });
  });
});
