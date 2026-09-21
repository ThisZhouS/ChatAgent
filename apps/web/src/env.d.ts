/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * Narrow surface exposed by the Electron preload (apps/desktop/preload.cjs).
 * The bridge only exists inside the desktop shell; in a plain browser none of
 * these fields are present and the local-agent card is hidden.
 */
interface ChatAgentHostBridge {
  command(command: unknown): Promise<{
    ok: boolean;
    result?: unknown;
    error?: string;
    detail?: string;
  }>;
  quitApp(): Promise<{ ok: boolean }>;
}

/** Desktop-only window controls (absent in a plain browser). */
interface ChatAgentWindowBridge {
  set(action: 'pin' | 'unpin' | 'toggle-pin' | 'hide' | 'show'): Promise<{
    ok: boolean;
    result?: { pinned: boolean; visible: boolean; focused: boolean };
    error?: string;
  }>;
}

interface Window {
  chatagent?: {
    platform: string;
    versions: { electron: string; chrome: string; node: string };
    host?: ChatAgentHostBridge;
    window?: ChatAgentWindowBridge;
  };
}
