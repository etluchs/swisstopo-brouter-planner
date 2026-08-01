# Topo Route Planner — swisstopo / BEV + BRouter

An in-browser bike route planner that puts a planning layer on top of official
national topographic maps — **Switzerland** (swisstopo) and **Austria** (BEV).
Routing comes from BRouter (OSM), but any leg can be switched to **direct** mode
and traced by hand — so a trail that's visible on the Landeskarte or the
Österreichische Karte but missing from OpenStreetMap can still go into the route.

- **Routed legs** (blue, solid): computed by BRouter over the OSM network.
- **Direct legs** (orange, dashed): straight segments through your own clicks,
  never sent to the router. Drop a chain of them to trace a curve you see on the
  topo raster.

Everything runs client-side: Leaflet + national raster tiles + a BRouter HTTP
endpoint. No build step.

## Regions

Pick the country at the top of the panel. A region bundles the projection, the
rasters, the elevation model and the point-info service; the waypoints are plain
WGS84 and survive a switch untouched.

| | Switzerland | Austria |
| --- | --- | --- |
| Projection | LV95 / EPSG:2056 (native Swiss grid) | Web Mercator / EPSG:3857 |
| Topo base | swisstopo Landeskarte (`pixelkarte-farbe`) | BEV [Austrian Map](https://maps.bev.gv.at) (ÖK), published to z16 |
| Aerial | swisstopo SWISSIMAGE | basemap.at orthophoto 30 cm |
| Terrain | — | basemap.at relief (`bmapgelaende`) |
| Overlays | Veloland, mountain-bike routes, public-transport stops | basemap.at labels & boundaries |
| Elevation | swissAlti3D via `api3.geo.admin.ch/profile.json` | BEV `transformator` height API |
| Right-click | multi-layer swisstopo identify (+ SchweizMobil links) | BEV terrain height at the point |

Austria's map renders in plain Web Mercator because that's the grid BEV and
basemap.at publish on; Switzerland keeps the true Swiss projection so it matches
the printed Landeskarte. Leaflet can't change CRS on a live map, so switching
region tears the map down and rebuilds it.

Austria has no public multi-layer identify service, so a right-click there
answers "how high is this point?" from the BEV DEM instead of listing features.
Outside its coverage that API returns 0 for every sample rather than an error —
the app treats an all-zero answer as *no data* rather than as flat ground.

Adding a third country is one entry in `REGIONS` (in `src/app.js`): a CRS, its
rasters, and three adapters — `ascent(a,b)`, `profile(flat)`, `identify(latlng)`.

## Thanks

These are just some vibe-coded (clauded) lines of JS on top of:
  - [BRouter](https://brouter.de)
  - [Swisstopo OGD](https://www.swisstopo.admin.ch/de/kostenlose-geobasisdaten-ogd)
  - [BEV](https://www.bev.gv.at) (Austrian Map, DEM) and
    [basemap.at](https://basemap.at)

## Quick start

### Just use it

Goto [the deployed version](https://etluchs.github.io/swisstopo-brouter-planner/).

### Run from sources

```bash
npm install          # only needed for the tests
npm run dev          # serves the app at http://localhost:5173
```

Open http://localhost:5173, click the map to add points, drag to adjust, click a
leg to insert a point, toggle any leg between Routed/Direct in the sidebar, and
export the result as GPX. On a phone, **Send to phone** hands the GPX straight to
your share sheet (e.g. Garmin Connect) — no download/upload shuffle.

The route lives in the URL: the address bar updates as you edit (region,
waypoints and routing profile, encoded in the `#…` hash), so you can **bookmark
or share a link that reopens the exact route**. **Copy link** puts that URL on
your clipboard. The hash stays client-side, so coordinates never hit a server.
Switzerland is the default and stays implicit (`#p=…&w=…`), so links made before
regions existed still open; Austria adds `r=at` up front (`#r=at&p=…&w=…`).

> The app itself needs no install — `index.html` is static. `npm install` only
> pulls Playwright for the test suite.

## Routing backend

The **BRouter endpoint** field defaults to the public host
`https://brouter.de/brouter`, which is fine for a quick look but may reject
cross-origin calls. For real use, self-host — it's a single container:

```bash
# download the segment files you need into ./segments4 first
# (from https://brouter.de/brouter/segments4/):
#   Switzerland  E5_N45.rd5
#   Austria      E5_N45.rd5, E10_N45.rd5, E15_N45.rd5
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
the correct swisstopo LV95 URL shape, the warning shown when tiles 404,
click-to-add, routed-leg → BRouter call + drawn path, direct-leg → dashed path
with **no** BRouter call + swissAlti3D ascent, leg toggling, and clear.

An `Austria (BEV)` block covers the second region end to end: the BEV `z/x/y`
tile shape, basemap.at's `z/y/x` orthophoto, direct-leg ascent from the BEV
height API (including the all-zero "outside coverage" case), the terrain-height
popup, the basemap.at overlay, `r=at` in the hash, and that a region switch
keeps the waypoints.

There's also an **opt-in smoke test** that hits the live swisstopo endpoint —
useful for confirming tiles actually load in a real browser (the thing a
sandboxed preview can block):

```bash
npm run test:smoke   # sets E2E_NETWORK=1; skipped otherwise
```

## Why tiles may look gray in some embeds

If you drop `index.html` into a sandboxed iframe/preview that blocks third-party
image requests, the tiles go gray even though the URLs are correct — the
swisstopo and BEV tiles are external. Served from a normal origin (`npm run
dev`, GitHub Pages, your own host) they load fine. The `test:smoke` test exists
to prove exactly that. (The Swiss map renders in the native grid
LV95/EPSG:2056, so there's no Web-Mercator OpenTopoMap fallback — a mixed
projection couldn't align.)

## Layout

```
index.html              app shell + CDN Leaflet + referrer policy
src/styles.css          cartographic UI styling
src/app.js              REGIONS config, map lifecycle, waypoint/leg state,
                        per-leg routing, national DEM adapters, GPX export
server.mjs              zero-dependency static server for dev + tests
tests/planner.spec.js   deterministic UI tests (tiles + BRouter stubbed)
tests/smoke.spec.js     opt-in live-swisstopo check
playwright.config.js    boots server.mjs as webServer
.github/workflows/ci.yml runs the suite on push/PR
```

## Attribution & terms

Base maps © swisstopo (CH) and © BEV / © basemap.at (AT) — keep the credits
(already wired into the tile layers). swisstopo's WMTS is free for public
geodata but discourages heavy scraping; basemap.at is CC BY 4.0 and BEV's open
data is CC BY 4.0. Review each service's terms for production volume. Routing
data © OpenStreetMap contributors (via BRouter). Elevation © swisstopo
(swissAlti3D) and © BEV.

## Possible next steps

- Single-call BRouter batching (`straight=` indices) to cut request *count* — the
  routed legs already fetch concurrently, so this is about server load, and it
  trades against the per-leg interaction model (toggle/highlight/elevation).
- More overlays, per-overlay opacity, remembering toggles, or a searchable
  picker over the full national catalogue (the overlay panel ships with a
  curated set per region).
- Pick the region automatically from where the first waypoint lands, instead of
  leaving it an explicit choice.
- A cycling-route overlay for Austria — the national datasets are on data.gv.at
  but there's no ready-made nationwide tile service to point at.
