// Shared live-update signal backed by a single Server-Sent Events connection to
// the collector's /v1/stream. The collector bumps a revision counter whenever
// new data is ingested and emits a `change`; subscribers are notified so they
// can refetch. QueryProvider coalesces these signals, so a busy session that
// emits many events per second still triggers at most one refetch per window.

/**
 * What changed. `sessions` lists the session ids the change touched; `null`
 * means the collector can't say (a reconnect, or a change not tied to one
 * session), so everything may be stale.
 */
export interface StreamChange {
  sessions: string[] | null;
}

let source: EventSource | null = null;
const listeners = new Set<(change: StreamChange) => void>();

function notify(change: StreamChange): void {
  listeners.forEach((l) => l(change));
}

function parseChange(ev: Event): StreamChange {
  try {
    const data = JSON.parse((ev as MessageEvent<string>).data) as { sessions?: unknown };
    if (Array.isArray(data.sessions)) {
      return { sessions: data.sessions.filter((s): s is string => typeof s === 'string') };
    }
  } catch {
    // Older collectors send no session list; treat as "anything may have changed".
  }
  return { sessions: null };
}

function ensureConnection(): void {
  if (source !== null || typeof EventSource === 'undefined') return;
  source = new EventSource('/v1/stream');
  // `change` = new data landed. `hello` = (re)connected, so we may have missed
  // events while disconnected — refetch to catch up. EventSource reconnects on
  // its own after an error, re-firing `hello`.
  source.addEventListener('change', (ev) => notify(parseChange(ev)));
  source.addEventListener('hello', () => notify({ sessions: null }));
}

/**
 * Subscribe to "collector data changed" signals from the live stream. The
 * callback fires on each change and on (re)connect. Callers should throttle
 * their own work — signals can arrive rapidly during an active session.
 */
export function subscribeStream(callback: (change: StreamChange) => void): () => void {
  ensureConnection();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
