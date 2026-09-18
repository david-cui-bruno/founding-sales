import { expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { randomUUID } from 'node:crypto';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { registerTemplateIpc } from '../../src/main/ipc/registerTemplateIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { SqlReplyTemplateRepository } from '../../src/main/outreach/templates/replyTemplateRepository';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { REPLY_TEMPLATE_SUBJECT, replyTemplateStatusSchema } from '../../src/shared/contracts/replyTemplateContract';
import { REPLY_TEMPLATE_SEED_HASHES } from '../../src/main/outreach/templates/replyTemplateSeeds';

const trusted = { senderFrame: { url: 'callie://app/index.html' } };

/**
 * Lane 31 left the template approval wired only as far as main: `registerTemplateIpc` registers the three worker
 * channels solely when the delegation runtime actually carries `replyTemplate`, and it did not. This is that hop,
 * proved end to end on the real seams: the real IPC registrar, the real delegation runtime, the real worker
 * gateway handler over an injected transport (no network, no AWS), and the real SQL template store.
 */
it('carries approve, revoke and pause from the real template IPC through the delegation runtime to the worker, and records the approval only on the worker receipt', async () => {
  electron.handle.mockReset(); electron.removeHandler.mockReset();
  const f = await createPmFixture();
  const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional', workspaceId: 'ws', clock: { now: () => PM_NOW } });
  const redeemed = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional');
  const handler = createWorkerHandler({ auth, host: 'worker.example.test' });
  const paths: string[] = [];
  const http: typeof fetch = async (input, init) => {
    const u = new URL(String(input)); paths.push(u.pathname);
    const reply = await handler({ version: '2.0', rawPath: u.pathname, rawQueryString: u.search.slice(1),
      headers: { host: u.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' },
      body: init?.body, requestContext: { domainName: u.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } } });
    return new Response(reply.body, { status: reply.statusCode });
  };
  // The migration seeds the five templates with its own wall clock, and the store refuses an update older than the
  // row it updates. Read the seed time and act one second after it, so the test is later than the seed by
  // construction instead of by luck.
  let nowValue = PM_NOW;
  const clock = { now: () => nowValue };
  const store = new SqlReplyTemplateRepository({ database: f.db, clock });
  const APPROVED_AT = new Date(Date.parse(store.get('T4').updatedAt) + 1000).toISOString();
  nowValue = APPROVED_AT;
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) },
    pairing: { ...redeemed, endpoint: 'https://worker.example.test' }, clock, fetch: http });
  const remove = registerTemplateIpc({ databaseGate: { withDatabase: async operation => operation(f.db) }, clock,
    host: runtime, isTrustedRendererUrl: () => true });
  const invoke = (channel: string, request?: unknown) => registeredIpcHandler(electron.handle, channel)(trusted, request);
  const state = (id: string) => store.read().templates.find(template => template.id === id)!.approval;
  try {
    // The runtime carries the method, so all six channels exist; before this lane only `read`, `edit` and
    // `sending-limits` could be registered at all.
    const channels = electron.handle.mock.calls.map(([channel]) => channel);
    expect(channels).toEqual(['templates:read', 'templates:edit', 'templates:approve', 'templates:revoke', 'templates:pause']);
    expect(typeof (runtime as { replyTemplate?: unknown }).replyTemplate).toBe('function');
    expect(state('T4')).toEqual({ state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null });

    const approveId = randomUUID();
    const approved = replyTemplateStatusSchema.parse(await invoke('templates:approve', { kind: 'approve', commandId: approveId, templateId: 'T4', expectedRevision: 1 }));
    expect(approved.receipt).toEqual({ commandId: approveId, status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null });
    // Settings reads the standing approval only because the worker applied it, and against the exact seeded text.
    expect(state('T4')).toEqual({ state: 'approved', approvedRevision: 1, approvedAt: APPROVED_AT, contentHash: REPLY_TEMPLATE_SEED_HASHES.T4 });
    expect(approved.snapshot.templates.find(template => template.id === 'T4')!.approval.contentHash).toBe(REPLY_TEMPLATE_SEED_HASHES.T4);

    // The same command id answers the same receipt: a retry after an uncertain reply never approves twice.
    expect(await invoke('templates:approve', { kind: 'approve', commandId: approveId, templateId: 'T4', expectedRevision: 1 })).toEqual(approved);

    // Pause is a workspace switch that keeps every approval, and resuming takes no second approval.
    const paused = replyTemplateStatusSchema.parse(await invoke('templates:pause', { kind: 'pause', commandId: randomUUID(), paused: true }));
    expect(paused.receipt?.status).toBe('applied');
    expect(paused.snapshot.settings.paused).toBe(true);
    expect(state('T4').state).toBe('approved');
    const resumed = replyTemplateStatusSchema.parse(await invoke('templates:pause', { kind: 'pause', commandId: randomUUID(), paused: false }));
    expect(resumed.snapshot.settings.paused).toBe(false);

    // Revoking the named revision takes the standing permission back on both sides.
    const revoked = replyTemplateStatusSchema.parse(await invoke('templates:revoke', { kind: 'revoke', commandId: randomUUID(), templateId: 'T4', expectedRevision: 1 }));
    expect(revoked.receipt?.status).toBe('applied');
    expect(state('T4')).toEqual({ state: 'revoked', approvedRevision: null, approvedAt: null, contentHash: null });
    // A revoke the worker no longer holds is a rejected receipt and changes nothing here.
    const again = replyTemplateStatusSchema.parse(await invoke('templates:revoke', { kind: 'revoke', commandId: randomUUID(), templateId: 'T4', expectedRevision: 1 }));
    expect(again.receipt).toMatchObject({ status: 'rejected', reason: 'template_not_approved' });
    expect(state('T4').state).toBe('revoked');

    // Nothing entered any company's outbox: the templates subject is workspace-level and has no account row.
    expect(paths.every(path => path === '/commands')).toBe(true);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM delegated_commands').get()).toEqual({ n: 0 });
    expect(() => runtime.submit({ commandId: randomUUID(), workspaceId: 'ws', accountId: REPLY_TEMPLATE_SUBJECT,
      expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'reply-template', payload: { kind: 'template-pause', paused: true } })).toThrow(/trusted saved SQL/);
    // A renderer cannot hand the runtime a body, a subject or a hash: the envelope takes the payload main built.
    await expect(runtime.replyTemplate({ commandId: randomUUID(), payload: { kind: 'template-approve', templateId: 'T4',
      revision: 1, subject: 'Invented', body: 'Invented', contentHash: 'a'.repeat(64) } })).rejects.toThrow();
    await expect(invoke('templates:approve', { kind: 'revoke', commandId: randomUUID(), templateId: 'T4', expectedRevision: 2 })).rejects.toThrow('TEMPLATE_REQUEST_FAILED');
    await expect(registeredIpcHandler(electron.handle, 'templates:approve')({ senderFrame: { url: 'https://untrusted.test/' } },
      { kind: 'approve', commandId: randomUUID(), templateId: 'T4', expectedRevision: 2 })).rejects.toThrow('TEMPLATE_REQUEST_FAILED');
  } finally { remove(); await runtime.dispose(); f.close(); }
});
