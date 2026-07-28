# Business Requirements Document (BRD) — Live Transit Transfer App

## 1. Overview

A mobile-first app for NYC subway riders that shows live transfer options at
every upcoming stop on the train a user is currently riding. The core value:
answer "if I get off here, what's my fastest connection?" in real time, without
requiring the user to plan a route in advance.

**Example use case:** Riding the C train, the app shows that getting off at
West 4th gets an A train in 2 minutes or an F in 3 minutes, while staying to
14th St gets an L train in 5 minutes.

## 2. Goals / Non-Goals

**Goals (v1):**
- Let a user identify their current train quickly and accurately
- Show live, per-stop transfer options with soonest-arrival times
- Let a user "hop" to a new active train by selecting a transfer, with a
  confirm step
- Ship as a mobile-responsive website prototype first

**Non-goals (v1 — explicitly out of scope):**
- Bus support (subway only)
- Service alerts / delay messaging
- Saved/remembered routes or preferences (stateless)
- Native iOS app / Live Activities / lock-screen widgets
- Historical delay-correction modeling
- Multi-city / non-NYC transit systems

## 3. User Flow

### Screen 1 — Home / Nearby Arrivals (map-based)
- Movable map centered on the user's current location (location permission
  required)
- Nearby stations surfaced with a dropdown/panel of upcoming arrivals per line
- Horizontal swipe on a line's panel toggles direction
- Tapping a specific arrival = selecting the active trip (line + direction +
  specific trip_id, in one action) — this is also how direction is
  determined; there's no separate direction-detection logic

### Screen 2 — Active Train / Journey View
- Shows the selected train's remaining stops in sequence
- At each stop: connecting lines with soonest arrival time per line (no
  additional ranking/recommendation — just soonest, per your decision)
- Each stop's transfer options are quickly tappable
- Persistent small element (likely header/footer) showing: last-updated
  timestamp, manual refresh button, and online/offline status dot (see
  Section 6a) — this is the screen most likely to be viewed underground, so
  it's the priority placement for this indicator

### Transfer Selection (state within Screen 2, not a separate screen)
- Tapping a transfer option shows a brief confirm/preview
- On confirm, that trip becomes the new active train, and Screen 2 re-renders
  with the new train's remaining stops/transfers
- This makes Screen 1 and the transfer-confirm interaction the only two ways
  to set the "active train" — same underlying component reused

## 4. Functional Requirements

- **Trip identification:** user selects a specific live trip from a list of
  currently-active trips (via Screen 1's arrival panel) — no manual trip_id
  entry, no GPS-based auto-matching
- **Direction handling:** determined entirely by the selected arrival; manual
  swipe-to-switch available on Screen 1 before selection
- **Transfer computation:** for each remaining stop on the active trip, look
  up connecting lines (static GTFS `transfers.txt`) and pull each one's next
  live arrival after the active train's predicted arrival at that stop
- **Trip hand-off:** selecting + confirming a transfer swaps the active trip
  and refreshes the journey view accordingly
- **No alerts/delay messaging** in v1
- **Fallback behavior when a connecting line has no live GTFS-RT data** —
  open decision, needs to be settled before backend build (options: static
  schedule fallback, "no live data" label, or hide the line)

## 5. Data Requirements

- **Static GTFS:** stops, routes, `transfers.txt` (station-to-line connection
  mapping)
- **GTFS-RT:** `TripUpdate` feeds for the active train and all connecting
  lines at each upcoming stop
- **Scope:** NYC subway only, no API key required per current `nyct-gtfs`
  access
- **Polling interval:** to be defined (target ~15–30s) — affects how "live"
  the UI needs to visually communicate updates

## 6. Non-Functional Requirements

- **Performance:** UI should feel live; refresh/latency target TBD
- **Reliability / offline behavior:** subway connectivity is expected to drop
  frequently mid-journey; the app should degrade gracefully rather than error
  out. See Section 6a for details.
- **Platform:** mobile-responsive website for v1; native iOS considered
  post-prototype

### 6a. Offline / Caching Behavior

Since cell service is unreliable underground, the app should treat "last known
good data" as a normal operating state, not an error state:

- **Local caching:** cache the most recent successful GTFS-RT response
  (active train's stop times + connecting lines' arrival times)
- **Predictive extrapolation while offline:** when a fresh poll fails, don't
  freeze the displayed countdowns — continue counting them down client-side
  based on elapsed time since the last successful fetch, so a "2 min" arrival
  correctly becomes "0 min" / "arriving" rather than staying stuck at "2 min"
  indefinitely. This is an estimate, not live data, and should be visually
  distinguishable (see indicator below).
- **Last updated timestamp:** small, persistent UI element showing when data
  was last successfully refreshed (e.g., "Updated 2 min ago")
- **Manual refresh button:** small button next to the timestamp letting the
  user force a refresh attempt once they regain signal
- **Online/offline status dot:** small green/red indicator — green if the
  last poll succeeded, red if the last poll attempt failed (not necessarily
  the same as device connectivity, since it should reflect actual API
  reachability)
- **Retry behavior:** app should keep attempting background polls on its
  normal interval even while offline, so it recovers automatically the moment
  signal returns, without requiring the manual refresh button (that button is
  a convenience for impatient users, not the only recovery path)

## 7. Open Questions (to resolve before/at mockup stage)

1. Fallback UI when a connecting line has no live data (see Section 4)
2. Confirm-step UI details for transfer hand-off (modal? inline expand? bottom
   sheet?)
3. Polling interval and how visually to indicate "data just refreshed" vs
   "data is stale"
4. What happens if the user's active train nears the end of its route with no
   further transfers — does the app prompt to pick a new train (back to
   Screen 1)?

## 8. Next Steps

- Take this BRD into Claude Design for Screen 1 and Screen 2 mockups
- Resolve Section 7 open questions as part of or before mockup review
- Hand finalized mockups + this BRD to Claude Code for prototype build
