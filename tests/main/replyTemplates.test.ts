import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler } }));

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { registerTemplateIpc, type ReplyTemplateCommandRequest } from '../../src/main/ipc/registerTemplateIpc';
import { SqlReplyTemplateRepository } from '../../src/main/outreach/templates/replyTemplateRepository';
import { REPLY_TEMPLATE_SEED_HASHES } from '../../src/main/outreach/templates/replyTemplateSeeds';
import { REPLY_TEMPLATE_SENDER_DAILY_LIMIT, REPLY_TEMPLATE_SIGN_OFF, replyTemplateContentHash, replyTemplateStatusSchema, sendingLimitsStatusSchema } from '../../src/shared/contracts/replyTemplateContract';
import { SENDER_RAMP_DEFAULT } from '../../src/shared/contracts/workerPolicyContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const NOW = '2026-09-18T12:00:00.000Z';
const LATER = '2026-09-18T13:00:00.000Z';
const EDITED_BODY = `Thanks for the time today. Callie is a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed.

Next step from our call: {next_step}.

${REPLY_TEMPLATE_SIGN_OFF}`;

type Fixture = {
  database: AppDatabase; repository: SqlReplyTemplateRepository; dispose(): void;
  commands: ReplyTemplateCommandRequest[]; remove(): void;
  channel(name: string): (event: unknown, ...args: unknown[]) => Promise<unknown>;
};
let clockValue = NOW;
const fixtures: (() => void)[] = [];

async function fixture(options: { worker?: 'applied' | 'rejected' | 'absent' } = {}): Promise<Fixture> {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  await migrateToLatest(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
  const clock = { now: () => clockValue };
  const commands: ReplyTemplateCommandRequest[] = [];
  const mode = options.worker ?? 'applied';
  const host = mode === 'absent' ? {} : {
    replyTemplate: async (request: ReplyTemplateCommandRequest) => {
      commands.push(request);
      return { commandId: request.commandId, status: mode === 'applied' ? 'applied' : 'rejected',
        authorityGeneration: 0, aggregateVersion: 1, reason: mode === 'applied' ? null : 'template_not_approved' };
    },
  };
  const remove = registerTemplateIpc({ databaseGate: { withDatabase: async operation => operation(database) }, clock, host,
    isTrustedRendererUrl: () => true });
  const dispose = () => { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); };
  fixtures.push(dispose);
  const channel = (name: string) => {
    const call = electron.handle.mock.calls.find(entry => entry[0] === name) as [string, (event: unknown, ...args: unknown[]) => Promise<unknown>] | undefined;
    if (!call) throw new Error(`channel ${name} was not registered`);
    return call[1];
  };
  return { database, repository: new SqlReplyTemplateRepository({ database, clock }), dispose, commands, remove, channel };
}
const sender = { senderFrame: { url: 'app://callie/index.html' } };
const invoke = async (f: Fixture, name: string, ...args: unknown[]) => f.channel(name)(sender, ...args);

beforeEach(() => { clockValue = NOW; electron.handle.mockReset(); electron.removeHandler.mockReset(); });
afterEach(() => { for (const dispose of fixtures.splice(0).reverse()) dispose(); });

describe('reply template store on a real migrated database', () => {
  it('reads the five seeded drafts and their pause switch', async () => {
    const f = await fixture();
    const snapshot = f.repository.read();
    expect(snapshot.templates.map(template => [template.id, template.approval.state])).toEqual([['T1', 'draft'], ['T2', 'draft'], ['T3', 'draft'], ['T4', 'draft'], ['T5', 'draft']]);
    expect(snapshot.settings).toEqual({ paused: false, revision: 1, updatedAt: expect.any(String) });
    expect(replyTemplateContentHash(f.repository.get('T1'))).toBe(REPLY_TEMPLATE_SEED_HASHES.T1);
  });

  it('records an approval only for the exact revision and hash, and an edit afterwards revokes it', async () => {
    const f = await fixture();
    const before = f.repository.get('T1');
    expect(() => f.repository.recordApproval({ templateId: 'T1', revision: 2, contentHash: REPLY_TEMPLATE_SEED_HASHES.T1 })).toThrow(/stale_reply_template/);
    expect(() => f.repository.recordApproval({ templateId: 'T1', revision: 1, contentHash: REPLY_TEMPLATE_SEED_HASHES.T2 })).toThrow(/stale_reply_template/);
    clockValue = LATER;
    const approved = f.repository.recordApproval({ templateId: 'T1', revision: 1, contentHash: REPLY_TEMPLATE_SEED_HASHES.T1 });
    expect(approved.templates[0]!.approval).toEqual({ state: 'approved', approvedRevision: 1, approvedAt: LATER, contentHash: REPLY_TEMPLATE_SEED_HASHES.T1 });
    expect(approved.templates[0]!.subject).toBe(before.subject);

    const edited = f.repository.edit({ templateId: 'T1', expectedRevision: 1, subject: 'Following up, {firm}', body: EDITED_BODY });
    expect(edited.templates[0]!.revision).toBe(2);
    expect(edited.templates[0]!.approval).toEqual({ state: 'revoked', approvedRevision: null, approvedAt: null, contentHash: null });
    expect(edited.templates[0]!.variables).toEqual(['firm', 'next_step']);
    // The revision moved, so the approval the worker holds no longer names this text.
    expect(replyTemplateContentHash(edited.templates[0]!)).not.toBe(REPLY_TEMPLATE_SEED_HASHES.T1);
  });

  it('refuses an edit that breaks a body rule, at a stale revision, and refuses deleting any row', async () => {
    const f = await fixture();
    expect(() => f.repository.edit({ templateId: 'T2', expectedRevision: 1, subject: 'Hi {firm}', body: `Callie answers the phone.\n\n${REPLY_TEMPLATE_SIGN_OFF}` })).toThrow(/template_product_sentence_missing/);
    expect(() => f.repository.edit({ templateId: 'T2', expectedRevision: 1, subject: 'Hi {firm}', body: 'Callie is a 24/7 maintenance agent for property managers.\n\nRegards, David' })).toThrow(/template_sign_off_missing/);
    expect(() => f.repository.edit({ templateId: 'T2', expectedRevision: 1, subject: 'Hi {owner}', body: EDITED_BODY })).toThrow(/template_unknown_variable/);
    expect(() => f.repository.edit({ templateId: 'T2', expectedRevision: 7, subject: 'Hi {firm}', body: EDITED_BODY })).toThrow(/stale_reply_template/);
    expect(f.repository.get('T2').revision).toBe(1);
    expect(() => f.database.raw.prepare("DELETE FROM email_templates WHERE id='T2'").run()).toThrow(/Email template history is immutable/);
  });

  it('records the pause switch once per change', async () => {
    const f = await fixture();
    clockValue = LATER;
    expect(f.repository.recordPaused(true).settings).toEqual({ paused: true, revision: 2, updatedAt: LATER });
    expect(f.repository.recordPaused(true).settings).toEqual({ paused: true, revision: 2, updatedAt: LATER });
    expect(f.repository.recordPaused(false).settings).toEqual({ paused: false, revision: 3, updatedAt: LATER });
  });
});

describe('templates IPC on the real registrar', () => {
  it('registers exactly the read, edit and three worker channels when a worker transport exists', async () => {
    const f = await fixture();
    expect(electron.handle.mock.calls.map(call => call[0])).toEqual(['templates:read', 'templates:edit', 'templates:approve', 'templates:revoke', 'templates:pause']);
    f.remove();
    expect(electron.removeHandler.mock.calls.map(call => call[0]))
      .toEqual(['templates:pause', 'templates:revoke', 'templates:approve', 'templates:edit', 'templates:read']);
  });

  it('registers only the local channels when the host carries no worker hop', async () => {
    const f = await fixture({ worker: 'absent' });
    expect(electron.handle.mock.calls.map(call => call[0])).toEqual(['templates:read', 'templates:edit']);
    const status = replyTemplateStatusSchema.parse(await invoke(f, 'templates:read'));
    expect(status.snapshot.templates).toHaveLength(5);
    expect(status.receipt).toBeNull();
  });

  it('sends the exact stored text and hash to the worker and records the approval only after it applied', async () => {
    const f = await fixture();
    const commandId = randomUUID();
    const status = replyTemplateStatusSchema.parse(await invoke(f, 'templates:approve', { kind: 'approve', commandId, templateId: 'T4', expectedRevision: 1 }));
    expect(f.commands).toHaveLength(1);
    const payload = f.commands[0]!.payload;
    expect(payload.kind).toBe('template-approve');
    if (payload.kind !== 'template-approve') throw new Error('unreachable');
    expect(payload).toEqual({ kind: 'template-approve', templateId: 'T4', revision: 1,
      subject: f.repository.get('T4').subject, body: f.repository.get('T4').body, contentHash: REPLY_TEMPLATE_SEED_HASHES.T4 });
    expect(status.receipt).toMatchObject({ commandId, status: 'applied' });
    expect(status.snapshot.templates.find(template => template.id === 'T4')!.approval)
      .toEqual({ state: 'approved', approvedRevision: 1, approvedAt: NOW, contentHash: REPLY_TEMPLATE_SEED_HASHES.T4 });
  });

  it('leaves the template untouched when the worker rejects the command', async () => {
    const f = await fixture({ worker: 'rejected' });
    const status = replyTemplateStatusSchema.parse(await invoke(f, 'templates:approve', { kind: 'approve', commandId: randomUUID(), templateId: 'T4', expectedRevision: 1 }));
    expect(status.receipt).toMatchObject({ status: 'rejected', reason: 'template_not_approved' });
    expect(status.snapshot.templates.find(template => template.id === 'T4')!.approval.state).toBe('draft');
    expect(f.repository.get('T4').approval.state).toBe('draft');
  });

  it('refuses an approval at a revision the renderer no longer holds, and sends nothing', async () => {
    const f = await fixture();
    f.repository.edit({ templateId: 'T4', expectedRevision: 1, subject: 'One question about maintenance calls at {firm}', body: EDITED_BODY });
    await expect(invoke(f, 'templates:approve', { kind: 'approve', commandId: randomUUID(), templateId: 'T4', expectedRevision: 1 })).rejects.toThrow();
    expect(f.commands).toEqual([]);
    expect(f.repository.get('T4').approval.state).toBe('draft');
  });

  it('refuses a request whose kind does not match its channel', async () => {
    const f = await fixture();
    await expect(invoke(f, 'templates:approve', { kind: 'revoke', commandId: randomUUID(), templateId: 'T4', expectedRevision: 1 })).rejects.toThrow();
    await expect(invoke(f, 'templates:pause', { kind: 'approve', commandId: randomUUID(), templateId: 'T4', expectedRevision: 1 })).rejects.toThrow();
    expect(f.commands).toEqual([]);
  });

  it('carries revoke and pause through the worker and records them', async () => {
    const f = await fixture();
    await invoke(f, 'templates:approve', { kind: 'approve', commandId: randomUUID(), templateId: 'T5', expectedRevision: 1 });
    const revoked = replyTemplateStatusSchema.parse(await invoke(f, 'templates:revoke', { kind: 'revoke', commandId: randomUUID(), templateId: 'T5', expectedRevision: 1 }));
    expect(revoked.snapshot.templates.find(template => template.id === 'T5')!.approval.state).toBe('revoked');
    expect(f.commands.at(-1)!.payload).toEqual({ kind: 'template-revoke', templateId: 'T5', revision: 1 });
    const paused = replyTemplateStatusSchema.parse(await invoke(f, 'templates:pause', { kind: 'pause', commandId: randomUUID(), paused: true }));
    expect(paused.snapshot.settings.paused).toBe(true);
    expect(f.commands.at(-1)!.payload).toEqual({ kind: 'template-pause', paused: true });
  });

  it('edits through the channel without reaching the worker at all', async () => {
    const f = await fixture();
    const status = replyTemplateStatusSchema.parse(await invoke(f, 'templates:edit', { templateId: 'T1', expectedRevision: 1, subject: 'Following up, {firm}', body: EDITED_BODY }));
    expect(status.snapshot.templates[0]!.revision).toBe(2);
    expect(status.receipt).toBeNull();
    expect(f.commands).toEqual([]);
  });
});

describe('sending limits', () => {
  const grant = { provider: 'google', subject: 'worker-subject', email: 'callie@usecallie.com',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.send'], owner: 'remote', purpose: 'permitted_correspondence',
    capabilities: ['send'] };

  async function limitsFixture(options: { ready?: boolean; paired?: boolean } = {}) {
    const temp = createTempDatabase(), key = createTestWorkspaceKey();
    const database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    const policies: unknown[] = [];
    const host = {
      googleConnections: { status: async () => options.ready === false ? { state: 'unconfigured', grant: null } : { state: 'ready', grant } },
      configurePolicy: async (request: unknown) => {
        policies.push(request);
        const parsed = request as { requestId: string; expectedRevision: number | null };
        return { requestId: parsed.requestId, kind: 'sender-caps', status: 'applied', revision: (parsed.expectedRevision ?? 0) + 1, fingerprint: 'b'.repeat(64) };
      },
    };
    const pairing = { load: async () => options.paired === false ? null : { workspaceId: 'workspace-one', pairingId: '6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071' } };
    const remove = registerTemplateIpc({ databaseGate: { withDatabase: async operation => operation(database) },
      clock: { now: () => clockValue }, host, pairing, isTrustedRendererUrl: () => true });
    fixtures.push(() => { remove(); closeDatabase(database); key.bytes.fill(0); temp.cleanup(); });
    const channel = (name: string) => {
      const call = electron.handle.mock.calls.find(entry => entry[0] === name) as [string, (event: unknown, ...args: unknown[]) => Promise<unknown>] | undefined;
      if (!call) throw new Error(`channel ${name} was not registered`);
      return call[1];
    };
    return { policies, channel };
  }

  it('writes one sender-caps row with the sender read from the grant and David\u2019s ramp', async () => {
    const f = await limitsFixture();
    expect(electron.handle.mock.calls.map(call => call[0])).toEqual(['templates:read', 'templates:edit', 'templates:sending-limits']);
    const requestId = randomUUID();
    const status = sendingLimitsStatusSchema.parse(await f.channel('templates:sending-limits')(sender, { requestId, expectedRevision: null }));
    expect(status).toEqual({ sender: 'callie@usecallie.com', dailyLimit: REPLY_TEMPLATE_SENDER_DAILY_LIMIT, ramp: SENDER_RAMP_DEFAULT,
      receipt: { requestId, kind: 'sender-caps', status: 'applied', revision: 1, fingerprint: 'b'.repeat(64) } });
    expect(f.policies).toEqual([{ version: 1, requestId, workspaceId: 'workspace-one', pairingId: '6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071',
      mailboxSubject: 'worker-subject', expectedRevision: null, kind: 'sender-caps',
      policy: { sender: 'callie@usecallie.com', dailyLimit: 40, ramp: SENDER_RAMP_DEFAULT } }]);
    expect(SENDER_RAMP_DEFAULT).toEqual({ startPerDay: 10, stepPerDay: 2, maxPerDay: 40 });
  });

  it('writes nothing when no grant is connected or no pairing is stored', async () => {
    const unready = await limitsFixture({ ready: false });
    await expect(unready.channel('templates:sending-limits')(sender, { requestId: randomUUID(), expectedRevision: null })).rejects.toThrow();
    expect(unready.policies).toEqual([]);
    electron.handle.mockReset();
    const unpaired = await limitsFixture({ paired: false });
    await expect(unpaired.channel('templates:sending-limits')(sender, { requestId: randomUUID(), expectedRevision: null })).rejects.toThrow();
    expect(unpaired.policies).toEqual([]);
  });
});
