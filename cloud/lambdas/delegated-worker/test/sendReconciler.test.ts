import { describe, expect, it } from 'vitest';
import { verifySentMatch } from '../src/sendReconciler';
import type { MailMessage } from '../../../../src/shared/contracts/mailThreadContract';

const email = { commandId: '11111111-1111-4111-8111-111111111111', from: 'sender@example.invalid', to: 'recipient@example.invalid', subject: 'Requested follow-up', body: 'Approved reply.\nSecond line.' };
const match: MailMessage = { id: 'sent1', threadId: 'thread1', rfcMessageId: `<${email.commandId}@callie.invalid>`, references: [], from: [email.from], to: [email.to], cc: [], date: '2026-09-09T00:00:00.000Z', subject: email.subject, bodyParts: [{ mimeType: 'text/plain', text: email.body, truncated: false }] };

describe('deterministic sent identity verification', () => {
  it('accepts only one complete exact associated message', () => {
    expect(verifySentMatch(email, [match])).toEqual({ status: 'provider_accepted', reason: 'sent_match', providerIdentity: { messageId: 'sent1', threadId: 'thread1' } });
  });
  it('absence and multiple matches remain unknown, never resend permission', () => {
    expect(verifySentMatch(email, [])).toEqual({ status: 'unknown', reason: 'sent_absent' });
    expect(verifySentMatch(email, [match, { ...match, id: 'sent2' }])).toEqual({ status: 'unknown', reason: 'sent_ambiguous' });
  });
  it.each([
    { rfcMessageId: '<other@callie.invalid>' }, { from: ['other@example.invalid'] },
    { to: ['other@example.invalid'] }, { cc: ['extra@example.invalid'] }, { subject: 'Changed' },
    { bodyParts: [{ mimeType: 'text/plain' as const, text: 'Changed', truncated: false }] },
    { bodyParts: [{ mimeType: 'text/plain' as const, text: email.body, truncated: true }] },
  ])('rejects identity/content mismatch %j', change => {
    expect(verifySentMatch(email, [{ ...match, ...change }]).status).toBe('unknown');
  });
  it('normalizes transport line endings but not substantive whitespace', () => {
    expect(verifySentMatch(email, [{ ...match, bodyParts: [{ mimeType: 'text/plain', text: email.body.replace(/\n/g, '\r\n'), truncated: false }] }]).status).toBe('provider_accepted');
    expect(verifySentMatch(email, [{ ...match, bodyParts: [{ mimeType: 'text/plain', text: email.body + ' ', truncated: false }] }]).status).toBe('unknown');
  });
  it('checks approved thread identity when replying', () => {
    expect(verifySentMatch({ ...email, threadId: 'different' }, [match]).status).toBe('unknown');
  });
});
it('requires exact approved References rather than only provider thread identity', () => {
  const approved = { ...email, threadId: 'thread1', inReplyTo: '<request@example.invalid>', references: ['<request@example.invalid>'] };
  expect(verifySentMatch(approved, [match]).status).toBe('unknown');
  expect(verifySentMatch(approved, [{ ...match, references: approved.references }]).status).toBe('provider_accepted');
  expect(verifySentMatch(approved, [{ ...match, references: [...approved.references, '<other@example.invalid>'] }]).status).toBe('unknown');
});
