import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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

import { registerValidatedIpc } from '../../src/main/ipc/registerValidatedIpc';
import { createIpcClient, type IpcInvoker } from '../../src/preload/ipcClient';
import { mutationReceiptSchema } from '../../src/shared/contracts/commonContract';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const requestSchema = z.object({ personId: z.string().min(1) }).strict();

const trustedEvent = { senderFrame: { url: 'callie://app/index.html' } };

function invokerThroughMain(): IpcInvoker {
  return {
    invoke: async (channel, ...args) =>
      registeredIpcHandler(electron.handle, channel)(trustedEvent, ...args),
  };
}

describe('preload ipcClient', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('round-trips a validated request and response through a registered main handler', async () => {
    const receipt = {
      revision: 3,
      affectedPersonIds: ['person-1'],
      affectedSalesCycleIds: ['cycle-1'],
    };
    const handler = vi.fn(async (request: { personId: string }) => {
      expect(request).toEqual({ personId: 'person-1' });
      return receipt;
    });
    registerValidatedIpc({
      channel: 'workflow:update',
      requestSchema,
      responseSchema: mutationReceiptSchema,
      handler,
    });

    const client = createIpcClient(invokerThroughMain());

    await expect(
      client.request('workflow:update', requestSchema, mutationReceiptSchema, {
        personId: 'person-1',
      }),
    ).resolves.toEqual(receipt);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed request in the preload before invoking main', async () => {
    const invoke = vi.fn();
    const client = createIpcClient({ invoke });

    await expect(
      client.request(
        'workflow:update',
        requestSchema,
        mutationReceiptSchema,
        { personId: '' },
      ),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a malformed main response after invoke', async () => {
    const invoke = vi.fn(async () => ({
      revision: -1,
      affectedPersonIds: [],
      affectedSalesCycleIds: [],
    }));
    const client = createIpcClient({ invoke });

    await expect(
      client.request('workflow:update', requestSchema, mutationReceiptSchema, {
        personId: 'person-1',
      }),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('invokes no-input channels without arguments and validates the response', async () => {
    const responseSchema = z.object({ ready: z.boolean() }).strict();
    registerValidatedIpc({
      channel: 'workflow:status',
      requestSchema: null,
      responseSchema,
      handler: () => ({ ready: true }),
    });

    const client = createIpcClient(invokerThroughMain());

    await expect(
      client.requestNoInput('workflow:status', responseSchema),
    ).resolves.toEqual({ ready: true });
  });

  it('rejects a malformed no-input response after invoke', async () => {
    const responseSchema = z.object({ ready: z.boolean() }).strict();
    const invoke = vi.fn(async () => ({ ready: 'yes' }));
    const client = createIpcClient({ invoke });

    await expect(
      client.requestNoInput('workflow:status', responseSchema),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith('workflow:status');
  });

  it('surfaces the main-process rejection for an untrusted sender', async () => {
    registerValidatedIpc({
      channel: 'workflow:status',
      requestSchema: null,
      responseSchema: z.object({ ready: z.boolean() }).strict(),
      handler: () => ({ ready: true }),
    });
    const untrustedInvoker: IpcInvoker = {
      invoke: async (channel, ...args) =>
        registeredIpcHandler(electron.handle, channel)(
          { senderFrame: { url: 'https://attacker.test' } },
          ...args,
        ),
    };

    const client = createIpcClient(untrustedInvoker);

    await expect(
      client.requestNoInput(
        'workflow:status',
        z.object({ ready: z.boolean() }).strict(),
      ),
    ).rejects.toThrow('trusted');
  });
});
