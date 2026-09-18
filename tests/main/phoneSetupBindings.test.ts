import { createPhoneSetupApi } from '../../src/preload/apis/phoneSetupApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, symlinkSync } from 'node:fs';
import { createProductionPhoneBindings, createPhoneInboundRegistry } from '../../src/main/startApplication';
import { PhoneRouteSettings } from '../../src/main/communications/phoneRouteSettings';
import { PHONE_DIAL_MODES } from '../../src/renderer/features/today/todayCopy';
import { createTempDatabase, type TempDatabase } from '../fixtures/tempDatabase';

// These tests never start Foundation or migrate a database. Keep the unrelated
// domain service graph out of this focused test while siblings change its schema.
// Calling it would be a test failure, not a mocked successful domain operation.
vi.mock('../../src/main/domain/createDomainServices', () => ({
  createDomainServices: () => { throw new Error('Unrelated domain composition is forbidden in isolated binding tests'); },
}));
vi.mock('../../src/main/db/migrate', () => ({
  migrateToLatest: () => { throw new Error('Migration is forbidden in isolated binding tests'); },
}));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {} }));

const NOW = '2026-08-31T15:00:00.000Z';
const temps: TempDatabase[] = [];
afterEach(() => { for (const temp of temps.splice(0)) temp.cleanup(); });

describe('isolated actual A3 binding/settings safety, not assembled domain acceptance', () => {
  it('does not inspect helper signatures or start processes on an unsupported platform', async () => {
    const temp = createTempDatabase(); temps.push(temp);
    const signature = vi.fn(async () => ({ signed: true as const, identifier: 'fixture.helper', teamIdentifier: 'FICTIONAL' }));
    const native = vi.fn(async () => 'forbidden');
    const settings = new PhoneRouteSettings(join(dirname(temp.path), 'proof.json'));
    const bindings = createProductionPhoneBindings({ settings, registry: createPhoneInboundRegistry(),
      helper: { path: { isPackaged: true, resourcesPath: '/Fictional/Callie.app/Contents/Resources',
        developmentExecutablePath: '/forbidden', environment: {} },
        signature: { parentExecutablePath: '/parent', expectedIdentifier: 'fixture.helper', run: signature } },
      native: { platform: 'linux', runAsync: native },
    });
    expect((await bindings.setup!.status()).state).toBe('unavailable');
    expect(signature).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  });

  // D6: Settings and the call card read the saved setup state. This pins that reading to the real
  // launcher: the dial mode says "Callie can dial" exactly when inspectCapability says available.
  it('lines every phone setup state up with what the launcher can actually do', async () => {
    const temp = createTempDatabase(); temps.push(temp);
    const settings = new PhoneRouteSettings(join(dirname(temp.path), 'proof.json'));
    let reply = JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route-v1' });
    const bindings = createProductionPhoneBindings({ settings, registry: createPhoneInboundRegistry(), now: () => NOW,
      helper: { path: { isPackaged: true, resourcesPath: '/Fictional/Callie.app/Contents/Resources',
        developmentExecutablePath: '/forbidden', environment: {} },
        signature: { parentExecutablePath: '/parent', expectedIdentifier: 'fixture.helper',
          run: async () => ({ signed: true as const, identifier: 'fixture.helper', teamIdentifier: 'FICTIONAL' }) } },
      native: { platform: 'darwin', runSync: () => reply, runAsync: async () => reply },
    });
    const observe = async () => {
      const state = (await bindings.setup!.status()).state;
      return { state, dialable: (await bindings.phone.inspectCapability()).state === 'available',
        claimed: PHONE_DIAL_MODES[state].reason === null };
    };
    // A helper answers but nothing is confirmed: "Not verified", and the launcher refuses.
    expect(await observe()).toEqual({ state: 'needs_confirmation', dialable: false, claimed: false });
    await bindings.setup!.confirm({ expectedFingerprint: 'fictional-route-v1' });
    expect(await observe()).toEqual({ state: 'configured', dialable: true, claimed: true });
    // The helper stops answering with the confirmed proof still on disk: "Unsupported, unsigned or unverified".
    reply = JSON.stringify({ version: 1, status: 'unavailable', reason: 'no_handler' });
    expect(await observe()).toEqual({ state: 'unavailable', dialable: false, claimed: false });
    reply = JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route-v1' });
    await bindings.setup!.clear();
    expect(await observe()).toEqual({ state: 'needs_confirmation', dialable: false, claimed: false });
    // A cleared proof with no candidate at all is "Not set up", and still refuses.
    reply = JSON.stringify({ version: 1, status: 'unavailable', reason: 'no_handler' });
    expect(PHONE_DIAL_MODES.unconfigured.reason).not.toBeNull();
    expect((await bindings.phone.inspectCapability()).state).toBe('unavailable');
    expect((await bindings.phone.dispatch('+14015550200')).status).not.toBe('handoff_accepted');
  });

  it('does not clear through a substituted symlink parent', () => {
    const temp = createTempDatabase(); temps.push(temp);
    const root = dirname(dirname(temp.path)); const target = join(root, 'target'); mkdirSync(target);
    const actual = new PhoneRouteSettings(join(target, 'proof.json'));
    actual.confirm({ version: 1, fingerprint: 'fictional-route', confirmedAt: NOW });
    symlinkSync(target, join(root, 'link'));
    const alias = new PhoneRouteSettings(join(root, 'link', 'proof.json'));
    expect(() => alias.clear()).toThrow('PHONE_SETUP_FAILED');
    expect(actual.read()?.fingerprint).toBe('fictional-route');
  });

});

describe('phone setup preload confirmation arity', () => {
  it.each([
    { name: 'missing input', args: [] },
    { name: 'extra undefined argument', args: [{ expectedFingerprint: 'fictional-route' }, undefined] },
    { name: 'extra object argument', args: [{ expectedFingerprint: 'fictional-route' }, { unexpected: true }] },
  ])('rejects $name before invoking IPC', async ({ args }) => {
    const invoke = vi.fn(async () => ({ state: 'configured', candidateFingerprint: 'fictional-route', confirmedAt: NOW }));
    const api = createPhoneSetupApi(createIpcClient({ invoke }));
    const result = Reflect.apply(api.confirm, api, args) as Promise<unknown>;
    await expect(result).rejects.toThrow('PHONE_SETUP_FAILED');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves validated confirmation with exactly one argument', async () => {
    const status = { state: 'configured', candidateFingerprint: 'fictional-route', confirmedAt: NOW };
    const invoke = vi.fn(async () => status);
    const api = createPhoneSetupApi(createIpcClient({ invoke }));
    expect(await api.confirm({ expectedFingerprint: 'fictional-route' })).toEqual(status);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('phone-setup:confirm', { expectedFingerprint: 'fictional-route' });
  });
});
