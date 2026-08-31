import { describe, expect, it } from 'vitest';

import { encryptedDriverDecision } from '../../src/main/db/sqliteDriverDecision';

type ProbePassed = (report: unknown) => boolean;

describe('encrypted SQLite driver decision', () => {
  it('exposes the exact Gate 0 package and cipher profile', () => {
    expect(encryptedDriverDecision).toEqual({
      packageName: 'better-sqlite3-multiple-ciphers',
      packageVersion: '12.11.1',
      cipher: 'sqlcipher',
      compatibility: 4,
      synchronous: true,
    });
  });

  it('rejects probe evidence when the pinned runtime or cipher profile differs', async () => {
    const { probePassed } = (await import(
      '../../scripts/probeEncryptedSqlite.cjs'
    )) as {
      probePassed: ProbePassed;
    };
    const passingReport = {
      packageVersion: '12.11.1',
      electronVersion: '44.0.0',
      platform: 'darwin',
      architecture: 'arm64',
      cipher: 'sqlcipher',
      legacy: '4',
      synchronousRow: { value: 'encrypted' },
      reopenedRow: { value: 'encrypted' },
      journalMode: 'wal',
      ftsRow: { content: 'searchable encrypted content' },
      integrity: 'ok',
      encryptedHeader: true,
      wrongKeyRejected: true,
    };

    expect(probePassed(passingReport)).toBe(true);
    for (const [field, value] of [
      ['packageVersion', '12.11.0'],
      ['electronVersion', '43.0.0'],
      ['platform', 'linux'],
      ['architecture', 'x64'],
      ['cipher', 'sqleet'],
      ['legacy', '3'],
    ] as const) {
      expect(probePassed({ ...passingReport, [field]: value })).toBe(false);
    }
  });
});
