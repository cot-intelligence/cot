import { useIsFetching } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * A 2px bar along the top while data revalidates in the background, so a
 * refresh reads as "live" rather than as a view dropping back to a skeleton.
 * It waits 300 ms before showing, so quick refetches don't flicker it.
 */
export function FetchBar() {
  const fetching = useIsFetching() > 0;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!fetching) {
      setShown(false);
      return;
    }
    const id = window.setTimeout(() => setShown(true), 300);
    return () => window.clearTimeout(id);
  }, [fetching]);
  return <div className="fetch-bar" data-on={shown} aria-hidden="true" />;
}
