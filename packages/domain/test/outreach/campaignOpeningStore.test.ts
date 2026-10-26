import { beforeEach, expect, it, vi } from 'vitest';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { selectCampaignOpeningBeforeTransaction, readyCampaignOpening, verifyCampaignOpeningFence, type CampaignOpeningAttempt } from '../../outreach/campaignOpeningStore.ts';
import { openingHash, type CampaignOpeningSelector } from '../../outreach/campaignOpening.ts';
import type { CurrentOpening } from '../../outreach/campaignOpeningSource.ts';
import { id, now, openingFixture } from './campaignOpeningFixture.ts';
const mocks = vi.hoisted(() => ({ current: vi.fn(), query: vi.fn(), gate: vi.fn(), execution: vi.fn(), enrollment: vi.fn(), eligibility: vi.fn() }));
vi.mock('../../outreach/campaignOpeningSource.ts', () => ({ readCurrentCampaignOpening: mocks.current }));
vi.mock('../../outreach/emailCampaignAuthority.ts', () => ({ campaignDatabaseNow: async () => '2026-10-26T14:00:00.000Z' }));
vi.mock('../../policy/sendGate.ts', () => ({ lockSendGateForStopFact: mocks.gate }));
vi.mock('../../sequences/rows.ts', () => ({ readStepExecution: mocks.execution, readEnrollment: mocks.enrollment }));
const ctx = repositoryContext(workspaceScope(id, { kind: 'system', component: 'worker' }), { query: mocks.query });
let attempt: CampaignOpeningAttempt | null, transaction: boolean, events: string[], current: CurrentOpening;
const choice = { variantId: 'local', citationIds: [`${id}:native`] };
const select = (selector?: CampaignOpeningSelector) => selectCampaignOpeningBeforeTransaction(ctx, ctx.db, { executionId: id, selector, eligibility: { evaluate: mocks.eligibility } });
beforeEach(() => {
  vi.clearAllMocks(); attempt = null; transaction = false; events = []; current = { kind: 'current', snapshot: openingFixture() };
  mocks.current.mockImplementation(async () => structuredClone(current));
  mocks.execution.mockResolvedValue({ id, enrollmentId: id, state: 'pending', notBefore: now, dueAt: now });
  mocks.enrollment.mockResolvedValue({ id, firmId: id, contactId: id, assignedUserId: id, endedAt: null, opportunityId: null });
  mocks.eligibility.mockResolvedValue({ ok: true });
  mocks.query.mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
    events.push(sql.split(' ')[0]!);
    if (sql === 'BEGIN') { expect(transaction).toBe(false); transaction = true; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { expect(transaction).toBe(true); transaction = false; }
    if (sql.startsWith('SELECT * FROM outreach_campaign_opening_attempts')) return { rows: attempt ? [structuredClone(attempt)] : [] };
    if (sql.startsWith('INSERT INTO outreach_campaign_opening_attempts')) {
      if (attempt) return { rows: [] };
      attempt = { execution_id: id, attempt_id: String(values[2]), binding: JSON.parse(String(values[3])), snapshot_hash: String(values[4]), state: 'unknown', content: null, invalidated_at: null, fence_id: null, subject_hash: null, body_hash: null };
      return { rows: [{ attempt_id: attempt.attempt_id }] };
    }
    if (sql.startsWith('UPDATE outreach_campaign_opening_attempts')) {
      expect(transaction).toBe(true);
      if (attempt) { attempt.state = values[3] === 'ready' ? 'ready' : 'refused'; attempt.content = values[4] ? JSON.parse(String(values[4])) : null; }
    }
    if (sql.startsWith('SELECT erase_campaign_opening') && attempt) {
      attempt.content = null; attempt.invalidated_at = new Date(now); if (attempt.state === 'ready') attempt.state = 'invalidated';
    }
    return { rows: [], rowCount: 0 };
  });
});
it('commits UNKNOWN claim before selector and never holds a transaction during the asynchronous port', async () => {
  const selector = vi.fn(async () => {
    expect(transaction).toBe(false); expect(events.at(-1)).toBe('COMMIT');
    expect(attempt?.state).toBe('unknown'); expect(attempt?.content).toBeNull();
    return { kind: 'selected' as const, choice };
  });
  await select({ select: selector });
  expect(attempt?.state).toBe('ready'); expect(transaction).toBe(false);
  const identity = attempt?.attempt_id;
  await select({ select: selector });
  expect(selector).toHaveBeenCalledTimes(1); expect(attempt?.attempt_id).toBe(identity);
  expect(await readyCampaignOpening(ctx, id)).toMatchObject({ kind: 'ready', opening: 'I noticed Fictional Homes serves Dallas, TX.' });
});
it('ambiguous selector failure leaves one UNKNOWN forever, separate from a send attempt', async () => {
  const selector = vi.fn(async () => { throw new Error('lost response with private content'); });
  await select({ select: selector }); const identity = attempt?.attempt_id;
  await select({ select: selector });
  expect(selector).toHaveBeenCalledTimes(1); expect(attempt).toMatchObject({ attempt_id: identity, state: 'unknown', content: null, fence_id: null });
  expect(await readyCampaignOpening(ctx, id)).toEqual({ kind: 'held' });
});
it('a concurrent job cannot call the selector again while the original response is delayed', async () => {
  let finish: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const selector = vi.fn(async () => { await wait; return { kind: 'selected' as const, choice }; });
  const first = select({ select: selector });
  await vi.waitFor(() => expect(selector).toHaveBeenCalledTimes(1));
  const identity = attempt?.attempt_id;
  await select({ select: selector }); expect(selector).toHaveBeenCalledTimes(1);
  finish!(); await first; expect(attempt?.attempt_id).toBe(identity); expect(attempt?.state).toBe('ready');
});
it.each(['source', 'owner', 'policy', 'template'] as const)('delayed %s change erases selection but conserves UNKNOWN identity without remint', async change => {
  const selector = vi.fn(async () => {
    if (current.kind !== 'current') throw new Error('fixture');
    if (change === 'source') current.snapshot.binding.sourceFingerprint = 'c'.repeat(64);
    if (change === 'owner') current.snapshot.binding.ownerUserId = '00000000-0000-4000-8000-000000000002';
    if (change === 'policy') current.snapshot.policy.variants[0]!.text = 'Changed policy';
    if (change === 'template') current.snapshot.binding.templateContentHash = 'd'.repeat(64);
    return { kind: 'selected' as const, choice };
  });
  await select({ select: selector }); const identity = attempt?.attempt_id;
  expect(attempt).toMatchObject({ state: 'unknown', content: null }); expect(attempt?.invalidated_at).not.toBeNull();
  await select({ select: selector }); expect(selector).toHaveBeenCalledTimes(1); expect(attempt?.attempt_id).toBe(identity);
});
it.each([{ kind: 'refused' as const }, { kind: 'selected' as const, choice: { ...choice, citationIds: ['foreign'] } }])('confirmed refusal/foreign citation is terminal: %j', async result => {
  const selector = vi.fn(async () => result); await select({ select: selector }); await select({ select: selector });
  expect(attempt?.state).toBe('refused'); expect(attempt?.content).toBeNull(); expect(selector).toHaveBeenCalledTimes(1);
});
it('missing selector creates no claim, but enabled policy remains held instead of fallback', async () => {
  await select(); expect(attempt).toBeNull(); expect(mocks.query).not.toHaveBeenCalled();
  expect(await readyCampaignOpening(ctx, id)).toEqual({ kind: 'held' });
  current = { kind: 'exact_template' }; expect(await readyCampaignOpening(ctx, id)).toEqual(current);
});
it('existing eligibility refusal prevents selection, and preexisting fence forbids retroactive composition', async () => {
  const selector = vi.fn(async () => ({ kind: 'selected' as const, choice }));
  mocks.eligibility.mockResolvedValue({ ok: false, reasonCode: 'scoped_pause' }); await select({ select: selector });
  expect(attempt).toBeNull(); expect(selector).not.toHaveBeenCalled();
  mocks.eligibility.mockResolvedValue({ ok: true });
  const query = mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async (sql: string, values: readonly unknown[]) => sql.startsWith('SELECT 1 FROM outbound_messages') ? { rows: [{}] } : query(sql, values));
  await select({ select: selector }); expect(attempt).toBeNull(); expect(selector).not.toHaveBeenCalled();
});
it('dispatch requires exact frozen fence and bytes, revalidates current source, and cannot reset selection for send UNKNOWN', async () => {
  await select({ select: async () => ({ kind: 'selected', choice }) });
  if (!attempt) throw new Error('fixture');
  attempt.fence_id = id; attempt.subject_hash = openingHash('Subject'); attempt.body_hash = openingHash('Frozen body');
  const fence = { id, stepExecutionId: id, subject: 'Subject', body: 'Frozen body' };
  expect(await verifyCampaignOpeningFence(ctx, fence)).toBe(true);
  expect(await verifyCampaignOpeningFence(ctx, { ...fence, body: 'Changed bytes' })).toBe(false);
  const identity = attempt.attempt_id; current = { kind: 'held' };
  expect(await verifyCampaignOpeningFence(ctx, fence)).toBe(false);
  expect(attempt).toMatchObject({ state: 'invalidated', content: null, attempt_id: identity, fence_id: id });
});
