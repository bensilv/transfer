import { useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';

// Below this flick speed (px/ms) at pointer-up, we snap to whichever point is
// nearest rather than treating it as an intentional flick.
const FLICK_VELOCITY_PX_PER_MS = 0.35;
// Only the last this-many-ms of pointer movement count toward the flick
// velocity, so a fast flick at the very end of a slow drag still registers.
const VELOCITY_WINDOW_MS = 120;
// How far a gesture has to travel before it commits to dragging the sheet
// (rather than scrolling content or being a plain tap). Small enough that the
// sheet feels immediate, large enough that tapping a button inside it is still
// unambiguously a tap.
const DRAG_THRESHOLD_PX = 4;
// Pulling above the tallest snap point keeps responding, just less and less,
// instead of feeling like it hit a wall.
const OVERSHOOT_MAX_PX = 40;
const OVERSHOOT_FOLLOW = 0.4;

/** Total height of the handle row, fixed so callers can compute a "just the handle plus X" snap point precisely. */
export const SHEET_HANDLE_HEIGHT_PX = 24;

/** Settle animation after a drag/snap. Exported because the map animates its
 * own "you are here" dot against exactly this curve — the two have to move in
 * lockstep or the dot visibly slides across the map as the sheet resizes. */
export const SHEET_SETTLE_MS = 320;
export const SHEET_SETTLE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface BottomSheetHandle {
  /** Animate to a snap point by index (e.g. collapse the sheet after a selection). */
  snapTo: (index: number) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startHeight: number;
  /** The scrollable region the gesture started inside, if any. */
  scrollEl: HTMLElement | null;
  fromHandle: boolean;
  decided: 'pending' | 'dragging' | 'scrolling';
  /** Whether the sheet actually moved — distinguishes a drag from a tap. */
  moved: boolean;
  samples: { t: number; y: number }[];
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
  /** Fires with the sheet's *resting* height (px) — on mount, and once a drag
   * or snap change settles. Deliberately not per-frame during a drag: the map
   * behind the sheet reacts to this, and re-rendering it 60x a second is what
   * makes the drag itself feel heavy. */
  onHeightChange?: (heightPx: number) => void;
  handleRef?: React.Ref<BottomSheetHandle>;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const maxIndex = snapPoints.length - 1;
  const targetHeight = snapPoints[activeSnap] ?? snapPoints[maxIndex];
  const [heightPx, setHeightPx] = useState(targetHeight);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const dragRef = useRef<DragState | null>(null);
  // Mirror of heightPx in a ref so endDrag can read the current value without
  // relying on the state-updater form (calling onSnapChange inside a state
  // updater triggers React's "update during render" warning).
  const heightPxRef = useRef(targetHeight);
  // Stable refs so event-handler closures always see the latest values without
  // being listed as reactive deps (which would cause stale-closure issues).
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;
  const snapPointsRef = useRef(snapPoints);
  snapPointsRef.current = snapPoints;
  // Set when a gesture actually moved the sheet, so the click the browser
  // synthesises at pointer-up doesn't also activate whatever button the drag
  // happened to start on top of.
  const suppressClickRef = useRef(false);
  // Pointer moves can arrive faster than the display refreshes (and coalesced
  // events make that worse), so the height is applied once per frame.
  const frameRef = useRef(0);
  const latestYRef = useRef(0);

  // Stable identities for add/removeEventListener that always run whichever
  // version of the handler the latest render produced.
  const moveRef = useRef<(e: PointerEvent) => void>(() => {});
  const endRef = useRef<(e: PointerEvent) => void>(() => {});
  const stableMove = useRef((e: PointerEvent) => moveRef.current(e)).current;
  const stableEnd = useRef((e: PointerEvent) => endRef.current(e)).current;
  const detachGestureListeners = useRef(() => {
    window.removeEventListener('pointermove', stableMove);
    window.removeEventListener('pointerup', stableEnd);
    window.removeEventListener('pointercancel', stableEnd);
  }).current;

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

  // touch-action alone can be raced by the browser when a gesture starts on a
  // region that *is* pannable (the horizontal station strip, the stop list).
  // Once we've claimed the gesture, hard-cancel any native scroll or
  // overscroll — this is what stops the page itself from moving underneath.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stopNativeScroll = (ev: TouchEvent) => {
      if (dragRef.current?.decided === 'dragging' && ev.cancelable) ev.preventDefault();
    };
    el.addEventListener('touchmove', stopNativeScroll, { passive: false });
    return () => el.removeEventListener('touchmove', stopNativeScroll);
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      detachGestureListeners();
    },
    [detachGestureListeners],
  );

  useImperativeHandle(handleRef, () => ({
    snapTo: (index: number) => {
      dragRef.current = null;
      detachGestureListeners();
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      setDragging(false);
      onSnapChange(index);
    },
  }));

  const nearestSnapIndex = (h: number, velocity: number): number => {
    // A decisive flick carries on to the next snap point past where the finger
    // let go, rather than stepping from whichever point happens to be nearest —
    // with three snap points, stepping from "nearest" can vault clean over the
    // middle one when the release lands just short of it.
    if (Math.abs(velocity) >= FLICK_VELOCITY_PX_PER_MS) {
      if (velocity > 0) {
        // Dragging down shrinks the sheet: the tallest snap point below here.
        for (let i = maxIndex; i >= 0; i--) if (snapPoints[i] < h - 1) return i;
        return 0;
      }
      for (let i = 0; i <= maxIndex; i++) if (snapPoints[i] > h + 1) return i;
      return maxIndex;
    }
    return snapPoints.reduce((bestI, p, i) => (Math.abs(p - h) < Math.abs(snapPoints[bestI] - h) ? i : bestI), 0);
  };

  /** Finger delta → sheet height, hard-stopped at the shortest snap point and
   * rubber-banded past the tallest one. */
  const heightForDelta = (drag: DragState, dy: number): number => {
    const sp = snapPointsRef.current;
    const min = sp[0];
    const max = sp[sp.length - 1];
    const raw = drag.startHeight - dy;
    if (raw > max) return max + Math.min(OVERSHOOT_MAX_PX, (raw - max) * OVERSHOOT_FOLLOW);
    return Math.max(min, raw);
  };

  const claimGesture = (startHeight: number) => {
    heightPxRef.current = startHeight;
    setHeightPx(startHeight);
    setDragging(true);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dragRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-sheet-nodrag]')) return;

    // Measure the live height instead of trusting state, so grabbing the sheet
    // mid-settle picks it up exactly where it is rather than jumping.
    const startHeight = rootRef.current?.getBoundingClientRect().height ?? heightPxRef.current;
    const fromHandle = !!target.closest('[data-sheet-handle]');

    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startHeight,
      scrollEl: target.closest<HTMLElement>('[data-sheet-scroll]'),
      fromHandle,
      // The handle exists to be dragged, so it never has to win a fight with
      // anything — it takes the gesture on contact.
      decided: fromHandle ? 'dragging' : 'pending',
      moved: false,
      samples: [{ t: performance.now(), y: e.clientY }],
    };
    // Track the rest of the gesture on the window rather than through React's
    // bubbling: a drag that starts on the sheet routinely ends up with the
    // pointer out over the map, and those moves have to keep counting.
    window.addEventListener('pointermove', stableMove, { passive: false });
    window.addEventListener('pointerup', stableEnd);
    window.addEventListener('pointercancel', stableEnd);
    if (fromHandle) claimGesture(startHeight);
  };

  const onPointerMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.decided === 'pending') {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      // A mostly-sideways gesture belongs to whatever horizontal strip it
      // started on (the station picker, the arrivals row), not to the sheet.
      if (Math.abs(dx) > Math.abs(dy)) {
        drag.decided = 'scrolling';
        return;
      }
      // Inside scrollable content the sheet takes the gesture only from the
      // content's top edge: pulling down from there shrinks the sheet, and
      // pushing up from there grows it while a taller snap point is still
      // available — so the sheet opens fully before its contents start
      // scrolling, rather than the gesture being swallowed by a list that
      // takes up most of the sheet. Once the content is scrolled, or there's
      // nothing taller to grow into, it's an ordinary scroll. Anywhere else in
      // the sheet — the handle, headers, toggles, the station strip — every
      // vertical drag moves the sheet.
      const scrollEl = drag.scrollEl;
      const canScroll = !!scrollEl && scrollEl.scrollHeight - scrollEl.clientHeight > 1;
      const atTopOfContent = !!scrollEl && scrollEl.scrollTop <= 0;
      const growsSheet = dy < 0 && activeSnap < maxIndex;
      if (canScroll && !(atTopOfContent && (dy > 0 || growsSheet))) {
        drag.decided = 'scrolling';
        return;
      }
      drag.decided = 'dragging';
      claimGesture(drag.startHeight);
    }

    if (drag.decided !== 'dragging') return;
    if (e.cancelable) e.preventDefault();
    if (Math.abs(dy) > DRAG_THRESHOLD_PX) drag.moved = true;

    const now = performance.now();
    drag.samples.push({ t: now, y: e.clientY });
    while (drag.samples.length > 1 && now - drag.samples[0].t > VELOCITY_WINDOW_MS) drag.samples.shift();

    latestYRef.current = e.clientY;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const d = dragRef.current;
      if (!d || d.decided !== 'dragging') return;
      const h = heightForDelta(d, latestYRef.current - d.startY);
      heightPxRef.current = h;
      setHeightPx(h);
    });
  };

  const settleOn = (idx: number) => {
    const snapped = snapPointsRef.current[idx];
    heightPxRef.current = snapped;
    setHeightPx(snapped);
    onHeightChangeRef.current?.(snapped);
    onSnapChange(idx);
  };

  const endDrag = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    detachGestureListeners();
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    if (drag.decided !== 'dragging') return;
    setDragging(false);
    suppressClickRef.current = drag.moved;

    // Tapping the handle without moving cycles snap points, so the sheet can be
    // opened and closed without a drag at all.
    if (!drag.moved) {
      if (drag.fromHandle) settleOn(activeSnap >= maxIndex ? 0 : activeSnap + 1);
      // A twitch just under the threshold elsewhere: leave the sheet be.
      else setHeightPx(heightPxRef.current);
      return;
    }

    // Include the release point: a finger that paused before lifting has
    // stopped, however fast it was travelling a moment earlier.
    const now = performance.now();
    drag.samples.push({ t: now, y: e.clientY });
    while (drag.samples.length > 1 && now - drag.samples[0].t > VELOCITY_WINDOW_MS) drag.samples.shift();
    const first = drag.samples[0];
    const last = drag.samples[drag.samples.length - 1];
    const dt = last.t - first.t;
    const velocity = dt > 0 ? (last.y - first.y) / dt : 0; // px/ms, positive = moving down

    // Derive the release height from the release point rather than from the
    // last frame we painted: a quick flick can start and finish inside a single
    // frame, and snapping off a height the sheet never reached sends it back
    // where it came from.
    const sp = snapPointsRef.current;
    const released = heightForDelta(drag, e.clientY - drag.startY);
    const clamped = Math.max(sp[0], Math.min(sp[sp.length - 1], released));
    settleOn(nearestSnapIndex(clamped, velocity));
  };

  moveRef.current = onPointerMove;
  endRef.current = endDrag;

  const onClickCapture = (e: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
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
        // Keeps content clipped to the rounded top corners while it resizes.
        overflow: 'hidden',
        // Set unconditionally, not just while dragging: touch-action is latched
        // when the gesture *starts*, so flipping it once a drag is underway (as
        // this used to) is always too late to stop the browser panning.
        touchAction: 'manipulation',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        transition: dragging ? 'none' : `height ${SHEET_SETTLE_MS}ms ${SHEET_SETTLE_EASING}`,
      }}
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
    >
      <div
        data-sheet-handle
        style={{
          flexShrink: 0,
          height: SHEET_HANDLE_HEIGHT_PX,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      >
        <div style={{ width: 40, height: 5, borderRadius: 3, background: '#d0d0d5' }} />
      </div>
      {children}
    </div>
  );
}
