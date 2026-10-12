import { useEffect, useRef, useState } from 'react';
import { previewRule, RuleSpecError, type RulePreview, type RuleSpec } from './api';

/**
 * Live dry run of an unsaved rule over recent history; the collector is the one
 * validator. A preview scans the whole window server-side and an aborted fetch
 * doesn't stop that work, so this keeps one request in flight and, when it
 * returns, runs only the latest spec.
 */
export function useRulePreview(spec: RuleSpec | null, days: number) {
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [problem, setProblem] = useState<RuleSpecError | null>(null);
  const [loading, setLoading] = useState(false);

  const key = spec ? JSON.stringify(spec) : '';
  const latest = useRef(key);
  latest.current = key;
  const flight = useRef<{ busy: boolean; next: string | null }>({ busy: false, next: null });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!key) {
      setPreview(null);
      setProblem(null);
      return;
    }
    const run = (body: string) => {
      flight.current.busy = true;
      setLoading(true);
      const s = JSON.parse(body) as RuleSpec;
      const current = () => mounted.current && body === latest.current;
      previewRule({ ...s, name: s.name?.trim() || 'Untitled rule' }, days)
        .then((p) => { if (current()) { setPreview(p); setProblem(null); } })
        .catch((e) => { if (current() && e instanceof RuleSpecError) { setProblem(e); setPreview(null); } })
        .finally(() => {
          const next = flight.current.next;
          flight.current = { busy: false, next: null };
          if (next && mounted.current) run(next);
          else if (mounted.current) setLoading(false);
        });
    };
    const t = window.setTimeout(() => {
      if (flight.current.busy) flight.current.next = key;
      else run(key);
    }, 500);
    return () => window.clearTimeout(t);
  }, [key, days]);

  return { preview, problem, setProblem, loading };
}
