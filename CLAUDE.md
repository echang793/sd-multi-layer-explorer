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
- Marine-layer fog uses two SVG panes (`fog`, `fogtex`):
  - Geometry repaints only when `fogFactor` changes.
  - Drift and breathing are CSS transform/opacity animations on the panes (compositor-only).

## Gotchas
- CARTO basemaps need a free per-person API key since 2026-09-23. Without one, tiles show an "API KEY REQUIRED" watermark while still returning HTTP 200.
  - The key is saved from the map-icon popover into localStorage `sdx.cartoKey`. Never hardcode it.
  - With no key, the app falls back to OSM tiles darkened with CSS (`.tiles-osm-dark`).
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
