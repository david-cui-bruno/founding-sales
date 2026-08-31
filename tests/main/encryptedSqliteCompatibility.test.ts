import { describe, expect, it } from 'vitest';

import { encryptedDriverDecision } from '../../src/main/db/sqliteDriverDecision';

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
});
