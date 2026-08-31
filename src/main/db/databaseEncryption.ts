import type { AppDatabase } from './database';
import { encryptedDriverDecision } from './sqliteDriverDecision';

export type DatabaseEncryptionHealth = {
  encrypted: true;
  cipherVersion: string;
  integrity: 'ok';
};

export function inspectDatabaseEncryption(
  database: AppDatabase,
): DatabaseEncryptionHealth {
  const cipher = database.raw.pragma('cipher', { simple: true });
  const compatibility = database.raw.pragma('legacy', { simple: true });
  const cipherVersionRow = database.raw
    .prepare<[], { version: unknown }>('SELECT sqlite3mc_version() AS version')
    .get();
  const cipherVersion = cipherVersionRow?.version;
  const integrity = database.raw.pragma('integrity_check', { simple: true });

  if (
    cipher !== encryptedDriverDecision.cipher
    || String(compatibility) !== String(encryptedDriverDecision.compatibility)
    || typeof cipherVersion !== 'string'
    || cipherVersion.length === 0
    || integrity !== 'ok'
  ) {
    throw new Error('Encrypted database verification failed.');
  }

  return {
    encrypted: true,
    cipherVersion,
    integrity,
  };
}
