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
