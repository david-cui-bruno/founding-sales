import { describe, expect, it, vi } from 'vitest';

const constructed = vi.hoisted(
  () =>
    [] as Array<{
      options: Record<string, unknown>;
      webContents: {
        on: ReturnType<typeof vi.fn>;
        executeJavaScript: ReturnType<typeof vi.fn>;
      };
    }>,
);

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = {
      on: vi.fn(),
      executeJavaScript: vi.fn(async () => undefined),
    };

    constructor(options: Record<string, unknown>) {
      constructed.push({ options, webContents: this.webContents });
    }
  }
  return { BrowserWindow: FakeBrowserWindow };
});

import {
  createWindow,
  founderWindowOptions,
  secureWebPreferences,
} from '../../src/main/createWindow';

describe('secureWebPreferences', () => {
  it('locks renderer access to the supplied preload bridge', () => {
    expect(secureWebPreferences('/tmp/preload.js')).toMatchObject({
      preload: '/tmp/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });
});

describe('founderWindowOptions', () => {
  it('keeps the shared frame geometry on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(founderWindowOptions('/tmp/preload.js', platform)).toMatchObject({
        width: 1440,
        height: 900,
        minWidth: 1050,
        minHeight: 700,
        webPreferences: secureWebPreferences('/tmp/preload.js'),
      });
    }
  });

  it('enables sidebar vibrancy behind a transparent backing on darwin', () => {
    expect(founderWindowOptions('/tmp/preload.js', 'darwin')).toMatchObject({
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      // An opaque backgroundColor would paint over the native material.
      backgroundColor: '#00000000',
    });
  });

  it('keeps the opaque frame and no vibrancy keys off darwin', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const options = founderWindowOptions('/tmp/preload.js', platform);
      expect(options.backgroundColor).toBe('#16191d');
      expect(options.titleBarStyle).toBeUndefined();
      expect('vibrancy' in options).toBe(false);
      expect('visualEffectState' in options).toBe(false);
    }
  });
});

describe('createWindow platform marker', () => {
  it('stamps body[data-platform="darwin"] on dom-ready so CSS can gate vibrancy', () => {
    constructed.length = 0;
    createWindow('/tmp/preload.js', 'darwin');
    const [instance] = constructed;
    expect(instance).toBeDefined();
    expect(instance!.webContents.on).toHaveBeenCalledWith(
      'dom-ready',
      expect.any(Function),
    );

    const domReady = instance!.webContents.on.mock.calls.find(
      ([event]) => event === 'dom-ready',
    )?.[1] as () => void;
    domReady();
    expect(instance!.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("dataset.platform = 'darwin'"),
      true,
    );
  });

  it('registers no marker hook off darwin', () => {
    constructed.length = 0;
    createWindow('/tmp/preload.js', 'linux');
    const [instance] = constructed;
    expect(instance).toBeDefined();
    expect(instance!.webContents.on).not.toHaveBeenCalled();
  });
});
