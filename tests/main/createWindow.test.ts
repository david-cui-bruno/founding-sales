import { describe, expect, it, vi } from 'vitest';

const constructed = vi.hoisted(
  () =>
    [] as Array<{
      options: Record<string, unknown>;
      events: Map<string, Array<(...args: unknown[]) => void>>;
      onceEvents: Map<string, Array<(...args: unknown[]) => void>>;
      shown: boolean[];
      webContents: {
        on: ReturnType<typeof vi.fn>;
        executeJavaScript: ReturnType<typeof vi.fn>;
      };
    }>,
);

const nativeThemeMock = vi.hoisted(() => ({
  shouldUseDarkColors: false,
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = {
      on: vi.fn(),
      executeJavaScript: vi.fn(async () => undefined),
    };

    events = new Map<string, Array<(...args: unknown[]) => void>>();
    onceEvents = new Map<string, Array<(...args: unknown[]) => void>>();
    shown: boolean[] = [];

    constructor(options: Record<string, unknown>) {
      constructed.push({
        options,
        events: this.events,
        onceEvents: this.onceEvents,
        shown: this.shown,
        webContents: this.webContents,
      });
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.events.get(event) ?? [];
      listeners.push(listener);
      this.events.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.onceEvents.get(event) ?? [];
      listeners.push(listener);
      this.onceEvents.set(event, listeners);
      return this;
    }

    show() {
      this.shown.push(true);
    }

    isDestroyed() {
      return false;
    }

    getBounds() {
      return { x: 1, y: 2, width: 1440, height: 900 };
    }

    setBackgroundColor(): void {
      return undefined;
    }
  }
  return { BrowserWindow: FakeBrowserWindow, nativeTheme: nativeThemeMock };
});

import {
  CANVAS_BACKGROUND,
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

  it('never shows the frame before ready-to-show', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(founderWindowOptions('/tmp/preload.js', platform).show).toBe(false);
    }
  });

  it('enables inset chrome, tuned traffic lights, and sidebar vibrancy on darwin', () => {
    expect(founderWindowOptions('/tmp/preload.js', 'darwin')).toMatchObject({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 19 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      // An opaque backgroundColor would paint over the native material.
      backgroundColor: '#00000000',
    });
  });

  it('keeps the opaque frame and no vibrancy keys off darwin', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const options = founderWindowOptions('/tmp/preload.js', platform);
      expect(options.backgroundColor).toBe(CANVAS_BACKGROUND.dark);
      expect(options.titleBarStyle).toBeUndefined();
      expect('vibrancy' in options).toBe(false);
      expect('visualEffectState' in options).toBe(false);
    }
  });

  it('syncs the off-darwin backing color to the persisted theme canvas', () => {
    expect(
      founderWindowOptions('/tmp/preload.js', 'linux', { theme: 'light' })
        .backgroundColor,
    ).toBe(CANVAS_BACKGROUND.light);
    expect(
      founderWindowOptions('/tmp/preload.js', 'linux', { theme: 'dark' })
        .backgroundColor,
    ).toBe(CANVAS_BACKGROUND.dark);
  });

  it('restores persisted bounds when present', () => {
    const options = founderWindowOptions('/tmp/preload.js', 'darwin', {
      bounds: { x: 8, y: 16, width: 1200, height: 780 },
    });
    expect(options).toMatchObject({ x: 8, y: 16, width: 1200, height: 780 });
  });
});

describe('createWindow', () => {
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

  it('shows the window only after ready-to-show fires', () => {
    constructed.length = 0;
    createWindow('/tmp/preload.js', 'darwin');
    const [instance] = constructed;
    expect(instance!.shown).toEqual([]);

    const readyToShow = instance!.onceEvents.get('ready-to-show')?.[0];
    expect(readyToShow).toBeDefined();
    readyToShow!();
    expect(instance!.shown).toEqual([true]);
  });

  it('debounce-persists bounds on move and resize when userData is provided', () => {
    constructed.length = 0;
    createWindow('/tmp/preload.js', 'darwin', '/tmp/callie-window-test');
    const [instance] = constructed;
    expect(instance!.events.get('move')).toBeDefined();
    expect(instance!.events.get('resize')).toBeDefined();
    expect(instance!.onceEvents.get('close')).toBeDefined();
  });

  it('registers no persistence listeners without a userData path', () => {
    constructed.length = 0;
    createWindow('/tmp/preload.js', 'darwin');
    const [instance] = constructed;
    expect(instance!.events.get('move')).toBeUndefined();
    expect(instance!.events.get('resize')).toBeUndefined();
  });
});
