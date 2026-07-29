import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 20_000;

export interface PolledData<T> {
  data: T | null;
  /** True once a request has failed and we're serving cached data (BRD 6a). */
  offline: boolean;
  lastFetchTs: number | null;
  /** Force an immediate refetch (manual refresh button). */
  refresh: () => void;
  refreshing: boolean;
}

/**
 * Polls `fetcher` on an interval, keeping the last successful response
 * around when a fetch fails instead of clearing it — the BRD's "last known
 * good data is a normal operating state, not an error state" behavior. The
 * same applies when `depsKey` changes (e.g. the rider pans to a new area):
 * the previous result stays displayed until the new one arrives, rather
 * than flashing empty. Re-fetches immediately whenever `depsKey` changes.
 */
export function usePolledData<T>(fetcher: () => Promise<T>, depsKey: string): PolledData<T> {
  const [data, setData] = useState<T | null>(null);
  const [offline, setOffline] = useState(false);
  const [lastFetchTs, setLastFetchTs] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useRef(async (isManual: boolean) => {
    if (isManual) setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      setData(result);
      setOffline(false);
      setLastFetchTs(Date.now());
    } catch {
      setOffline(true);
    } finally {
      if (isManual) setRefreshing(false);
    }
  });

  useEffect(() => {
    let cancelled = false;
    const run = async (isManual: boolean) => {
      if (cancelled) return;
      await load.current(isManual);
    };
    void run(false);
    const id = setInterval(() => void run(false), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // depsKey intentionally captures everything the fetcher closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  return { data, offline, lastFetchTs, refresh: () => void load.current(true), refreshing };
}
