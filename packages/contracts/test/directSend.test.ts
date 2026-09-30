import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.ts';
import { CLASSIFIABLE_MANUAL_MODE_ORIGINS, classifyControlModeOriginCommandSchema } from '../src/index.ts';

/**
 * Send-path v2, slice S1: a direct Gmail send is an update to the conversation, not a
 * cause of manual mode. So no command stores a direct-send origin — `direct_send` is only
 * an evidence label that releases an old manual mode to automated — and the command that
 * undid a direct-send takeover is gone.
 */

const command = {
  commandId: '11111111-1111-4111-8111-111111111111',
  clientVersion: '1.0.0',
  opportunityId: '22222222-2222-4222-8222-222222222222',
  reason: 'the message of 3 September',
};

describe('the classification of a NULL manual-mode origin', () => {
  it('accepts the three stored origins and the direct-send evidence label', () => {
    expect([...CLASSIFIABLE_MANUAL_MODE_ORIGINS]).toEqual([
      'human_reply',
      'engaged_call',
      'salesperson_command',
      'direct_send',
    ]);
    for (const origin of CLASSIFIABLE_MANUAL_MODE_ORIGINS) {
      expect(classifyControlModeOriginCommandSchema.safeParse({ ...command, origin }).success, origin).toBe(true);
    }
  });

  it('refuses the historical keep-following-up choice', () => {
    expect(
      classifyControlModeOriginCommandSchema.safeParse({ ...command, origin: 'direct_send_keep_automation' }).success,
    ).toBe(false);
  });
});

describe('the keep-following-up command', () => {
  it('is no longer part of the contract', () => {
    expect('keepFollowingUpCommandSchema' in contracts).toBe(false);
  });
});
