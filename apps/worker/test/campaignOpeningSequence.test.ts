import { beforeEach, expect, it, vi } from 'vitest';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { JobHandlerInput } from '@fss/domain/jobs/handlerRegistry.ts';
import { sequenceActionJobHandler } from '../src/handlers/sequenceAction.ts';
const mocks = vi.hoisted(() => ({ select: vi.fn(), run: vi.fn(), dispatch: vi.fn(), query: vi.fn() }));
vi.mock('@fss/domain/outreach/campaignOpeningStore.ts', () => ({ selectCampaignOpeningBeforeTransaction: mocks.select }));
vi.mock('@fss/domain/sequences/executions.ts', () => ({ runDueStepExecution: mocks.run, dispatchPreparedStep: mocks.dispatch }));
const id = '00000000-0000-4000-8000-000000000001', now = '2026-10-26T14:00:00.000Z';
let transaction: boolean, events: string[];
const input: JobHandlerInput = { session: { query: mocks.query }, scope: workspaceScope(id, { kind: 'system', component: 'worker' }),
  job: { id, workspaceId: id, kind: 'sequence.action', idempotencyKey: id, payload: { stepExecutionId: id }, attempt: 1, maxAttempts: 4, fencingToken: '1', leaseOwner: 'local', leaseExpiresAt: now } };
beforeEach(() => {
  vi.clearAllMocks(); transaction = false; events = [];
  mocks.query.mockImplementation(async (sql: string) => {
    events.push(sql); if (sql === 'BEGIN') transaction = true; if (sql === 'COMMIT' || sql === 'ROLLBACK') transaction = false;
    return { rows: [{ now: new Date(now) }], rowCount: 1 };
  });
  mocks.select.mockImplementation(async () => { expect(transaction).toBe(false); events.push('selection'); });
  mocks.run.mockImplementation(async () => { expect(transaction).toBe(true); events.push('prepare'); return { kind: 'handed_to_send', stepExecutionId: id, outboundMessageId: id, sendAt: now }; });
  mocks.dispatch.mockImplementation(async () => { expect(transaction).toBe(false); expect(events.at(-1)).toBe('COMMIT'); events.push('dispatch'); });
});
it('awaits opening owner before normal preparation transaction, dispatch stays after commit using existing engine', async () => {
  const selector = { select: vi.fn() };
  await sequenceActionJobHandler({ openingSelector: selector }).handle(input);
  expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ actor: { kind: 'system', component: 'worker' } }) }), input.session,
    expect.objectContaining({ executionId: id, selector }));
  expect(events).toEqual(['SELECT now() AS now', 'selection', 'BEGIN', 'prepare', 'COMMIT', 'dispatch']);
});
it('unavailable production selector is not silently installed or invoked', async () => {
  await sequenceActionJobHandler().handle(input);
  expect(mocks.select.mock.calls[0]?.[2]).toMatchObject({ selector: undefined });
});
it('unknown opening-owner database failure does not continue into preparation or handoff', async () => {
  const failure = new Error('synthetic unknown database commit'); mocks.select.mockRejectedValue(failure);
  await expect(sequenceActionJobHandler().handle(input)).rejects.toBe(failure);
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled(); expect(transaction).toBe(false);
});
