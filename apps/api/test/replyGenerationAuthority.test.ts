import { beforeEach, expect, it, vi } from 'vitest';
import { replyDraftContextInputSchema, replyDraftContextSchema, replyDraftGenerateInputSchema, type ReplyDraftContext } from '../../../packages/contracts/src/replyComposer.ts';
import { generateReplyDraft, type HumanReplyDraftPort } from '@fss/domain/replies/composerGeneration.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';

const seams = vi.hoisted(() => ({ context: vi.fn(), attempt: vi.fn(), reserve: vi.fn(), calling: vi.fn(), settle: vi.fn(), settings: vi.fn(), holds: vi.fn(), spend: vi.fn() }));
vi.mock('@fss/domain/replies/composer.ts', () => ({ readReplyDraftContext: seams.context }));
vi.mock('@fss/domain/research/reservations.ts', () => ({ readAttempt: seams.attempt, reserveAttempt: seams.reserve, markCalling: seams.calling, settleAttempt: seams.settle }));
vi.mock('@fss/domain/policy/sendGate.ts', () => ({ lockSendGateForDispatch: vi.fn() }));
vi.mock('@fss/domain/research/ceilings.ts', () => ({ lockResearchBudget: vi.fn() }));
vi.mock('@fss/domain/research/settings.ts', () => ({ readResearchSettings: seams.settings }));
vi.mock('@fss/domain/policy/holds.ts', () => ({ listApplicableHolds: seams.holds }));
vi.mock('@fss/domain/policy/clock.ts', () => ({ databaseNow: async () => '2026-10-22T20:00:00Z' }));
vi.mock('@fss/domain/research/ledger.ts', () => ({ workspaceBusinessZone: async () => 'America/New_York', readCreditSpend: seams.spend }));

const id = '10000000-0000-4000-8000-000000000001';
const ctx = repositoryContext(workspaceScope(id, { kind: 'user', userId: id, role: 'salesperson' }), { query: async () => ({ rows: [], rowCount: 0 }) });
const input = replyDraftGenerateInputSchema.parse({ messageId: id, sourceRevision: 'a'.repeat(64), commandId: id, clientVersion: '1.0.0', factRefs: [], envelope: { to: ['person@example.test'], cc: [] } });
const source = { ok: true as const, value: replyDraftContextSchema.parse({ messageId: id, sourceRevision: input.sourceRevision, firmId: id, contactId: id, authorUserId: id, mailboxId: id, mailboxOwnerUserId: id, authorAddress: 'owner@example.test', authorizationRevision: 1, subject: 'Question', senderAddress: 'person@example.test', providerThreadId: id, inReplyTo: 'question@example.test', references: [], observedTo: ['owner@example.test'], observedCc: [], replyToMetadata: 'unavailable', envelope: input.envelope, recipientOptions: [{ address: 'person@example.test', contactId: id }], messageText: 'Private source original', priorContext: [{ direction: 'outgoing', text: 'Private prior original' }], bookings: [], facts: [], availableFacts: [] }) };
const count = vi.fn(async (_context: ReplyDraftContext) => 100);
const prepare = vi.fn(async (_context: ReplyDraftContext) => ({ raw: JSON.stringify({ text: 'Thank you for your question.', factRefs: [], unsupportedClaims: [] }), costCents: 1, costEstimated: false }));
const port: HumanReplyDraftPort = { providerKey: 'aws_bedrock.outreach_reply', countInputTokens: count, prepareReplyDraft: prepare };
beforeEach(() => {
  vi.clearAllMocks();
  seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => { replyDraftContextInputSchema.parse(selection); return source; });
  seams.settings.mockResolvedValue({ enabled: true, dailyCostCeilingCents: 1000, monthlyCostCeilingCents: 10000 });
  seams.holds.mockResolvedValue([]);
  seams.spend.mockResolvedValue({ todayCents: 0, monthToDateCents: 0 });
  seams.attempt.mockResolvedValue(null);
  seams.reserve.mockResolvedValue({ id });
  seams.calling.mockResolvedValue(true);
  seams.settle.mockResolvedValue(undefined);
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
  let authorized = true, settled = false;
  seams.settle.mockImplementation(async () => { settled = true; });
  seams.context.mockImplementation(async () => { if (settled) authorized = false; return source; });
  const result = await generateReplyDraft(ctx, input, port, async () => authorized);
  expect(prepare).toHaveBeenCalledOnce();
  expect(seams.settle).toHaveBeenCalledOnce();
  expect(result).toEqual({ ok: false, reason: 'session_changed' });
  expect(JSON.stringify(result)).not.toContain('Thank you');
});

it.each(['attempt', 'settings', 'holds', 'spend', 'reserve', 'calling'] as const)('refuses source deletion or reassignment during %s with an unchanged principal', async wait => {
  for (const reason of ['message_unavailable', 'not_assigned']) {
    count.mockClear(); prepare.mockClear(); seams.reserve.mockClear(); seams.settle.mockClear();
    seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => { replyDraftContextInputSchema.parse(selection); return source; });
    const loseSource = (): void => { seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => { replyDraftContextInputSchema.parse(selection); return { ok: false, reason }; }); };
    const defaults = {
      attempt: null,
      settings: { enabled: true, dailyCostCeilingCents: 1000, monthlyCostCeilingCents: 10000 },
      holds: [], spend: { todayCents: 0, monthToDateCents: 0 }, reserve: { id }, calling: true,
    };
    seams[wait].mockImplementation(async () => { loseSource(); return defaults[wait]; });
    const authorized = vi.fn(async () => true);
    expect(await generateReplyDraft(ctx, input, port, authorized)).toEqual({ ok: false, reason });
    await expect(authorized.mock.results[0]?.value).resolves.toBe(true);
    expect(count).toHaveBeenCalledTimes(wait === 'attempt' ? 0 : 1);
    expect(prepare).not.toHaveBeenCalled();
    if (wait === 'attempt') {
      expect(seams.reserve).not.toHaveBeenCalled();
      expect(seams.settle).not.toHaveBeenCalled();
    } else {
      expect(seams.reserve).toHaveBeenCalledOnce();
      expect(seams.reserve).toHaveBeenCalledWith(ctx, expect.objectContaining({ subjectId: input.commandId, attempt: 1 }));
      expect(seams.settle).toHaveBeenCalledWith(ctx, expect.objectContaining({ reservationId: id, outcome: { kind: 'released_not_called' } }));
    }
  }
});

it.each(['attempt', 'reserve'] as const)('refuses a changed exact source revision after %s without disclosure at the next port', async wait => {
  seams[wait].mockImplementation(async () => {
    seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => {
      replyDraftContextInputSchema.parse(selection);
      return { ok: true, value: replyDraftContextSchema.parse({ ...source.value, sourceRevision: 'b'.repeat(64), messageText: 'Replacement source' }) };
    });
    return wait === 'attempt' ? null : { id };
  });
  expect(await generateReplyDraft(ctx, input, port, async () => true)).toEqual({ ok: false, reason: 'source_changed' });
  expect(count).toHaveBeenCalledTimes(wait === 'attempt' ? 0 : 1);
  expect(prepare).not.toHaveBeenCalled();
});

it('uses freshly revalidated contract contexts rather than the initial object at both ports', async () => {
  let reads = 0;
  seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => {
    replyDraftContextInputSchema.parse(selection);
    reads++;
    return { ok: true, value: replyDraftContextSchema.parse(source.value) };
  });
  const result = await generateReplyDraft(ctx, input, port, async () => true);
  expect(result.ok).toBe(true);
  expect(count).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(count.mock.calls[0]?.[0]).not.toBe(source.value);
  expect(prepare.mock.calls[0]?.[0]).not.toBe(source.value);
  expect(reads).toBeGreaterThanOrEqual(5);
});

it.each([2, 4])('rechecks the principal after fresh disclosure context read %i', async boundary => {
  let reads = 0, authorized = true;
  seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => {
    replyDraftContextInputSchema.parse(selection);
    if (++reads === boundary) authorized = false;
    return source;
  });
  expect(await generateReplyDraft(ctx, input, port, async () => authorized)).toEqual({ ok: false, reason: 'session_changed' });
  expect(count).toHaveBeenCalledTimes(boundary === 2 ? 0 : 1);
  expect(prepare).not.toHaveBeenCalled();
  if (boundary === 4) expect(seams.settle).toHaveBeenCalledWith(ctx, expect.objectContaining({ outcome: { kind: 'released_not_called' } }));
});

it('keeps the same consumed attempt after known-not-called source refusal and restoration', async () => {
  seams.reserve.mockImplementation(async () => {
    seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => { replyDraftContextInputSchema.parse(selection); return { ok: false, reason: 'message_unavailable' }; });
    return { id };
  });
  expect(await generateReplyDraft(ctx, input, port)).toEqual({ ok: false, reason: 'message_unavailable' });
  expect(seams.settle).toHaveBeenCalledWith(ctx, expect.objectContaining({ reservationId: id, outcome: { kind: 'released_not_called' } }));
  seams.context.mockImplementation(async (_ctx: unknown, selection: unknown) => { replyDraftContextInputSchema.parse(selection); return source; });
  seams.attempt.mockResolvedValue({ id, state: 'released' });
  expect(await generateReplyDraft(ctx, input, port)).toEqual({ ok: false, reason: 'generation_already_attempted' });
  expect(count).toHaveBeenCalledOnce();
  expect(prepare).not.toHaveBeenCalled();
  expect(seams.reserve).toHaveBeenCalledOnce();
  expect(seams.reserve).toHaveBeenCalledWith(ctx, expect.objectContaining({ subjectId: input.commandId, attempt: 1 }));
});

it('retains existing absent-port and already-attempted refusals without another paid call', async () => {
  expect(await generateReplyDraft(ctx, input, null)).toEqual({ ok: false, reason: 'generation_unavailable' });
  seams.attempt.mockResolvedValue({ id });
  expect(await generateReplyDraft(ctx, input, port)).toEqual({ ok: false, reason: 'generation_already_attempted' });
  expect(count).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
