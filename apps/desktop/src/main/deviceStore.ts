import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deviceSecretSchema,
  rememberedWorkspaceSchema,
  storedDeviceSchema,
  type RememberedWorkspace,
  type StoredDevice,
} from '../shared/contract.ts';
import type { SecretVault } from './keychain.ts';

/**
 * What this Mac remembers about its registration (specification 5.3).
 *
 * The split is the whole point. The identifiers — workspace, user, device, label,
 * API address — are ordinary JSON in the app's own directory; they are not secret and
 * pretending otherwise would only make them harder to look at when something is
 * wrong. The device secret goes to the macOS Keychain and nowhere else.
 *
 * One secret since wave 3b (audit item S7): the rotating refresh credential has no
 * caller, because `POST /auth/session/open` takes the device secret and the secret does
 * not rotate. It is not written any more, and `forget()` still removes the account, so
 * an item 1.0.12 left behind goes with the registration rather than outliving it.
 *
 * One more file, and deliberately not `device.json`: `workspace.json` holds the workspace
 * id and the name of the last sign-in (wave 1). `forget()` leaves it, so the next sign-in
 * on this Mac asks for neither. It is two public identifiers and no secret.
 */

export const DEVICE_FILE = 'device.json';
export const WORKSPACE_FILE = 'workspace.json';
export const DEVICE_SECRET_ACCOUNT = 'device-secret';
export const REFRESH_CREDENTIAL_ACCOUNT = 'refresh-credential';

export interface DeviceStoreOptions {
  readonly directory: string;
  readonly vault: SecretVault;
}

export interface DeviceStore {
  load(): Promise<StoredDevice | null>;
  save(device: StoredDevice, secrets: { readonly deviceSecret: string }): Promise<void>;
  /**
   * Rewrite the public half alone — the identifiers and the role — leaving both secrets
   * where they are. A renewal uses it to record the role the server now gives this
   * membership (lane g69); nothing secret is passed and nothing secret is written.
   */
  saveDevice(device: StoredDevice): Promise<void>;
  /** The long-lived credential this Mac opens a session with, or null when it has none. */
  deviceSecret(): Promise<string | null>;
  /**
   * Remove 1.0.12's rotating credential, if this Mac still has one.
   *
   * Nothing has read it since wave 3b, and a secret nothing reads is a secret nobody
   * notices is still there. It goes at the first startup of this build that finds a
   * registration, rather than waiting for a sign-out that may never come.
   */
  forgetRefreshCredential(): Promise<void>;
  /** Removes `device.json` and both Keychain accounts. The remembered workspace stays. */
  forget(): Promise<void>;
  /** The last sign-in's workspace and name, or null when this Mac has none. */
  rememberedWorkspace(): Promise<RememberedWorkspace | null>;
  rememberWorkspace(value: RememberedWorkspace): Promise<void>;
}

export function createDeviceStore(options: DeviceStoreOptions): DeviceStore {
  const path = join(options.directory, DEVICE_FILE);
  const workspacePath = join(options.directory, WORKSPACE_FILE);

  const writeAtomically = async (value: unknown, target: string = path): Promise<void> => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
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
      // The secret is checked against its contract shape before it is stored, so a
      // malformed grant cannot leave a half-registered Mac behind.
      deviceSecretSchema.parse(secrets.deviceSecret);
      await options.vault.write(DEVICE_SECRET_ACCOUNT, secrets.deviceSecret);
      await writeAtomically(parsed);
    },

    async saveDevice(device) {
      await writeAtomically(storedDeviceSchema.parse(device));
    },

    async deviceSecret() {
      return await options.vault.read(DEVICE_SECRET_ACCOUNT);
    },

    async forgetRefreshCredential() {
      await options.vault.remove(REFRESH_CREDENTIAL_ACCOUNT);
    },

    async forget() {
      await rm(path, { force: true }).catch(() => undefined);
      await options.vault.remove(DEVICE_SECRET_ACCOUNT);
      await options.vault.remove(REFRESH_CREDENTIAL_ACCOUNT);
    },

    async rememberedWorkspace() {
      try {
        return rememberedWorkspaceSchema.parse(JSON.parse(await readFile(workspacePath, 'utf8')));
      } catch {
        return null;
      }
    },

    async rememberWorkspace(value) {
      await writeAtomically(rememberedWorkspaceSchema.parse(value), workspacePath);
    },
  };
}
