// Shared live-update signal backed by a single Server-Sent Events connection to
// the collector's /v1/stream. The collector bumps a revision counter whenever
// new data is ingested and emits a `change`; subscribers are notified so they
// can refetch. usePolling coalesces these signals, so a busy session that emits
// many events per second still triggers at most one refetch per window.

let source: EventSource | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

function ensureConnection(): void {
  if (source !== null || typeof EventSource === 'undefined') return;
  source = new EventSource('/v1/stream');
  // `change` = new data landed. `hello` = (re)connected, so we may have missed
  // events while disconnected — refetch to catch up. EventSource reconnects on
  // its own after an error, re-firing `hello`.
  source.addEventListener('change', notify);
  source.addEventListener('hello', notify);
}

/**
 * Subscribe to "collector data changed" signals from the live stream. The
 * callback fires on each change and on (re)connect. Callers should throttle
 * their own work — signals can arrive rapidly during an active session.
 */
export function subscribeStream(callback: () => void): () => void {
  ensureConnection();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
