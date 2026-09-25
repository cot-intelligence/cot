import { createContext, useContext } from 'react';
import type { Store } from './api';

/** The DB the open session page reads from (traced sessions or Session Replay). */
export const SessionStoreContext = createContext<Store>('main');

export function useSessionStore(): Store {
  return useContext(SessionStoreContext);
}

/** Hash route for a session page in its store (`#/session/…` or `#/replay/…`). */
export function sessionHref(id: string, store: Store = 'main'): string {
  return `#/${store === 'replay' ? 'replay' : 'session'}/${encodeURIComponent(id)}`;
}
