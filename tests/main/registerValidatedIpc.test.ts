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
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const trustedEvent = { senderFrame: { url: 'callie://app/index.html' } };
const untrustedEvent = { senderFrame: { url: 'https://attacker.test' } };

const requestSchema = z.object({ id: z.string() }).strict();
const responseSchema = z.object({ ok: z.literal(true) }).strict();

function registeredHandler(channel = 'workflow:test') {
  return registeredIpcHandler(electron.handle, channel);
}

describe('registerValidatedIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers the requested channel exactly once', () => {
    registerValidatedIpc({
      channel: 'workflow:test',
      requestSchema,
      responseSchema,
      handler: () => ({ ok: true as const }),
    });

    expect(electron.handle).toHaveBeenCalledTimes(1);
    expect(electron.handle.mock.calls[0]?.[0]).toBe('workflow:test');
  });

  it('rejects an untrusted sender before parsing or invoking the provider', async () => {
    const provider = vi.fn();
    registerValidatedIpc({
      channel: 'workflow:test', requestSchema,
      responseSchema, handler: provider,
    });

    await expect(registeredHandler()(untrustedEvent, { id: 'p1' }))
      .rejects.toThrow('trusted');
    expect(provider).not.toHaveBeenCalled();
  });

  it('accepts only the explicitly composed development sender validator', async () => {
    registerValidatedIpc({
      channel: 'workflow:test',
      requestSchema: null,
      responseSchema,
      handler: () => ({ ok: true as const }),
      isTrustedRendererUrl: (url) => url === 'http://localhost:5173/',
    });

    await expect(
      registeredHandler()({ senderFrame: { url: 'http://localhost:5173/' } }),
    ).resolves.toEqual({ ok: true });
    await expect(
      registeredHandler()({ senderFrame: { url: 'http://localhost:5173/other' } }),
    ).rejects.toThrow('trusted');
  });

  it('validates the request and returns the validated provider response', async () => {
    const provider = vi.fn(async (request: { id: string }) => {
      expect(request).toEqual({ id: 'p1' });
      return { ok: true as const };
    });
    registerValidatedIpc({
      channel: 'workflow:test', requestSchema,
      responseSchema, handler: provider,
    });

    await expect(registeredHandler()(trustedEvent, { id: 'p1' }))
      .resolves.toEqual({ ok: true });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed request before invoking the provider', async () => {
    const provider = vi.fn();
    registerValidatedIpc({
      channel: 'workflow:test', requestSchema,
      responseSchema, handler: provider,
    });

    await expect(registeredHandler()(trustedEvent, { id: 7 })).rejects.toThrow();
    await expect(registeredHandler()(trustedEvent, { id: 'p1', score: 90 }))
      .rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });

  it('requires exactly one request argument for request-bearing channels', async () => {
    const provider = vi.fn();
    registerValidatedIpc({
      channel: 'workflow:test', requestSchema,
      responseSchema, handler: provider,
    });

    await expect(registeredHandler()(trustedEvent)).rejects.toThrow('request');
    await expect(registeredHandler()(trustedEvent, { id: 'p1' }, { id: 'p2' }))
      .rejects.toThrow('request');
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects every argument on a no-request channel before invoking the provider', async () => {
    const provider = vi.fn(() => ({ ok: true as const }));
    registerValidatedIpc({
      channel: 'workflow:no-input', requestSchema: null,
      responseSchema, handler: provider,
    });

    await expect(
      registeredHandler('workflow:no-input')(trustedEvent, { id: 'p1' }),
    ).rejects.toThrow('arguments');
    expect(provider).not.toHaveBeenCalled();
    await expect(registeredHandler('workflow:no-input')(trustedEvent))
      .resolves.toEqual({ ok: true });
  });

  it('rejects a malformed provider response in the main process', async () => {
    registerValidatedIpc({
      channel: 'workflow:test', requestSchema,
      responseSchema, handler: async () => ({ ok: false } as unknown as { ok: true }),
    });

    await expect(registeredHandler()(trustedEvent, { id: 'p1' })).rejects.toThrow();
  });

  it('removes only the registered handler and does so once', () => {
    const unregister = registerValidatedIpc({
      channel: 'workflow:test', requestSchema,
      responseSchema, handler: () => ({ ok: true as const }),
    });

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(1);
    expect(electron.removeHandler).toHaveBeenCalledWith('workflow:test');
  });
});
