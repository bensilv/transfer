# Deploying to Vercel

One Vercel project serves both apps: `apps/web` builds as the static site,
`apps/server` runs as a Node serverless function under `/api/*` — wired up by
`vercel.json` at the repo root.

## One-time setup

1. Go to [vercel.com/new](https://vercel.com/new) and import this GitHub repo.
2. **Root Directory**: leave it as `./` (the repo root) — don't point it at
   `apps/web`. `vercel.json` already knows where each app lives.
3. **Framework Preset**: Vercel should detect "Other" / use `vercel.json`
   as-is. You don't need to set a build/output command manually.
4. Click **Deploy**. No environment variables are required — the server
   always fetches MTA's real public GTFS-RT feeds, no API key needed. It
   does need live network access to MTA's servers at request time; there's
   no offline/mock fallback.

The frontend calls its own `/api/*` on the same domain, so there's no
separate API URL to configure.

## After every push to `main`

Nothing to do — Vercel auto-deploys `main` on every push, since that's the
workflow we agreed on (push straight to main, no staging step).

## If the first deploy fails

This was built and tested in a sandbox that has no network access to
Vercel's build infrastructure or to MTA's servers, so the actual Vercel build
step and the live `mta` data path have not been run end-to-end before this
first deploy. If the build fails, paste me the Vercel build log and I'll fix
it — the most likely failure mode is the `@vercel/node` build step not
resolving one of the `.js`-suffixed TypeScript imports in `apps/server/src`
(a known quirk of bundling NodeNext-style ESM TypeScript).

## Verifying live MTA data actually works

Once deployed, open the site and check:

- Screen 1 shows real upcoming arrival times for stations near you.
- If a station shows no arrivals for any line, that line's GTFS-RT feed may
  just be quiet at that moment — retry, or check the Vercel function logs for
  fetch errors. Staten Island Railway stations never show arrivals: none of
  MTA's subway GTFS-RT feeds cover SIR.
