import { getSettings } from './api';

interface Umami {
  identify?: (id: string, data?: Record<string, unknown>) => void;
  track?: (...args: unknown[]) => void;
}

declare global {
  interface Window {
    umami?: Umami;
  }
}

let identified = false;

function waitForUmami(timeoutMs = 10_000): Promise<Umami | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (window.umami?.identify) return resolve(window.umami);
      if (Date.now() - start > timeoutMs) return resolve(null);
      window.setTimeout(tick, 200);
    };
    tick();
  });
}

/**
 * Tag this browser with the collector's anonymous install_id so analytics can
 * tell self-hosted instances apart. Every instance runs on 127.0.0.1, so the
 * default hostname-based segmentation collapses everyone into one visitor —
 * identifying by install_id restores per-instance segregation. Best-effort:
 * silently no-ops when offline, air-gapped, or the script is blocked.
 */
export async function identifyInstall(): Promise<void> {
  if (identified) return;
  try {
    const { install_id } = await getSettings();
    if (!install_id) return;
    const umami = await waitForUmami();
    if (!umami?.identify) return;
    umami.identify(install_id, { install_id });
    identified = true;
  } catch {
    /* analytics is non-essential; never surface errors to the user */
  }
}
