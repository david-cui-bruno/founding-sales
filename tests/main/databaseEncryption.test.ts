import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyWorkspaceKey,
  type RawDatabase,
} from '../../src/main/db/sqliteDriver';
import { TEST_WORKSPACE_KEY } from '../fixtures/tempDatabase';

describe('encrypted database', () => {
  let bundleDirectory: string;
  let scenarioBundle: string;

  beforeAll(() => {
    bundleDirectory = mkdtempSync(join(process.cwd(), '.native-test-'));
    scenarioBundle = join(bundleDirectory, 'database-encryption.cjs');
    const build = spawnSync(join(process.cwd(), 'node_modules/.bin/esbuild'), [
      join(process.cwd(), 'tests/support/databaseEncryptionScenario.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--packages=external',
      '--log-level=error',
      `--outfile=${scenarioBundle}`,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(build.status).toBe(0);
  });

  afterAll(() => {
    rmSync(bundleDirectory, { recursive: true, force: true });
  });

  it.each(['create-and-health', 'reopen-and-wrong-key'])(
    'passes the %s plain-Node scenario',
    (scenario) => {
      const result = spawnSync(process.execPath, [scenarioBundle, scenario], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
    },
  );

  it('rejects malformed key lengths before issuing any database operation', () => {
    const calls: string[] = [];
    const raw = {
      pragma: (statement: string) => {
        calls.push(`pragma:${statement}`);
      },
      prepare: (statement: string) => {
        calls.push(`prepare:${statement}`);
        return { get: (): undefined => undefined };
      },
    } as unknown as RawDatabase;

    expect(() => applyWorkspaceKey(raw, Buffer.alloc(31))).toThrow(
      'Workspace key must contain 32 bytes.',
    );
    expect(calls).toEqual([]);
  });

  it('applies cipher, compatibility, and key before validating schema access', () => {
    const calls: string[] = [];
    const raw = {
      pragma: (statement: string) => {
        calls.push(`pragma:${statement}`);
      },
      prepare: (statement: string) => {
        calls.push(`prepare:${statement}`);
        return {
          get: () => {
            calls.push('get');
            return { count: 0 };
          },
        };
      },
    } as unknown as RawDatabase;

    applyWorkspaceKey(raw, Buffer.from(TEST_WORKSPACE_KEY.bytes));

    expect(calls).toEqual([
      "pragma:cipher='sqlcipher'",
      'pragma:legacy=4',
      `pragma:key="x'${'2a'.repeat(32)}'"`,
      'prepare:SELECT count(*) FROM sqlite_master',
      'get',
    ]);
  });
});
