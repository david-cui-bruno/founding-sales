import { afterEach, expect, it, vi } from 'vitest';
import { CRM_EXTRACTION_ENDPOINT, CRM_EXTRACTION_MODELS } from '@fss/contracts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { extractionSetupOperations } from '../src/main/extractionSetupOperations.ts';
import { OPERATIONS } from '../src/shared/operations.ts';
import { extractionSetupInput, extractionSetupPorts } from '../src/renderer/settings/extractionSetup.ts';
import type { HttpSend } from '../src/main/apiClient.ts';

afterEach(() => vi.unstubAllGlobals());
const input = extractionSetupInput.parse({
  expectedRevision: 4, enabled: false, endpointId: CRM_EXTRACTION_ENDPOINT,
  modelVersion: CRM_EXTRACTION_MODELS[0], accessGrantVersion: 'reviewed-access', dataHandlingVersion: 'reviewed-policy',
  dailyCeilingCents: 100, monthlyCeilingCents: 2000, inputTokenPriceMicros: '1.1', outputTokenPriceMicros: '5.5',
});
function harness(send: HttpSend, token: string | null = 'fixture-token') {
  let generation = 1;
  const api = createAuthedClient({ baseUrl: 'https://fixture.example.test', clientVersion: '1.0.51',
    accessToken: async () => token === null ? null : { token, generation }, send });
  const handlers = extractionSetupOperations({ api, identity: { current: () => generation } });
  vi.stubGlobal('callieApi', {
    read: (name: 'crm.processingPurpose', value: unknown) => handlers[name](OPERATIONS[name].input.parse(value)),
    command: (name: 'crm.processingPurposeSave', value: unknown) => handlers[name](OPERATIONS[name].input.parse(value)),
  });
  return { handlers, changeIdentity: () => { generation += 1; } };
}
it('preserves the strict 1.0.51 authenticated command envelope and save-only result', async () => {
  const send = vi.fn<HttpSend>(async (_url, init) => {
    expect(init.headers['authorization']).toBe('Bearer fixture-token');
    const body: unknown = JSON.parse(init.body ?? '{}');
    expect(body).toEqual({ commandId: expect.any(String), clientVersion: '1.0.51', ...input });
    return { status: 200, body: { status: 'accepted', replayed: false, result: { revision: 5, enabled: false } } };
  });
  harness(send);
  await expect(extractionSetupPorts.save(input)).resolves.toEqual({ revision: 5, enabled: false });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBe('https://fixture.example.test/crm/processing/purpose/save');
});
it.each(['purpose_revision_conflict', 'purpose_access_denied', 'activation_not_available'])('propagates %s without retry or activation fallback', async reason => {
  const send = vi.fn<HttpSend>(async () => ({ status: 409, body: { status: 'refused', reason } }));
  harness(send);
  await expect(extractionSetupPorts.save(input)).rejects.toThrow(reason);
  expect(send).toHaveBeenCalledTimes(1);
});
it('fails closed signed out and refuses a malicious enabled proposal before dispatch', async () => {
  const send = vi.fn<HttpSend>();
  harness(send, null);
  await expect(extractionSetupPorts.save(input)).rejects.toThrow('not_signed_in');
  await expect(extractionSetupPorts.save({ ...input, enabled: true } as never)).rejects.toThrow();
  await expect(extractionSetupPorts.save({ ...input, endpointId: 'unreviewed' } as never)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
it.each([
  { revision: 5, enabled: true },
  { revision: 5, enabled: false, ownerApprovalId: 'invented' },
])('refuses incompatible save response %j', async result => {
  harness(async () => ({ status: 200, body: { status: 'accepted', result } }));
  await expect(extractionSetupPorts.save(input)).rejects.toThrow('unreadable_answer');
});
it('rejects stale bridge identity after the external wait', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const send = vi.fn<HttpSend>(async () => { await pending; return { status: 200, body: { status: 'accepted', result: { revision: 5, enabled: false } } }; });
  const { changeIdentity } = harness(send);
  const result = extractionSetupPorts.save(input);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  changeIdentity();
  release();
  await expect(result).rejects.toThrow('identity_changed');
});
it('keeps exact legacy unconfigured read shape and rejects additive private fields', async () => {
  const value = { configured: false, enabled: false, revision: 0, modelVersion: null, endpoint: null,
    dailyCeilingCents: 0, monthlyCeilingCents: 0, unavailableReason: 'purpose_not_configured' };
  const send = vi.fn<HttpSend>(async (_url, init) => {
    expect(JSON.parse(init.body ?? '{}')).toEqual({});
    return { status: 200, body: value };
  });
  harness(send);
  await expect(extractionSetupPorts.read()).resolves.toEqual(value);
  harness(async () => ({ status: 200, body: { ...value, token: 'must-not-cross' } }));
  await expect(extractionSetupPorts.read()).rejects.toThrow('unreadable_answer');
});
