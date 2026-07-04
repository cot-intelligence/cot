// Shared live-update store backed by a single Server-Sent Events connection to
// the collector's /v1/stream. The collector bumps a revision counter whenever
// new data is ingested; every open EventSource receives a `change`. usePolling
// subscribes here so components refetch on real changes instead of on a timer.

export interface StreamSnapshot {
  revision: number;
  connected: boolean;
}

// A single object identity per state so useSyncExternalStore sees a stable
// snapshot between changes (returning a fresh object every read would loop).
let snapshot: StreamSnapshot = { revision: 0, connected: false };
let source: EventSource | null = null;
const listeners = new Set<() => void>();

function update(next: Partial<StreamSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

function ensureConnection(): void {
  if (source !== null || typeof EventSource === 'undefined') return;
  source = new EventSource('/v1/stream');
  source.addEventListener('hello', () => update({ connected: true }));
  source.addEventListener('change', (event) => {
    let revision = snapshot.revision + 1;
    try {
      const parsed = JSON.parse((event as MessageEvent).data);
      if (typeof parsed.revision === 'number') revision = parsed.revision;
    } catch {
      /* fall back to a local increment */
    }
    update({ revision, connected: true });
  });
  // EventSource reconnects on its own; mark disconnected so pollers resume their
  // own interval as a fallback until the stream is back.
  source.onerror = () => {
    if (snapshot.connected) update({ connected: false });
  };
}

export function subscribeStream(callback: () => void): () => void {
  ensureConnection();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function getStreamSnapshot(): StreamSnapshot {
  return snapshot;
}
