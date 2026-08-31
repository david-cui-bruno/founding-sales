import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import type { ImportProvider } from '../../src/main/imports/importService';
import type {
  ImportCommitRequest,
  ImportPreview,
  ImportStatus,
} from '../../src/shared/contracts/importContract';
import {
  IMPORT_IPC_CHANNELS,
  registerImportIpc,
} from '../../src/main/imports/registerImportIpc';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const trustedEvent = { senderFrame: { url: 'callie://app/index.html' } };
const untrustedEvent = { senderFrame: { url: 'https://attacker.test' } };

const CONTENT_HASH = 'a'.repeat(64);

const validPreview: ImportPreview = {
  previewId: 'preview-1',
  contentHash: CONTENT_HASH,
  columns: ['Name'],
  sampleRows: [{ rowNumber: 2, cells: ['Kevin Shin'] }],
  suggestedMapping: { Name: 'person_name' as const },
  rowCount: 1,
  validCount: 1,
  errors: [],
  duplicateCandidates: [],
  expiresAt: '2026-08-31T15:30:00.000Z',
};

const validReceipt = {
  jobId: 'job-1',
  importedPersonIds: ['person-1'],
  importedRowCount: 1,
  revision: 42,
};

const validStatus: ImportStatus = {
  jobId: 'job-1',
  state: 'succeeded' as const,
  progressCurrent: 1,
  progressTotal: 1,
  safeErrorCode: null,
};

const validSource = {
  kind: 'csv' as const,
  sourceName: 'leads.csv',
  content: 'Name\nKevin Shin\n',
};

const validRemapRequest = {
  previewId: 'preview-1',
  contentHash: CONTENT_HASH,
  mapping: { Name: 'person_name' as const },
};

const validCommitRequest: ImportCommitRequest = {
  previewId: 'preview-1',
  contentHash: CONTENT_HASH,
  mapping: { Name: 'person_name' as const },
  source: { channel: 'registry' as const, referredByPersonId: null },
  duplicateDecisions: [],
};

function fakeProvider(): ImportProvider {
  return {
    preview: vi.fn(async () => validPreview),
    remap: vi.fn(async () => validPreview),
    commit: vi.fn(async () => validReceipt),
    status: vi.fn(async () => validStatus),
  };
}

describe('registerImportIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers exactly the four import channels', () => {
    registerImportIpc(fakeProvider());

    expect(electron.handle).toHaveBeenCalledTimes(4);
    expect(electron.handle.mock.calls.map((call) => call[0])).toEqual([
      'imports:preview',
      'imports:remap',
      'imports:commit',
      'imports:status',
    ]);
  });

  it('routes imports:preview to the provider and returns the validated preview', async () => {
    const provider = fakeProvider();
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.preview);
    await expect(handler(trustedEvent, validSource)).resolves.toEqual(validPreview);
    expect(provider.preview).toHaveBeenCalledWith(validSource);
  });

  it('routes imports:remap to the provider', async () => {
    const provider = fakeProvider();
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.remap);
    await expect(handler(trustedEvent, validRemapRequest)).resolves.toEqual(validPreview);
    expect(provider.remap).toHaveBeenCalledWith(validRemapRequest);
  });

  it('routes imports:commit to the provider and returns the receipt', async () => {
    const provider = fakeProvider();
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.commit);
    await expect(handler(trustedEvent, validCommitRequest)).resolves.toEqual(validReceipt);
    expect(provider.commit).toHaveBeenCalledWith(validCommitRequest);
  });

  it('routes imports:status to the provider and returns the job status', async () => {
    const provider = fakeProvider();
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.status);
    await expect(handler(trustedEvent, { jobId: 'job-1' })).resolves.toEqual(validStatus);
    expect(provider.status).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  it('rejects an untrusted sender before invoking the provider', async () => {
    const provider = fakeProvider();
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.preview);
    await expect(handler(untrustedEvent, validSource)).rejects.toThrow('trusted');
    expect(provider.preview).not.toHaveBeenCalled();
  });

  it('rejects a mapping without exactly one person-name column', async () => {
    const provider = fakeProvider();
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.commit);
    await expect(handler(trustedEvent, {
      ...validCommitRequest,
      mapping: { Name: 'ignore' },
    })).rejects.toThrow();
    expect(provider.commit).not.toHaveBeenCalled();
  });

  it('rejects a commit request that smuggles extra keys', async () => {
    const provider = fakeProvider();
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.commit);
    await expect(handler(trustedEvent, {
      ...validCommitRequest,
      rows: [{ personName: 'Injected' }],
    })).rejects.toThrow();
    expect(provider.commit).not.toHaveBeenCalled();
  });

  it('rejects a provider response that violates the preview contract', async () => {
    const provider = fakeProvider();
    provider.preview = vi.fn(async () => ({
      ...validPreview,
      contentHash: 'not-a-sha256',
    })) as unknown as ImportProvider['preview'];
    registerImportIpc(provider);

    const handler = registeredIpcHandler(electron.handle, IMPORT_IPC_CHANNELS.preview);
    await expect(handler(trustedEvent, validSource)).rejects.toThrow();
  });

  it('unregisters all four channels exactly once', () => {
    const unregister = registerImportIpc(fakeProvider());

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(4);
    expect(electron.removeHandler.mock.calls.map((call) => call[0]).sort()).toEqual([
      'imports:commit',
      'imports:preview',
      'imports:remap',
      'imports:status',
    ]);
  });
});
