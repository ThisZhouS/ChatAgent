const { contextBridge, ipcRenderer } = require('electron');

// Narrow host bridge. There is deliberately no general-purpose ipcRenderer
// passthrough: the page can only (a) read host status/tasks and (b) submit the
// controlled commands defined by the host schema. The per-launch device token
// stays in the main process and is never exposed here.
contextBridge.exposeInMainWorld('chatagent', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  host: {
    /** Send one validated host command. Resolves with {ok, result|error}. */
    command: (command) => ipcRenderer.invoke('chatagent:host', command),
    /** Stop the background agent, then quit the app (explicit, not window close). */
    quitApp: () => ipcRenderer.invoke('chatagent:host:quit-app'),
    /**
     * Load the bundled offline workbench into this window. Takes no argument: the
     * page cannot ask the main process to open an arbitrary location.
     */
    openWorkbench: () => ipcRenderer.invoke('chatagent:workbench:open'),
  },
  /**
   * Window controls the page may ask for. The action is a fixed verb (not a path or a
   * rectangle), so a compromised page cannot move the window somewhere unexpected or
   * open arbitrary targets; every action is validated again in the main process.
   */
  window: {
    set: (action) => ipcRenderer.invoke('chatagent:window', { action }),
  },
});
