const { app, BrowserWindow, session, shell, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomBytes, randomUUID } = require('crypto');

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

// Force the Chromium sandbox for every renderer in this process, not just the
// windows we remember to configure (must run before the app is ready).
app.enableSandbox();

function resolveServerUrl() {
  const arg = process.argv.find((item) => item.startsWith('--server='));
  if (arg) return arg.slice('--server='.length);

  if (process.env.CHATAGENT_SERVER_URL) {
    // Only http(s) is a real remote workbench. A file:/javascript: URL here would
    // make local files "the app origin" and hand them the host bridge.
    try {
      const parsed = new URL(process.env.CHATAGENT_SERVER_URL);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return process.env.CHATAGENT_SERVER_URL;
      }
      console.error(`[chatagent] refusing non-http server url: ${parsed.protocol}`);
    } catch {
      console.error('[chatagent] ignoring unparseable CHATAGENT_SERVER_URL');
    }
  }

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

/**
 * Hands a link to the real browser, but only for the protocols we expect. The
 * check is on the *parsed* protocol, not on a string prefix, so neither
 * `https://evil.example`-style lookalikes nor exotic schemes reach the OS.
 */
function openExternalIfSafe(target) {
  try {
    const parsed = new URL(target);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      void shell.openExternal(target);
    }
  } catch {
    // not a URL: nothing to open
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
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  // Navigation away from the configured server is opened in the real browser
  // instead of inside the trusted shell window (a link in a message must not be
  // able to repaint the client UI).
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url, serverUrl)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  });

  win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) {
      void win.loadFile('error.html', { query: { url: serverUrl } });
    }
  });

  // Windows shutdown / restart / logout does not emit `before-quit`; the OS gives
  // the app a short window here, so the same teardown runs.
  win.on('query-session-end', () => {
    void shutdownHostOnce('os_session_end');
  });
  win.on('session-end', () => {
    void shutdownHostOnce('os_session_end');
  });

  // No embedded webviews exist in this app; refusing attachment outright removes
  // a whole class of renderer-escape bugs.
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
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
let trayUnavailable = false;

// Single idempotent shutdown path shared by every quit route (tray, menu, IPC,
// OS session end). Teardown is bounded: if the host cannot stop in time the app
// is force-exited instead of lingering with a live agent behind it.
const SHUTDOWN_DEADLINE_MS = 8000;
let shutdownPromise = null;
let shutdownDone = false;

function shutdownHostOnce(reason) {
  if (shutdownDone) return Promise.resolve();
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const current = host;
    if (current) {
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_DEADLINE_MS);
      });
      await Promise.race([
        current.close(reason).catch((err) => {
          console.error('[chatagent] host shutdown failed:', err);
        }),
        deadline,
      ]);
      clearTimeout(timer);
    }
    shutdownDone = true;
  })();
  return shutdownPromise;
}

function hostRoot() {
  if (process.env.CHATAGENT_HOST_ROOT) return process.env.CHATAGENT_HOST_ROOT;
  return path.join(app.getPath('userData'), 'agent-host');
}

/**
 * Stable device identity (Gate 7A.2). The old value was `desktop-<platform>`,
 * which is identical on every Windows machine — task ownership and receipts
 * could not be told apart. The id is generated once and kept in userData.
 */
function resolveDeviceId() {
  const file = path.join(app.getPath('userData'), 'device.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId.length >= 8) {
      return parsed.deviceId;
    }
  } catch {
    // first run or unreadable file: fall through and mint a new identity
  }
  const deviceId = `desktop-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ deviceId, createdAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.error('[chatagent] could not persist device id:', err.message);
  }
  return deviceId;
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
    deviceId: resolveDeviceId(),
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
  // keeps the host alive. The actual teardown lives in the single before-quit
  // path below, so every quit route (tray, menu, IPC, OS) behaves identically.
  ipcMain.handle('chatagent:host:quit-app', async (event) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'untrusted_sender' };
    }
    app.quit();
    return { ok: true };
  });

  // Open the bundled offline workbench. No target is accepted from the page.
  ipcMain.handle('chatagent:workbench:open', (event) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'untrusted_sender' };
    }
    showLocalWorkbench(serverUrl);
    return { ok: true };
  });
}

function createTray(serverUrl) {
  try {
    if (!fs.existsSync(TRAY_ICON)) {
      // No tray means no way back to the window and no quit affordance.
      trayUnavailable = true;
      return;
    }
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip('ChatAgent — 本机 Agent 后台运行中');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => showMainWindow(serverUrl) },
        { label: '打开本机工作台（不依赖服务器）', click: () => showLocalWorkbench(serverUrl) },
        { type: 'separator' },
        {
          // Same single shutdown path as every other quit route.
          label: '退出（停止后台 Agent）',
          click: () => app.quit(),
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

/**
 * Gate 7A.2 — the offline workbench: a page shipped inside the app that talks to
 * the local host through the same narrow bridge as the web workbench. It works
 * with the organization server unreachable, which is the whole point of the
 * on-device agent.
 */
function showLocalWorkbench(serverUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showMainWindow(serverUrl);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    void mainWindow.loadFile('workbench.html', { query: { server: serverUrl } });
  }
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
    // Both handlers are required — `setPermissionRequestHandler` alone still
    // leaves synchronous permission *checks* answering "granted".
    const allowedPermissions = new Set(['clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
      allowedPermissions.has(permission),
    );

    deviceToken = randomBytes(32).toString('hex');
    createHost();
    void host.start().catch((err) => {
      console.error('[chatagent] host failed to start:', err);
      const locked = err && err.code === 'agent_host_store_locked';
      const detail = locked
        ? '本机任务库已被另一个 ChatAgent 进程占用，为避免两个调度器写同一份任务记录，后台 Agent 未启动。'
          + `请关闭其它 ChatAgent 实例后重启。若确认没有其它实例在运行（例如上次异常退出），可删除锁文件后重试：${err.lockPath ?? '（任务库同名 .lock 文件）'}`
        : `后台 Agent 启动失败：${err && err.message ? err.message : String(err)}`;
      try {
        dialog.showErrorBox('ChatAgent', detail);
      } catch {
        // headless/CI: the console line above is the record
      }
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
    // Without a tray icon the user could never get back to the app, so closing
    // the last window must quit rather than leave an invisible process behind.
    if (trayUnavailable) {
      app.quit();
      return;
    }
    // Otherwise intentionally: the local agent keeps running behind the tray.
  });

  // Single shutdown path for every quit route: stop dispatching, cancel in-flight
  // runs (the adapter kills each executor's own process tree), persist, release
  // the task-store lock, then let the quit continue. The latch makes the second
  // before-quit (our own app.quit()) pass straight through, so quit semantics stay
  // standard instead of being replaced by a bare app.exit().
  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    void shutdownHostOnce('app_quit').then(() => app.quit());
  });

  app.on('will-quit', () => {
    try {
      tray?.destroy();
    } catch {
      // tray may already be gone
    }
  });
}
