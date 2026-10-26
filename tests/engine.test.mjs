// Tests for the DOM-free engine block (<script id="sdx-engine">) inside src/index.html.
// The block is extracted and run in a bare vm context: no DOM, no Leaflet, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HTML_PATH = fileURLToPath(new URL('../src/index.html', import.meta.url));

function loadEngine() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script id="sdx-engine">([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html must contain <script id="sdx-engine">');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(m[1], sandbox, { filename: 'sdx-engine.js' });
  assert.ok(sandbox.SDX, 'engine must export globalThis.SDX');
  return sandbox;
}

const ctx = loadEngine();
const SDX = ctx.SDX;
const { neighborhoods, landmarks } = SDX.DATA;
const { tempAt, humidityAt, fogFactor, zoneCurve24 } = SDX.climate;
const { haversineMi, walkMinutes } = SDX.geo;
const { nearestTacos } = SDX.crawl;
const { applyFilters } = SDX.filters;

// San Diego County's extent (Camp Pendleton to Borrego / the border).
const inBBox = (p) => p.lat > 32.53 && p.lat < 33.52 && p.lon > -117.62 && p.lon < -116.08;
const hours = (a, b, step = 0.25) => { const out = []; for (let h = a; h <= b + 1e-9; h += step) out.push(h); return out; };

// ---------------------------------------------------------------- dataset
test('dataset: >=15 neighborhoods, >=20 landmarks, valid coords, unique ids', () => {
  assert.ok(neighborhoods.length >= 15, `neighborhoods=${neighborhoods.length}`);
  assert.ok(landmarks.length >= 20, `landmarks=${landmarks.length}`);
  const ids = new Set();
  for (const p of [...neighborhoods, ...landmarks]) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${p.id} has non-finite coords`);
    assert.ok(inBBox(p), `${p.id} outside SD County bbox`);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
  }
});

test('dataset: every zone needed by the chart is populated', () => {
  for (const z of ['coastal', 'central', 'inland', 'mountain']) {
    assert.ok(neighborhoods.some((n) => n.zone === z), `no neighborhood in zone ${z}`);
  }
  for (const n of ['La Jolla', 'Pacific Beach', 'Coronado', 'El Cajon', 'Escondido', 'Santee', 'Poway', 'Downtown', 'North Park', 'Chula Vista']) {
    assert.ok(neighborhoods.some((x) => x.name === n), `missing spec neighborhood ${n}`);
  }
});

test('dataset: temperature markers are tiered so county zoom stays readable', () => {
  // Sanity-check regression: 38 markers piled up over central San Diego at county zoom.
  // Tier 1 shows at every zoom; tier 2 only once zoomed in.
  const spec = ['La Jolla', 'Pacific Beach', 'Coronado', 'El Cajon', 'Escondido', 'Santee', 'Poway', 'Downtown', 'North Park', 'Chula Vista'];
  for (const n of neighborhoods) assert.ok(n.tier === 1 || n.tier === 2, `${n.id} tier ${n.tier}`);
  for (const name of spec) assert.equal(neighborhoods.find((n) => n.name === name).tier, 1, name);
  const t1 = neighborhoods.filter((n) => n.tier === 1);
  assert.ok(t1.length >= 12 && t1.length <= 22, `tier-1 count ${t1.length}`);
  for (const z of ['coastal', 'central', 'inland', 'mountain']) assert.ok(t1.some((n) => n.zone === z), `no tier-1 ${z}`);
  for (let i = 0; i < t1.length; i++) {
    for (let j = i + 1; j < t1.length; j++) {
      const d = haversineMi(t1[i], t1[j]);
      assert.ok(d >= 2.25, `${t1[i].name} and ${t1[j].name} only ${d.toFixed(1)} mi apart at tier 1`);
    }
  }
});

test('dataset: landmarks are breweries or taco shops tied to a known neighborhood', () => {
  const hoodIds = new Set(neighborhoods.map((n) => n.id));
  for (const p of landmarks) {
    assert.ok(p.type === 'brewery' || p.type === 'taco', `${p.id} bad type ${p.type}`);
    assert.ok(hoodIds.has(p.hood), `${p.id} unknown hood ${p.hood}`);
    for (const k of ['hazyIPA', 'open247', 'bajaFish']) {
      assert.equal(typeof p.tags[k], 'boolean', `${p.id}.tags.${k}`);
    }
  }
  assert.ok(landmarks.filter((p) => p.type === 'brewery').length >= 50, 'county-wide brewery coverage');
  assert.ok(landmarks.filter((p) => p.type === 'taco').length >= 150, 'county-wide taco coverage');
});

test('dataset: spots cover the whole county, not just the coast and downtown', () => {
  const regions = {
    'North County (lat > 33.0)': (p) => p.lat > 33.0,
    'East County (lon > -117.0)': (p) => p.lon > -117.0,
    'South Bay (lat < 32.66)': (p) => p.lat < 32.66,
    'Central / Kearny Mesa (32.80-32.90, -117.20..-117.10)': (p) => p.lat > 32.8 && p.lat < 32.9 && p.lon > -117.2 && p.lon < -117.1,
  };
  for (const [name, inRegion] of Object.entries(regions)) {
    const tacos = landmarks.filter((p) => p.type === 'taco' && inRegion(p)).length;
    const brews = landmarks.filter((p) => p.type === 'brewery' && inRegion(p)).length;
    assert.ok(tacos >= 10, `${name}: only ${tacos} taco shops`);
    assert.ok(brews >= 2, `${name}: only ${brews} breweries`);
  }
});

test('dataset: no non-beer "breweries" or non-taco "taco shops"', () => {
  // Sanity-check regressions: kombucha, cider, mead, spirits, taphouses and a sports bar
  // were in the brewery list; a pizza place, wings and fruit shops were in the taco list.
  const notBrewery = /kombucha|booch|cider|cyder|mead|cutwater|tap ?house|beer house|cork and craft|^beer company$|oggi/i;
  const notTaco = /pizza|wings|frut|fruit|mawazo/i;
  // A brewery's own taproom ("Mike Hess Brewing - Seaport Village Taphouse") is fine.
  const badB = landmarks.filter((p) => p.type === 'brewery' && notBrewery.test(p.name) && !/brew(ing|ery)/i.test(p.name)).map((p) => p.name);
  // A real taquería that also sells fruit ("... Taqueria, Fruit & Deli") is fine.
  const badT = landmarks.filter((p) => p.type === 'taco' && notTaco.test(p.name) && !/taco|taquer/i.test(p.name)).map((p) => p.name);
  assert.deepEqual(Array.from(badB), []);
  assert.deepEqual(Array.from(badT), []);
});

test('dataset: no duplicate listings of the same place', () => {
  // Regression: "Pizza Port" and "Pizza Port Ocean Beach" 8 m apart were the same brewpub.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const dups = [];
  for (let i = 0; i < landmarks.length; i++) {
    for (let j = i + 1; j < landmarks.length; j++) {
      const a = landmarks[i];
      const b = landmarks[j];
      if (a.type !== b.type || haversineMi(a, b) * 1609 > 60) continue;
      const [x, y] = [norm(a.name), norm(b.name)].sort((m, n) => m.length - n.length);
      if (y.startsWith(x.slice(0, Math.max(6, x.length - 8)))) dups.push(`${a.name} ~ ${b.name}`);
    }
  }
  assert.deepEqual(dups, []);
});

test('dataset: area follows the street-address city when it names a known area', () => {
  // Regression: Spring Valley spots showed as "La Mesa", San Ysidro as "Imperial Beach",
  // Solana Beach as "Del Mar" because area was just the nearest neighborhood center.
  const byName = new Map(neighborhoods.map((n) => [n.name, n.id]));
  for (const want of ['Spring Valley', 'Lemon Grove', 'San Ysidro', 'Solana Beach', 'City Heights']) {
    assert.ok(byName.has(want), `missing area ${want}`);
  }
  let checked = 0;
  for (const p of landmarks) {
    const city = (p.addr || '').split(', ')[1];
    if (!city || !byName.has(city)) continue;
    checked++;
    assert.equal(p.hood, byName.get(city), `${p.name} (${city}) filed under ${p.hood}`);
  }
  assert.ok(checked > 20, `only ${checked} spots had a matching city`);
  const sv = landmarks.find((p) => (p.addr || '').endsWith('Spring Valley'));
  assert.equal(SDX.placeLabel(sv), 'Spring Valley');
});

test('dataset: national chains are excluded', () => {
  const chains = /taco bell|del taco|chipotle|jack in the box|el pollo loco|qdoba|bj's/i;
  const hits = landmarks.filter((p) => chains.test(p.name)).map((p) => p.name);
  assert.deepEqual(Array.from(hits), []);
});

test('dataset: tags only apply to the matching type; hazy is a real mix', () => {
  for (const p of landmarks) {
    if (p.type === 'taco') assert.equal(p.tags.hazyIPA, false, p.id);
    else assert.ok(!p.tags.open247 && !p.tags.bajaFish, p.id);
  }
  const brews = landmarks.filter((p) => p.type === 'brewery');
  const hazy = brews.filter((p) => p.tags.hazyIPA).length;
  assert.ok(hazy > 0 && hazy < brews.length, `hazy=${hazy}/${brews.length}`);
  assert.ok(landmarks.some((p) => p.tags.open247), 'need some 24/7 shops');
  assert.ok(landmarks.some((p) => p.tags.bajaFish), 'need some seafood / Baja shops');
});

// ---------------------------------------------------------------- climate
test('climate: each zone stays inside its band from 6 AM to 10 PM', () => {
  const bands = { coastal: [66, 74], central: [72, 82], inland: [82, 98], mountain: [60, 84] };
  for (const [zone, [lo, hi]] of Object.entries(bands)) {
    for (const h of hours(6, 22)) {
      const t = tempAt(zone, h, 0);
      assert.ok(Number.isFinite(t), `${zone}@${h} not finite`);
      assert.ok(t >= lo - 0.5 && t <= hi + 0.5, `${zone}@${h}=${t} outside ${lo}-${hi}`);
    }
  }
});

test('climate: neighborhood offsets never push a zone outside its band', () => {
  for (const n of neighborhoods) {
    for (const h of hours(6, 22, 1)) {
      const t = tempAt(n.zone, h, n.offset);
      const [lo, hi] = SDX.ZONES[n.zone].band;
      assert.ok(t >= lo - 0.5 && t <= hi + 0.5, `${n.id}@${h}=${t}`);
    }
  }
});

test('climate: inland spikes rapidly to a midday peak', () => {
  const peak = Math.max(...hours(13, 15).map((h) => tempAt('inland', h, 0)));
  assert.ok(peak >= 95, `inland peak ${peak}`);
  assert.ok(tempAt('inland', 13, 0) - tempAt('inland', 9, 0) >= 10, 'inland 9->13 rise < 10F');
});

test('climate: coastal humid all day, inland dry at midday', () => {
  for (const h of hours(6, 22, 1)) assert.ok(humidityAt('coastal', h) >= 70, `coastal RH@${h}`);
  for (const h of [12, 13, 14, 15]) assert.ok(humidityAt('inland', h) <= 35, `inland RH@${h}`);
});

test('climate: 24h curve has 24 finite points and night dips below the day band', () => {
  for (const z of ['coastal', 'inland', 'mountain', 'central']) {
    const c = zoneCurve24(z);
    assert.equal(c.length, 24);
    assert.ok(c.every(Number.isFinite), `${z} curve has non-finite values`);
  }
  assert.ok(zoneCurve24('inland')[3] < 82, 'inland 3 AM should be cooler than the daytime band');
});

test('fogFactor: full until 11, burns off, clear 15-19, returns by 22', () => {
  for (const h of hours(6, 11)) assert.equal(fogFactor(h), 1, `fog@${h}`);
  const burn = hours(11, 14.5);
  for (let i = 1; i < burn.length; i++) {
    assert.ok(fogFactor(burn[i]) < fogFactor(burn[i - 1]), `not decreasing at ${burn[i]}`);
  }
  for (const h of hours(15, 19)) assert.equal(fogFactor(h), 0, `fog@${h}`);
  const back = hours(19, 22);
  for (let i = 1; i < back.length; i++) {
    assert.ok(fogFactor(back[i]) > fogFactor(back[i - 1]), `not increasing at ${back[i]}`);
  }
  assert.ok(fogFactor(22) >= 0.6);
  for (const h of hours(0, 24, 0.1)) {
    const f = fogFactor(h);
    assert.ok(f >= 0 && f <= 1, `fog@${h}=${f}`);
  }
});

// ---------------------------------------------------------------- geo + crawl
test('geo: haversine Downtown -> Pacific Beach is ~7 miles; walking is 25 min/mile', () => {
  const dt = neighborhoods.find((n) => n.name === 'Downtown');
  const pb = neighborhoods.find((n) => n.name === 'Pacific Beach');
  const d = haversineMi(dt, pb);
  assert.ok(d > 6 && d < 9, `DT->PB ${d}`);
  assert.equal(haversineMi(dt, dt), 0);
  assert.equal(walkMinutes(1), 25);
  assert.equal(walkMinutes(0), 0);
});

test('crawl: nearestTacos returns <=3 sorted taco shops within 1.5 mi', () => {
  const breweries = landmarks.filter((p) => p.type === 'brewery');
  let withAny = 0;
  let withThree = 0;
  for (const b of breweries) {
    const res = nearestTacos(b, landmarks, { max: 3, radiusMi: 1.5 });
    assert.ok(res.length <= 3);
    for (let i = 0; i < res.length; i++) {
      assert.equal(res[i].poi.type, 'taco');
      assert.ok(res[i].miles <= 1.5, `${b.id} -> ${res[i].poi.id} ${res[i].miles}`);
      assert.equal(res[i].minutes, walkMinutes(res[i].miles));
      if (i) assert.ok(res[i].miles >= res[i - 1].miles, 'not sorted');
    }
    if (res.length) withAny++;
    if (res.length === 3) withThree++;
  }
  assert.ok(withAny >= 30, `only ${withAny} breweries have a taco within 1.5 mi`);
  assert.ok(withThree >= 10, `only ${withThree} breweries have a full 3-stop crawl`);
});

test('crawl: radius is respected and candidates list can be pre-filtered', () => {
  const b = landmarks.find((p) => p.type === 'brewery');
  assert.deepEqual(nearestTacos(b, landmarks, { max: 3, radiusMi: 0 }).length, 0);
  assert.equal(nearestTacos(b, [], { max: 3, radiusMi: 1.5 }).length, 0);
});

// ---------------------------------------------------------------- filters
test('filters: no flags returns everything', () => {
  assert.equal(applyFilters(landmarks, {}).length, landmarks.length);
});

// A spot is "crawlable" if the other type is within the crawl radius (1.5 mi).
const hasPartner = (p, pool) =>
  pool.some((q) => q.type !== p.type && haversineMi(p, q) <= SDX.crawl.RADIUS_MI);

test('filters: crawlable keeps only brewery/taco pairs within walking range', () => {
  assert.equal(SDX.crawl.RADIUS_MI, 1.5);
  const out = applyFilters(landmarks, { crawlable: true });
  assert.ok(out.length > 0 && out.length < landmarks.length, `crawlable=${out.length}`);
  for (const p of out) assert.ok(hasPartner(p, out), `${p.id} kept without a partner in range`);
  for (const p of landmarks) {
    if (hasPartner(p, landmarks)) assert.ok(out.includes(p), `${p.id} has a partner but was dropped`);
  }
  // Isolated breweries can't start a crawl.
  const lonely = landmarks.filter((p) => p.type === 'brewery' && !hasPartner(p, landmarks));
  assert.ok(lonely.length > 0, 'expected some breweries with no taco shop in range');
  for (const b of lonely) assert.ok(!out.includes(b), `${b.id} should be hidden`);
});

test('filters: crawlable is judged against the other active filters', () => {
  // With Hazy on, a taco shop only counts if a *hazy* brewery is in range.
  const out = applyFilters(landmarks, { crawlable: true, hazyIPA: true });
  const tacos = out.filter((p) => p.type === 'taco');
  assert.ok(tacos.length > 0);
  for (const t of tacos) assert.ok(hasPartner(t, out.filter((p) => p.type === 'brewery')), `${t.id}`);
  assert.ok(out.filter((p) => p.type === 'brewery').every((p) => p.tags.hazyIPA));
});

test('dataset: no dog-friendly tag anywhere', () => {
  assert.ok(landmarks.every((p) => !('dogFriendly' in p.tags)));
});

test('filters: hazy IPA narrows breweries only; taco flags narrow tacos only', () => {
  const tacos = landmarks.filter((p) => p.type === 'taco');
  const brews = landmarks.filter((p) => p.type === 'brewery');

  const hazy = applyFilters(landmarks, { hazyIPA: true });
  assert.equal(hazy.filter((p) => p.type === 'taco').length, tacos.length);
  assert.ok(hazy.filter((p) => p.type === 'brewery').every((p) => p.tags.hazyIPA));
  assert.ok(hazy.filter((p) => p.type === 'brewery').length < brews.length);

  const late = applyFilters(landmarks, { open247: true });
  assert.equal(late.filter((p) => p.type === 'brewery').length, brews.length);
  assert.ok(late.filter((p) => p.type === 'taco').every((p) => p.tags.open247));
  assert.ok(late.some((p) => p.type === 'taco'), 'dataset needs at least one 24/7 taco shop');

  const baja = applyFilters(landmarks, { bajaFish: true });
  assert.equal(baja.filter((p) => p.type === 'brewery').length, brews.length);
  assert.ok(baja.filter((p) => p.type === 'taco').every((p) => p.tags.bajaFish));
});

test('filters: flags combine with AND', () => {
  const out = applyFilters(landmarks, { crawlable: true, bajaFish: true });
  assert.ok(out.length > 0);
  for (const p of out) {
    assert.ok(hasPartner(p, out));
    if (p.type === 'taco') assert.ok(p.tags.bajaFish);
  }
});

// ---------------------------------------------------------------- registry
test('registry: validates, rejects duplicates, preserves order, emits events', () => {
  const reg = new SDX.ModuleRegistry();
  const seen = [];
  reg.on('registered', (m) => seen.push(m.id));
  const mod = (id) => ({ id, name: id.toUpperCase(), onActivate() {} });

  reg.registerModule(mod('a'));
  reg.registerModule(mod('b'));
  // Array.from copies into this realm; vm-context arrays have a different prototype.
  assert.deepEqual(Array.from(reg.list(), (m) => m.id), ['a', 'b']);
  assert.equal(reg.get('b').name, 'B');
  assert.equal(reg.get('zzz'), undefined);
  assert.deepEqual(seen, ['a', 'b']);

  assert.throws(() => reg.registerModule(mod('a')), /duplicate/i);
  assert.throws(() => reg.registerModule({ name: 'x', onActivate() {} }), /id/i);
  assert.throws(() => reg.registerModule({ id: 'x', onActivate() {} }), /name/i);
  assert.throws(() => reg.registerModule({ id: 'x', name: 'X' }), /onActivate/i);
  assert.throws(() => reg.registerModule(null), /object/i);
  assert.equal(reg.list().length, 2);
});

test('tags: activeLabels lists only tags that are true for that spot', () => {
  // Regression: popups rendered every tag chip (false ones only dimmed), so every taco
  // shop appeared to claim "24/7" and "Seafood".
  const { activeLabels } = SDX.tags;
  const plain = landmarks.find((p) => p.type === 'taco' && !p.tags.open247 && !p.tags.bajaFish);
  assert.deepEqual(Array.from(activeLabels(plain)), []);
  const late = landmarks.find((p) => p.type === 'taco' && p.tags.open247);
  assert.ok(Array.from(activeLabels(late)).includes('24/7'));
  const sea = landmarks.find((p) => p.type === 'taco' && p.tags.bajaFish);
  assert.ok(Array.from(activeLabels(sea)).includes('Seafood'));
  for (const p of landmarks) {
    const labels = Array.from(activeLabels(p));
    assert.equal(labels.includes('24/7'), p.tags.open247, p.id);
    assert.equal(labels.includes('Seafood'), p.tags.bajaFish, p.id);
    assert.equal(labels.includes('Hazy IPA'), p.tags.hazyIPA, p.id);
  }
});

test('registry: accepts onFocus/onBlur hooks and rejects non-function values', () => {
  // Modules use these to show focus-only visuals (e.g. the marine layer only while
  // Microclimates is the focused layer).
  const reg = new SDX.ModuleRegistry();
  const base = { name: 'X', onActivate() {} };
  reg.registerModule({ ...base, id: 'ok', onFocus() {}, onBlur() {} });
  assert.throws(() => reg.registerModule({ ...base, id: 'bad-focus', onFocus: 'yes' }), /onFocus must be a function/);
  assert.throws(() => reg.registerModule({ ...base, id: 'bad-blur', onBlur: 1 }), /onBlur must be a function/);
});

test('bus: last() returns the latest payload so late subscribers can sync', () => {
  // Regression: the Surf template subscribed to 'clock' after Microclimates had already
  // emitted, so it showed its default 9:00 AM instead of the shared clock.
  const bus = new SDX.EventBus();
  assert.equal(bus.last('clock'), undefined);
  bus.emit('clock', { hour: 7.5 });
  bus.emit('clock', { hour: 8 });
  assert.equal(bus.last('clock').hour, 8);
  let got = null;
  bus.on('clock', (p) => { got = p.hour; });
  bus.emit('clock', { hour: 9 });
  assert.equal(got, 9);
  assert.equal(bus.last('clock').hour, 9);
});

test('registry: global LayerRegistry singleton is exposed', () => {
  assert.ok(ctx.LayerRegistry instanceof SDX.ModuleRegistry);
  assert.equal(ctx.LayerRegistry, SDX.LayerRegistry);
});

// ---------------------------------------------------------------- opening hours
// San Diego (Pacific) wall-clock dates, independent of the machine's timezone.
// 2026-09-28 is a Monday.
const at = (y, m, d, hh, mm = 0) => SDX.time.fromPacific(y, m, d, hh, mm);
const MON = (hh, mm) => at(2026, 9, 28, hh, mm);
const TUE = (hh, mm) => at(2026, 9, 29, hh, mm);
const FRI = (hh, mm) => at(2026, 10, 2, hh, mm);
const SAT = (hh, mm) => at(2026, 10, 3, hh, mm);
const SUN = (hh, mm) => at(2026, 10, 4, hh, mm);

test('hours: 24/7, day ranges, lists and multiple spans', () => {
  const { isOpenAt } = SDX.hours;
  assert.equal(isOpenAt('24/7', MON(3)), true);
  const h = 'Mo-Th 16:00-23:00; Fr-Sa 12:00-23:00; Su 12:00-22:00';
  assert.equal(isOpenAt(h, MON(17)), true);
  assert.equal(isOpenAt(h, MON(15, 59)), false);
  assert.equal(isOpenAt(h, SAT(12, 30)), true);
  assert.equal(isOpenAt(h, SUN(22, 30)), false);
  assert.equal(isOpenAt('Mo-Fr 11:00-14:00,17:00-21:00', TUE(15)), false);
  assert.equal(isOpenAt('Mo-Fr 11:00-14:00,17:00-21:00', TUE(18)), true);
  assert.equal(isOpenAt('Mo,Tu 09:00-17:00', TUE(10)), true);
  assert.equal(isOpenAt('Fr, Sa 09:00-17:00', SAT(10)), true);
  assert.equal(isOpenAt('10:00-20:00', SUN(11)), true, 'no days = every day');
});

test('hours: spans past midnight spill into the next morning', () => {
  const { isOpenAt } = SDX.hours;
  const h = 'Mo,Tu 12:00-21:00;We,Th 12:00-23:00;Fr, Sa 12:00-01:00;Su 12:00-22:00';
  assert.equal(isOpenAt(h, SAT(0, 30)), true, 'Friday 12:00-01:00 covers early Saturday');
  assert.equal(isOpenAt(h, SUN(0, 30)), true, 'Saturday spills into Sunday');
  assert.equal(isOpenAt(h, MON(0, 30)), false, 'Sunday closes at 22:00');
  assert.equal(isOpenAt(h, SAT(1, 30)), false);
});

test('hours: later rules override earlier ones; off/closed; unknown stays null', () => {
  const { isOpenAt } = SDX.hours;
  assert.equal(isOpenAt('Mo-Fr 08:00-17:00; Fr off', FRI(10)), false);
  assert.equal(isOpenAt('Mo-Fr 08:00-17:00; Fr off', TUE(10)), true);
  assert.equal(isOpenAt('Mo-Su 09:00-17:00; PH off', TUE(10)), true, 'holiday rules are ignored');
  for (const bad of ['', 'by appointment', 'sunrise-sunset', 'Mo-Fr 9am-5pm']) {
    assert.equal(isOpenAt(bad, TUE(10)), null, `"${bad}" should be unknown`);
  }
  assert.equal(isOpenAt(undefined, TUE(10)), null);
});

test('hours: nextChange reports when a spot closes or opens', () => {
  const { nextChange } = SDX.hours;
  const h = 'Mo-Th 16:00-23:00; Fr-Sa 12:00-23:00; Su 12:00-22:00';
  const a = nextChange(h, MON(17));
  assert.equal(a.open, true);
  assert.equal(SDX.time.parts(a.at).hour, 23);
  const b = nextChange(h, MON(12));
  assert.equal(b.open, false);
  assert.equal(SDX.time.parts(b.at).hour, 16);
  assert.equal(nextChange('24/7', MON(12)).at, null, '24/7 never changes');
  assert.equal(nextChange('by appointment', MON(12)), null);
});

// ---------------------------------------------------------------- San Diego time
test('time: Pacific wall clock converts both ways, across DST', () => {
  const T = SDX.time;
  const summer = T.fromPacific(2026, 7, 1, 9, 0);   // PDT, UTC-7
  const winter = T.fromPacific(2026, 12, 15, 9, 0); // PST, UTC-8
  assert.equal(summer.getUTCHours(), 16);
  assert.equal(winter.getUTCHours(), 17);
  const p = T.parts(T.fromPacific(2026, 9, 28, 17, 45));
  assert.deepEqual([p.y, p.m, p.d, p.hour, p.minute, p.weekday], [2026, 9, 28, 17, 45, 1]);
  assert.equal(T.hour(T.fromPacific(2026, 9, 28, 15, 30)), 15.5);
  assert.equal(T.dayStartMs(T.fromPacific(2026, 9, 28, 15)), T.fromPacific(2026, 9, 28, 0).getTime());
  assert.equal(T.dayKey(T.fromPacific(2026, 9, 28, 23, 59)), '2026-09-28');
  assert.equal(T.dayKey(T.fromPacific(2026, 9, 29, 0, 1)), '2026-09-29');
});

test('time: hours and "today" stay on San Diego time when the device is elsewhere', () => {
  // Regression: Open Now used the device timezone, so a laptop set to another zone
  // judged San Diego shop hours against the wrong clock.
  const prev = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    const T = SDX.time;
    const mon5pm = T.fromPacific(2026, 9, 28, 17, 0);
    assert.equal(SDX.hours.isOpenAt('Mo-Th 16:00-23:00', mon5pm), true);
    assert.equal(SDX.hours.isOpenAt('Mo-Th 16:00-23:00', T.fromPacific(2026, 9, 28, 15, 0)), false);
    assert.equal(T.hour(mon5pm), 17);
    assert.equal(T.dayKey(mon5pm), '2026-09-28');
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

// ---------------------------------------------------------------- new filters
const fake = (id, type, lat, lon, hours) => ({ id, name: id, type, lat, lon, hours, tags: { hazyIPA: false, open247: false, bajaFish: false } });

test('filters: openNow hides known-closed spots and keeps unknown hours', () => {
  const pois = [
    fake('open', 'taco', 32.75, -117.13, 'Mo-Su 09:00-21:00'),
    fake('closed', 'taco', 32.75, -117.13, 'Mo-Su 18:00-21:00'),
    fake('unknown', 'taco', 32.75, -117.13, ''),
  ];
  const out = Array.from(applyFilters(pois, { openNow: true, now: MON(12) }), (p) => p.id);
  assert.deepEqual(out, ['open', 'unknown']);
});

test('filters: crawlable honors a custom walk radius', () => {
  const n = (mi) => applyFilters(landmarks, { crawlable: true, radiusMi: mi }).length;
  assert.ok(n(0.25) < n(1.5), `${n(0.25)} !< ${n(1.5)}`);
  assert.ok(n(1.5) < n(3), `${n(1.5)} !< ${n(3)}`);
  assert.equal(n(1.5), applyFilters(landmarks, { crawlable: true }).length, '1.5 mi is the default');
});

test('filters: near keeps only spots within the distance of you', () => {
  const me = { lat: 32.7479, lon: -117.1296 }; // North Park
  const n1 = applyFilters(landmarks, { near: { ...me, mi: 1 } });
  const n5 = applyFilters(landmarks, { near: { ...me, mi: 5 } });
  assert.ok(n1.length > 0 && n1.length < n5.length);
  for (const p of n5) assert.ok(haversineMi(me, p) <= 5);
});

// ---------------------------------------------------------------- NWS
const HOUR = 3600e3;
const t0 = Date.UTC(2026, 8, 26, 10);

test('nws: expandSeries spreads ISO-8601 intervals into hourly values', () => {
  const m = SDX.nws.expandSeries([
    { validTime: '2026-09-26T10:00:00+00:00/PT4H', value: 21.1 },
    { validTime: '2026-09-26T14:00:00+00:00/PT1H', value: 20.5 },
    { validTime: '2026-09-26T15:00:00+00:00/P1DT2H', value: 19 },
  ]);
  assert.equal(m.get(t0), 21.1);
  assert.equal(m.get(t0 + 3 * HOUR), 21.1);
  assert.equal(m.get(t0 + 4 * HOUR), 20.5);
  assert.equal(m.get(t0 + 5 * HOUR), 19);
  assert.equal(m.get(t0 + 5 * HOUR + 25 * HOUR), 19);
  assert.equal(m.get(t0 + 5 * HOUR + 26 * HOUR), undefined);
});

test('nws: dayHours gives 24 slots with null gaps; cToF converts', () => {
  const m = SDX.nws.expandSeries([{ validTime: '2026-09-26T10:00:00+00:00/PT2H', value: 20 }]);
  const day = Array.from(SDX.nws.dayHours(m, t0 - 10 * HOUR));
  assert.equal(day.length, 24);
  assert.equal(day[10], 20);
  assert.equal(day[11], 20);
  assert.equal(day[12], null);
  assert.equal(day[0], null);
  assert.equal(SDX.nws.cToF(0), 32);
  assert.equal(SDX.nws.cToF(100), 212);
  assert.equal(SDX.nws.cToF(null), null);
});

test('nws: validateGridpoint fails loudly on missing or empty series', () => {
  const series = (n) => ({ values: Array.from({ length: n }, (_, i) => ({ validTime: `2026-09-26T${10 + i}:00:00+00:00/PT1H`, value: 1 })) });
  const good = { properties: { temperature: series(3), relativeHumidity: series(3), skyCover: series(3) } };
  assert.doesNotThrow(() => SDX.nws.validateGridpoint(good));
  assert.throws(() => SDX.nws.validateGridpoint({ properties: { temperature: series(3), relativeHumidity: series(3) } }), /skyCover/);
  assert.throws(() => SDX.nws.validateGridpoint({ properties: { temperature: series(0), relativeHumidity: series(3), skyCover: series(3) } }), /temperature/);
  assert.throws(() => SDX.nws.validateGridpoint(null), /gridpoint/i);
});

// ================================================================ live sky & sea (batch 1)
test('math: lerpAngle takes the short way around the compass', () => {
  const { lerpAngle } = SDX.math;
  assert.equal(lerpAngle(350, 10, 0.5), 0);
  assert.equal(lerpAngle(10, 350, 0.5), 0);
  assert.equal(lerpAngle(90, 180, 0.5), 135);
  assert.equal(lerpAngle(90, 180, 0), 90);
  assert.equal(lerpAngle(90, 180, 1), 180);
  assert.ok(lerpAngle(359, 1, 0.25) >= 0 && lerpAngle(359, 1, 0.25) < 360);
});

test('nws: kmhToMph converts and guards non-numbers', () => {
  assert.equal(SDX.nws.kmhToMph(16.09344), 10);
  assert.equal(SDX.nws.kmhToMph(null), null);
  assert.equal(SDX.nws.kmhToMph(NaN), null);
});

test('nws: clearingHour finds when the coastal cloud deck breaks and returns', () => {
  const sky = Array(24).fill(null);
  [[6, 95], [7, 95], [8, 90], [9, 80], [10, 62], [11, 38], [12, 20], [13, 15], [14, 15], [15, 20], [16, 30], [17, 45], [18, 60], [19, 80], [20, 90], [21, 90], [22, 90], [23, 90]]
    .forEach(([h, v]) => { sky[h] = v; });
  const r = SDX.nws.clearingHour(sky);
  assert.equal(r.state, 'clearing');
  // 62 -> 38 crosses 50 halfway between 10:00 and 11:00
  assert.ok(Math.abs(r.at - 10.5) < 0.01, `at=${r.at}`);
  // 45 -> 60 crosses 50 a third of the way from 17:00 to 18:00
  assert.ok(Math.abs(r.returnAt - (17 + 1 / 3)) < 0.01, `returnAt=${r.returnAt}`);
});

test('nws: clearingHour covers clear, cloudy-all-day and thin data', () => {
  const flat = (v) => Array.from({ length: 24 }, () => v);
  assert.equal(SDX.nws.clearingHour(flat(10)).state, 'clear');
  assert.equal(SDX.nws.clearingHour(flat(90)).state, 'cloudy');
  const sparse = Array(24).fill(null); sparse[8] = 90; sparse[9] = 20;
  assert.equal(SDX.nws.clearingHour(sparse).state, 'unknown');
  assert.equal(SDX.nws.clearingHour([]).state, 'unknown');
  assert.equal(SDX.nws.clearingHour(null).state, 'unknown');
});

const KSAN_OBS = {
  properties: {
    timestamp: '2026-10-06T05:50:00+00:00', textDescription: 'Mostly Clear',
    temperature: { unitCode: 'wmoUnit:degC', value: 27 },
    relativeHumidity: { unitCode: 'wmoUnit:percent', value: 50.986771578907 },
    windSpeed: { unitCode: 'wmoUnit:km_h-1', value: 5.544 },
    windDirection: { unitCode: 'wmoUnit:degree_(angle)', value: 320 },
  },
};

test('obs: stations are real SD airports with valid coords', () => {
  const { STATIONS } = SDX.obs;
  assert.ok(STATIONS.length >= 8);
  assert.ok(STATIONS.some((s) => s.id === 'KSAN'));
  for (const s of STATIONS) {
    assert.match(s.id, /^K[A-Z]{3}$/);
    assert.ok(inBBox(s), `${s.id} outside the county`);
  }
  assert.equal(new Set(STATIONS.map((s) => s.id)).size, STATIONS.length);
});

test('obs: parse converts units and reports age', () => {
  const now = Date.parse('2026-10-06T06:20:00Z');
  const o = SDX.obs.parse(KSAN_OBS, now);
  assert.equal(o.tF, 80.6);
  assert.equal(Math.round(o.rh), 51);
  assert.equal(o.windMph, 3.4);
  assert.equal(o.windFromDeg, 320);
  assert.equal(o.desc, 'Mostly Clear');
  assert.equal(o.ageMin, 30);
});

test('obs: parse fails loudly on junk and tolerates one missing field', () => {
  assert.throws(() => SDX.obs.parse(null, 0), /observation/i);
  assert.throws(() => SDX.obs.parse({ properties: {} }, 0), /observation/i);
  const noTemp = JSON.parse(JSON.stringify(KSAN_OBS));
  noTemp.properties.temperature.value = null;
  assert.throws(() => SDX.obs.parse(noTemp, Date.parse('2026-10-06T06:00:00Z')), /temperature/i);
  const noWind = JSON.parse(JSON.stringify(KSAN_OBS));
  noWind.properties.windSpeed.value = null;
  const o = SDX.obs.parse(noWind, Date.parse('2026-10-06T06:00:00Z'));
  assert.equal(o.windMph, null);
  assert.equal(o.tF, 80.6);
});

test('obs: delta is observed minus forecast, rounded, null-safe', () => {
  assert.equal(SDX.obs.delta(70, 73.4), 3);
  assert.equal(SDX.obs.delta(70, 66.6), -3);
  assert.equal(SDX.obs.delta(null, 70), null);
  assert.equal(SDX.obs.delta(70, NaN), null);
});

test('obs: nearest station honors the distance cap', () => {
  const near = SDX.obs.nearest(32.75, -117.2, 5);
  assert.equal(near.id, 'KSAN');
  assert.equal(SDX.obs.nearest(32.0, -118.0, 5), null);
});

test('alerts: relevant keeps weather that matters, drops expired, sorts by severity', () => {
  const now = Date.parse('2026-10-06T06:00:00-07:00');
  const f = (id, event, severity, expires) => ({ properties: { id, event, severity, expires, headline: `${event} issued`, areaDesc: 'San Diego County Coastal Areas', onset: null, ends: expires } });
  const json = { features: [
    f('a', 'Beach Hazards Statement', 'Moderate', '2026-10-09T23:00:00-07:00'),
    f('b', 'Extreme Heat Warning', 'Severe', '2026-10-08T20:00:00-07:00'),
    f('c', 'Special Marine Warning', 'Minor', '2026-10-09T23:00:00-07:00'),
    f('d', 'Dense Fog Advisory', 'Minor', '2026-10-05T09:00:00-07:00'),
    f('e', 'Coastal Flood Advisory', 'Minor', '2026-10-09T11:00:00-07:00'),
  ] };
  const out = SDX.alerts.relevant(json, now);
  assert.deepEqual(Array.from(out, (a) => a.id), ['b', 'a', 'e']);
  assert.equal(out[0].event, 'Extreme Heat Warning');
  assert.equal(out[0].level, 3);
});

test('alerts: malformed payload throws, empty is fine, merge dedupes by id', () => {
  assert.throws(() => SDX.alerts.relevant({}, 0), /alerts/i);
  assert.throws(() => SDX.alerts.relevant(null, 0), /alerts/i);
  assert.deepEqual(Array.from(SDX.alerts.relevant({ features: [] }, 0)), []);
  const a = { id: 'x', level: 2 };
  const b = { id: 'x', level: 2 };
  const c = { id: 'y', level: 3 };
  assert.deepEqual(Array.from(SDX.alerts.merge([[a], [b, c]]), (x) => x.id), ['y', 'x']);
});

test('marine: CO-OPS water temperature parses the latest reading and a 24h series', () => {
  const json = { metadata: { id: '9410230', name: 'La Jolla' }, data: [
    { t: '2026-10-05 06:18', v: '72.5', f: '0,0,0' }, { t: '2026-10-05 06:24', v: '72.5', f: '0,0,0' },
    { t: '2026-10-06 06:00', v: '71.8', f: '0,0,0' }, { t: '2026-10-06 06:06', v: '71.6', f: '0,0,0' },
  ] };
  const r = SDX.marine.parseCoops(json);
  assert.equal(r.tF, 71.6);
  assert.equal(r.at, Date.parse('2026-10-06T06:06:00Z'));
  assert.equal(r.series.length, 4);
  assert.throws(() => SDX.marine.parseCoops({ error: { message: 'No data' } }), /water/i);
  assert.throws(() => SDX.marine.parseCoops({ data: [{ t: 'x', v: '' }] }), /water/i);
});

test('marine: Open-Meteo marine parses waves and sea temperature', () => {
  const json = {
    current: { time: '2026-10-06T06:00', wave_height: 3.018, wave_period: 10.15, sea_surface_temperature: 73.6 },
    hourly: { time: ['2026-10-06T04:00', '2026-10-06T05:00', '2026-10-06T06:00'], wave_height: [3.1, 3.08, 3.0], sea_surface_temperature: [73.9, 73.8, null] },
  };
  const r = SDX.marine.parseOpenMeteo(json);
  assert.equal(r.waveFt, 3);
  assert.equal(r.periodS, 10.2);
  assert.equal(r.sstF, 73.6);
  assert.deepEqual(Array.from(r.waveSeries), [3.1, 3.08, 3.0]);
  assert.throws(() => SDX.marine.parseOpenMeteo({}), /marine/i);
  assert.throws(() => SDX.marine.parseOpenMeteo({ current: { wave_height: NaN } }), /marine/i);
});

test('air: parse and AQI categories follow the EPA bands', () => {
  const json = { current: { time: '2026-10-06T06:00', us_aqi: 66, pm2_5: 17.0 }, hourly: { time: ['a', 'b'], us_aqi: [69, 66] } };
  const r = SDX.air.parse(json);
  assert.equal(r.aqi, 66);
  assert.equal(r.pm25, 17);
  assert.deepEqual(Array.from(r.series), [69, 66]);
  assert.throws(() => SDX.air.parse({ current: {} }), /air/i);
  const cat = SDX.air.category;
  assert.equal(cat(30).label, 'Good');
  assert.equal(cat(66).label, 'Moderate');
  assert.equal(cat(120).label, 'Unhealthy for sensitive groups');
  assert.equal(cat(180).label, 'Unhealthy');
  assert.equal(cat(250).label, 'Very unhealthy');
  assert.equal(cat(400).label, 'Hazardous');
  assert.equal(cat(NaN), null);
});

test('sat: GIBS capabilities default time is extracted, junk throws', () => {
  const xml = '<Dimension><ows:Identifier>Time</ows:Identifier><Default>2026-10-06T05:20:00Z</Default><Current>false</Current></Dimension>';
  assert.equal(SDX.sat.parseDefaultTime(xml), '2026-10-06T05:20:00Z');
  assert.throws(() => SDX.sat.parseDefaultTime('<xml/>'), /satellite/i);
});

test('sat: frames step back from the newest in 10-minute multiples, oldest first', () => {
  const f = SDX.sat.frames('2026-10-06T05:20:00Z', 5, 60);
  assert.deepEqual(Array.from(f), ['2026-10-06T01:20:00Z', '2026-10-06T02:20:00Z', '2026-10-06T03:20:00Z', '2026-10-06T04:20:00Z', '2026-10-06T05:20:00Z']);
  assert.throws(() => SDX.sat.frames('nope', 3, 60), /satellite/i);
  assert.throws(() => SDX.sat.frames('2026-10-06T05:20:00Z', 3, 7), /satellite/i);
});

test('sat: age is minutes behind now, tile math lands over San Diego', () => {
  assert.equal(SDX.sat.ageMin('2026-10-06T05:20:00Z', Date.parse('2026-10-06T06:14:00Z')), 54);
  const t = SDX.sat.tileXY(32.8, -117.1, 6);
  assert.equal(t.x, 11);
  assert.ok(t.y >= 25 && t.y <= 27, `y=${t.y}`);
  assert.match(SDX.sat.tileUrl('2026-10-06T05:20:00Z', 6, 11, 26), /GOES-West_ABI_GeoColor\/default\/2026-10-06T05:20:00Z\/GoogleMapsCompatible_Level7\/6\/26\/11\.png$/);
});

test('alerts: group folds the same warning issued per zone into one entry with every area', () => {
  const mk = (id, event, ends, areaDesc, level = 3) => ({ id, event, ends, areaDesc, level });
  const out = SDX.alerts.group([
    mk('1', 'Extreme Heat Warning', '2026-10-08T20:00:00-07:00', 'San Diego County Coastal Areas'),
    mk('2', 'Extreme Heat Warning', '2026-10-08T20:00:00-07:00', 'San Diego County Inland Valleys'),
    mk('3', 'Extreme Heat Warning', '2026-10-09T08:00:00-07:00', 'San Diego County Mountains'),
    mk('4', 'Beach Hazards Statement', '2026-10-09T23:00:00-07:00', 'San Diego County Coastal Areas', 2),
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].event, 'Extreme Heat Warning');
  assert.equal(out[0].areaDesc, 'San Diego County Coastal Areas; San Diego County Inland Valleys');
  assert.deepEqual(Array.from(out[0].ids), ['1', '2']);
  assert.equal(out[1].areaDesc, 'San Diego County Mountains');
  // duplicate area names are not repeated
  const dup = SDX.alerts.group([mk('a', 'Wind Advisory', 'x', 'Coast'), mk('b', 'Wind Advisory', 'x', 'Coast')]);
  assert.equal(dup[0].areaDesc, 'Coast');
  assert.deepEqual(Array.from(SDX.alerts.group([])), []);
});

// ================================================================ smarter crawls (batch 2)
const stop = (hours, minutes = 10, name = 'Taqueria') => ({ poi: { id: name, name, hours }, miles: 0.5, minutes });
const TUE_9 = 'Mo-Su 11:00-21:00';

test('crawl: arrival adds the walk to the start time and checks the stop is open then', () => {
  const [a] = SDX.crawl.arrival([stop(TUE_9, 10)], at(2026, 10, 6, 18, 0));
  assert.equal(a.arrivesAt.getTime(), at(2026, 10, 6, 18, 10).getTime());
  assert.equal(a.open, true);
  assert.equal(a.closesInMin, 170);
  assert.equal(a.tight, false);
});

test('crawl: arrival flags stops that close before you get there', () => {
  const [a] = SDX.crawl.arrival([stop(TUE_9, 10)], at(2026, 10, 6, 20, 55));
  assert.equal(a.open, false);
  assert.equal(a.opensAt.getTime(), at(2026, 10, 7, 11, 0).getTime());
  assert.equal(a.tight, false);
  assert.equal(a.closesInMin, null);
});

test('crawl: arrival marks a stop that closes within 30 minutes of arriving as tight', () => {
  const [a] = SDX.crawl.arrival([stop(TUE_9, 10)], at(2026, 10, 6, 20, 40));
  assert.equal(a.open, true);
  assert.equal(a.closesInMin, 10);
  assert.equal(a.tight, true);
});

test('crawl: arrival copes with unknown hours, 24/7 and closing after midnight', () => {
  const out = SDX.crawl.arrival([stop('', 5, 'u'), stop('24/7', 5, 'a'), stop('Mo-Su 12:00-01:00', 20, 'm')], at(2026, 10, 6, 23, 50));
  assert.equal(out[0].open, null);
  assert.equal(out[0].closesInMin, null);
  assert.equal(out[0].tight, false);
  assert.equal(out[1].open, true);
  assert.equal(out[1].closesInMin, null);
  assert.equal(out[2].open, true);
  assert.equal(out[2].closesInMin, 50);
});

test('crawl: arrival does not mutate or lose the nearestTacos fields', () => {
  const t = stop(TUE_9, 7);
  const [a] = SDX.crawl.arrival([t], at(2026, 10, 6, 12, 0));
  assert.equal(a.poi, t.poi);
  assert.equal(a.minutes, 7);
  assert.equal(a.miles, 0.5);
  assert.deepEqual(Object.keys(t).sort(), ['miles', 'minutes', 'poi']);
});

test('crawl: status says open/closed/unknown and whether the change is soon', () => {
  const S = SDX.crawl.status;
  const closingSoon = S(TUE_9, at(2026, 10, 6, 20, 30));
  assert.equal(closingSoon.state, 'open');
  assert.equal(closingSoon.minutes, 30);
  assert.equal(closingSoon.soon, true);
  const opensSoon = S(TUE_9, at(2026, 10, 6, 10, 40));
  assert.equal(opensSoon.state, 'closed');
  assert.equal(opensSoon.minutes, 20);
  assert.equal(opensSoon.soon, true);
  assert.equal(S(TUE_9, at(2026, 10, 6, 13, 0)).soon, false);
  assert.equal(S(TUE_9, at(2026, 10, 6, 5, 0)).soon, false);
  assert.equal(S('', at(2026, 10, 6, 13, 0)).state, 'unknown');
  assert.equal(S('24/7', at(2026, 10, 6, 13, 0)).state, 'open');
  assert.equal(S('24/7', at(2026, 10, 6, 13, 0)).minutes, null);
});

test('crawl: countOpen tallies known-open spots against all', () => {
  const pois = [{ hours: TUE_9 }, { hours: TUE_9 }, { hours: '' }, { hours: 'Mo-Su 06:00-08:00' }];
  const c = SDX.crawl.countOpen(pois, at(2026, 10, 6, 12, 0));
  assert.deepEqual({ open: c.open, closed: c.closed, unknown: c.unknown, total: c.total }, { open: 2, closed: 1, unknown: 1, total: 4 });
});

// ================================================================ shareable URL state (batch 3)
const J = (x) => JSON.parse(JSON.stringify(x));

test('urlstate: defaults encode to nothing', () => {
  assert.equal(SDX.urlstate.encode({}), '');
  assert.equal(SDX.urlstate.encode({ tab: 'microclimates', source: 'sim', metric: 'temp', hood: 'all', radiusMi: 1.5, view: 'pins', filters: [], layers: [] }), '');
});

test('urlstate: encode writes a stable, compact string', () => {
  const s = SDX.urlstate.encode({ tab: 'hotspots', hood: 'pacific-beach', filters: ['crawlable', 'openNow'], radiusMi: 2, view: 'heat', sel: 'b-n123' });
  assert.equal(s, 't=hotspots&a=pacific-beach&f=crawlable,openNow&r=2&v=heat&s=b-n123');
  const m = SDX.urlstate.encode({ tab: 'microclimates', hour: 14.5, source: 'live', metric: 'rh', layers: ['sat', 'wind'] });
  assert.equal(m, 'h=14.5&src=live&m=rh&l=sat,wind');
});

test('urlstate: decode round-trips what encode wrote', () => {
  const state = { tab: 'hotspots', hood: 'ocean-beach', filters: ['hazyIPA', 'open247'], radiusMi: 0.75, view: 'heat', sel: 'b-n1' };
  assert.deepEqual(J(SDX.urlstate.decode(SDX.urlstate.encode(state))), state);
  const micro = { hour: 9.25, source: 'live', metric: 'rh', layers: ['obs'] }; // microclimates is the default tab
  assert.deepEqual(J(SDX.urlstate.decode(SDX.urlstate.encode(micro))), micro);
});

test('urlstate: decode clamps numbers and snaps them to the controls\' steps', () => {
  const d = (q) => J(SDX.urlstate.decode(q));
  assert.equal(d('r=9').radiusMi, 3);
  assert.equal(d('r=0.1').radiusMi, 0.5);
  assert.equal(d('r=1.33').radiusMi, 1.25);
  assert.equal(d('h=3').hour, 6);
  assert.equal(d('h=99').hour, 22);
  assert.equal(d('h=10.1').hour, 10);
  assert.equal(d('h=abc').hour, undefined);
  assert.equal(d('r=NaN').radiusMi, undefined);
  assert.equal(d('r=Infinity').radiusMi, undefined);
});

test('urlstate: decode ignores unknown keys, filters, layers and values', () => {
  const d = SDX.urlstate.decode('f=hacker,openNow,near&l=sat,zzz,wind&src=evil&m=rh&v=cube&t=Nope!&x=1&near=yes');
  assert.deepEqual(J(d), { filters: ['openNow'], layers: ['sat', 'wind'], metric: 'rh' });
});

test('urlstate: decode never throws on garbage and rejects markup in ids', () => {
  for (const g of ['', '=', '====&&&', '%E0%A4%A', 'a', '&&&&', null, undefined, 42, {}, 'x'.repeat(5000)]) {
    assert.doesNotThrow(() => SDX.urlstate.decode(g), `input ${String(g).slice(0, 12)}`);
    assert.deepEqual(J(SDX.urlstate.decode(g)), {});
  }
  const d = J(SDX.urlstate.decode('a=<script>alert(1)</script>&s=../../etc&t=<b>'));
  assert.deepEqual(d, {});
  assert.deepEqual(J(SDX.urlstate.decode('#t=hotspots')), { tab: 'hotspots' });
});

test('urlstate: encode drops invalid values instead of writing them', () => {
  const s = SDX.urlstate.encode({ hour: NaN, radiusMi: Infinity, hood: '<x>', filters: ['openNow', 'near', 'bogus'], layers: ['sat', 'bogus'], sel: 'a b' });
  assert.equal(s, 'l=sat&f=openNow');
});

// ================================================================ radar + storm alerts
test('alerts: tropical, hurricane, winter-storm and freeze notices are kept; marine-only ones are not', () => {
  const now = Date.parse('2026-10-06T06:00:00-07:00');
  const f = (id, event, severity) => ({ properties: { id, event, severity, ends: '2026-10-08T20:00:00-07:00', headline: event, areaDesc: 'San Diego County Coastal Areas' } });
  const json = { features: [
    f('a', 'Tropical Storm Warning', 'Severe'), f('b', 'Hurricane Watch', 'Severe'), f('c', 'Winter Storm Warning', 'Severe'),
    f('d', 'Freeze Warning', 'Moderate'), f('e', 'Storm Surge Warning', 'Extreme'), f('f', 'Severe Thunderstorm Warning', 'Severe'),
    f('g', 'Special Marine Warning', 'Minor'), f('h', 'Small Craft Advisory', 'Minor'), f('i', 'Winter Weather Advisory', 'Minor'),
  ] };
  const ids = Array.from(SDX.alerts.relevant(json, now), (a) => a.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e', 'f', 'i']);
});

test('radar: six 10-minute frames, oldest first, newest is the live composite', () => {
  const fr = Array.from(SDX.radar.frames());
  assert.equal(fr.length, 6);
  assert.deepEqual(fr.map((f) => f.minAgo), [50, 40, 30, 20, 10, 0]);
  assert.equal(fr[5].id, 'nexrad-n0q-900913');
  assert.equal(fr[0].id, 'nexrad-n0q-900913-m50m');
  assert.equal(fr[4].id, 'nexrad-n0q-900913-m10m');
});

test('radar: tile url follows the Iowa State tile-cache pattern', () => {
  assert.equal(SDX.radar.tileUrl('nexrad-n0q-900913-m10m', 7, 22, 51), 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913-m10m/7/22/51.png');
  assert.match(SDX.radar.tileUrl('nexrad-n0q-900913', '{z}', '{x}', '{y}'), /\/\{z\}\/\{x\}\/\{y\}\.png$/);
});

test('radar: a few tiles cover the county and the pixel boxes stay inside each tile', () => {
  const tiles = Array.from(SDX.radar.countyTiles(7));
  assert.ok(tiles.length >= 1 && tiles.length <= 4, `tiles=${tiles.length}`);
  const centre = SDX.sat.tileXY(32.85, -117.0, 7);
  assert.ok(tiles.some((t) => t.x === centre.x && t.y === centre.y));
  let area = 0;
  for (const t of tiles) {
    const b = SDX.radar.pixelBox(t, 7);
    assert.ok(b && b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 256 && b.y1 <= 256 && b.x1 > b.x0 && b.y1 > b.y0);
    area += (b.x1 - b.x0) * (b.y1 - b.y0);
  }
  // county is ~1.54 deg wide by ~1 deg tall: ~140 x ~100 px at zoom 7 (pixels are ~2.8125/256 deg wide)
  assert.ok(area > 120 * 80 && area < 170 * 130, `area=${area}`);
  assert.equal(SDX.radar.pixelBox({ x: 0, y: 0 }, 7), null);
});

test('radar: echoCount counts non-transparent pixels inside the box only', () => {
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, a) => { rgba[(y * w + x) * 4 + 3] = a; };
  put(0, 0, 255); put(1, 1, 200); put(2, 2, 3); put(3, 3, 255);
  const all = SDX.radar.echoCount(rgba, w, h, { x0: 0, y0: 0, x1: 4, y1: 4 });
  assert.deepEqual({ echo: all.echo, total: all.total }, { echo: 3, total: 16 }); // alpha 3 is rounding noise, not rain
  const part = SDX.radar.echoCount(rgba, w, h, { x0: 0, y0: 0, x1: 2, y1: 2 });
  assert.deepEqual({ echo: part.echo, total: part.total }, { echo: 2, total: 4 });
});

test('radar: classify and trend words, with NaN-safe input', () => {
  const C = SDX.radar.classify;
  assert.equal(C(0, 1000).key, 'none');
  assert.equal(C(2, 1000).key, 'none');
  assert.equal(C(20, 1000).key, 'isolated');
  assert.equal(C(120, 1000).key, 'scattered');
  assert.equal(C(400, 1000).key, 'widespread');
  assert.equal(C(5, 0), null);
  assert.equal(C(NaN, 1000), null);
  const T = SDX.radar.trend;
  assert.equal(T(0.2, 0.05), 'increasing');
  assert.equal(T(0.05, 0.2), 'decreasing');
  assert.equal(T(0.1, 0.11), 'steady');
  assert.equal(T(0, 0), 'none');
  assert.equal(T(null, 0.1), null);
  assert.equal(T(NaN, 0.1), null);
});

test('urlstate: the radar layer round-trips', () => {
  assert.equal(SDX.urlstate.encode({ layers: ['radar', 'sat'] }), 'l=sat,radar');
  assert.deepEqual(J(SDX.urlstate.decode('l=radar,wind,zzz')), { layers: ['wind', 'radar'] });
});

test('sat: candidates walk back from the advertised newest frame in 10-minute steps', () => {
  assert.deepEqual(Array.from(SDX.sat.candidates('2026-10-06T05:20:00Z', 3)), ['2026-10-06T05:20:00Z', '2026-10-06T05:10:00Z', '2026-10-06T05:00:00Z']);
  assert.deepEqual(Array.from(SDX.sat.candidates('2026-10-06T00:00:00Z', 2)), ['2026-10-06T00:00:00Z', '2026-10-05T23:50:00Z']);
  assert.throws(() => SDX.sat.candidates('nope', 2), /satellite/i);
});
