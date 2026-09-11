import { app, BrowserWindow, Menu, powerMonitor, protocol, safeStorage } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { createWindow } from './main/createWindow';
import {
  CALLIE_APPLE_BRIDGE_IDENTIFIER,
} from './main/appleBridge/appleBridgeSupervisor';
import {
  createApplicationMenuTemplate,
  menuNavigationScripts,
  openImportScript,
} from './main/applicationMenu';
import { createDockBadgeUpdater } from './main/dockBadge';
import { createRendererTrust } from './main/navigationPolicy';
import { registerCallieProtocol } from './main/protocol';
import {
  startApplication,
  type RunningApplication,
} from './main/startApplication';
import { createFileLogSink } from './main/logging/fileLogSink';
import { createSafeLogger } from './main/logging/safeLogger';
import { isPreReleaseBackupInvocation, runPreReleaseBackupHost } from './main/backup/preReleaseBackupRuntime';

const preReleaseBackupMode = isPreReleaseBackupInvocation(process.argv.slice(1));
if (preReleaseBackupMode) {
  void runPreReleaseBackupHost(app, safeStorage).then(receipt => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`, () => app.exit(0));
  }, () => {
    process.stderr.write('PRE_RELEASE_BACKUP_FAILED\n', () => app.exit(1));
  });
}

if (!preReleaseBackupMode) protocol.registerSchemesAsPrivileged([
  {
    scheme: 'callie',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const rendererTrust = createRendererTrust({
  isPackaged: app.isPackaged,
  developmentRendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
});

const ownsSingleInstanceLock = !started && !preReleaseBackupMode && app.requestSingleInstanceLock();
if (!started && !preReleaseBackupMode && !ownsSingleInstanceLock) {
  app.quit();
}

let rendererProtocolRegistered = false;

const createAndLoadWindow = async (signal?: AbortSignal): Promise<void> => {
  if (!rendererProtocolRegistered) {
    registerCallieProtocol(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
    );
    rendererProtocolRegistered = true;
  }

  const mainWindow = createWindow(
    path.join(__dirname, 'preload.js'),
    process.platform,
    app.getPath('userData'),
  );

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!rendererTrust.isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const rendererUrl = rendererTrust.rendererUrl;
  let rejectForAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  const destroyWindow = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
  };
  const handleAbort = (): void => {
    destroyWindow();
    rejectForAbort?.(new Error('Renderer window loading was cancelled.'));
  };

  signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    if (signal?.aborted) {
      handleAbort();
    }

    await Promise.race([mainWindow.loadURL(rendererUrl), aborted]);
  } catch (error) {
    destroyWindow();
    throw error;
  } finally {
    signal?.removeEventListener('abort', handleAbort);
  }
};

let runningApplication: RunningApplication | undefined;
let applicationStarted = false;
let startupAbortController: AbortController | undefined;
let startupPromise: Promise<void> | undefined;
let quitAfterStartup = false;
let allowQuit = false;

/**
 * Runs a constant script in the focused window. Every payload comes from the
 * fixed constants in applicationMenu.ts, never from user input.
 */
const runInFocusedWindow = (script: string): void => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow === null || focusedWindow.isDestroyed()) {
    return;
  }

  void focusedWindow.webContents
    .executeJavaScript(script, true)
    .catch((): undefined => undefined);
};

const installApplicationMenu = (): void => {
  try {
    const template = createApplicationMenuTemplate({
      appName: app.getName?.() ?? 'Callie Founder Sales System',
      platform: process.platform,
      isPackaged: app.isPackaged,
      navigate: (route) => runInFocusedWindow(menuNavigationScripts[route]),
      openImport: () => runInFocusedWindow(openImportScript),
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch {
    // The native menu is polish; never block startup on menu wiring.
  }
};

let dockBadgeInstalled = false;
const installDockBadge = (): void => {
  if (dockBadgeInstalled) {
    return;
  }

  const dock = app.dock;
  if (process.platform !== 'darwin' || dock === undefined) {
    return;
  }

  dockBadgeInstalled = true;
  const dockBadgeUpdater = createDockBadgeUpdater({
    platform: process.platform,
    // TODO: RunningApplication currently exposes only databasePath and
    // shutdown, so main has no public surface to count fresh inbound leads.
    // Replace this injected 0 with a real fresh-inbound count query once
    // startApplication exposes one. Due dates no longer exist in the app,
    // so the badge must never carry a due count.
    getFreshInboundCount: () => 0,
    setBadge: (text) => dock.setBadge(text),
  });
  dockBadgeUpdater.refresh();
  const dockBadgeTimer = setInterval(
    () => dockBadgeUpdater.refresh(),
    60_000,
  );
  dockBadgeTimer.unref();
  app.on('browser-window-focus', () => dockBadgeUpdater.refresh());
};

if (!started && ownsSingleInstanceLock) {
  void app
    .whenReady()
    .then(() => {
      installApplicationMenu();
      startupAbortController = new AbortController();
      const signal = startupAbortController.signal;
      const fileLogSink = createFileLogSink({ userDataPath: app.getPath('userData') });
      const logger = createSafeLogger({ write: fileLogSink.write });

      startupPromise = startApplication({
        appVersion: app.getVersion(),
        userDataPath: app.getPath('userData'),
        appleBridge: {
          platform: process.platform,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          environment: {
            CALLIE_APPLE_BRIDGE_PATH:
              process.env.CALLIE_APPLE_BRIDGE_PATH,
          },
          allowDevelopmentOverride: true,
          allowUnsignedDevelopment: true,
          stagingRoot: path.join(
            app.getPath('userData'),
            'apple-bridge-staging',
          ),
          expectedIdentifier: CALLIE_APPLE_BRIDGE_IDENTIFIER,
          parentExecutablePath: process.execPath,
        },
        appleSpikeEnabled: app.commandLine.hasSwitch(
          'apple-feasibility-spike',
        ),
        // Packaged E2E launches with --use-mock-keychain; never auto-poll the
        // real inbox from a test workspace. Manual pollNow stays available.
        // TEST-ONLY: the packaged sourcing E2E also sets
        // CALLIE_SOURCING_FIXTURE_DIR so sourcing.pollNow reads ndjson
        // fixtures from that local directory instead of S3 (see
        // startApplication.createProductionSourcingPoller). Real launches
        // never set that variable.
        sourcingPollingEnabled: !app.commandLine.hasSwitch('use-mock-keychain'),
        phoneRouteMode: app.commandLine.hasSwitch('use-mock-keychain') ? 'fixture' : 'native',
        isTrustedRendererUrl: rendererTrust.isTrustedRendererUrl,
        signal,
        logger,
        logDirectoryPath: fileLogSink.directoryPath,
        registerOutboundLifecycle: ({ onWake, onLock, onUnlock }) => {
          const owned: (() => void)[] = [];
          const cleanup = (): unknown[] => {
            const errors: unknown[] = [];
            for (const remove of owned.splice(0).reverse()) {
              try { remove(); }
              catch (error) { errors.push(error); }
            }
            return errors;
          };
          const register = (add: () => void, remove: () => void): void => {
            add();
            owned.push(remove);
          };
          try {
            register(() => powerMonitor.on('resume', onWake), () => powerMonitor.removeListener('resume', onWake));
            register(() => powerMonitor.on('lock-screen', onLock), () => powerMonitor.removeListener('lock-screen', onLock));
            register(() => powerMonitor.on('unlock-screen', onUnlock), () => powerMonitor.removeListener('unlock-screen', onUnlock));
          } catch (error) {
            const errors = cleanup();
            if (errors.length > 0) throw new AggregateError([error, ...errors], 'Outbound lifecycle registration and rollback failed.', { cause: error });
            throw error;
          }
          return () => {
            const errors = cleanup();
            if (errors.length > 0) throw new AggregateError(errors, 'Outbound lifecycle cleanup failed.');
          };
        },
        createWindow: () => createAndLoadWindow(signal),
      }).then(async (application) => {
        if (signal.aborted) {
          await application.shutdown();
          return;
        }

        runningApplication = application;
        applicationStarted = true;
        installDockBadge();
      });

      return startupPromise;
    })
    .catch(() => {
      if (!quitAfterStartup) {
        allowQuit = true;
        app.quit();
      }
    });
}

app.on('before-quit', (event) => {
  if (allowQuit) {
    return;
  }

  if (runningApplication !== undefined) {
    event.preventDefault();
    if (quitAfterStartup) {
      return;
    }

    quitAfterStartup = true;
    applicationStarted = false;
    const application = runningApplication;
    runningApplication = undefined;
    const finishQuit = (): void => {
      allowQuit = true;
      app.quit();
    };
    void application.shutdown().then(finishQuit, finishQuit);
    return;
  }

  if (startupPromise === undefined) {
    return;
  }

  event.preventDefault();
  startupAbortController?.abort();

  if (quitAfterStartup) {
    return;
  }

  quitAfterStartup = true;
  const finishQuit = (): void => {
    allowQuit = true;
    app.quit();
  };
  void startupPromise.then(finishQuit, finishQuit);
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (
    applicationStarted &&
    !quitAfterStartup &&
    BrowserWindow.getAllWindows().length === 0
  ) {
    void createAndLoadWindow().catch((): void => {
      app.quit();
    });
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
