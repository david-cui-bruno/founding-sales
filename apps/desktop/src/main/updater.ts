import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { UPDATE_IPC_CHANNELS, type UpdateStatus } from '../shared/updateContract.ts';
import { checkForUpdate, downloadVerifiedArtifact } from './updateChannel.ts';
import {
  createUpdater,
  nodeUpdateFiles,
  systemCommandRunner,
  type UpdateOutcome,
  type UpdaterOptions,
} from './updateInstall.ts';

/**
 * The part of the update channel that is Electron (lane g83).
 *
 * Everything that decides anything is in `updateChannel.ts` (may this answer be
 * believed) and `updateInstall.ts` (may this bundle replace the running one, and when),
 * and both are tested without Electron. This file binds them to macOS: the real
 * filesystem, Apple's `codesign`, `ditto` and `plutil` by absolute path, the dialogs,
 * `app.relaunch`, and the one line the page draws.
 *
 * Since g83 a verified update installs itself. At launch — right after `start(...)` has
 * opened the window — the channel is read and anything it offers is downloaded,
 * verified, put in place and relaunched, with "Updating Callie to 1.0.6…" in Home's
 * sidebar while it happens and no question asked. While the app is in use, the six-hourly
 * check downloads and stages an update and then shows "Restart to update" in the same
 * place; the next launch installs it if the person does not. When the API has raised the
 * minimum client version the app is already refusing every mutation (5.3), so that check
 * installs at once instead of waiting.
 *
 * What did not change is the refusal: a manifest, a download or a bundle that does not
 * verify is not installed, and the person is told so in the dialog every build since
 * G13a has shown. An install that fails after verification leaves the running app where
 * it was and hands the person the verified zip, as G13a's builds always did.
 * `docs/decisions/g83-the-update-installs-itself.md` replaces
 * `docs/decisions/g13-update-application.md`.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;

export interface UpdateWatchOptions {
  readonly currentVersion: string;
  /** Defaults to Electron's `process.getSystemVersion()`; the manifest's OS minimum is checked against it. */
  readonly systemVersion?: string;
  readonly channelBaseUrl: string;
  /** Base64 SPKI DER, compiled in by the build. Empty means every update is refused. */
  readonly publicKey: string;
  /** True when the API has raised the minimum above this build (5.3). */
  readonly blocked: () => Promise<boolean>;
  readonly intervalMs?: number;
  /** Everything below is injected in tests of the binding; the defaults are macOS. */
  readonly check?: UpdaterOptions['check'];
  readonly download?: UpdaterOptions['download'];
  readonly tell?: UpdaterOptions['tell'];
  readonly reveal?: UpdaterOptions['reveal'];
  readonly downloadDirectory?: () => string;
}

export interface UpdateWatch {
  /** The launch check, started by `startUpdateWatch` itself. */
  readonly launch: Promise<UpdateOutcome>;
  /** The in-use check, now. */
  checkNow(): Promise<UpdateOutcome>;
  restart(): Promise<UpdateOutcome>;
  stop(): void;
}

export function startUpdateWatch(options: UpdateWatchOptions): UpdateWatch {
  const updater = createUpdater({
    currentVersion: options.currentVersion,
    systemVersion: options.systemVersion ?? hostSystemVersion(),
    channelBaseUrl: options.channelBaseUrl,
    publicKey: options.publicKey,
    host: {
      updateDirectory: join(app.getPath('userData'), 'updates'),
      executablePath: app.getPath('exe'),
      files: nodeUpdateFiles(),
      run: systemCommandRunner(),
      now: () => new Date(),
    },
    check: options.check ?? checkForUpdate,
    download: options.download ?? (async manifest => await downloadVerifiedArtifact(manifest)),
    blocked: options.blocked,
    tell: options.tell ?? defaultTell,
    reveal: options.reveal ?? ((path: string) => { shell.showItemInFolder(path); }),
    downloadDirectory: options.downloadDirectory ?? (() => app.getPath('downloads')),
    relaunch: executablePath => {
      // The relauncher waits for this process to exit before it starts the new bundle,
      // so the single-instance lock is free by the time the new one asks for it.
      app.relaunch({ execPath: executablePath });
      app.exit(0);
    },
    // A ping, not the state: the page asks for the state through the bridge, which
    // parses it, so there is one way in for it rather than two.
    publish: () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(UPDATE_IPC_CHANNELS.changed);
      }
    },
    log: line => {
      console.error(line);
    },
  });

  // The page asks for the state, and for a restart; neither takes an argument, so
  // whatever the renderer sent is ignored rather than read.
  ipcMain.handle(UPDATE_IPC_CHANNELS.state, (): UpdateStatus => updater.status());
  ipcMain.handle(UPDATE_IPC_CHANNELS.restart, async (): Promise<UpdateStatus> => {
    await updater.restartToUpdate();
    return updater.status();
  });

  const launch = updater.atLaunch();
  const timer = setInterval(() => {
    void updater.periodic();
  }, options.intervalMs ?? SIX_HOURS);
  timer.unref?.();

  return {
    launch,
    checkNow: async () => await updater.periodic(),
    restart: async () => await updater.restartToUpdate(),
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * macOS's version, as Electron reports it (`15.4.1`). Outside Electron there is none,
 * and the empty string refuses every update rather than assuming the Mac is new enough
 * (`macOsVersion` in `updateChannel.ts`).
 */
function hostSystemVersion(): string {
  const read = (process as { readonly getSystemVersion?: () => string }).getSystemVersion;
  return typeof read === 'function' ? read.call(process) : '';
}

async function defaultTell(message: string, detail: string): Promise<void> {
  await dialog.showMessageBox({ type: 'info', buttons: ['OK'], message, detail });
}
