import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFileLogSink } from '../../../src/main/logging/fileLogSink';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'callie-safe-logs-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createFileLogSink', () => {
  it('creates a 0700 log directory and a 0600 daily NDJSON file', () => {
    const userDataPath = temporaryRoot();
    const sink = createFileLogSink({ userDataPath, now: () => new Date('2026-09-04T12:00:00Z') });

    sink.write('{"eventCode":"SAFE_EVENT"}');

    expect(statSync(join(userDataPath, 'logs')).mode & 0o777).toBe(0o700);
    const logPath = join(userDataPath, 'logs', '2026-09-04.ndjson');
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(logPath, 'utf8')).toBe('{"eventCode":"SAFE_EVENT"}\n');
  });

  it('rejects a symlinked log directory', () => {
    const userDataPath = temporaryRoot();
    const target = temporaryRoot();
    symlinkSync(target, join(userDataPath, 'logs'));

    expect(() => createFileLogSink({ userDataPath })).toThrow('LOG_DIRECTORY_SYMLINK_REJECTED');
    expect(lstatSync(join(userDataPath, 'logs')).isSymbolicLink()).toBe(true);
  });

  it('rejects group- or world-accessible parent permissions', () => {
    const userDataPath = temporaryRoot();
    chmodSync(userDataPath, 0o755);

    expect(() => createFileLogSink({ userDataPath })).toThrow('LOG_PARENT_PERMISSIONS_UNSAFE');
  });

  it('fsyncs every appended record', () => {
    const fsync = vi.fn();
    const userDataPath = temporaryRoot();
    const sink = createFileLogSink({
      userDataPath,
      now: () => new Date('2026-09-04T12:00:00Z'),
      fsync,
    });

    sink.write('{"eventCode":"SAFE_EVENT"}');

    expect(fsync).toHaveBeenCalledTimes(1);
    expect(fsync.mock.calls[0]![0]).toEqual(expect.any(Number));
  });

  it('retains today plus the preceding thirteen UTC daily files', () => {
    const userDataPath = temporaryRoot();
    const logs = join(userDataPath, 'logs');
    mkdirSync(logs, { mode: 0o700 });
    for (const date of ['2026-08-20', '2026-08-21', '2026-08-22', '2026-09-03']) {
      writeFileSync(join(logs, `${date}.ndjson`), '{}\n', { mode: 0o600 });
    }
    writeFileSync(join(logs, 'keep-me.txt'), 'not a daily log', { mode: 0o600 });

    const sink = createFileLogSink({ userDataPath, now: () => new Date('2026-09-04T12:00:00Z') });
    sink.write('{"eventCode":"SAFE_EVENT"}');

    expect(readdirSync(logs).sort()).toEqual([
      '2026-08-22.ndjson', '2026-09-03.ndjson', '2026-09-04.ndjson', 'keep-me.txt',
    ]);
  });
});
