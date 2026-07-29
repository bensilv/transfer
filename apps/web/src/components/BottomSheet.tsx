import { useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';

// Below this flick speed (px/ms) at pointer-up, we snap to whichever point is
// nearest rather than treating it as an intentional flick.
const FLICK_VELOCITY_PX_PER_MS = 0.5;
// Only the last this-many-ms of pointer movement count toward the flick
// velocity, so a fast flick at the very end of a slow drag still registers.
const VELOCITY_WINDOW_MS = 120;
// A drag must move at least this far before it's allowed to steal the
// gesture from a scrollable content region (see the scroll/drag note below).
const CONTENT_DRAG_THRESHOLD_PX = 6;

/** Total height of the handle row, fixed so callers can compute a "just the handle plus X" snap point precisely. */
export const SHEET_HANDLE_HEIGHT_PX = 24;

export interface BottomSheetHandle {
  /** Animate to a snap point by index (e.g. collapse the sheet after a selection). */
  snapTo: (index: number) => void;
}

export function BottomSheet({
  snapPoints,
  activeSnap,
  onSnapChange,
  onHeightChange,
  handleRef,
  className,
  style,
  children,
}: {
  /** Sheet heights in px, ascending (e.g. [96, 420, windowHeight]). */
  snapPoints: number[];
  /** Controlled current snap index. */
  activeSnap: number;
  onSnapChange: (index: number) => void;
  /** Fires continuously with the live height (px) during drag/animation — e.g. so the map can keep its "you are here" dot above the sheet. */
  onHeightChange?: (heightPx: number) => void;
  handleRef?: React.Ref<BottomSheetHandle>;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const targetHeight = snapPoints[activeSnap] ?? snapPoints[snapPoints.length - 1];
  const [heightPx, setHeightPx] = useState(targetHeight);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    scrollEl: HTMLElement | null;
    decided: 'pending' | 'dragging' | 'scrolling';
    samples: { t: number; y: number }[];
  } | null>(null);
  // Mirror of heightPx in a ref so endDrag can read the current value without
  // relying on the state-updater form (calling onSnapChange inside a state
  // updater triggers React's "update during render" warning).
  const heightPxRef = useRef(targetHeight);
  // Stable ref so event-handler closures always call the latest version without
  // being listed as reactive deps (which would cause stale-closure issues).
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;

  // Animate toward the controlled snap point whenever it changes and we're
  // not mid-drag (a drag's own pointer-up already lands exactly on target).
  useEffect(() => {
    if (dragRef.current) return;
    heightPxRef.current = targetHeight;
    setHeightPx(targetHeight);
    // Defer onHeightChange past the current render cycle: React strict-mode
    // double-invocation can make the synchronous call appear to happen "during
    // rendering", even though it's inside an effect.  A microtask still runs
    // before the browser paints, so the map obstructedBottomPx stays in sync.
    const cb = onHeightChangeRef.current;
    if (cb) queueMicrotask(() => cb(targetHeight));
  }, [targetHeight]);

  useImperativeHandle(handleRef, () => ({
    snapTo: (index: number) => {
      dragRef.current = null;
      setDragging(false);
      onSnapChange(index);
    },
  }));

  const nearestSnapIndex = (h: number, velocity: number): number => {
    // A decisive flick moves to the adjacent snap point in that direction
    // even if the sheet hasn't visually reached it yet.
    if (Math.abs(velocity) >= FLICK_VELOCITY_PX_PER_MS) {
      const dir = velocity > 0 ? -1 : 1; // dragging down (positive dy) shrinks height
      const current = snapPoints.reduce(
        (bestI, p, i) => (Math.abs(p - h) < Math.abs(snapPoints[bestI] - h) ? i : bestI),
        0,
      );
      return Math.max(0, Math.min(snapPoints.length - 1, current + dir));
    }
    return snapPoints.reduce((bestI, p, i) => (Math.abs(p - h) < Math.abs(snapPoints[bestI] - h) ? i : bestI), 0);
  };

  const beginDrag = (e: React.PointerEvent, scrollEl: HTMLElement | null, decided: 'pending' | 'dragging') => {
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: heightPx,
      scrollEl,
      decided,
      samples: [{ t: performance.now(), y: e.clientY }],
    };
    if (decided === 'dragging') {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDragging(true);
    }
  };

  const onHandlePointerDown = (e: React.PointerEvent) => {
    beginDrag(e, null, 'dragging');
  };

  // Content areas that should scroll instead of dragging the sheet must be
  // marked with data-sheet-scroll. We start in "pending" and only take over
  // the gesture once the user drags down (positive dy) while that region is
  // already scrolled to its top — a natural "pull past the top" handoff,
  // matching iOS-style sheets. Dragging up, or dragging down mid-scroll,
  // always stays a normal scroll.
  const onContentPointerDown = (e: React.PointerEvent) => {
    const scrollEl = (e.target as HTMLElement).closest<HTMLElement>('[data-sheet-scroll]');
    beginDrag(e, scrollEl, 'pending');
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.startY;

    if (drag.decided === 'pending') {
      if (drag.scrollEl && drag.scrollEl.scrollTop > 0) {
        drag.decided = 'scrolling';
        return;
      }
      if (dy <= CONTENT_DRAG_THRESHOLD_PX) {
        // Not enough downward movement yet to claim the gesture; could still
        // become a scroll (upward) or a drag (more downward movement).
        if (dy < -CONTENT_DRAG_THRESHOLD_PX) drag.decided = 'scrolling';
        return;
      }
      drag.decided = 'dragging';
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDragging(true);
    }

    if (drag.decided !== 'dragging') return;
    e.preventDefault();

    const now = performance.now();
    drag.samples.push({ t: now, y: e.clientY });
    while (drag.samples.length > 1 && now - drag.samples[0].t > VELOCITY_WINDOW_MS) drag.samples.shift();

    const min = snapPoints[0];
    const max = snapPoints[snapPoints.length - 1];
    const newH = Math.max(min, Math.min(max, drag.startHeight - dy));
    heightPxRef.current = newH;
    setHeightPx(newH);
    onHeightChangeRef.current?.(newH);
  };

  const endDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (drag.decided !== 'dragging') return;
    setDragging(false);

    const first = drag.samples[0];
    const last = drag.samples[drag.samples.length - 1];
    const dt = last.t - first.t;
    const velocity = dt > 0 ? (last.y - first.y) / dt : 0; // px/ms, positive = moving down

    const idx = nearestSnapIndex(heightPxRef.current, velocity);
    const snapped = snapPoints[idx];
    heightPxRef.current = snapped;
    setHeightPx(snapped);
    onHeightChangeRef.current?.(snapped);
    onSnapChange(idx);
  };

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        // Spread first: layout/positioning below is load-bearing for the drag
        // mechanics, so a caller's `style` (background, borderRadius, shadow)
        // may only add to it, never override it by accident.
        ...style,
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: heightPx,
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        touchAction: dragging ? 'none' : undefined,
        transition: dragging ? 'none' : 'height 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        onPointerDown={onHandlePointerDown}
        style={{
          flexShrink: 0,
          height: SHEET_HANDLE_HEIGHT_PX,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        <div style={{ width: 36, height: 5, borderRadius: 3, background: '#d0d0d5' }} />
      </div>
      <div onPointerDown={onContentPointerDown} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  );
}
