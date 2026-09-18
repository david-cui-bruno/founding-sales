import { expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { randomUUID } from 'node:crypto';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import type { OutreachApi, EmailDraft, OutreachStatus } from '../../src/shared/contracts/outreachContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, TERRITORY_CALL_POLICY_SUBJECT, territoryCallPolicyId } from '../../src/shared/contracts/territoryCallPolicyContract';

const draft: EmailDraft = { id: 'd1', personId: 'p1', salesCycleId: 'c1', contactMethodId: 'e1', recipient: 'owner@example.com', subject: 'Hello', body: 'Message', revision: 1, status: 'draft', generation: 'none', messageId: null, notice: null, updatedAt: PM_NOW };
const status: OutreachStatus = { model: 'unconfigured', modelName: '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' };
const provider: OutreachApi = { status: async () => status, configure: async () => status, connectGmail: async () => status, disconnectGmail: async () => status,
  inspectLocalAuthority: async input => ({ draftId: input.draftId, expectedRevision: input.expectedRevision, personId: 'p1', contactMethodId: 'e1', state: 'held', reason: 'email_authority_unavailable', checkedAt: PM_NOW }),
  openDraft: async () => draft, saveDraft: async () => draft, generateDraft: async () => draft, sendDraft: async () => draft };
const trusted = { senderFrame: { url: 'callie://app/index.html' } };

it('reads, approves once, pauses and resumes the territory policy through the runtime, the trusted IPC channel and the real preload against the real gateway', async () => {
  electron.handle.mockReset(); electron.removeHandler.mockReset();
  const f = await createPmFixture();
  const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional', workspaceId: 'ws', clock: { now: () => PM_NOW } });
  const redeemed = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional');
  const handler = createWorkerHandler({ auth, host: 'worker.example.test' });
  const paths: string[] = [];
  const http: typeof fetch = async (input, init) => {
    const u = new URL(String(input)); paths.push(u.pathname);
    const reply = await handler({ version: '2.0', rawPath: u.pathname, rawQueryString: u.search.slice(1), headers: { host: u.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' }, body: init?.body, requestContext: { domainName: u.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } } });
    return new Response(reply.body, { status: reply.statusCode });
  };
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) }, pairing: { ...redeemed, endpoint: 'https://worker.example.test' }, clock: { now: () => PM_NOW }, fetch: http });
  const unregister = registerOutreachIpc({ provider, delegation: runtime });
  const api = createCallieApi({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) });
  try {
    expect(electron.handle.mock.calls.map(([channel]) => channel)).toContain('outreach:delegation-territory-policy');
    const bridge = api.delegation.territoryPolicy;
    if (!bridge) throw new Error('current preload exposes the territory policy');
    expect(await bridge({ kind: 'read' })).toEqual({ workspaceId: 'ws', policy: null, definition: DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, receipt: null });
    const approveId = randomUUID();
    const approved = await bridge({ kind: 'approve', commandId: approveId, expectedRevision: 0 });
    expect(approved.receipt).toEqual({ commandId: approveId, status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null });
    expect(approved.policy).toMatchObject({ ...DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, policyId: territoryCallPolicyId('ws'), workspaceId: 'ws', pairingId: redeemed.pairingId, revision: 1, state: 'active', approvedRevision: 1 });
    // The same command id answers the same receipt; a stale second approval is a rejected receipt with the worker's reason.
    expect(await bridge({ kind: 'approve', commandId: approveId, expectedRevision: 0 })).toEqual(approved);
    const stale = await bridge({ kind: 'approve', commandId: randomUUID(), expectedRevision: 0 });
    expect(stale.receipt).toMatchObject({ status: 'rejected', reason: 'policy_revision_conflict', aggregateVersion: 1 });
    expect(stale.policy).toEqual(approved.policy);
    const paused = await bridge({ kind: 'set-state', commandId: randomUUID(), expectedRevision: 1, state: 'paused' });
    expect(paused).toMatchObject({ receipt: { status: 'applied', aggregateVersion: 2 }, policy: { revision: 2, state: 'paused', approvedRevision: 1 } });
    const resumed = await bridge({ kind: 'set-state', commandId: randomUUID(), expectedRevision: 2, state: 'active' });
    expect(resumed.policy).toMatchObject({ revision: 3, state: 'active' });
    expect((await bridge({ kind: 'read' })).policy).toEqual(resumed.policy);
    expect(paths.every(path => path === '/commands')).toBe(true);
    // Nothing was queued for any company; the policy path bypasses the account outbox and the public submit refuses it.
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM delegated_commands').get()).toEqual({ n: 0 });
    expect(() => runtime.submit({ commandId: randomUUID(), workspaceId: 'ws', accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload: { kind: 'policy.read' } })).toThrow(/trusted saved SQL/);
    const invoke = registeredIpcHandler(electron.handle, 'outreach:delegation-territory-policy');
    await expect(invoke(trusted, { kind: 'approve', commandId: 'not-a-uuid', expectedRevision: 0 })).rejects.toThrow('OUTREACH_REQUEST_FAILED');
    await expect(invoke({ senderFrame: { url: 'https://untrusted.test/' } }, { kind: 'read' })).rejects.toThrow('OUTREACH_REQUEST_FAILED');
    await expect(bridge({ kind: 'approve', commandId: randomUUID(), expectedRevision: 0, definition: DEFAULT_TERRITORY_CALL_POLICY_DEFINITION } as never)).rejects.toThrow();
  } finally { unregister(); await runtime.dispose(); f.close(); }
});
