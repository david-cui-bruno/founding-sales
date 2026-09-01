import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDebouncedSaver,
  readWindowState,
  windowStatePath,
  writeWindowState,
} from '../../src/main/windowState';

let userDataPath: string;

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'callie-window-state-'));
});

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('readWindowState', () => {
  it('returns an empty state when no file exists', () => {
    expect(readWindowState(userDataPath)).toEqual({});
  });

  it('round-trips bounds and theme through the JSON file', () => {
    writeWindowState(userDataPath, {
      bounds: { x: 12, y: 34, width: 1280, height: 800 },
      theme: 'dark',
    });

    expect(readWindowState(userDataPath)).toEqual({
      bounds: { x: 12, y: 34, width: 1280, height: 800 },
      theme: 'dark',
    });
  });

  it('rejects corrupt JSON without throwing', async () => {
    await writeFile(windowStatePath(userDataPath), '{not json');
    expect(readWindowState(userDataPath)).toEqual({});
  });

  it('drops malformed bounds and unknown themes', async () => {
    await writeFile(
      windowStatePath(userDataPath),
      JSON.stringify({
        bounds: { x: 'left', y: 0, width: -5, height: 700 },
        theme: 'hotdog',
      }),
    );
    expect(readWindowState(userDataPath)).toEqual({});
  });

  it('keeps a valid theme even when bounds are malformed', async () => {
    await writeFile(
      windowStatePath(userDataPath),
      JSON.stringify({ bounds: null, theme: 'light' }),
    );
    expect(readWindowState(userDataPath)).toEqual({ theme: 'light' });
  });
});

describe('writeWindowState', () => {
  it('writes compact JSON that survives reload', async () => {
    writeWindowState(userDataPath, {
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    });
    const raw = await readFile(windowStatePath(userDataPath), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    });
  });
});

describe('createDebouncedSaver', () => {
  it('coalesces bursts of schedule calls into one save', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = createDebouncedSaver(save, 500);

    saver.schedule();
    saver.schedule();
    saver.schedule();
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush saves immediately and cancels the pending timer', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = createDebouncedSaver(save, 500);

    saver.schedule();
    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush without a pending schedule still saves once', () => {
    const save = vi.fn();
    const saver = createDebouncedSaver(save, 500);
    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
