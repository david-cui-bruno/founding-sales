import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { requestedFollowupFixture, REQUESTED_NOW } from '../fixtures/requestedFollowup';
import { accountRecordSchema, type AccountRecord } from '../../src/shared/contracts/accountRecordContract';
import { requestedRecipientSchema, requestedFollowupDraftSchema, type RequestedRecipient } from '../../src/shared/contracts/requestedFollowupContract';
import { createRequestedFollowupService, validateRequestedDraftContext, validateRequestedRecipient, requestedFollowupContextRevision } from '../../src/main/outreach/requestedFollowupService';
import type { AccountClaim, AccountSource } from '../../src/shared/contracts/accountContract';

const EXCERPT = 'Alpha Residential Management. Write to office@alpha-pm.example about your building.';
const EMAIL = 'office@alpha-pm.example';
const source: AccountSource = { id: 'source-alpha-home', url: 'https://alpha-pm.example/', fetchedAt: '2026-09-08T00:00:00.000Z',
  sha256: createHash('sha256').update(EXCERPT).digest('hex'), excerpt: EXCERPT, permitted: true };
const claim: AccountClaim = { key: 'business_email', kind: 'fact', value: EMAIL, selection: 'role_mailbox', evidenceIds: [source.id] };
const binding: RequestedRecipient = { kind: 'account_claim', claimIndex: 0, email: EMAIL };

function withClaim(overrides: { claims?: AccountClaim[]; sources?: AccountSource[] } = {}): AccountRecord {
  const f = requestedFollowupFixture();
  return accountRecordSchema.parse({ ...f.record, sources: overrides.sources ?? [source], claims: overrides.claims ?? [claim] });
}

describe('the recipient binding that names one recorded business email', () => {
  it('parses beside the route and owner-supplied bindings and carries no original call', () => {
    expect(requestedRecipientSchema.parse(binding)).toEqual(binding);
    expect(requestedRecipientSchema.safeParse({ ...binding, originalCall: requestedFollowupFixture().ref }).success).toBe(false);
    expect(requestedRecipientSchema.safeParse({ ...binding, claimIndex: -1 }).success).toBe(false);
    expect(requestedRecipientSchema.safeParse({ ...binding, claimIndex: 1.5 }).success).toBe(false);
  });

  it('accepts the claim at the named index and refuses every way it can have changed', () => {
    const f = requestedFollowupFixture();
    expect(() => validateRequestedRecipient(withClaim(), binding, f.ref)).not.toThrow();
    const refused: { why: string; record: AccountRecord; binding?: RequestedRecipient }[] = [
      { why: 'a different address at that index', record: withClaim({ claims: [{ ...claim, value: 'someone.else@alpha-pm.example' }] }) },
      { why: 'a different claim key at that index', record: withClaim({ claims: [{ key: 'role', kind: 'fact', value: 'Owner', evidenceIds: [source.id] }] }) },
      { why: 'no claim at that index', record: withClaim({ claims: [] }) },
      { why: 'the claim moved to another index', record: withClaim({ claims: [{ key: 'role', kind: 'fact', value: 'Owner', evidenceIds: [source.id] }, claim] }) },
      { why: 'a source that is no longer permitted', record: withClaim({ sources: [{ ...source, permitted: false }] }) },
      { why: 'an excerpt that no longer hashes to its recorded sha', record: withClaim({ sources: [{ ...source, excerpt: 'rewritten after the fact' }] }) },
      { why: 'a citation the record no longer carries', record: withClaim({ sources: [] }) },
      { why: 'the same source recorded twice', record: withClaim({ sources: [source, { ...source }] }) },
    ];
    for (const item of refused) {
      expect(() => validateRequestedRecipient(item.record, item.binding ?? binding, f.ref), item.why).toThrow('requested_business_email_stale');
    }
  });

  it('is checked again at approval, through the same draft-context validation the admission path runs', async () => {
    const f = requestedFollowupFixture();
    const record = withClaim();
    const event = f.event, command = f.command;
    if (event.kind !== 'manual.outcome' || command.kind !== 'complete-manual') throw new Error('fixture outcome');
    const context = { account: record, originalCall: { command, event, handoff: f.handoff },
      mailContext: f.draft.mailContext, mailbox: { subject: f.draft.mailboxSubject, sender: f.draft.sender } };
    let draft = requestedFollowupDraftSchema.parse({ ...f.draft, recipient: EMAIL, recipientBinding: binding });
    draft = { ...draft, contextRevision: requestedFollowupContextRevision(draft) };
    expect(() => validateRequestedDraftContext(draft, context)).not.toThrow();
    // Exactly the same draft, against a record whose claim changed after it was prepared, is refused at approval.
    expect(() => validateRequestedDraftContext(draft, { ...context, account: withClaim({ claims: [{ ...claim, value: 'moved@alpha-pm.example' }] }) }))
      .toThrow('requested_business_email_stale');

    // And at prepare time, through the real service: nothing is saved when the claim does not back the recipient.
    const saves: unknown[] = [];
    const service = createRequestedFollowupService({
      store: { readContext: async () => ({ ...context, account: withClaim({ claims: [] }) }), get: async () => null,
        save: async value => { saves.push(value); return value; } },
      clock: { now: () => REQUESTED_NOW }, id: () => 'draft-template-1' });
    await expect(service.prepareRequestedFollowup({ accountId: f.draft.accountId, originalCall: f.ref, recipientBinding: binding,
      expectedAccountVersion: 1, mode: 'manual' }, new AbortController().signal)).rejects.toThrow('requested_business_email_stale');
    expect(saves).toEqual([]);
  });
});
