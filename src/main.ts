import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { createWindow } from './main/createWindow';
import { isTrustedRendererUrl } from './main/navigationPolicy';
import { registerCallieProtocol } from './main/protocol';

protocol.registerSchemesAsPrivileged([
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

const isTrustedDevelopmentRendererUrl = (url: string): boolean => {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return false;
  }

  try {
    return (
      new URL(url).origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    );
  } catch {
    return false;
  }
};

const createAndLoadWindow = () => {
  const mainWindow = createWindow(path.join(__dirname, 'preload.js'));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url) && !isTrustedDevelopmentRendererUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadURL('callie://app/index.html');
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app.whenReady().then(() => {
  registerCallieProtocol(
    path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
  );
  createAndLoadWindow();
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createAndLoadWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
