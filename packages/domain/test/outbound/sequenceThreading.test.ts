import { describe, expect, it } from 'vitest';
import { sequenceThreadFromHistory, threadSubject } from '../../outbound/sequenceThreading.ts';
import { mimeOf } from '../../mail/gmailClientHttp.ts';

const fence = { mailboxId: 'mailbox', firmId: 'firm', contactId: 'person', opportunityId: 'deal', recipientAddress: 'robin@example.test', subject: 'Re: Callie + Example' };
const prior = {
  execution_state: 'completed', completion_source: 'send', result: 'sent', state: 'sent', admin_resolution: null,
  mailbox_id: 'mailbox', firm_id: 'firm', contact_id: 'person', opportunity_id: 'deal',
  recipient_address: 'robin@example.test', subject: 'Callie + Example',
  provider_message_id_header: '<first@example.test>', provider_thread_id: 'gmail-thread', account_matches: true,
};

describe('ordinary sequence lineage decision', () => {
  it('starts without an invented parent, then replies to the latest durable Message-ID', () => {
    expect(sequenceThreadFromHistory(fence, [])).toEqual({ ok: true, value: null });
    const result = sequenceThreadFromHistory(fence, [prior, { ...prior, provider_message_id_header: '<second@example.test>' }]);
    expect(result).toEqual({ ok: true, value: { threadId: 'gmail-thread', inReplyTo: '<second@example.test>', references: ['<first@example.test>', '<second@example.test>'] } });
    if (!result.ok || !result.value) throw new Error('missing thread');
    const mime = mimeOf({ to: fence.recipientAddress, from: 'sender@example.test', subject: fence.subject, body: 'Reviewed reply', rfcMessageId: '<third@example.test>', ...result.value });
    expect(mime).toContain('Message-ID: <third@example.test>\r\n');
    expect(mime).toContain('In-Reply-To: <second@example.test>\r\n');
    expect(mime).toContain('References: <first@example.test> <second@example.test>\r\n');
  });

  it.each(['prepared', 'held', 'dispatching', 'reconciling', 'unknown_terminal', null])('never advances past unresolved prior %s', state => {
    expect(sequenceThreadFromHistory(fence, [{ ...prior, state }])).toEqual({ ok: false, reason: 'sequence_thread_prior_unresolved' });
  });

  it.each([
    { mailbox_id: 'another' }, { firm_id: 'another' }, { contact_id: 'another' },
    { opportunity_id: 'another' }, { recipient_address: 'another@example.test' },
    { account_matches: false }, { account_matches: null },
  ])('refuses changed owner/recipient/account scope %j', changed => {
    expect(sequenceThreadFromHistory(fence, [{ ...prior, ...changed }])).toEqual({ ok: false, reason: 'sequence_thread_scope_changed' });
  });

  it.each([{ provider_thread_id: null }, { provider_message_id_header: null }, { provider_message_id_header: '<bad>\r\nX: injected' }])('refuses unavailable or malformed identity %j', changed => {
    expect(sequenceThreadFromHistory(fence, [{ ...prior, ...changed }])).toEqual({ ok: false, reason: 'sequence_thread_identity_missing' });
  });

  it('does not guess between conflicting actual provider threads', () => {
    expect(sequenceThreadFromHistory(fence, [prior, { ...prior, provider_thread_id: 'different' }])).toEqual({ ok: false, reason: 'sequence_thread_conflict' });
  });

  it('preserves explicitly different subjects as separate conversations without changing copy', () => {
    expect(sequenceThreadFromHistory({ ...fence, subject: 'Different approved topic' }, [prior])).toEqual({ ok: true, value: null });
    expect(threadSubject('Re: re: Callie + Example')).toBe('Callie + Example');
  });

  it('skips explicitly skipped attempts, never unresolved delivered claims', () => {
    expect(sequenceThreadFromHistory(fence, [{ ...prior, state: 'unknown_terminal', admin_resolution: 'skipped' }])).toEqual({ ok: true, value: null });
    expect(sequenceThreadFromHistory(fence, [{ ...prior, state: 'unknown_terminal', admin_resolution: 'delivered' }])).toEqual({ ok: false, reason: 'sequence_thread_prior_unresolved' });
  });

  it('recognizes durable system cadence skips without exempting unknown delivery attempts', () => {
    const skipped = { ...prior, state: null, completion_source: 'system', result: 'not_applicable' };
    expect(sequenceThreadFromHistory(fence, [skipped])).toEqual({ ok: true, value: null });
    expect(sequenceThreadFromHistory(fence, [prior, skipped])).toEqual(sequenceThreadFromHistory(fence, [prior]));
    for (const state of ['prepared', 'held', 'dispatching', 'reconciling', 'unknown_terminal']) {
      expect(sequenceThreadFromHistory(fence, [{ ...skipped, state }])).toEqual({ ok: false, reason: 'sequence_thread_prior_unresolved' });
    }
    expect(sequenceThreadFromHistory(fence, [{ ...skipped, execution_state: 'pending' }])).toEqual({ ok: false, reason: 'sequence_thread_prior_unresolved' });
    expect(sequenceThreadFromHistory(fence, [{ ...skipped, completion_source: 'send' }])).toEqual({ ok: false, reason: 'sequence_thread_prior_unresolved' });
  });
});
