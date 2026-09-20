import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deviceSecretSchema, storedDeviceSchema, type StoredDevice } from '../shared/contract.ts';
import type { SecretVault } from './keychain.ts';

/**
 * What this Mac remembers about its registration (specification 5.3).
 *
 * The split is the whole point. The identifiers — workspace, user, device, label,
 * API address — are ordinary JSON in the app's own directory; they are not secret and
 * pretending otherwise would only make them harder to look at when something is
 * wrong. The device secret and the refresh credential go to the macOS Keychain and
 * nowhere else, and `forget()` removes both, so signing out of a Mac is one call
 * rather than a list someone has to work through.
 */

export const DEVICE_FILE = 'device.json';
export const DEVICE_SECRET_ACCOUNT = 'device-secret';
export const REFRESH_CREDENTIAL_ACCOUNT = 'refresh-credential';

export interface DeviceStoreOptions {
  readonly directory: string;
  readonly vault: SecretVault;
}

export interface DeviceStore {
  load(): Promise<StoredDevice | null>;
  save(device: StoredDevice, secrets: { readonly deviceSecret: string; readonly refreshCredential: string }): Promise<void>;
  /** The live refresh credential, or null when this Mac holds none. */
  refreshCredential(): Promise<string | null>;
  saveRefreshCredential(credential: string): Promise<void>;
  deviceSecret(): Promise<string | null>;
  forget(): Promise<void>;
}

export function createDeviceStore(options: DeviceStoreOptions): DeviceStore {
  const path = join(options.directory, DEVICE_FILE);

  const writeAtomically = async (value: unknown): Promise<void> => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    async load() {
      try {
        return storedDeviceSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        // Absent or unreadable are the same thing to a caller: this Mac is not paired.
        return null;
      }
    },

    async save(device, secrets) {
      const parsed = storedDeviceSchema.parse(device);
      // Both secrets are checked against their contract shapes before they are stored,
      // so a malformed grant cannot leave a half-registered Mac behind.
      deviceSecretSchema.parse(secrets.deviceSecret);
      await options.vault.write(DEVICE_SECRET_ACCOUNT, secrets.deviceSecret);
      await options.vault.write(REFRESH_CREDENTIAL_ACCOUNT, secrets.refreshCredential);
      await writeAtomically(parsed);
    },

    async refreshCredential() {
      return await options.vault.read(REFRESH_CREDENTIAL_ACCOUNT);
    },

    async saveRefreshCredential(credential) {
      await options.vault.write(REFRESH_CREDENTIAL_ACCOUNT, credential);
    },

    async deviceSecret() {
      return await options.vault.read(DEVICE_SECRET_ACCOUNT);
    },

    async forget() {
      await rm(path, { force: true }).catch(() => undefined);
      await options.vault.remove(DEVICE_SECRET_ACCOUNT);
      await options.vault.remove(REFRESH_CREDENTIAL_ACCOUNT);
    },
  };
}
