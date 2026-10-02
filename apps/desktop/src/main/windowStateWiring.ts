import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, screen, type BrowserWindow } from 'electron';
import { chooseWindowBounds, parseWindowState, type ChosenWindow } from './windowState.ts';

/** The thin Electron layer over `windowState.ts`: read the screen, watch the window, save. */

const MINIMUM = { width: 760, height: 480 } as const;
const SAVE_DELAY_MS = 500;

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/** Where the window should open now. Never throws: an unreadable file means the default. */
/** Synchronous on purpose: a few hundred bytes, read before the window exists. */
export function loadWindowChoice(): ChosenWindow & { readonly minimum: typeof MINIMUM } {
  let text: string | null = null;
  try {
    text = readFileSync(stateFile(), 'utf8');
  } catch {
    text = null;
  }
  const displays = screen.getAllDisplays();
  const preferred = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const choice = chooseWindowBounds({
    saved: parseWindowState(text),
    displays: displays.map((d) => ({ workArea: d.workArea })),
    preferred: { workArea: preferred.workArea },
    minimum: MINIMUM,
  });
  return { ...choice, minimum: MINIMUM };
}

async function writeAtomically(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

/** Save the window's bounds (debounced) as it moves and resizes, and once more on close. */
export function rememberWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (window.isDestroyed()) return;
    const state = {
      // The un-maximized rectangle, so leaving maximized returns to the size he chose.
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    };
    void writeAtomically(stateFile(), state).catch(() => undefined);
  };
  const later = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    window.on(event as 'resize', later);
  }
  window.on('close', () => {
    if (timer !== null) clearTimeout(timer);
    save();
  });
}
