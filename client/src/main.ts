import { app, BrowserWindow, ipcMain, protocol, safeStorage, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { createWindow } from '../../src/main/createWindow';
import { createRendererTrust } from '../../src/main/navigationPolicy';
import { registerCallieProtocol } from '../../src/main/protocol';
import { ClientCore } from './main/clientCore';
import { TokenStore } from './main/tokenStore';
import { createProductionDialLauncher } from './main/phone';
import { resolveWorkerEndpoint } from './main/workerEndpoint';
import {
  CLIENT_CHANNELS,
  clientStatusSchema,
  commandResultSchema,
  dialRequestSchema,
  dialResultSchema,
  pairRequestSchema,
  pairResultSchema,
  readRequestSchema,
  readResultSchema,
  v1CommandSchema,
} from './shared/clientContract';

/**
 * The thin client's main process (FSS target design, section 1): one window, one device token in a
 * safeStorage-encrypted file, the worker's views and commands over five IPC channels. No database, no
 * migrations, no backup, no sync. The window, the renderer trust rules and the `callie://` scheme that
 * serves the bundled UI are the old app's modules, imported from the repository's `src/main`.
 */

// The bundled UI is served through callie://, never file://: the fuses withhold file:// privileges.
protocol.registerSchemesAsPrivileged([
  { scheme: 'callie', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Two overrides for development and the Playwright specs. A packaged build ignores its environment.
if (!app.isPackaged && process.env.CALLIE_CLIENT_USER_DATA) {
  app.setPath('userData', process.env.CALLIE_CLIENT_USER_DATA);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const rendererTrust = createRendererTrust({
  isPackaged: app.isPackaged,
  developmentRendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
});
const userDataPath = app.getPath('userData');
// Everything the client keeps lives here: device-token.bin (safeStorage-encrypted), today-last-good.json,
// and the public worker-endpoint.json when the endpoint is not given by the environment.
const clientDirectory = path.join(userDataPath, 'client');

const core = new ClientCore({
  clientDirectory,
  tokenStore: new TokenStore({ directory: clientDirectory, safeStorage }),
  endpoint: resolveWorkerEndpoint({ env: process.env, clientDirectory, isPackaged: app.isPackaged }),
  // The Phone.app handoff (S2): the packaged same-team helper and the local setup proof, resolved only when a dial
  // is asked for. An unpackaged run has no route at all and says so, which is what a development run and the specs get.
  dialLauncher: createProductionDialLauncher({ clientDirectory, isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath, parentExecutablePath: app.getPath('exe') }),
});

type Parser<T> = { parse(value: unknown): T };

/** One channel: only a trusted renderer frame may call it, and both the request and the reply cross a schema. */
function handle<I, O>(channel: string, input: Parser<I> | null, output: Parser<O>, run: (request: I) => Promise<O>): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<O> => {
    if (!rendererTrust.isTrustedRendererUrl(event.senderFrame?.url ?? '')) throw new Error('untrusted_sender');
    const request = (input === null ? undefined : input.parse(raw)) as I;
    return output.parse(await run(request));
  });
}

handle(CLIENT_CHANNELS.status, null, clientStatusSchema, () => core.status());
handle(CLIENT_CHANNELS.pair, pairRequestSchema, pairResultSchema, (request) => core.pair(request));
handle(CLIENT_CHANNELS.get, readRequestSchema, readResultSchema, (request) => core.get(request));
handle(CLIENT_CHANNELS.command, v1CommandSchema, commandResultSchema, (command) => core.command(command));
handle(CLIENT_CHANNELS.dial, dialRequestSchema, dialResultSchema, (request) => core.dial(request));
handle(CLIENT_CHANNELS.unpair, null, clientStatusSchema, () => core.unpair());

const createMainWindow = (): void => {
  const window = createWindow(path.join(__dirname, 'preload.js'), process.platform, userDataPath);
  window.webContents.on('will-navigate', (event, url) => {
    if (!rendererTrust.isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void window.loadURL(rendererTrust.rendererUrl);
};

void app.whenReady().then(() => {
  registerCallieProtocol(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`));
  createMainWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
