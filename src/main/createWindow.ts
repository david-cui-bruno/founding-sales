import { BrowserWindow, nativeTheme, type WebPreferences } from 'electron';

import {
  createDebouncedSaver,
  readWindowState,
  writeWindowState,
  type PersistedWindowState,
  type WindowBounds,
} from './windowState';

export const secureWebPreferences = (
  preloadPath: string,
): WebPreferences => ({
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
});

/**
 * Canvas colors mirroring the renderer neutral ramp step 1 (design/themes.css).
 * Keeping the native backing in sync prevents any theme-mismatched flash
 * behind the renderer paint.
 */
export const CANVAS_BACKGROUND = Object.freeze({
  light: '#fcfdfe',
  dark: '#0a0a0b',
} as const);

/**
 * The sidebar header is ~52px tall; the traffic lights are ~14px, so a 19px
 * top inset centers them vertically. 20px leading matches HIG spacing.
 */
const TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 20, y: 19 });

export type FounderWindowStateOptions = {
  theme?: 'light' | 'dark';
  bounds?: WindowBounds;
};

/**
 * On darwin the window carries a native `sidebar` vibrancy material. A solid
 * backgroundColor would paint over the effect, so the backing is fully
 * transparent there; the renderer keeps the content area opaque via CSS and
 * only the nav rail column lets the material read through. Off darwin the
 * backing follows the persisted theme canvas.
 */
export const founderWindowOptions = (
  preloadPath: string,
  platform: NodeJS.Platform = process.platform,
  state: FounderWindowStateOptions = {},
) => ({
  width: state.bounds?.width ?? 1440,
  height: state.bounds?.height ?? 900,
  ...(state.bounds !== undefined
    ? { x: state.bounds.x, y: state.bounds.y }
    : {}),
  minWidth: 1050,
  minHeight: 700,
  show: false,
  titleBarStyle: platform === 'darwin' ? ('hiddenInset' as const) : undefined,
  backgroundColor:
    platform === 'darwin'
      ? '#00000000'
      : CANVAS_BACKGROUND[state.theme ?? 'dark'],
  ...(platform === 'darwin'
    ? {
        trafficLightPosition: TRAFFIC_LIGHT_POSITION,
        vibrancy: 'sidebar' as const,
        visualEffectState: 'followWindow' as const,
      }
    : {}),
  webPreferences: secureWebPreferences(preloadPath),
});

/** CSS in the sandboxed renderer gates translucency on this body attribute. */
const PLATFORM_MARKER_SCRIPT =
  "document.body.dataset.platform = 'darwin';" as const;

const resolvedNativeTheme = (): 'light' | 'dark' | undefined => {
  try {
    return nativeTheme?.shouldUseDarkColors === true ? 'dark' : 'light';
  } catch {
    return undefined;
  }
};

export const createWindow = (
  preloadPath: string,
  platform: NodeJS.Platform = process.platform,
  userDataPath?: string,
): BrowserWindow => {
  const persisted: PersistedWindowState =
    userDataPath === undefined ? {} : readWindowState(userDataPath);
  const theme = persisted.theme ?? resolvedNativeTheme();

  const window = new BrowserWindow(
    founderWindowOptions(preloadPath, platform, {
      bounds: persisted.bounds,
      ...(theme === undefined ? {} : { theme }),
    }),
  );

  // Never flash an unpainted frame: reveal only once the renderer is ready.
  window.once('ready-to-show', () => {
    window.show();
  });

  if (platform === 'darwin') {
    window.webContents.on('dom-ready', () => {
      void window.webContents.executeJavaScript(PLATFORM_MARKER_SCRIPT, true);
    });
  }

  if (userDataPath !== undefined) {
    const persistBounds = createDebouncedSaver(() => {
      if (window.isDestroyed()) {
        return;
      }
      writeWindowState(userDataPath, {
        ...readWindowState(userDataPath),
        bounds: window.getBounds(),
      });
    });
    window.on('move', () => persistBounds.schedule());
    window.on('resize', () => persistBounds.schedule());
    window.once('close', () => persistBounds.flush());

    const onNativeThemeUpdated = (): void => {
      const resolved = resolvedNativeTheme();
      if (resolved === undefined) {
        return;
      }
      writeWindowState(userDataPath, {
        ...readWindowState(userDataPath),
        theme: resolved,
      });
      if (platform !== 'darwin' && !window.isDestroyed()) {
        window.setBackgroundColor(CANVAS_BACKGROUND[resolved]);
      }
    };
    nativeTheme?.on?.('updated', onNativeThemeUpdated);
    window.once('closed', () => {
      nativeTheme?.removeListener?.('updated', onNativeThemeUpdated);
    });
  }

  return window;
};
