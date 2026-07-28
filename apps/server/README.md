# Transit server

Backend for the transit transfer app. Serves nearby-station arrivals and
per-trip journeys (remaining stops + connecting-line transfer times) over a
small REST API.

Deployed to Vercel, this runs as a serverless function (see root `vercel.json`)
— every request fetches fresh data on demand rather than relying on a
background process, since serverless functions don't have one. Locally it
also runs as a normal long-lived Express server via `npm run dev`.

## Running

```
cp .env.example .env   # optional, defaults are fine for local dev
npm install
npm run dev
```

Listens on `http://localhost:8787` by default.

## Data sources

Set `DATA_SOURCE` in `.env` (or as a Vercel project environment variable):

- **`mock`** (default) — deterministic generated arrivals/journeys, seeded
  from `src/data/stations.ts` and `src/data/schedule.ts`. Needs no network
  access. This is what runs out of the box, and what this was developed
  against (the sandbox this was built in has no network access to MTA).
- **`mta`** — fetches the real public MTA GTFS-RT protobuf feeds on demand
  (see `src/realtime/mtaProvider.ts`), no API key required. The first request
  after a cold start also fetches MTA's static GTFS `stops.txt` and matches
  it against our seeded stations by coordinates (`src/data/gtfsStatic.ts`) to
  resolve their real stop IDs — no hardcoded/guessed IDs. That resolution is
  memoized in memory for the life of the warm serverless instance.

Both providers implement the same `RealtimeProvider` interface
(`src/realtime/types.ts`), so the rest of the app — the transfer-computation
logic and the API layer — doesn't change based on which is active.

## Coverage

Seeded with five real Lower Manhattan / West Village stations (14 St-8 Av,
W 4 St-Wash Sq, Union Sq-14 St, Chambers St, Canal St) rather than the full
~472-station system, to keep the static "GTFS" side of this prototype
hand-maintainable. Extending coverage means adding stations (with real
coordinates) to `src/data/stations.ts` and their line sequences to
`src/data/schedule.ts` (mock mode) — real MTA data then resolves for them
automatically via the coordinate-matching in `gtfsStatic.ts`.

## API

- `GET /api/health` — `{ serverTime, dataSource }`
- `GET /api/stations` — static station list (id, name, lat/lon, lines)
- `GET /api/stations/nearby?direction=downtown|uptown` — Screen 1 data: every
  station with each line's upcoming arrivals in that direction
- `GET /api/journey?tripId=&line=&direction=&boardedStationId=&boardedArrivalMs=`
  — Screen 2 / transfer-preview data: the remaining stops after the boarding
  stop, with each stop's connecting-line transfer options

Each response includes a `status: { online, lastErrorMessage }` reflecting
whether *that specific request's* upstream MTA fetch succeeded (mock mode
always reports online).
