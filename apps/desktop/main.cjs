const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_SERVER_URL = 'http://localhost:8787';

function resolveServerUrl() {
  const arg = process.argv.find((item) => item.startsWith('--server='));
  if (arg) return arg.slice('--server='.length);

  if (process.env.CHATAGENT_SERVER_URL) return process.env.CHATAGENT_SERVER_URL;

  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'),
    );
    if (config && typeof config.serverUrl === 'string') return config.serverUrl;
  } catch {
    // fall through to default
  }

  return DEFAULT_SERVER_URL;
}

function createWindow(serverUrl) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    title: 'ChatAgent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) {
      void win.loadFile('error.html', { query: { url: serverUrl } });
    }
  });

  void win.loadURL(serverUrl);
  return win;
}

app.whenReady().then(() => {
  const serverUrl = resolveServerUrl();
  createWindow(serverUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(serverUrl);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
