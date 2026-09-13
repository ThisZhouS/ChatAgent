const { app, BrowserWindow, session, shell } = require('electron');
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

/** True when `target` is the configured app origin (or a file inside the app). */
function isAppOrigin(target, serverUrl) {
  try {
    const app_ = new URL(serverUrl);
    const other = new URL(target);
    return other.origin === app_.origin;
  } catch {
    return false;
  }
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
      // Renderer stays sandboxed; the preload only exposes read-only metadata.
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Navigation away from the configured server is opened in the real browser
  // instead of inside the trusted shell window (a link in a message must not be
  // able to repaint the client UI).
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url, serverUrl)) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
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

  // The client needs no device permission: deny every request by default so a
  // compromised page cannot reach the camera, microphone or location APIs.
  const allowedPermissions = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });

  createWindow(serverUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(serverUrl);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
