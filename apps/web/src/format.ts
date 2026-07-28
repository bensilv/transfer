export function formatClock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** "2 min" / "NOW", prefixed with "~" while running on stale (offline) data. */
export function formatMinutesAway(arrivalMs: number, nowMs: number, offline: boolean): string {
  const mins = Math.round((arrivalMs - nowMs) / 60000);
  const text = mins <= 0 ? 'NOW' : `${mins} min`;
  return offline ? `~${text}` : text;
}

export function formatUpdatedAgo(lastFetchTs: number | null, nowMs: number): string {
  if (lastFetchTs === null) return 'Not yet updated';
  const elapsedSec = (nowMs - lastFetchTs) / 1000;
  if (elapsedSec < 5) return 'Updated just now';
  if (elapsedSec < 60) return `Updated ${Math.round(elapsedSec)}s ago`;
  return `Updated ${Math.round(elapsedSec / 60)}m ago`;
}
