import { BrowserWindow, type WebPreferences } from 'electron';

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
 * On darwin the window carries a native `sidebar` vibrancy material. A solid
 * backgroundColor would paint over the effect, so the backing is fully
 * transparent there; the renderer keeps the content area opaque via CSS and
 * only the nav rail column lets the material read through.
 */
export const founderWindowOptions = (
  preloadPath: string,
  platform: NodeJS.Platform = process.platform,
) => ({
  width: 1440,
  height: 900,
  minWidth: 1050,
  minHeight: 700,
  titleBarStyle: platform === 'darwin' ? ('hiddenInset' as const) : undefined,
  backgroundColor: platform === 'darwin' ? '#00000000' : '#16191d',
  ...(platform === 'darwin'
    ? {
        vibrancy: 'sidebar' as const,
        visualEffectState: 'followWindow' as const,
      }
    : {}),
  webPreferences: secureWebPreferences(preloadPath),
});

/** CSS in the sandboxed renderer gates translucency on this body attribute. */
const PLATFORM_MARKER_SCRIPT =
  "document.body.dataset.platform = 'darwin';" as const;

export const createWindow = (
  preloadPath: string,
  platform: NodeJS.Platform = process.platform,
): BrowserWindow => {
  const window = new BrowserWindow(founderWindowOptions(preloadPath, platform));
  if (platform === 'darwin') {
    window.webContents.on('dom-ready', () => {
      void window.webContents.executeJavaScript(PLATFORM_MARKER_SCRIPT, true);
    });
  }
  return window;
};
