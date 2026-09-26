// Refresh the county-wide brewery + taco-shop dataset from OpenStreetMap (Overpass API)
// and inject it into src/index.html between the POI-DATA markers.
//
//   node scripts/fetch-pois.mjs            # fetch + inject
//   node scripts/fetch-pois.mjs --dry-run  # fetch + report only
//
// Fails loudly (non-zero exit, nothing written) on HTTP errors, Overpass runtime errors,
// or suspiciously small results. Data (c) OpenStreetMap contributors, ODbL.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML = fileURLToPath(new URL('../src/index.html', import.meta.url));
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const MIRROR = 'https://overpass.kumi.systems/api/interpreter';
const MIN_BREWERIES = 50;
const MIN_TACOS = 150;

const QUERY = `[out:json][timeout:120];
area["name"="San Diego County"]["boundary"="administrative"]["admin_level"="6"]->.sd;
(
  nwr["craft"="brewery"](area.sd);
  nwr["microbrewery"="yes"](area.sd);
  nwr["amenity"~"^(bar|pub|restaurant|biergarten)$"]["name"~"Brew(ing|ery|ers|pub)|Beer Co|Ale ?[Ww]orks",i](area.sd);
  nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"taco|mexican"](area.sd);
  nwr["amenity"~"^(restaurant|fast_food)$"]["name"~"taco|taquer",i](area.sd);
);
out center tags;`;

// National / big regional chains: not what a taco-and-brew crawl is for.
const CHAINS = /taco bell|del taco|chipotle|jack in the box|el pollo loco|taco john|qdoba|baja fresh|rubio'?s|wahoo'?s|on the border|chuy'?s|el torito|green burrito|carl'?s|taco cabana|poquito mas|bj'?s|yard house|rock ?bottom|gordon biersch|miller'?s ale/i;

const isBrewery = (t) =>
  t.craft === 'brewery' || t.microbrewery === 'yes' || /brew(ing|ery|ers|pub)|beer co|ale ?works/i.test(t.name || '');
const isTacoShop = (t) =>
  /taco|taquer/i.test(t.name || '') || /taco/.test(t.cuisine || '') ||
  (t.amenity === 'fast_food' && /mexican/.test(t.cuisine || ''));

function fail(msg) {
  console.error(`fetch-pois: ${msg}`);
  process.exit(1);
}

// Overpass is shared and often busy: retry with backoff, then try a public mirror.
async function query() {
  const errors = [];
  for (const [i, url] of [ENDPOINT, ENDPOINT, MIRROR].entries()) {
    if (i) await new Promise((r) => setTimeout(r, 5000 * i));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'sd-multi-layer-explorer/0.1 (personal project)' },
        body: 'data=' + encodeURIComponent(QUERY),
      });
      if (r.ok) return r;
      errors.push(`${url}: HTTP ${r.status}`);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  return fail('all Overpass attempts failed\n  ' + errors.join('\n  '));
}

const res = await query();
const json = await res.json().catch(() => fail('Overpass returned non-JSON'));
if (json.remark && /error|timed out/i.test(json.remark)) fail(`Overpass runtime error: ${json.remark}`);
if (!Array.isArray(json.elements) || json.elements.length === 0) fail('Overpass returned no elements');

const rows = [];
for (const e of json.elements) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (!t.name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (CHAINS.test(t.name) || CHAINS.test(t.brand || '')) continue;
  const type = isBrewery(t) ? 'b' : isTacoShop(t) ? 't' : null;
  if (!type) continue;
  let flags = 0;
  if (type === 't' && t.opening_hours === '24/7') flags |= 1;
  if (type === 't' && (/seafood|fish/.test(t.cuisine || '') || /mariscos|fish|oyster|seafood|baja/i.test(t.name))) flags |= 2;
  const addr = [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:city']].filter(Boolean).join(', ');
  rows.push({
    id: `${type}-${e.type[0]}${e.id}`, type, name: t.name.trim(),
    lat: +lat.toFixed(5), lon: +lon.toFixed(5), flags, addr, hours: t.opening_hours || '',
  });
}

// Drop duplicates: the same place mapped as both a node and a building (same type,
// same normalized name, within 150 m).
const norm = (s) => s.toLowerCase().replace(/\b(the|brewing|brewery|company|co|tasting room|taproom|restaurant)\b/g, '').replace(/[^a-z0-9]/g, '');
const distM = (a, b) => {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
};
const kept = [];
for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
  const dup = kept.find((k) => k.type === r.type && norm(k.name) === norm(r.name) && distM(k, r) < 150);
  if (dup) { if (!dup.addr && r.addr) dup.addr = r.addr; if (!dup.hours && r.hours) dup.hours = r.hours; continue; }
  kept.push(r);
}
kept.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

const nB = kept.filter((r) => r.type === 'b').length;
const nT = kept.length - nB;
if (nB < MIN_BREWERIES) fail(`only ${nB} breweries (< ${MIN_BREWERIES}); refusing to write partial data`);
if (nT < MIN_TACOS) fail(`only ${nT} taco shops (< ${MIN_TACOS}); refusing to write partial data`);
console.log(`fetch-pois: ${nB} breweries, ${nT} taco shops (${rows.length - kept.length} duplicates dropped)`);

if (process.argv.includes('--dry-run')) process.exit(0);

// Row format: [id, type, name, lat, lon, flags(1=24/7, 2=seafood), address, opening_hours]
const body = kept.map((r) => '    ' + JSON.stringify([r.id, r.type, r.name, r.lat, r.lon, r.flags, r.addr, r.hours]).replace(/<\//g, '<\\/')).join(',\n');
const stamp = new Date().toISOString().slice(0, 10);
const block = `/* POI-DATA:BEGIN (generated by scripts/fetch-pois.mjs on ${stamp}; (c) OpenStreetMap contributors, ODbL) */\n  const POI_ROWS = [\n${body},\n  ];\n  /* POI-DATA:END */`;

const html = readFileSync(HTML, 'utf8');
const re = /\/\* POI-DATA:BEGIN[\s\S]*?\/\* POI-DATA:END \*\//;
if (!re.test(html)) fail('POI-DATA markers not found in src/index.html');
writeFileSync(HTML, html.replace(re, block));
console.log(`fetch-pois: wrote ${kept.length} rows into src/index.html`);
