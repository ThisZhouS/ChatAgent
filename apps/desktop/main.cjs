const { app, BrowserWindow, session, shell, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomBytes } = require('crypto');

// Bundled local agent host (packages/agent-host compiled to one CJS file by
// build-agent-host.mjs). It is the single scheduler on this device.
const {
  LocalAgentHost,
  JsonFileAgentHostStore,
  HermesProcessAdapter,
  FakeHermesAdapter,
  handleHostCommand,
} = require('./agent-host.bundle.cjs');

const DEFAULT_SERVER_URL = 'http://localhost:8787';
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');

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
      // Renderer stays sandboxed; the preload only exposes read-only metadata
      // and the narrow host command bridge.
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

// --- Local agent host --------------------------------------------------------
//
// The host is owned by the Electron *main* process: it keeps running while the
// window is open, while it is closed, and while the renderer crashes. Only the
// narrow validated command bridge below can talk to it, and the per-launch
// device token never leaves this process.

/** Absolute path of the real Hermes runtime, or undefined to use the fake. */
function resolveHermesExecutable() {
  const candidates = [];
  if (process.env.CHATAGENT_HERMES_EXE) candidates.push(process.env.CHATAGENT_HERMES_EXE);
  // Runtime shipped next to the packaged app (production layout).
  candidates.push(
    path.join(process.resourcesPath || __dirname, 'hermes-runtime', 'hermes-agent-cn-runtime-win32-x64.exe'),
  );
  // PoC runtime extracted under Temp (development layout).
  candidates.push(
    path.join(__dirname, '..', '..', 'Temp', 'hermes-runtime', 'hermes-agent-cn-runtime-win32-x64.exe'),
  );
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

let host = null;
let deviceToken = '';
let tray = null;
let mainWindow = null;

function hostRoot() {
  if (process.env.CHATAGENT_HOST_ROOT) return process.env.CHATAGENT_HOST_ROOT;
  return path.join(app.getPath('userData'), 'agent-host');
}

function createHost() {
  const root = hostRoot();
  const executable = resolveHermesExecutable();
  const adapter = executable
    ? new HermesProcessAdapter({ executable, model: undefined, provider: undefined })
    : new FakeHermesAdapter({ durationMs: 2500, artifactName: 'result.md' });
  const executorReason = executable
    ? ''
    : 'real Hermes runtime not found; using offline fake executor (never passed off as real)';

  host = new LocalAgentHost({
    deviceId: `desktop-${process.platform}`,
    agentId: 'hermes',
    workRoot: path.join(root, 'work'),
    store: new JsonFileAgentHostStore(path.join(root, 'tasks.json')),
    adapter,
    executorReason,
  });
  return host;
}

function registerHostIpc(serverUrl) {
  // Electron security checklist #17: validate the sender of every IPC message.
  // Only frames of our own app (the configured server origin in the renderer,
  // or our local error page) may talk to the host bridge.
  const appOrigins = [serverUrl];
  const isTrustedSender = (event) => {
    try {
      const frameUrl = event.senderFrame?.url ?? '';
      if (frameUrl.startsWith('file://')) return true; // our bundled error page
      return appOrigins.some((origin) => {
        try {
          return new URL(frameUrl).origin === new URL(origin).origin;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };

  // The renderer sends the raw command object; main holds the per-launch token
  // and never forwards it to the page. handleHostCommand enforces the schema,
  // the token gate and the host's own authorization.
  ipcMain.handle('chatagent:host', (event, command) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'untrusted_sender', detail: 'IPC sender is not the app frame' };
    }
    return handleHostCommand(host, command, { token: deviceToken }, deviceToken);
  });

  // Explicit "stop agent, then quit" — distinct from closing the window, which
  // keeps the host alive.
  ipcMain.handle('chatagent:host:quit-app', async (event) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'untrusted_sender' };
    }
    await host.stop('app_quit');
    app.quit();
    return { ok: true };
  });
}

function createTray(serverUrl) {
  try {
    if (!fs.existsSync(TRAY_ICON)) return;
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip('ChatAgent — 本机 Agent 后台运行中');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => showMainWindow(serverUrl) },
        { type: 'separator' },
        {
          label: '退出（停止后台 Agent）',
          click: () => {
            void host.stop('app_quit').finally(() => app.quit());
          },
        },
      ]),
    );
    tray.on('double-click', () => showMainWindow(serverUrl));
  } catch (err) {
    // A tray is nice-to-have; a broken icon must not take the app down.
    console.error('[chatagent] tray unavailable:', err.message);
  }
}

function showMainWindow(serverUrl) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = createWindow(serverUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow(resolveServerUrl());
  });

  app.whenReady().then(() => {
    const serverUrl = resolveServerUrl();

    // The client needs no device permission: deny every request by default so a
    // compromised page cannot reach the camera, microphone or location APIs.
    const allowedPermissions = new Set(['clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });

    deviceToken = randomBytes(32).toString('hex');
    createHost();
    void host.start().catch((err) => {
      console.error('[chatagent] host failed to start:', err);
    });
    registerHostIpc(serverUrl);
    createTray(serverUrl);

    showMainWindow(serverUrl);

    app.on('activate', () => showMainWindow(serverUrl));
  });

  // The host is the long-lived unit, not the window. Closing every window keeps
  // the process (and in-flight tasks) alive; quitting is explicit and stops the
  // host first (see chatagent:host:quit-app / tray "退出").
  app.on('window-all-closed', () => {
    // Intentionally not calling app.quit(): the local agent must keep running.
  });
}
