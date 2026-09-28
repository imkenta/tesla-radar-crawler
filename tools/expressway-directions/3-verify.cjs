// 逐支驗證快速道路單向桿的羅盤標籤：與「離桿最近的單向車道」行車方向同側才算通過，產出白名單。
//   node 3-verify.cjs cams.json osm.json ../../data/expressway-direction-verified.json
// 通過條件（全部成立）：
//   1. 30m 內有單向（oneway）的 motorway／trunk／primary 主線（非匝道）；
//   2. 標籤方位與最近那條單向車道的行車方向差 < 60°；
//   3. 最近的「反向」單向車道（與最近車道差 > 90°）不存在，或至少遠 3m——座標落在中央分隔島上、
//      分不出是哪一側的一律不通過。
// 不通過的桿，同步時把 direction_bearing 清空（App 就不會拿它做方向排除，照報）。
const fs = require('fs');
const { parseDirection } = require('../../lib/speed-camera-metadata.cjs');
// 標籤一律由官方方向文字重算（同步後未通過的桿在資料庫裡方位已被清空，不能依賴 direction_bearing）。
const cams = require(process.argv[2])
  .filter(r => r.direction_mode === 'single' && r.lat != null && r.lng != null)
  .map(r => ({ ...r, direction_bearing: parseDirection(r.direction).bearing }))
  .filter(r => r.direction_bearing != null);
const ways = require(process.argv[3]).elements.filter(e => e.type === 'way' && e.geometry);
const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const norm = a => ((a % 360) + 360) % 360;
const adiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)); return d > 180 ? 360 - d : d; };
const bearing = (a, b) => { const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)); const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon)); return norm(deg(Math.atan2(y, x))); };
const toXY = (p, o) => ({ x: rad(p.lon - o.lon) * Math.cos(rad(o.lat)) * R, y: rad(p.lat - o.lat) * R });
const distToSeg = (p, a, b) => { const A = toXY(a, p), B = toXY(b, p); const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy; let t = L2 ? -(A.x * dx + A.y * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(A.x + t * dx, A.y + t * dy); };
const entries = [], rejected = [];
for (const c of cams) {
  const p = { lat: c.lat, lon: c.lng };
  const lanes = [];
  for (const w of ways) {
    const ow = w.tags.oneway;
    if (ow !== 'yes' && ow !== '-1' && ow !== 'true') continue;
    const g = w.geometry; let best = null;
    for (let i = 0; i + 1 < g.length; i++) { const d = distToSeg(p, g[i], g[i + 1]); if (!best || d < best.d) best = { d, b: bearing(g[i], g[i + 1]) }; }
    if (best && best.d <= 30) lanes.push({ d: best.d, b: ow === '-1' ? norm(best.b + 180) : best.b, ref: w.tags.ref || '' });
  }
  lanes.sort((a, b) => a.d - b.d);
  const near = lanes[0];
  let reason = null;
  if (!near) reason = '30m 內沒有單向主線';
  else {
    const opp = lanes.find(l => adiff(l.b, near.b) > 90);
    if (adiff(c.direction_bearing, near.b) >= 60) reason = `標籤 ${c.direction_bearing}° 與最近單向車道 ${Math.round(near.b)}° 差 ${Math.round(adiff(c.direction_bearing, near.b))}°`;
    else if (opp && opp.d - near.d < 3) reason = `座標在兩側車道之間分不出（${Math.round(near.d)}m／${Math.round(opp.d)}m）`;
  }
  const row = { road: c.road, lat: c.lat, lng: c.lng, label_bearing: c.direction_bearing };
  if (reason) rejected.push({ ...row, reason });
  else entries.push({ ...row, lane_bearing: Math.round(near.b), lane_distance_m: Math.round(near.d) });
}
entries.sort((a, b) => a.road.localeCompare(b.road) || a.lat - b.lat);
const out = { version: 1, generated_at: new Date().toISOString().slice(0, 10), how: 'tools/expressway-directions/README.md', entries };
fs.writeFileSync(process.argv[4], JSON.stringify(out, null, 1) + '\n');
console.log(`通過 ${entries.length}／不通過 ${rejected.length}（共 ${cams.length}）`);
for (const r of rejected) console.log(`  ✗ ${r.road}（${r.lat},${r.lng}）${r.reason}`);
