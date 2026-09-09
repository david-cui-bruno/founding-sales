import { beforeEach, describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { registerLinkedInIpc } from '../../src/main/linkedin/registerLinkedInIpc';
import { createLinkedInApi } from '../../src/preload/apis/linkedInApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';
import { LinkedInService } from '../../src/main/linkedin/linkedInService';
beforeEach(() => { electron.handle.mockReset(); electron.removeHandler.mockReset(); });
const trusted = { senderFrame: { url: 'callie://app/index.html' } };
describe('standalone LinkedIn IPC/preload', () => {
  it('roundtrips edits through strict validated IPC and unregisters idempotently', async () => {
    const f = await createLinkedInFixture();
    try {
      const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Original');
      const remove = registerLinkedInIpc({ provider: new LinkedInService({ repository: f.drafts }) });
      const api = createLinkedInApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
      expect((await api.save({ draftId: draft.id, expectedRevision: 1, body: 'Preserved' })).body).toBe('Preserved');
      expect((await api.get({ draftId: draft.id, expectedRevision: 2 })).personId).toBe(f.personId);
      const invoke = registeredIpcHandler(electron.handle, 'linkedin:save');
      await expect(invoke(trusted, { draftId: draft.id, expectedRevision: 2, body: 'bad', accountId: 'other' })).rejects.toThrow('LINKEDIN_REQUEST_FAILED');
      await expect(invoke({ senderFrame: { url: 'https://evil.invalid' } }, { draftId: draft.id, expectedRevision: 2, body: 'bad' })).rejects.toThrow('LINKEDIN_REQUEST_FAILED');
      expect(f.drafts.requireRevision(draft.id, 2).body).toBe('Preserved');
      remove(); remove(); expect(electron.removeHandler).toHaveBeenCalledTimes(electron.handle.mock.calls.length);
    } finally { f.close(); }
  });
  it('rejects mismatched response binding and unexpected request properties', async () => {
    const f = await createLinkedInFixture();
    try {
      const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Original');
      const api = createLinkedInApi(createIpcClient({ invoke: async () => ({ ...draft, id: 'wrong' }) }));
      await expect(api.get({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow();
      await expect(api.save({ draftId: draft.id, expectedRevision: 1, body: 'test', target: 'evil' } as never)).rejects.toThrow();
      const wrongRevision = createLinkedInApi(createIpcClient({ invoke: async () => ({ ...draft, revision: 8 }) }));
      await expect(wrongRevision.get({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow();
    } finally { f.close(); }
  });
});
