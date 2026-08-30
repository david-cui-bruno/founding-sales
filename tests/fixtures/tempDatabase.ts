import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
