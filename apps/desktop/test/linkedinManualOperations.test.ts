import { expect, it, vi } from 'vitest';
import type { AuthedClient } from '../src/main/authedClient.ts';
import { linkedinManualOperations } from '../src/main/social/linkedinManualOperations.ts';
import type { LinkedinManualView } from '@fss/contracts';
const id = '11111111-1111-4111-8111-111111111111';
const input = { ledgerId: id, entryId: id, commandId: id, expectedRevision: 0, kind: 'reply' as const, connectionState: null, occurredAt: '2026-10-01T13:00:00.000Z', voided: false, correction: null };
const view: LinkedinManualView = { accounts: [], choices: [], ledgers: [], history: [], nextBefore: null, coverage: 'manual_owner_assertions_only' };
function host(api: object, generation: () => number = () => 0) { return linkedinManualOperations({ api: api as AuthedClient, generation }); }
it('uses the same command ID and rereads current state rather than displaying an immutable receipt', async () => {
  const command = vi.fn(async () => ({ ok: true, value: { ledgerId: id, entryId: id, revision: 1 } }));
  const read = vi.fn(async () => ({ ok: true, value: view }));
  const handlers = host({ command, read });
  expect(await handlers['linkedinManual.record'](input)).toEqual({ accepted: true, view, reason: null });
  const { commandId: _, ...payload } = input;
  expect(command).toHaveBeenCalledWith('/crm/linkedin/manual/record', payload, expect.any(Function), { commandId: id });
  expect(read).toHaveBeenCalledWith('/crm/linkedin/manual/read', expect.any(Function), { ledgerId: id });
});
it('never reads after an ambiguous command and retains the exact retry ID', async () => {
  const command = vi.fn(async () => ({ ok: false, reason: 'unreadable_answer' }));
  const read = vi.fn();
  const handlers = host({ command, read });
  expect(await handlers['linkedinManual.record'](input)).toEqual({ accepted: false, view: null, reason: 'unreadable_answer' });
  await handlers['linkedinManual.record'](input);
  for (const call of command.mock.calls) expect(call).toEqual(['/crm/linkedin/manual/record', expect.objectContaining({ ledgerId: id, entryId: id }), expect.any(Function), { commandId: id }]);
  expect(read).not.toHaveBeenCalled();
});
it('drops command and refresh results after a session change, without issuing an old-session read', async () => {
  let generation = 0;
  const read = vi.fn(async () => ({ ok: true, value: view }));
  const command = vi.fn(async () => { generation++; return { ok: true, value: { ledgerId: id, entryId: id, revision: 1 } }; });
  expect(await host({ command, read }, () => generation)['linkedinManual.record'](input)).toEqual({ accepted: false, view: null, reason: 'session_changed' });
  expect(read).not.toHaveBeenCalled();
  const stableCommand = vi.fn(async () => ({ ok: true, value: { ledgerId: id, entryId: id, revision: 1 } }));
  const changingRead = vi.fn(async () => { generation++; return { ok: true, value: view }; });
  expect(await host({ command: stableCommand, read: changingRead }, () => generation)['linkedinManual.record'](input)).toEqual({ accepted: false, view: null, reason: 'session_changed' });
});
it('does not claim current state when a saved write cannot be reread', async () => {
  const command = vi.fn(async () => ({ ok: true, value: { ledgerId: id, entryId: id, revision: 1 } }));
  const read = vi.fn(async () => ({ ok: false, reason: 'offline' }));
  expect(await host({ command, read })['linkedinManual.record'](input)).toEqual({ accepted: true, view: null, reason: 'offline' });
});
