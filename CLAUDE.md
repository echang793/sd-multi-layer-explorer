# SD Multi-Layer Explorer

## Purpose
Single-file interactive map of San Diego. It covers microclimates and the marine layer, plus taco/brewery crawls, built on a plugin `LayerRegistry`. Personal use (Eric), local only.

## Stack
- Plain HTML/CSS/JS in one file, with no build step.
- CDN libraries:
  - Leaflet 1.9.4 (unpkg)
  - Chart.js 4.4.7 and Lucide 0.469.0 (jsdelivr)
  - Tailwind Play CDN
  - Google Fonts (Inter, JetBrains Mono)
- Tests: Node 25 built-in `node:test`, with no npm dependencies.

## Entry points
- `src/index.html` is the whole app. It has two inline scripts:
  - `<script id="sdx-engine">`: data, climate/geo math, filters, `EventBus` and `ModuleRegistry`. No DOM. Tests load this block through `node:vm`.
  - `<script id="sdx-app">`: the Leaflet/Chart.js shell (`App`, `ModuleHost`), Module 1 (Microclimates), Module 2 (Tacos & Brews), and the Module 3 template (Surf, only with `?surf=1`).

## Commands
```bash
# run (static server; open http://127.0.0.1:8105/)
npm run serve
# test
npm test
# lint (syntax-checks inline scripts, duplicate ids, literal NaN/undefined)
npm run lint
# refresh county-wide breweries + taco shops from OpenStreetMap (rewrites the POI-DATA block)
node scripts/fetch-pois.mjs          # add --dry-run to only report counts
```

## Architecture
- Adding a module means one `LayerRegistry.registerModule({...})` call. Core never names a module id.
- `ModuleHost.call()` passes `(el, ctx)` to `renderControls`/`renderSidebar`, and `(ctx, ...args)` to every other hook.
- Core owns `ctx.layer` (it adds the layer, then fades it out and clears it on deactivate). Charts made with `ctx.chart()` are destroyed automatically when focus changes.
- Microclimates tracks two hours:
  - `state.hour` is the target. It's mutated in place by the slider and play.
  - `display` is the eased hour that actually gets drawn. It advances in the shared rAF loop (`onFrame`).
- Tacos & Brews data is about 365 real spots (93 breweries, 272 taco shops) from OSM Overpass.
  - It's baked into `POI_ROWS` between the `POI-DATA:BEGIN/END` markers.
  - Chains are excluded in `CHAINS`. Non-beer places (kombucha, cider, mead, spirits, bars that only pour) are excluded in `NOT_BREWERY`, and mis-tagged non-taco spots in `NOT_TACO`.
  - Duplicates are merged when they share a name prefix within 60 m.
  - A spot's `hood` is the city from its street address when that matches a known area, otherwise the nearest neighborhood center. Popups show `SDX.placeLabel()`.
  - Popups show only tags that are true (`SDX.tags.activeLabels`).
  - 24/7 and seafood come from OSM tags. Hazy IPA is a simulated stable hash.
- Pins live in a `L.markerClusterGroup`, which recreates marker DOM as clusters split and merge.
  - Pin visual state is stored on the pin object and re-applied in `m.on('add')`.
  - An active crawl's pins are moved out of the cluster (`pinOut`/`pinBack`).
- Neighborhoods have a `tier`. Tier-2 temperature markers fade out below zoom 11 (the `mc-far` class) so the county view stays readable.
- Microclimates broadcasts `bus.emit('clock', {hour})`. Late subscribers read `bus.last('clock')`.
- Microclimates `state.source` is `sim` or `live`.
  - Live mode fetches NWS `/points` → raw `/gridpoints` for each of the 38 areas, 4 requests at a time.
  - It caches in localStorage: the point→grid mapping for 7 days, the grid data for 1 hour.
  - An area whose fetch fails shows "—" and is never filled with simulated numbers. If every fetch fails, the app shows a toast and falls back to `sim`.
  - In live mode the fog shape is driven by coastal sky cover. To test failures, set `window.SDXDebug = { nwsBase: 'bad url' }`.
- Microclimates `state.metric` is `temp` or `rh`.
- All time-of-day logic uses San Diego time through `SDX.time`, never the device clock or timezone:
  - `fromPacific`, `parts`, `hour`, `dayStartMs`, `dayKey`.
  - This covers the clock, "today" for NWS, Open Now and popup hours.
  - Tests build dates with `SDX.time.fromPacific`, and one test runs under `TZ=Asia/Tokyo`.
- Microclimates `state.follow` (default true) keeps the clock on real San Diego time, re-read about once a second. Dragging the slider, arrow keys or Play turn it off; Now turns it back on.
- Live NWS refreshes in the background while live mode is on:
  - It checks every minute and when the tab becomes visible.
  - It refetches when the data is an hour old or the San Diego day has changed.
  - The old data stays on screen until the new data arrives. A failed refresh keeps the old data and shows a toast.
  - `window.SDXDebugLive.expire()` forces a refresh for testing.
- Tacos & Brews `state` also has:
  - `radiusMi`: the walk radius, driving Crawlable and crawl routes.
  - `me` / `nearMi`: Near Me. Location comes from browser geolocation, which needs localhost or https.
  - `view`: `pins` or `heat`. The heat layer is created on first use.
- The visible-spots memo is keyed on the filters object plus radius, your location and the current minute (for Open Now).
- `SDX.hours` reads OSM opening_hours. All 101 hour strings in the data parse. Anything unrecognized returns null ("Hours unknown"), and Open Now dims those spots instead of hiding them.
- Marine-layer fog uses two SVG panes (`fog`, `fogtex`):
  - Geometry repaints only when `fogFactor` changes.
  - Drift and breathing are CSS transform/opacity animations on the panes (compositor-only).

## Live sky & sea (Microclimates)
- All sources are free, keyless and CORS-open. They are fetched in the `LiveSky` data layer (app block) with a 12 s timeout and a poll/back-off (10 min after a failure). A source that is down shows "unavailable"; nothing is ever filled with simulated numbers.
  - Alerts: NWS `alerts/active?point=` at 3 points (coast, valleys, mountains), every 10 min. `SDX.alerts.relevant` keeps heat/fog/surf/wind/fire/flood/air-quality events and drops expired ones; `group` folds per-zone duplicates.
  - Station readings: NWS `stations/{id}/observations/latest` for 10 airports (`SDX.obs.STATIONS`). The ± chip compares with the NWS forecast grid of the nearest area at the reading's hour, so it only appears with Data = Live.
  - Sea & air: NOAA CO-OPS 9410230 (La Jolla water temp), Open-Meteo marine (waves, period) and air-quality (US AQI). Open-Meteo's free API is for non-commercial use.
  - Satellite: NASA GIBS `GOES-West_ABI_GeoColor`. The newest frame time comes from the layer's WMTS capabilities `<Default>`, then one tile is probed (GIBS 404s for frames it doesn't have). 8 frames, 40 min apart, crossfaded by opacity in the `sat` pane. Frames are typically 1-1.5 h behind real time and the label says so. It's an IR image at night.
  - Radar: NEXRAD composite tiles from Iowa State (`mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913[-mNNm]`): the live frame plus five 10-minute-old ones, crossfaded in the `radar` pane. The "rain over the county" line is computed from the tiles themselves (echo pixels inside the county box now vs 30 min ago, `SDX.radar.*`), and is polled every 5 min while Microclimates is active even if the layer is off. It reports radar echoes only; it does not predict arrival or speed of a storm.
  - Alert types kept by `SDX.alerts.relevant` (`ALERT_RE`) include tropical/hurricane/storm (thunderstorm, winter, surge), freeze/frost and winter weather, besides heat/fog/surf/wind/fire/flood/air quality.
  - Satellite probe starts one frame back from GIBS's advertised newest (that frame's tiles often 404, which also logs a console error) and walks back up to an hour.
  - Wind: from the same NWS grid fetch as temperature (`windSpeed`/`windDirection`), so wind needs Data = Live (turning Wind on switches it). Grid cache key is `sdx.nws.grid2.*`.
  - "Clears around…" in the marine card comes from `SDX.nws.clearingHour` on the coastal average sky cover.
- Not used on purpose: NDBC buoy text (no CORS), Yelp/Google ratings (paid).
- Test a failure with `window.SDXDebug = { fail: ['alerts', 'obs', 'sea', 'air', 'sat'] }` (set before load).
- The sun-following basemap brightness is a CSS variable (`--tile-b`) on the map container, set only while Microclimates is focused with the tint on.

## Crawls, URL state, install
- `SDX.crawl.arrival(stops, startAt)` checks every crawl stop's hours at the time you'd arrive (`open` is `true`/`false`/`null`; `tight` = closes within 30 min of arrival). `SDX.crawl.status` drives the closing/opening-soon pin badges (within 45 min). Routes to stops that will be closed are drawn red.
- The address-bar hash is the shareable state (`SDX.urlstate`: `t` tab, `h` hour, `src`, `m`, `l` layers, `a` area, `f` filters, `r` radius, `v` view, `s` shared crawl). `decode` clamps and whitelists everything and never throws. The app rewrites the hash about once a second via `replaceState`; pasting a different hash reloads. Near Me is deliberately not shared.
- `sw.js` + `manifest.webmanifest` make it installable. The service worker caches only the shell and CDN libraries; live data is never cached, so offline the data panels say "unavailable". Bump `VERSION` in `sw.js` if the cache strategy changes (HTML is network-first, so normal deploys need no bump).
- On phones the dock is a bottom sheet with three stops (peek/half/full), moved with transform only. `App.flyTo` pads by the visible part of the dock (`--sheet-y`).

## CI
- `.github/workflows/pages.yml`: tests (also under `TZ=Asia/Tokyo`) and lint must pass before deploy; PRs run the tests but don't deploy.
- `.github/workflows/refresh-pois.yml`: monthly Overpass pull that opens a PR (never pushes to main). A PR created with `GITHUB_TOKEN` needs the repo setting Actions → General → "Allow GitHub Actions to create and approve pull requests".

## Gotchas
- CARTO basemaps need a free per-person API key since 2026-09-23. Without one, tiles show an "API KEY REQUIRED" watermark while still returning HTTP 200.
  - The key is saved from the map-icon popover into localStorage `sdx.cartoKey`. Never hardcode it.
  - With no key, the app falls back to OSM tiles darkened with CSS (`.tiles-osm-dark`).
- leaflet.heat logs a Canvas2D "willReadFrequently" performance warning once the heatmap is shown. It's third-party and harmless.
- Tailwind Play CDN logs a console warning ("should not be used in production"). This is expected, not an error.
- Tailwind preflight sets `img{max-width:100%}`, which breaks Leaflet tiles. It's overridden in CSS, so keep that override.
- Tests compare engine arrays created inside the vm context. Copy them with `Array.from` before `deepEqual`, because cross-realm prototypes differ.
- The Claude browser pane can't run `file://` pages, so serve over HTTP. Screenshots from its emulated viewports are scaled wrong, so use headless Chrome over CDP for full-resolution checks.

- Overpass often returns 504. `fetch-pois.mjs` retries, then tries a mirror, and exits non-zero without writing if the data is short.
- OSM has only 3 East County breweries mapped. That's an upstream data gap, not a filter bug.
- OSM can be stale. A few brewery pairs 13–26 m apart (Eppig/Pariah, North Pine/Rough Draft) may be a closed business plus its replacement. Fix these in OSM, not by hand here.

## Do NOT touch
- Don't hand-edit the `POI-DATA` block. Rerun the fetch script instead.
- The `<script id="sdx-engine">` block must stay DOM-free and must not contain a literal closing script tag. The tests regex-extract it.
- The 500-line file rule is waived here on purpose, because the spec requires a single file.
