import { beforeEach, expect, it, vi } from 'vitest';
import { generateReplyDraft, type HumanReplyDraftPort } from '@fss/domain/replies/composerGeneration.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';

const seams = vi.hoisted(() => ({ context: vi.fn(), attempt: vi.fn(), reserve: vi.fn(), calling: vi.fn(), settle: vi.fn() }));
vi.mock('@fss/domain/replies/composer.ts', () => ({ readReplyDraftContext: seams.context }));
vi.mock('@fss/domain/research/reservations.ts', () => ({ readAttempt: seams.attempt, reserveAttempt: seams.reserve, markCalling: seams.calling, settleAttempt: seams.settle }));
vi.mock('@fss/domain/policy/sendGate.ts', () => ({ lockSendGateForDispatch: vi.fn() }));
vi.mock('@fss/domain/research/ceilings.ts', () => ({ lockResearchBudget: vi.fn() }));
vi.mock('@fss/domain/research/settings.ts', () => ({ readResearchSettings: async () => ({ enabled: true, dailyCostCeilingCents: 1000, monthlyCostCeilingCents: 10000 }) }));
vi.mock('@fss/domain/policy/holds.ts', () => ({ listApplicableHolds: async () => [] }));
vi.mock('@fss/domain/policy/clock.ts', () => ({ databaseNow: async () => '2026-10-22T20:00:00Z' }));
vi.mock('@fss/domain/research/ledger.ts', () => ({ workspaceBusinessZone: async () => 'America/New_York', readCreditSpend: async () => ({ todayCents: 0, monthToDateCents: 0 }) }));

const id = '10000000-0000-4000-8000-000000000001';
const ctx = repositoryContext(workspaceScope(id, { kind: 'user', userId: id, role: 'salesperson' }), { query: async () => ({ rows: [], rowCount: 0 }) });
const input = { messageId: id, sourceRevision: 'a'.repeat(64), commandId: id, clientVersion: '1.0.0', factRefs: [], envelope: { to: ['person@example.test'], cc: [] } };
const source = { ok: true, value: { sourceRevision: input.sourceRevision, firmId: id, mailboxId: id, mailboxOwnerUserId: id, facts: [] } };
const count = vi.fn(async () => 100);
const prepare = vi.fn(async () => ({ raw: JSON.stringify({ text: 'Thank you for your question.', factRefs: [], unsupportedClaims: [] }), costCents: 1, costEstimated: false }));
const port: HumanReplyDraftPort = { providerKey: 'aws_bedrock.outreach_reply', countInputTokens: count, prepareReplyDraft: prepare };
beforeEach(() => {
  vi.clearAllMocks();
  seams.context.mockResolvedValue(source);
  seams.attempt.mockResolvedValue(null);
  seams.reserve.mockResolvedValue({ id });
  seams.calling.mockResolvedValue(true);
});

it('refuses before any token-count port sees originals after source assembly loses identity', async () => {
  let authorized = true;
  seams.context.mockImplementation(async () => { authorized = false; return source; });
  expect(await generateReplyDraft(ctx, input, port, async () => authorized)).toEqual({ ok: false, reason: 'session_changed' });
  expect(count).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(seams.reserve).not.toHaveBeenCalled();
});

it('rechecks identity after the paid-attempt lookup and before token counting', async () => {
  let authorized = true;
  seams.attempt.mockImplementation(async () => { authorized = false; return null; });
  expect(await generateReplyDraft(ctx, input, port, async () => authorized)).toEqual({ ok: false, reason: 'session_changed' });
  expect(count).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

it('withholds a generated suggestion after identity changes during the final source re-read', async () => {
  let authorized = true, reads = 0;
  seams.context.mockImplementation(async () => { if (++reads === 3) authorized = false; return source; });
  const result = await generateReplyDraft(ctx, input, port, async () => authorized);
  expect(prepare).toHaveBeenCalledOnce();
  expect(seams.settle).toHaveBeenCalledOnce();
  expect(result).toEqual({ ok: false, reason: 'session_changed' });
  expect(JSON.stringify(result)).not.toContain('Thank you');
});

it('retains existing absent-port and already-attempted refusals without another paid call', async () => {
  expect(await generateReplyDraft(ctx, input, null)).toEqual({ ok: false, reason: 'generation_unavailable' });
  seams.attempt.mockResolvedValue({ id });
  expect(await generateReplyDraft(ctx, input, port)).toEqual({ ok: false, reason: 'generation_already_attempted' });
  expect(count).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
