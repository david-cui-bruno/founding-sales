import { describe, expect, it, vi } from 'vitest';
import { ADMIN_IPC_CHANNELS } from '../src/main/settingsBridge.ts';

/**
 * The Save channel with the note left empty (wave 1). Until then the main process read
 * an empty note as a malformed request and answered with the unchanged state, so the
 * page looked as if it had saved and nothing was sent.
 *
 * Electron is replaced by a recorder of the handlers, as `updater.test.ts` does.
 */

const handlers = vi.hoisted(() => new Map<string, (event: unknown, argument: unknown) => Promise<unknown>>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, argument: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
}));

describe('the Save channel (wave 1)', () => {
  it('sends a Save whose note was left empty, with the default note', async () => {
    const { registerAdminBridge, resetAdminWindowRegistrations } = await import('../src/main/settingsWindow.ts');
    resetAdminWindowRegistrations();
    const sent: unknown[] = [];
    registerAdminBridge({
      api: {
        read: async () => await Promise.resolve({ ok: false, reason: 'not_found', offline: false } as const),
        command: async (path: string, payload: Readonly<Record<string, unknown>>) => {
          if (path === '/settings/update') sent.push(payload);
          return await Promise.resolve({ ok: false, reason: 'refused', offline: false } as const);
        },
      },
      session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
    });
    const save = handlers.get(ADMIN_IPC_CHANNELS.saveSetting);
    expect(save).toBeDefined();
    await save?.({}, { settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' }, changeNote: '' });
    await save?.({}, { settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' } });
    expect(sent).toEqual([
      { settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' }, changeNote: 'Changed on the Mac' },
      { settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' }, changeNote: 'Changed on the Mac' },
    ]);
  });
});
