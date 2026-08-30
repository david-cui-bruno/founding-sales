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

export const createWindow = (preloadPath: string): BrowserWindow =>
  new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: secureWebPreferences(preloadPath),
  });
