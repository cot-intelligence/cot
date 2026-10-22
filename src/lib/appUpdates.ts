import { useCallback, useEffect, useState } from 'react';

/** The Mac app's own updater, reached over its IPC; absent in a browser. */
type Ipc = { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
const ipc = () => (window as { __TAURI_INTERNALS__?: Ipc }).__TAURI_INTERNALS__;

export const inApp = () => Boolean(ipc());

export type AppUpdate = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'failed';
  current: string;
  version: string | null;
  notes: string | null;
  error: string | null;
  downloaded: number;
  total: number | null;
};

export const checkAppUpdate = () => ipc()!.invoke<AppUpdate>('update_check');
export const installAppUpdate = () => ipc()!.invoke<void>('update_install');

const busy = (u: AppUpdate | null) => u?.status === 'checking' || u?.status === 'downloading' || u?.status === 'installing';

/** The app's update state, polled: every 30s at rest, several times a second while it moves. */
export function useAppUpdate() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const refresh = useCallback(async () => {
    const app = ipc();
    if (!app) return;
    try {
      setUpdate(await app.invoke<AppUpdate>('update_state'));
    } catch {
      /* the app refused or is restarting */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), busy(update) ? 400 : 30_000);
    return () => window.clearInterval(id);
  }, [refresh, update?.status]);
  return { update, setUpdate, refresh };
}

export const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
