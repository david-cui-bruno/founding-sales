import { describe, expect, it } from 'vitest';
import {
  SENDER_RAMP_DEFAULT, senderCapForDay, senderCapPolicySchema, senderCapStatusSchema,
  senderRampSchema, workerPolicyRequestSchema,
} from '../../src/shared/contracts/workerPolicyContract';
import { remoteGoogleGrantDisclosureSchema, remoteGoogleGrantStatusSchema } from '../../src/shared/contracts/remoteGoogleGrantContract';
import { googleGrantDisclosure, personalGoogleGrantDisclosure, googleScopes } from '../../src/shared/contracts/googleGrantCapabilities';

const ramp = SENDER_RAMP_DEFAULT;
const day = (value: string) => `${value}T09:15:00.000Z`;
const request = {
  version: 1 as const, requestId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws',
  pairingId: '22222222-2222-4222-8222-222222222222', mailboxSubject: 'mailbox', expectedRevision: null as number | null,
  kind: 'sender-caps' as const,
};
const grant = {
  provider: 'google' as const, subject: 'mailbox', email: 'callie@usecallie.com',
  grantedScopes: ['openid', 'email', googleScopes.send, googleScopes.relevant_read],
  owner: 'remote' as const, purpose: 'permitted_correspondence' as const, capabilities: ['send' as const, 'relevant_read' as const],
};

describe('sender cap warm-up ramp arithmetic', () => {
  it('is the approved ramp and never widens the flat daily limit', () => {
    expect(ramp).toEqual({ startPerDay: 10, stepPerDay: 2, maxPerDay: 40 });
    expect(senderRampSchema.safeParse({ startPerDay: 40, stepPerDay: 2, maxPerDay: 10 }).success).toBe(false);
    expect(senderCapPolicySchema.safeParse({ sender: 'callie@usecallie.com', dailyLimit: 20, ramp }).success).toBe(false);
    expect(senderCapPolicySchema.safeParse({ sender: 'callie@usecallie.com', dailyLimit: 40, ramp }).success).toBe(true);
  });
  it.each([
    ['2026-09-18', 10, 1],
    ['2026-09-21', 16, 4],
    ['2026-10-03', 40, 16],
    ['2026-10-28', 40, 41],
  ])('at UTC calendar day %s the cap is %i', (today, expected, position) => {
    const status = senderCapForDay({ dailyLimit: 40, ramp }, day('2026-09-18'), day(today));
    expect(senderCapStatusSchema.parse(status)).toEqual(status);
    expect(status.today).toBe(expected);
    expect(status.position).toEqual({ day: position, ...ramp });
  });
  it('holds at the start value before any recorded send and never goes backwards in time', () => {
    expect(senderCapForDay({ dailyLimit: 40, ramp }, null, day('2026-09-18'))).toEqual({ today: 10, position: { day: 1, ...ramp }, firstSendAt: null });
    expect(senderCapForDay({ dailyLimit: 40, ramp }, day('2026-09-18'), day('2026-09-01')).today).toBe(10);
  });
  it('keeps the flat cap when no ramp is configured', () => {
    expect(senderCapForDay({ dailyLimit: 7 }, day('2026-09-01'), day('2026-09-18'))).toEqual({ today: 7, position: null, firstSendAt: day('2026-09-01') });
  });
  it('admits a sender-caps policy request with and without a ramp', () => {
    expect(workerPolicyRequestSchema.safeParse({ ...request, policy: { sender: 'callie@usecallie.com', dailyLimit: 40 } }).success).toBe(true);
    expect(workerPolicyRequestSchema.safeParse({ ...request, policy: { sender: 'callie@usecallie.com', dailyLimit: 40, ramp } }).success).toBe(true);
    expect(workerPolicyRequestSchema.safeParse({ ...request, policy: { sender: 'callie@usecallie.com', dailyLimit: 40, ramp: { ...ramp, stepPerDay: -1 } } }).success).toBe(false);
  });
});

describe('remote grant status and disclosure the desktop will accept', () => {
  it('carries the sender cap only beside a grant', () => {
    const senderCap = senderCapForDay({ dailyLimit: 40, ramp }, day('2026-09-18'), day('2026-09-21'));
    expect(remoteGoogleGrantStatusSchema.parse({ state: 'ready', grant, senderCap }).senderCap).toEqual(senderCap);
    expect(remoteGoogleGrantStatusSchema.safeParse({ state: 'unconfigured', grant: null, senderCap }).success).toBe(false);
    expect(remoteGoogleGrantStatusSchema.parse({ state: 'ready', grant }).senderCap).toBeUndefined();
  });
  it('refuses a stale disclosure version and text, and states the Internal audience without a testing warning', () => {
    for (const disclosure of [googleGrantDisclosure, personalGoogleGrantDisclosure]) {
      expect(remoteGoogleGrantDisclosureSchema.parse({ version: disclosure.version, text: disclosure.text })).toEqual(disclosure);
      expect(disclosure.version.endsWith('-v2')).toBe(true);
      expect(disclosure.text).not.toMatch(/seven days|Testing/);
      expect(disclosure.text).toContain('Internal');
      expect(remoteGoogleGrantDisclosureSchema.safeParse({ version: disclosure.version.replace('-v2', '-v1'), text: disclosure.text }).success).toBe(false);
      expect(remoteGoogleGrantDisclosureSchema.safeParse({ version: disclosure.version, text: `${disclosure.text} Edited.` }).success).toBe(false);
    }
    expect(googleGrantDisclosure.text).toContain('usecallie.com');
  });
});
