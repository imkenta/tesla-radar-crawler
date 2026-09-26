'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyFreewayBearingOverrides,
  logFreewayBearingResult,
  MATCH_RADIUS_M,
  DEFAULT_TABLE_PATH,
} = require('../lib/freeway-bearing-overrides.cjs');

const table = require(DEFAULT_TABLE_PATH);

const cam = (over = {}) => ({
  road: '國道一號五楊北向38.8公里', lat: 25.065003, lng: 121.383882,
  road_class: 'freeway', direction_mode: 'single', direction: '南往北', direction_bearing: 0,
  ...over,
});
const angleDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };

test('國道單向桿套用表上的實際走向，且不改動傳入的物件', () => {
  const input = [cam()];
  const r = applyFreewayBearingOverrides(input);
  assert.equal(r.applied, 1);
  assert.equal(r.records[0].direction_bearing, 81);
  assert.equal(input[0].direction_bearing, 0, '不得就地修改');
  assert.equal(r.records[0].direction, '南往北', '官方方向文字原樣保留');
});

test('非國道、雙向、缺座標的紀錄完全不動', () => {
  const others = [
    cam({ road_class: 'ordinary' }),
    cam({ road_class: 'expressway' }),
    cam({ direction_mode: 'bidirectional', direction_bearing: null }),
    cam({ lat: null }),
  ];
  const r = applyFreewayBearingOverrides(others);
  assert.equal(r.applied, 0);
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(r.records, others);
});

test('同路名但座標搬家超過容許半徑 → 退回羅盤值並回報', () => {
  const moved = cam({ lat: 25.065003 + 0.001 }); // ≈111m
  const r = applyFreewayBearingOverrides([moved]);
  assert.equal(r.applied, 0);
  assert.equal(r.records[0].direction_bearing, 0);
  assert.deepEqual(r.unmatched, ['國道一號五楊北向38.8公里']);
  assert.ok(MATCH_RADIUS_M < 111);
});

test('表上沒有的新桿 → 退回羅盤值並回報', () => {
  const r = applyFreewayBearingOverrides([cam({ road: '國道一號北向999公里' })]);
  assert.equal(r.records[0].direction_bearing, 0);
  assert.deepEqual(r.unmatched, ['國道一號北向999公里']);
});

test('表上標 keep_compass 的桿維持羅盤值、不算 unmatched', () => {
  const keep = table.entries.find((e) => e.keep_compass);
  assert.ok(keep, '表上應有 keep_compass 的桿');
  const r = applyFreewayBearingOverrides([cam({ road: keep.road, lat: keep.lat, lng: keep.lng, direction_bearing: 180 })]);
  assert.equal(r.records[0].direction_bearing, 180);
  assert.equal(r.keptCompass, 1);
  assert.deepEqual(r.unmatched, []);
});

test('警告行只在有對不上的桿時出現', () => {
  const lines = [];
  logFreewayBearingResult('x', { applied: 0, keptCompass: 0, unmatched: [] }, (l) => lines.push(l));
  assert.equal(lines.length, 0);
  logFreewayBearingResult('x', { applied: 3, keptCompass: 1, unmatched: ['國道一號北向999公里'] }, (l) => lines.push(l));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /⚠️/);
});

// ── 表本身的健全性 ───────────────────────────────────────────────

test('方位表：每筆不是 0–359 的整數方位就是 keep_compass，且 (路名, 座標) 不重複', () => {
  const seen = new Set();
  for (const e of table.entries) {
    assert.match(e.road, /^國道/);
    assert.ok(Number.isFinite(e.lat) && Number.isFinite(e.lng), e.road);
    if (e.keep_compass) assert.ok(e.reason, `${e.road} 要寫明為什麼維持羅盤值`);
    else assert.ok(Number.isInteger(e.bearing) && e.bearing >= 0 && e.bearing < 360, e.road);
    const key = `${e.road}|${e.lat}|${e.lng}`;
    assert.ok(!seen.has(key), `重複：${key}`);
    seen.add(key);
  }
  assert.equal(table.entries.filter((e) => !e.keep_compass).length, 170);
  assert.equal(table.entries.filter((e) => e.keep_compass).length, 18);
});

// 2026-09-19 實車 ground truth（TeslaToolbox C-64）：通過／預警當下的 GPS course。
// 真桿：新方位與車頭必須同向（夾角 <45°）；對向誤報的桿：必須被判成對向（夾角 >135°）。
const GROUND_TRUTH = [
  // [路名, 當下車頭, 應為同向?]
  ['國道一號五楊北向38.8公里', 90, true],   // 回程，舊值讓它 109m 才報
  ['國道一號汐五北向16公里', 90, true],     // 回程，389m 才報
  ['國道一號南向22.7公里', 270, true],      // 去程，401m 才報
  ['國道一號北向14.5公里', 82, true],
  ['國道一號南向13.7公里', 263, true],
  ['國道一號汐五南向16.1公里', 263, true],
  ['國道一號南向34.4公里', 267, true],
  ['國道五號南向13.3公里', 106, true],
  ['國道五號北向5.7公里', 307, true],
  ['國道三號北向14.5公里', 9, true],
  ['國道一號北向37公里', 269, false],        // 去程南下，對向桿 50m 誤報
  ['國道一號五楊北向38.8公里', 281, false],  // 去程南下，對向桿 543m 誤報
  ['國道一號汐五南向29.5公里', 89, false],   // 回程北上，對向桿誤報
  ['國道一號南向22.7公里', 95, false],       // 回程北上，對向桿誤報
  ['國道一號汐五南向16.1公里', 92, false],   // 回程北上，對向桿誤報
];

test('方位表：2026-09-19 實車的真桿同向、對向誤報的桿判成對向', () => {
  for (const [road, course, shouldMatch] of GROUND_TRUTH) {
    const e = table.entries.find((x) => x.road === road && !x.keep_compass);
    assert.ok(e, `${road} 應在表內且有方位`);
    const d = angleDiff(e.bearing, course);
    if (shouldMatch) assert.ok(d < 45, `${road} 車頭 ${course}° 應同向，實得夾角 ${d}°`);
    else assert.ok(d > 135, `${road} 車頭 ${course}° 應為對向，實得夾角 ${d}°`);
  }
});

test('方位表：同一里程點的南北（東西）向兩支桿方位必須大致相反', () => {
  const byKey = new Map();
  for (const e of table.entries.filter((x) => !x.keep_compass)) {
    const m = /^(國道.+?號(?:甲線)?(?:五楊|汐五)?)(北|南|東|西)向([0-9.]+)公里$/.exec(e.road);
    if (!m) continue;
    const k = `${m[1]}|${Math.round(parseFloat(m[3]))}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ dir: m[2], e });
  }
  let pairs = 0;
  for (const list of byKey.values()) {
    for (const a of list) for (const b of list) {
      const opposite = (a.dir === '北' && b.dir === '南') || (a.dir === '東' && b.dir === '西');
      if (!opposite) continue;
      pairs += 1;
      assert.ok(angleDiff(a.e.bearing, b.e.bearing) > 120,
        `${a.e.road}（${a.e.bearing}°）與 ${b.e.road}（${b.e.bearing}°）應大致相反`);
    }
  }
  assert.ok(pairs >= 10, `應有足夠的對向配對可驗（實得 ${pairs}）`);
});

// 2026-09-25 宜蘭→台中長途實車（TeslaToolbox C-64 續驗）：軌跡 60m 內經過當下的 GPS course。
// 國四東向 24.778K 在 S 形彎上（車頭 280°），表上原本寫 102°＝對向車道的切線 ⇒ 真桿被當對向排除、漏報。
const GROUND_TRUTH_0925 = [
  ['國道四號東向24.778公里', 280, true],
  ['國道四號西向23.3公里', 185, false],
  ['國道一號南向60.1公里', 226, true],
  ['國道一號南向78.2公里', 261, true],
  ['國道一號南向81.8公里', 274, true],
  ['國道一號南向86.5公里', 200, true],
  ['國道一號南向124公里', 178, true],
  ['國道一號南向129.15公里', 200, true],
  ['國道一號南向165.3公里', 180, true],
  ['國道一號北向63.7公里', 192, false],
  ['國道一號北向82.1公里', 275, false],
  ['國道一號北向127.5公里', 215, false],
  ['國道一號北向157.4公里', 207, false],
];

test('方位表：2026-09-25 實車（含國四 S 形彎）真桿同向、對向桿判成對向', () => {
  for (const [road, course, shouldMatch] of GROUND_TRUTH_0925) {
    const e = table.entries.find((x) => x.road === road && !x.keep_compass);
    assert.ok(e, `${road} 應在表內且有方位`);
    const d = angleDiff(e.bearing, course);
    if (shouldMatch) assert.ok(d < 45, `${road} 車頭 ${course}° 應同向，實得夾角 ${d}°`);
    else assert.ok(d > 135, `${road} 車頭 ${course}° 應為對向，實得夾角 ${d}°`);
  }
});

// 局部鄰桿守門（2026-09-26）：同一條國道、里程差 0.5–3km 的鄰桿連線給出「里程遞增方向」；
// 表上的方位與它（依南／東＝遞增、北／西＝遞減換算後）差 ≥90° ＝挑到對向車道，必須擋下。
// 彎道上鄰桿弦與切線可差 60° 以上（國四 24.778K：弦 215°、切線 281°），所以門檻只要求「同側」。
test('方位表：每支改寫的桿與局部鄰桿方向同側（差 <90°）', () => {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const brg = (a, b) => {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  };
  const cmean = (bs) => ((Math.atan2(bs.reduce((s, b) => s + Math.sin(rad(b)), 0), bs.reduce((s, b) => s + Math.cos(rad(b)), 0)) * 180) / Math.PI + 360) % 360;
  const dist = (a, b) => Math.hypot(rad(b.lng - a.lng) * Math.cos(rad(a.lat)), rad(b.lat - a.lat)) * R;
  const parsed = table.entries.filter((e) => !e.keep_compass).map((e) => {
    const m = /^國道(.+?號(?:甲線)?)(?:五楊|汐五)?(北|南|東|西)向([0-9.]+)公里$/.exec(e.road);
    return m && { e, fw: m[1], inc: m[2] === '南' || m[2] === '東', km: parseFloat(m[3]) };
  }).filter(Boolean);
  let checked = 0;
  for (const x of parsed) {
    // 座標距離也要合理（≤ 里程差×1.6＋300m），排除來源座標錯置的鄰桿
    const near = parsed.filter((y) => y !== x && y.fw === x.fw
      && Math.abs(y.km - x.km) >= 0.5 && Math.abs(y.km - x.km) <= 3
      && dist(x.e, y.e) <= Math.abs(y.km - x.km) * 1000 * 1.6 + 300);
    if (!near.length) continue;
    const local = cmean(near.map((y) => (y.km > x.km ? brg(x.e, y.e) : brg(y.e, x.e))));
    const expect = x.inc ? local : (local + 180) % 360;
    const d = angleDiff(x.e.bearing, expect);
    assert.ok(d < 90, `${x.e.road} 表上 ${x.e.bearing}° 與局部鄰桿方向 ${Math.round(expect)}° 差 ${Math.round(d)}°（疑似挑到對向車道）`);
    checked += 1;
  }
  assert.ok(checked >= 80, `應有足夠的桿可驗（實得 ${checked}）`);
});
