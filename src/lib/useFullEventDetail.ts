import { useQuery } from '@tanstack/react-query';
import { getEventDetail, type TimelineItem } from './api';
import { useSessionStore } from './sessionStore';

function lookupFor(item: TimelineItem, fallbackSessionId?: string) {
  const sessionId = item.detail_lookup?.session_id ?? fallbackSessionId;
  const eventId = item.detail_lookup?.event_id ?? item.id;
  return { sessionId, eventId };
}

/**
 * Resolve an event's full detail when the session payload only carried a
 * preview (or, for tool calls, nothing — see `detail_truncated`). Backed by the
 * shared react-query cache so collapsing and re-expanding a row, or showing the
 * same event in the timeline and the side panel, fetches it once.
 */
export function useFullEventDetail(item: TimelineItem | null, sessionId?: string) {
  const lookup = item ? lookupFor(item, sessionId) : null;
  const enabled = Boolean(item?.detail_truncated && lookup?.sessionId && lookup.eventId != null);
  const store = useSessionStore();
  const { data, isPending, isError } = useQuery({
    queryKey: ['eventDetail', store, lookup?.sessionId, lookup?.eventId],
    queryFn: () => getEventDetail(lookup!.sessionId!, lookup!.eventId, store),
    enabled,
  });

  const resolved = item && enabled && data
    ? { ...item, detail: data.detail, attachments: data.attachments ?? item.attachments }
    : item;

  return {
    resolved,
    loading: enabled && isPending && !isError,
  };
}
