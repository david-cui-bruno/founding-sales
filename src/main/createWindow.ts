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

export const founderWindowOptions = (preloadPath: string) => ({
  width: 1440,
  height: 900,
  minWidth: 1050,
  minHeight: 700,
  titleBarStyle:
    process.platform === 'darwin' ? ('hiddenInset' as const) : undefined,
  backgroundColor: '#16191d',
  webPreferences: secureWebPreferences(preloadPath),
});

export const createWindow = (preloadPath: string): BrowserWindow =>
  new BrowserWindow(founderWindowOptions(preloadPath));
