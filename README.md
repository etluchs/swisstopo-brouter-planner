# Topo Route Planner — swisstopo + BRouter

An in-browser bike route planner that puts a planning layer on top of the
official swisstopo topographic maps. Routing comes from BRouter (OSM), but any
leg can be switched to **direct** mode and traced by hand — so a trail that's
visible on the Landeskarte but missing from OpenStreetMap can still go into the
route.

- **Routed legs** (blue, solid): computed by BRouter over the OSM network.
- **Direct legs** (orange, dashed): straight segments through your own clicks,
  never sent to the router. Drop a chain of them to trace a curve you see on the
  topo raster.

Everything runs client-side: Leaflet + swisstopo raster tiles + a BRouter HTTP
endpoint. No build step.

## Quick start

```bash
npm install          # only needed for the tests
npm run dev          # serves the app at http://localhost:5173
```

Open http://localhost:5173, click the map to add points, drag to adjust, click a
leg to insert a point, toggle any leg between Routed/Direct in the sidebar, and
export the result as GPX.

> The app itself needs no install — `index.html` is static. `npm install` only
> pulls Playwright for the test suite.

## Routing backend

The **BRouter endpoint** field defaults to the public host
`https://brouter.de/brouter`, which is fine for a quick look but may reject
cross-origin calls. For real use, self-host — it's a single container:

```bash
# download Switzerland segment files into ./segments4 first
# (E5_N45.rd5 etc. from https://brouter.de/brouter/segments4/)
docker run --rm -p 17777:17777 -v ./segments4:/segments4 brouter
```

Then set the endpoint to `http://localhost:17777/brouter`. Profiles
(`trekking`, `fastbike`, `gravel`, `mtb`, `shortest`) must exist on the server.

## Tests

Playwright drives a real Chromium. The core suite stubs both the tiles and the
BRouter response, so it's deterministic and needs no network:

```bash
npm test             # headless
npm run test:headed  # watch it click
npm run test:ui      # interactive runner
npm run report       # open the last HTML report
```

`tests/planner.spec.js` covers: Leaflet bootstrap, that tiles are requested with
the correct swisstopo URL shape, the OpenTopoMap fallback when tiles 404,
click-to-add, routed-leg → BRouter call + drawn path, direct-leg → dashed path
with **no** BRouter call, leg toggling, and clear.

There's also an **opt-in smoke test** that hits the live swisstopo endpoint —
useful for confirming tiles actually load in a real browser (the thing a
sandboxed preview can block):

```bash
npm run test:smoke   # sets E2E_NETWORK=1; skipped otherwise
```

## Why tiles may look gray in some embeds

If you drop `index.html` into a sandboxed iframe/preview that blocks third-party
image requests, the tiles go gray even though the URLs are correct — both
swisstopo and the OpenTopoMap fallback are external. Served from a normal origin
(`npm run dev`, GitHub Pages, your own host) the swisstopo Landeskarte loads
fine. The `test:smoke` test exists to prove exactly that.

## Layout

```
index.html              app shell + CDN Leaflet + referrer policy
src/styles.css          cartographic UI styling
src/app.js              map, waypoint/leg state, per-leg routing, GPX export
server.mjs              zero-dependency static server for dev + tests
tests/planner.spec.js   deterministic UI tests (tiles + BRouter stubbed)
tests/smoke.spec.js     opt-in live-swisstopo check
playwright.config.js    boots server.mjs as webServer
.github/workflows/ci.yml runs the suite on push/PR
```

## Attribution & terms

Base maps © swisstopo — keep the credit (already wired into the tile layer).
swisstopo's WMTS is free for public geodata but discourages heavy scraping;
review their terms of use for production volume. Routing data © OpenStreetMap
contributors. OpenTopoMap fallback is CC-BY-SA.

## Possible next steps

- Elevation on direct legs by sampling swissAlti3D (swisstopo DEM height query).
- Batch consecutive routed points into one BRouter call with `straight=` indices
  for the direct ones, instead of one request per leg.
- Native Swiss projection (LV95 / EPSG:2056) via proj4 if you want the true grid.
- Deploy to GitHub Pages (it's fully static).
