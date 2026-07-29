import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { fetchJourney } from '../api';
import { usePolledData } from '../hooks/usePolledData';
import { useNowTick } from '../hooks/useNowTick';
import { formatClock, formatMinutesAway, formatUpdatedAgo } from '../format';
import { LINE_COLORS, textColorFor } from '../lines';
import { pickDirectionLabels } from '../directionLabels';
import type { ActiveTrip, Direction } from '../types';

export function JourneyScreen({
  active,
  preview,
  onPreviewTransfer,
  onCancelPreview,
  onConfirmPreview,
  onGoHome,
}: {
  active: ActiveTrip;
  preview: ActiveTrip | null;
  onPreviewTransfer: (trip: ActiveTrip) => void;
  onCancelPreview: () => void;
  onConfirmPreview: () => void;
  onGoHome: () => void;
}) {
  const now = useNowTick();
  const displayed = preview ?? active;

  // Which direction's arrivals to show for connecting lines at each stop.
  // Defaults to whichever train is currently boarded, and resets to match
  // it again each time the rider actually boards a new one (confirming a
  // transfer) — but not while merely previewing, so toggling doesn't get
  // clobbered by a preview that hasn't been confirmed yet.
  const [transferDirection, setTransferDirection] = useState<Direction>(active.direction);
  useEffect(() => {
    setTransferDirection(active.direction);
  }, [active.tripId, active.direction]);

  const journeyKey = [
    displayed.tripId,
    displayed.line,
    displayed.direction,
    displayed.boardedStationId,
    displayed.boardedArrivalMs,
    transferDirection,
  ].join('|');
  const { data, offline: fetchFailed, lastFetchTs, refresh, refreshing } = usePolledData(
    () => fetchJourney(displayed, transferDirection),
    journeyKey,
  );
  // "offline" covers both our own request failing and the backend reaching us
  // fine but failing to reach the live MTA feed for this request.
  const offline = fetchFailed || data?.status.online === false;

  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(130);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setHeaderHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isPreviewing = !!preview;
  const displayLineColor = LINE_COLORS[displayed.line] ?? '#0039A6';
  const displayLineTextColor = textColorFor(displayed.line);
  const stops = data?.stops ?? [];
  const headerDirectionLabel = data?.directionLabel ?? (displayed.direction === 'uptown' ? 'Uptown' : 'Downtown');
  const allTransfers = stops.flatMap((sp) => sp.transfers);
  const { toggle: transferToggleLabels, qualifierFor: transferQualifierFor } = pickDirectionLabels(allTransfers);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={headerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, background: '#fff', borderBottom: '1px solid #eee', paddingTop: 'max(14px, env(safe-area-inset-top))', zIndex: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px 10px' }}>
          {isPreviewing ? (
            <button onClick={onCancelPreview} style={circleBtnStyle}>‹</button>
          ) : (
            <button onClick={onGoHome} style={{ ...circleBtnStyle, fontSize: 15 }}>✕</button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 28, height: 28, borderRadius: '50%', background: displayLineColor, color: displayLineTextColor,
                fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              {displayed.line}
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a' }}>{headerDirectionLabel}</span>
          </div>
          <div style={{ width: 32 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px 10px' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#8a8a90' }}>Show transfers toward</span>
          <div style={{ display: 'flex', background: '#f1f1f3', borderRadius: 10, padding: 2 }}>
            <button
              onClick={() => setTransferDirection('downtown')}
              style={{
                padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: transferDirection === 'downtown' ? '#fff' : 'transparent',
                color: transferDirection === 'downtown' ? '#1a1a1a' : '#8a8a90',
              }}
            >
              {transferToggleLabels.downtown}
            </button>
            <button
              onClick={() => setTransferDirection('uptown')}
              style={{
                padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: transferDirection === 'uptown' ? '#fff' : 'transparent',
                color: transferDirection === 'uptown' ? '#1a1a1a' : '#8a8a90',
              }}
            >
              {transferToggleLabels.uptown}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 10px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: offline ? '#e0433d' : '#1a9c53', flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: '#6b6b70' }}>{offline ? 'OFFLINE' : 'LIVE'}</span>
          <span style={{ fontSize: 12, color: '#9a9aa0' }}>&middot; {formatUpdatedAgo(lastFetchTs, now)}</span>
          <button onClick={refresh} style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: '50%', background: '#f1f1f3', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 14, color: '#555', display: 'inline-block', animation: refreshing ? 'spin 0.6s linear' : 'none' }}>&#8635;</span>
          </button>
        </div>
        <div style={{ padding: '0 16px 8px' }}>
          <span style={{ fontSize: 11, fontStyle: 'italic', color: '#b0b0b6' }}>
            Transfer times reflect each connecting line&rsquo;s arrival after your train reaches that stop &mdash; not from right now.
          </span>
        </div>
      </div>

      <div style={{ position: 'absolute', inset: 0, paddingTop: headerHeight, paddingBottom: isPreviewing ? 90 : 24, overflow: 'auto', boxSizing: 'border-box' }}>
        <div style={{ padding: '16px 16px 24px' }}>
          {stops.map((sp, i) => (
            <div key={sp.stationId} style={{ display: 'flex', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14, flexShrink: 0 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: displayLineColor, border: '2px solid #fff', boxShadow: '0 0 0 2px #ddd', marginTop: 4, flexShrink: 0 }} />
                <div style={{ flex: 1, width: 2, background: '#e2e2e6', display: i === stops.length - 1 ? 'none' : 'block' }} />
              </div>
              <div style={{ flex: 1, paddingBottom: 22 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a' }}>{sp.name}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#8a8a90', marginBottom: 8 }}>
                  {formatClock(sp.arrivalMs)} &middot; {stopMinsAway(sp.arrivalMs, now)}
                </div>
                {sp.transfers.length > 0 ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {sp.transfers.map((tr) => {
                      const noData = tr.arrivalMs === null || !tr.tripId;
                      const qualifier = transferQualifierFor(tr, transferDirection);
                      return (
                        <button
                          key={tr.line}
                          onClick={() => {
                            if (noData) return;
                            onPreviewTransfer({ tripId: tr.tripId!, line: tr.line, direction: tr.direction, boardedStationId: sp.stationId, boardedArrivalMs: tr.arrivalMs! });
                          }}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 6px 6px', borderRadius: 20, background: '#f5f5f7', border: 'none', cursor: noData ? 'default' : 'pointer' }}
                        >
                          <span style={{ width: 22, height: 22, borderRadius: '50%', background: tr.color, color: tr.textColor, fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {tr.line}
                          </span>
                          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2 }}>
                            <span
                              style={{
                                fontSize: 13, fontWeight: 800,
                                color: noData ? '#b0b0b6' : offline ? '#9a9aa0' : '#1a1a1a',
                                fontStyle: !noData && offline ? 'italic' : 'normal',
                              }}
                            >
                              {noData ? 'NO DATA' : formatMinutesAway(tr.arrivalMs!, sp.arrivalMs, offline, '0 min')}
                            </span>
                            {qualifier && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: '#9a9aa0' }}>{qualifier}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#9a9aa0' }}>No further connections</div>
                )}
              </div>
            </div>
          ))}
          {!data && <div style={{ fontSize: 13, color: '#9a9aa0', padding: '8px 2px' }}>Loading&hellip;</div>}
          {data && stops.length === 0 && (
            <div style={{ fontSize: 13, color: '#9a9aa0', padding: '8px 2px' }}>
              This trip continues beyond this prototype&rsquo;s seeded station coverage.
            </div>
          )}
        </div>
      </div>

      {isPreviewing && (
        <button
          onClick={onConfirmPreview}
          style={{ position: 'absolute', right: 16, bottom: 24, padding: '13px 20px', borderRadius: 26, background: '#0039A6', color: '#fff', border: 'none', fontSize: 14, fontWeight: 800, boxShadow: '0 8px 20px rgba(0,0,0,0.3)', cursor: 'pointer', zIndex: 5 }}
        >
          Transfer &rarr;
        </button>
      )}
    </div>
  );
}

const circleBtnStyle: CSSProperties = {
  width: 32, height: 32, borderRadius: '50%', background: '#f1f1f3', border: 'none', fontSize: 16, fontWeight: 700, color: '#555', cursor: 'pointer',
};

function stopMinsAway(arrivalMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((arrivalMs - nowMs) / 60000));
  return mins < 1 ? 'now' : `${mins} min away`;
}
