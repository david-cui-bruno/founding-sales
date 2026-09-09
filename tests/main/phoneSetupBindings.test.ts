import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, symlinkSync } from 'node:fs';
import { createProductionPhoneBindings, createPhoneInboundRegistry } from '../../src/main/startApplication';
import { PhoneRouteSettings } from '../../src/main/communications/phoneRouteSettings';
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
