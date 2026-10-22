import { beforeEach, expect, it, vi } from 'vitest';
import { readReplyDraftContext } from '@fss/domain/replies/composer.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { QueryResultRowLike } from '@fss/domain/db/queryable.ts';

const seams = vi.hoisted(() => ({ message: vi.fn(), body: vi.fn(), target: vi.fn(), firm: vi.fn(), authorization: vi.fn() }));
vi.mock('@fss/domain/mail/messages.ts', () => ({ readMessage: seams.message, readMessageBody: seams.body }));
vi.mock('@fss/domain/mail/matching.ts', () => ({ directSendTargetOf: seams.target }));
vi.mock('@fss/domain/crm/firms.ts', () => ({ readFirm: seams.firm }));
vi.mock('@fss/domain/outreach/authorization.ts', () => ({ authorizationForMailbox: seams.authorization }));
vi.mock('@fss/domain/suppression/effective.ts', () => ({ firstSuppressed: async () => null }));
vi.mock('@fss/domain/policy/holds.ts', () => ({ listApplicableHolds: async () => [] }));
vi.mock('@fss/domain/outreach/facts.ts', () => ({ readApprovedAnswerBlocks: async () => ({ ok: true, value: [] }) }));
vi.mock('@fss/domain/research/ledger.ts', () => ({ workspaceBusinessZone: async () => 'America/New_York' }));

const id = '10000000-0000-4000-8000-000000000001';
const firm = { id, assigned_user_id: id, status: 'active', time_zone: 'America/New_York' };
const message = { id, mailboxId: id, direction: 'incoming', matched: true, metadataOnly: false, headerFrom: 'person@example.test', headerTo: ['owner@example.test'], headerCc: [], subject: 'Question', rfcMessageId: 'question@example.test', providerThreadId: id, referenceMessageIds: [], listId: null, autoSubmitted: null, internalDate: '2026-10-22T20:00:00Z' };
let afterAssembly: () => void;
let thread: { id: string; direction: string; internal_date: Date; body_text: string | null; truncated: boolean | null }[];
const ctx = repositoryContext(workspaceScope(id, { kind: 'user', userId: id, role: 'salesperson' }), {
  async query<Row extends QueryResultRowLike>(sql: string) {
    let rows: QueryResultRowLike[] = [];
    if (sql.includes('SELECT owner_user_id,email_address')) rows = [{ owner_user_id: id, email_address: 'owner@example.test', provider_account_id: id, status: 'connected', sync_state: 'ready', generation: 1 }];
    else if (sql.includes('SELECT e.id,e.version')) rows = [{ id, version: 1, address: 'person@example.test', contact_id: id }];
    else if (sql.includes('UNION SELECT email_address')) rows = [{ address: 'owner@example.test' }];
    else if (sql.includes('SELECT m.id,m.direction')) rows = structuredClone(thread);
    else if (sql.includes('FROM meetings')) afterAssembly();
    return { rows: rows as Row[], rowCount: rows.length };
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  afterAssembly = () => {};
  thread = [{ id, direction: 'incoming', internal_date: new Date(message.internalDate), body_text: 'Private original', truncated: false }];
  seams.message.mockResolvedValue(message);
  seams.body.mockResolvedValue({ text: 'Private original', truncated: false });
  seams.target.mockResolvedValue({ id, firmId: id, contactId: id, opportunityId: null, outreachPlanId: null });
  seams.firm.mockResolvedValue(firm);
  seams.authorization.mockResolvedValue({ allowed: true, revision: 1 });
});

it('returns the existing context under unchanged actual source and Firm access', async () => {
  expect(await readReplyDraftContext(ctx, { messageId: id, factRefs: [] })).toMatchObject({ ok: true, value: { messageText: 'Private original' } });
});

it('refuses actual Firm reassignment after waiting for booking context', async () => {
  afterAssembly = () => { seams.firm.mockResolvedValue({ ...firm, assigned_user_id: 'another-owner' }); };
  expect(await readReplyDraftContext(ctx, { messageId: id, factRefs: [] })).toEqual({ ok: false, reason: 'not_assigned' });
});

it('refuses original/prior body removal during later context reads', async () => {
  afterAssembly = () => { thread = thread.map(row => ({ ...row, body_text: null, truncated: null })); };
  expect(await readReplyDraftContext(ctx, { messageId: id, factRefs: [] })).toEqual({ ok: false, reason: 'source_changed' });
});

it('refuses changed mailbox authorization after context assembly waits', async () => {
  afterAssembly = () => { seams.authorization.mockResolvedValue({ allowed: false, revision: 2 }); };
  expect(await readReplyDraftContext(ctx, { messageId: id, factRefs: [] })).toEqual({ ok: false, reason: 'owner_changed' });
});

it('does not mix an earlier original body with a replacement thread body', async () => {
  thread[0]!.body_text = 'Replacement original';
  expect(await readReplyDraftContext(ctx, { messageId: id, factRefs: [] })).toEqual({ ok: false, reason: 'source_changed' });
});
