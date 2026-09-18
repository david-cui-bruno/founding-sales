import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConditionalCommandHarness } from './sdkHarness';
import { accountKey, createWorkerAccountRepository } from '../src/workerAccountRepository';
import type { AccountRecord } from '../../../../src/shared/contracts/accountRecordContract';
import type { AccountClaim, AccountSource } from '../../../../src/shared/contracts/accountContract';

const clock = { now: () => '2026-09-09T00:00:00.000Z' };
const EXCERPT = 'Alpha Residential Management. Write to office@alpha-pm.example about your building.';
const source: AccountSource = { id: 'source-alpha-home', url: 'https://alpha-pm.example/', fetchedAt: '2026-09-08T00:00:00.000Z',
  sha256: createHash('sha256').update(EXCERPT).digest('hex'), excerpt: EXCERPT, permitted: true };
const emailClaim = (value: string): AccountClaim => ({ key: 'business_email', kind: 'fact', value, selection: 'role_mailbox', evidenceIds: [source.id] });
const roleClaim: AccountClaim = { key: 'role', kind: 'fact', value: 'Owner and broker of record.', evidenceIds: [source.id] };
const command = (n: number) => `00000000-0000-4000-a000-00000000000${n}`;

async function fixture() {
  const dynamo = new ConditionalCommandHarness();
  const store = createWorkerAccountRepository({ dynamo, tableName: 't', workspaceId: 'ws', clock });
  const account = await store.create({ commandId: command(1), name: 'Alpha Residential Management', domain: 'alpha-pm.example' });
  await store.recordFetchedSource({ accountId: account.id, source });
  const record = () => dynamo.inspect(accountKey(account.id)) as AccountRecord;
  const admit = (commandId: string, expectedVersion: number, claims: AccountClaim[]) =>
    store.admitEvidence({ commandId, accountId: account.id, expectedVersion, sources: [source], claims, routes: [] });
  return { dynamo, store, account, record, admit };
}

describe('the business email claim write on the worker account record', () => {
  it('records one address and drops the same address a later research run finds again', async () => {
    const f = await fixture();
    await f.admit(command(2), 1, [roleClaim, emailClaim('office@alpha-pm.example')]);
    expect(f.record().claims).toEqual([roleClaim, emailClaim('office@alpha-pm.example')]);
    // Research runs again on the next revision and reads the same published page. That is one fact recorded twice,
    // not two mailboxes: the second copy is dropped and everything else in the batch still commits.
    await f.admit(command(3), 2, [roleClaim, emailClaim('office@alpha-pm.example')]);
    expect(f.record().claims.filter(claim => claim.key === 'business_email')).toHaveLength(1);
    expect(f.record().claims.filter(claim => claim.key === 'role')).toHaveLength(2);
    expect(f.record().account.version).toBe(3);
  });

  it('never keeps two addresses in one batch either', async () => {
    const f = await fixture();
    await f.admit(command(2), 1, [emailClaim('office@alpha-pm.example'), emailClaim('office@alpha-pm.example')]);
    expect(f.record().claims).toEqual([emailClaim('office@alpha-pm.example')]);
  });

  it('refuses a different address rather than deciding by accident which mailbox a template would send to', async () => {
    const f = await fixture();
    await f.admit(command(2), 1, [emailClaim('office@alpha-pm.example')]);
    await expect(f.admit(command(3), 2, [emailClaim('hello@alpha-pm.example')])).rejects.toThrow('business_email_conflict');
    // Nothing of the refused batch was written: the record is exactly what it was.
    expect(f.record().claims).toEqual([emailClaim('office@alpha-pm.example')]);
    expect(f.record().account.version).toBe(2);
    await expect(f.admit(command(4), 2, [emailClaim('office@alpha-pm.example'), emailClaim('hello@alpha-pm.example')])).rejects.toThrow('business_email_conflict');
    expect(f.record().account.version).toBe(2);
  });

  it('replays an identical batch by its command id without recording anything twice', async () => {
    const f = await fixture();
    const first = await f.admit(command(2), 1, [emailClaim('office@alpha-pm.example')]);
    const replay = await f.admit(command(2), 1, [emailClaim('office@alpha-pm.example')]);
    expect(replay).toEqual({ ...first, duplicate: true });
    expect(f.record().claims).toHaveLength(1);
    expect(f.record().account.version).toBe(2);
  });
});
