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

import type { PipelineSnapshot } from '../../src/shared/contracts/pipelineContract';
import { registerPipelineIpc } from '../../src/main/pipeline/registerPipelineIpc';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const trustedEvent = { senderFrame: { url: 'callie://app/index.html' } };
const untrustedEvent = { senderFrame: { url: 'https://attacker.test/' } };

const emptySnapshot: PipelineSnapshot = {
  stages: [
    'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
  ].map((stage): PipelineSnapshot['stages'][number] => ({
    stage: stage as PipelineSnapshot['stages'][number]['stage'],
    cards: [],
  })),
  revision: 0,
};

function registeredHandler() {
  return registeredIpcHandler(electron.handle, 'pipeline:get');
}

describe('registerPipelineIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers only pipeline:get and returns the validated snapshot', async () => {
    const provider = { get: vi.fn(async () => emptySnapshot) };

    registerPipelineIpc(provider);

    expect(electron.handle).toHaveBeenCalledTimes(1);
    expect(electron.handle.mock.calls[0]?.[0]).toBe('pipeline:get');
    await expect(registeredHandler()(trustedEvent)).resolves.toEqual(emptySnapshot);
    expect(provider.get).toHaveBeenCalledTimes(1);
  });

  it('rejects an untrusted sender before invoking the provider', async () => {
    const provider = { get: vi.fn(async () => emptySnapshot) };
    registerPipelineIpc(provider);

    await expect(registeredHandler()(untrustedEvent)).rejects.toThrow('trusted');
    expect(provider.get).not.toHaveBeenCalled();
  });

  it('rejects every request argument before invoking the provider', async () => {
    const provider = { get: vi.fn(async () => emptySnapshot) };
    registerPipelineIpc(provider);

    await expect(
      registeredHandler()(trustedEvent, { stage: 'won' }),
    ).rejects.toThrow('argument');
    expect(provider.get).not.toHaveBeenCalled();
  });

  it('rejects a malformed provider snapshot in the main process', async () => {
    const provider = {
      get: vi.fn(async () => ({ ...emptySnapshot, revision: -1 })),
    };
    registerPipelineIpc(provider);

    await expect(registeredHandler()(trustedEvent)).rejects.toThrow();
  });

  it('rejects a snapshot that smuggles extra fields onto a card', async () => {
    const provider = {
      get: vi.fn(async () => ({
        ...emptySnapshot,
        stages: emptySnapshot.stages.map((lane) =>
          lane.stage === 'won'
            ? { ...lane, score: 95 }
            : lane,
        ),
      })),
    };
    registerPipelineIpc(provider);

    await expect(registeredHandler()(trustedEvent)).rejects.toThrow();
  });

  it('removes only the pipeline handler and does so once', () => {
    const unregister = registerPipelineIpc({ get: async () => emptySnapshot });

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(1);
    expect(electron.removeHandler).toHaveBeenCalledWith('pipeline:get');
  });
});
