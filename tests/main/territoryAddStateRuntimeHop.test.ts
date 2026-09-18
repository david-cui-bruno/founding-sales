import { expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { randomUUID } from 'node:crypto';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { territoryPolicyCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { territoryCallPolicyRequestSchema, TERRITORY_CALL_POLICY_SUBJECT } from '../../src/shared/contracts/territoryCallPolicyContract';
import { TERRITORY_RULES_REVISION } from '../../src/shared/contracts/territoryClearanceContract';

/**
 * Lane 36 (PR 106) finished "Add a state" on the worker and deliberately left `add-state` out of the request
 * union, because this runtime maps that union **positionally**: a fourth member with no branch of its own would
 * have fallen through to `policy.set-state`, which pauses or resumes the whole territory policy. The union member
 * and the branch therefore arrive together, and this test is what holds them together: it reads the exact owner
 * command the runtime put on the wire.
 */
it('carries an add-state request as policy.add-state and never as policy.set-state', async () => {
  electron.handle.mockReset(); electron.removeHandler.mockReset();
  const f = await createPmFixture();
  const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional', workspaceId: 'ws', clock: { now: () => PM_NOW } });
  const redeemed = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional');
  const handler = createWorkerHandler({ auth, host: 'worker.example.test' });
  const sent: unknown[] = [];
  const http: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    sent.push(JSON.parse(String(init?.body ?? 'null')));
    const reply = await handler({ version: '2.0', rawPath: u.pathname, rawQueryString: u.search.slice(1),
      headers: { host: u.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' },
      body: init?.body, requestContext: { domainName: u.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } } });
    return new Response(reply.body, { status: reply.statusCode });
  };
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) },
    pairing: { ...redeemed, endpoint: 'https://worker.example.test' }, clock: { now: () => PM_NOW }, fetch: http });
  try {
    // The union admits the fourth member, so Settings can reach the runtime with it at all.
    const request = { kind: 'add-state' as const, commandId: randomUUID(), expectedAddedRevision: 0, state: 'MA' as const };
    expect(territoryCallPolicyRequestSchema.parse(request)).toEqual(request);

    await runtime.territoryPolicy(request);
    const command = territoryPolicyCommandSchema.parse(sent.at(-1));
    expect(command.payload).toEqual({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'MA', rulesRevision: TERRITORY_RULES_REVISION });
    expect(command.payload.kind).not.toBe('policy.set-state');
    expect(command).toMatchObject({ commandId: request.commandId, workspaceId: 'ws', accountId: TERRITORY_CALL_POLICY_SUBJECT,
      expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy' });

    // The three kinds that were already there still map where they did: the fall-through is still set-state's.
    await runtime.territoryPolicy({ kind: 'set-state', commandId: randomUUID(), expectedRevision: 1, state: 'paused' });
    expect(territoryPolicyCommandSchema.parse(sent.at(-1)).payload).toEqual({ kind: 'policy.set-state', expectedRevision: 1, state: 'paused' });
    await runtime.territoryPolicy({ kind: 'approve', commandId: randomUUID(), expectedRevision: 0 });
    expect(territoryPolicyCommandSchema.parse(sent.at(-1)).payload.kind).toBe('policy.approve');
    await runtime.territoryPolicy({ kind: 'read' });
    expect(territoryPolicyCommandSchema.parse(sent.at(-1)).payload).toEqual({ kind: 'policy.read' });
  } finally { await runtime.dispose(); f.close(); }
});
