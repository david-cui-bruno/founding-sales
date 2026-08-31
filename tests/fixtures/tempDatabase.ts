import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceKey } from '../../src/main/security/workspaceKeyTypes';

export const TEST_WORKSPACE_KEY: WorkspaceKey = {
  bytes: Buffer.alloc(32, 0x2a),
  version: 1,
};

export const createTestWorkspaceKey = (byte = 0x2a): WorkspaceKey => ({
  bytes: Buffer.alloc(32, byte),
  version: 1,
});

export type TempDatabase = {
  path: string;
  cleanup: () => void;
};

export function createTempDatabase(): TempDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'callie-database-test-'));

  return {
    path: join(directory, 'data', 'callie.sqlite3'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
