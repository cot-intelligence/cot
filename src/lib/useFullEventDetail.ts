import { useEffect, useState } from 'react';
import { getEventDetail, type TimelineItem } from './api';

type FullDetail = {
  detail: string | null;
  attachments: TimelineItem['attachments'];
};

function lookupFor(item: TimelineItem, fallbackSessionId: string) {
  const sessionId = item.detail_lookup?.session_id ?? fallbackSessionId;
  const eventId = item.detail_lookup?.event_id ?? item.id;
  return { sessionId, eventId, key: `${sessionId}:${eventId}` };
}

export function useFullEventDetail(item: TimelineItem | null, sessionId: string) {
  const [fullByKey, setFullByKey] = useState<Record<string, FullDetail>>({});
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const lookup = item ? lookupFor(item, sessionId) : null;
  const lookupSessionId = lookup?.sessionId;
  const lookupEventId = lookup?.eventId;
  const lookupKey = lookup?.key;
  const needsFull = Boolean(
    item?.detail_truncated && lookupKey && fullByKey[lookupKey] === undefined && failedKey !== lookupKey,
  );

  useEffect(() => {
    setFailedKey(null);
  }, [lookupKey]);

  useEffect(() => {
    if (!needsFull || !item || !lookupSessionId || lookupEventId == null || !lookupKey) return;
    let cancelled = false;
    getEventDetail(lookupSessionId, lookupEventId)
      .then((res) => {
        if (!cancelled) {
          setFullByKey((prev) => ({
            ...prev,
            [lookupKey]: { detail: res.detail, attachments: res.attachments },
          }));
          setFailedKey(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailedKey(lookupKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needsFull, item, lookupSessionId, lookupEventId, lookupKey]);

  const loaded = lookupKey ? fullByKey[lookupKey] : undefined;
  const resolved = item && item.detail_truncated && loaded
    ? { ...item, detail: loaded.detail, attachments: loaded.attachments ?? item.attachments }
    : item;

  return {
    resolved,
    loading: needsFull,
  };
}
