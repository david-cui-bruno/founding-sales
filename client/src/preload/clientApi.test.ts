import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createClientApi } from './clientApi';

/**
 * The renderer bridge on a fake IPC invoker: exactly six operations (slice S2 added `dial`), every request
 * validated before it is sent and every reply validated with the contract's zod schemas before it reaches
 * renderer code.
 */
const NOW = '2026-09-18T12:00:00.000Z';
const status = { state: 'unpaired', endpoint: 'https://worker.example.test', endpointSource: 'environment', deviceId: null, workspaceId: null, pairedAt: null, notice: null };
const diagnostics = {
  asOf: NOW,
  attempts: [{ at: NOW, kind: 'command', outcome: 'ok', reason: null, detail: { code: 'revoke_device', commandId: randomUUID() }, durationMs: 40, ref: null }],
  lastTick: { at: NOW, status: 'completed', durationMs: 900 },
  devices: [{ deviceId: randomUUID(), label: 'David MacBook', createdAt: NOW, lastSeenAt: null, revokedAt: null, expiresAt: '2026-12-17T12:00:00.000Z' }],
};
const invoker = (reply: unknown) => vi.fn().mockResolvedValue(reply);

describe('createClientApi', () => {
  it('exposes exactly status, pair, get, command, dial, phoneSetup, google and unpair', () => {
    expect(Object.keys(createClientApi(vi.fn())).sort()).toEqual(['command', 'dial', 'get', 'google', 'pair', 'phoneSetup', 'status', 'unpair']);
  });

  it('google sends the action and validates the answer, refusing anything the contract does not allow', async () => {
    const begun = { outcome: 'begun', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x', opened: true,
      sentence: 'Google is open in your browser. Finish the consent there, then come back to this page.' };
    const invoke = invoker(begun);
    expect(await createClientApi(invoke).google({ action: 'begin' })).toEqual(begun);
    expect(invoke).toHaveBeenCalledWith('client:google', { action: 'begin' });
    const revoked = { outcome: 'revoked', revoked: 1, sentence: 'Revoked the old grant. The fresh consent is unaffected.' };
    expect(await createClientApi(invoker(revoked)).google({ action: 'revoke_old' })).toEqual(revoked);
    // There is no third action, and there is no outcome that says a send happened.
    await expect(createClientApi(invoker(begun)).google({ action: 'connect' } as never)).rejects.toThrow();
    await expect(createClientApi(invoker({ outcome: 'sent' })).google({ action: 'begin' })).rejects.toThrow();
  });

  it('dial sends the firm and the number and validates the answer, refusing a shape the contract does not allow', async () => {
    const handed = { outcome: 'handed_off', number: '+14015550201' };
    const invoke = invoker(handed);
    expect(await createClientApi(invoke).dial({ firmId: 'account-ri-1', number: '+14015550201' })).toEqual(handed);
    expect(invoke).toHaveBeenCalledWith('client:dial', { firmId: 'account-ri-1', number: '+14015550201' });
    const refused = { outcome: 'refused', reason: 'view_stale', sentence: 'This list is more than two minutes old. Refresh it and try again.' };
    expect(await createClientApi(invoker(refused)).dial({ firmId: 'account-ri-1', number: '+14015550201' })).toEqual(refused);
    // Never a bare "called": the outcome words are handed_off, refused and unknown, and nothing else parses.
    await expect(createClientApi(invoker({ outcome: 'called' })).dial({ firmId: 'a', number: '+14015550201' })).rejects.toThrow();
    await expect(createClientApi(invoker({ outcome: 'refused', reason: 'made_up', sentence: 'x' })).dial({ firmId: 'a', number: '+14015550201' })).rejects.toThrow();
    await expect(createClientApi(invoke).dial({ firmId: '', number: '+14015550201' })).rejects.toThrow();
  });

  it('status and unpair invoke their channels without a payload and validate the reply', async () => {
    const invoke = invoker(status);
    const api = createClientApi(invoke);
    expect(await api.status()).toEqual(status);
    expect(await api.unpair()).toEqual(status);
    expect(invoke.mock.calls).toEqual([['client:status'], ['client:unpair']]);
    await expect(createClientApi(invoker({ state: 'weird' })).status()).rejects.toThrow();
  });

  it('pair sends the code or path and validates the result', async () => {
    const paired = { outcome: 'paired', status: { ...status, state: 'paired', deviceId: randomUUID(), workspaceId: 'ws', pairedAt: NOW }, codeFileDeleted: true };
    const invoke = invoker(paired);
    expect(await createClientApi(invoke).pair('/private/codes/device-code')).toEqual(paired);
    expect(invoke).toHaveBeenCalledWith('client:pair', { codeOrPath: '/private/codes/device-code' });
    await expect(createClientApi(invoke).pair('')).rejects.toThrow();
    await expect(createClientApi(invoker({ outcome: 'paired' })).pair('x')).rejects.toThrow();
  });

  it('get sends the view and kind and validates a Diagnostics view with the contract schema', async () => {
    const invoke = invoker({ outcome: 'ok', fetchedAt: NOW, view: diagnostics });
    const result = await createClientApi(invoke).get({ view: '/v1/diagnostics', kind: 'command' });
    expect(result).toEqual({ outcome: 'ok', fetchedAt: NOW, view: diagnostics });
    expect(invoke).toHaveBeenCalledWith('client:get', { view: '/v1/diagnostics', kind: 'command' });
    const broken = invoker({ outcome: 'ok', fetchedAt: NOW, view: { ...diagnostics, attempts: [{ ...diagnostics.attempts[0], detail: 'free text' }] } });
    await expect(createClientApi(broken).get({ view: '/v1/diagnostics' })).rejects.toThrow();
    await expect(createClientApi(invoke).get({ view: '/v1/nope' } as never)).rejects.toThrow();
  });

  it('get validates a Today view with the contract, keeps its source and sentence, and passes the other outcomes through unchanged', async () => {
    const today = { asOf: NOW, list: null, reason: 'not_built_yet', postures: [], statesWithoutPosture: [] };
    expect(await createClientApi(invoker({ outcome: 'ok', fetchedAt: NOW, view: today })).get({ view: '/v1/today' })).toEqual({ outcome: 'ok', fetchedAt: NOW, view: today });
    expect(await createClientApi(invoker({ outcome: 'ok', fetchedAt: NOW, view: today, source: 'last_good', sentence: 'The worker could not be reached.' })).get({ view: '/v1/today' }))
      .toEqual({ outcome: 'ok', fetchedAt: NOW, view: today, source: 'last_good', sentence: 'The worker could not be reached.' });
    await expect(createClientApi(invoker({ outcome: 'ok', fetchedAt: NOW, view: { list: null, reason: 'not_built' } })).get({ view: '/v1/today' })).rejects.toThrow();
    await expect(createClientApi(invoker({ outcome: 'ok', fetchedAt: NOW, view: 'text' })).get({ view: '/v1/today' })).rejects.toThrow();
    const unauthenticated = { outcome: 'unauthenticated', reason: 'device_expired', cleared: true, sentence: 'The worker refused this device: its token expired. Pair again with a new code.' };
    expect(await createClientApi(invoker(unauthenticated)).get({ view: '/v1/diagnostics' })).toEqual(unauthenticated);
    const unavailable = { outcome: 'unavailable', reason: 'timeout', status: null, sentence: 'The worker did not answer within 15 seconds.' };
    expect(await createClientApi(invoker(unavailable)).get({ view: '/v1/today' })).toEqual(unavailable);
  });

  it('command refuses a malformed command before invoking and validates the receipt', async () => {
    const command = { commandId: randomUUID(), kind: 'revoke_device', deviceId: randomUUID() } as const;
    const receipt = { commandId: command.commandId, outcome: 'applied', reason: null };
    const invoke = invoker({ outcome: 'ok', receipt });
    expect(await createClientApi(invoke).command(command)).toEqual({ outcome: 'ok', receipt });
    expect(invoke).toHaveBeenCalledWith('client:command', command);
    const notV4 = { ...command, commandId: '00000000-0000-1000-8000-000000000000' };
    await expect(createClientApi(invoke).command(notV4)).rejects.toThrow();
    await expect(createClientApi(invoke).command({ ...command, kind: 'pause' } as never)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(createClientApi(invoker({ outcome: 'ok', receipt: { ...receipt, outcome: 'maybe' } })).command(command)).rejects.toThrow();
  });
});
