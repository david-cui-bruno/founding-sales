import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hand-rolled window-state persistence: bounds plus the last resolved theme
 * live in one small JSON file under userData. The theme is read before the
 * BrowserWindow exists so its backgroundColor can match the renderer canvas
 * and never flash the wrong color on launch.
 */

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PersistedWindowState = {
  bounds?: WindowBounds;
  theme?: 'light' | 'dark';
};

const STATE_FILE = 'callie.window-state.json';

export const windowStatePath = (userDataPath: string): string =>
  join(userDataPath, STATE_FILE);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseBounds = (value: unknown): WindowBounds | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isFiniteNumber(candidate.x) ||
    !isFiniteNumber(candidate.y) ||
    !isFiniteNumber(candidate.width) ||
    !isFiniteNumber(candidate.height) ||
    candidate.width < 400 ||
    candidate.height < 300
  ) {
    return undefined;
  }
  return {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  };
};

const parseTheme = (value: unknown): 'light' | 'dark' | undefined =>
  value === 'light' || value === 'dark' ? value : undefined;

/** Reads persisted state; any corruption degrades to an empty object. */
export const readWindowState = (userDataPath: string): PersistedWindowState => {
  let raw: string;
  try {
    raw = readFileSync(windowStatePath(userDataPath), 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }

  const candidate = parsed as Record<string, unknown>;
  const state: PersistedWindowState = {};
  const bounds = parseBounds(candidate.bounds);
  if (bounds !== undefined) {
    state.bounds = bounds;
  }
  const theme = parseTheme(candidate.theme);
  if (theme !== undefined) {
    state.theme = theme;
  }
  return state;
};

/** Best-effort write; window state is never worth crashing over. */
export const writeWindowState = (
  userDataPath: string,
  state: PersistedWindowState,
): void => {
  try {
    writeFileSync(windowStatePath(userDataPath), JSON.stringify(state));
  } catch {
    // Persistence is polish only.
  }
};

export type DebouncedSaver = {
  schedule(): void;
  flush(): void;
};

/** Debounces move/resize bursts into one save per quiet period. */
export const createDebouncedSaver = (
  save: () => void,
  delayMs = 500,
): DebouncedSaver => {
  let timer: NodeJS.Timeout | undefined;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    schedule: () => {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        save();
      }, delayMs);
      timer.unref?.();
    },
    flush: () => {
      clear();
      save();
    },
  };
};
