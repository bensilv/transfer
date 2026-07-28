import { useEffect, useState } from 'react';

/** Re-renders the caller every second so live countdowns (e.g. "2 min") tick down. */
export function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
