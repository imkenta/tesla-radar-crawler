const fs = require('fs');
const cams = require(process.argv[2]).filter(r => r.direction_mode === 'single');
const waysA = require(process.argv[3]).elements, waysB = require(process.argv[4]).elements;
const seen = new Set(); const ways = [...waysA, ...waysB].filter(e => e.type === 'way' && e.geometry && !seen.has(e.id) && seen.add(e.id));
const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const norm = a => ((a % 360) + 360) % 360;
const adiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)); return d > 180 ? 360 - d : d; };
const bearing = (a, b) => { const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)); const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon)); return norm(deg(Math.atan2(y, x))); };
const toXY = (p, o) => ({ x: rad(p.lon - o.lon) * Math.cos(rad(o.lat)) * R, y: rad(p.lat - o.lat) * R });
const distToSeg = (p, a, b) => { const A = toXY(a, p), B = toXY(b, p); const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy; let t = L2 ? -(A.x * dx + A.y * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(A.x + t * dx, A.y + t * dy); };
const cmean = bs => norm(deg(Math.atan2(bs.reduce((s, b) => s + Math.sin(rad(b)), 0), bs.reduce((s, b) => s + Math.cos(rad(b)), 0))));
const NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 八: 8, 十: 10 };
const parseRoad = road => { const m = /^國道([一二三四五六八十])號(甲線)?(五楊|汐五)?\s*(北|南|東|西)向\s*([0-9.]+)\s*(?:公里|[Kk])/.exec(road || ''); return m ? { fw: NUM[m[1]] + (m[2] ? 'A' : ''), dir: m[4], km: parseFloat(m[5]) } : null; };
const P = cams.map(c => ({ c, p: parseRoad(c.road), pt: { lat: c.lat, lon: c.lng } }));
const byFw = {}; for (const x of P) if (x.p) (byFw[x.p.fw] = byFw[x.p.fw] || []).push(x);
for (const x of P) { let best = Infinity; for (const w of ways) { const g = w.geometry; for (let i = 0; i + 1 < g.length; i++) { const d = distToSeg(x.pt, g[i], g[i + 1]); if (d < best) best = d; } } x.onRoad = best <= 150; x.roadDist = Math.round(best); }


// 穩健的「里程遞增方向」：±WIN km 內所有桿兩兩連線（里程差 ≥0.8km），取圓平均 → 剔除偏離 >50° 的 → 再平均
function robustIncreasing(list, x, WIN) {
  const loc = list.filter(y => Math.abs(y.p.km - x.p.km) <= WIN && (y.onRoad || y === x));
  let bs = [];
  for (let i = 0; i < loc.length; i++) for (let j = 0; j < loc.length; j++) { const a = loc[i], b = loc[j]; if (b.p.km - a.p.km >= 0.8) bs.push(bearing(a.pt, b.pt)); }
  if (bs.length < 1) return null;
  let m = cmean(bs); const kept = bs.filter(b => adiff(b, m) <= 50);
  if (kept.length) m = cmean(kept);
  return { b: m, pairs: bs.length, agree: kept.length / bs.length };
}
const out = [];
for (const fw of Object.keys(byFw)) {
  const list = byFw[fw].sort((a, b) => a.p.km - b.p.km);
  for (const x of list) {
    let inc = null; for (const W of [8, 15, 30, 60]) { inc = robustIncreasing(list, x, W); if (inc && inc.pairs >= 3) break; }
    const increasing = (x.p.dir === '南' || x.p.dir === '東');
    const chord = inc ? norm(increasing ? inc.b : inc.b + 180) : null;
    const cands = [];
    for (const w of ways) { const g = w.geometry; let best = null; for (let i = 0; i + 1 < g.length; i++) { const d = distToSeg(x.pt, g[i], g[i + 1]); if (!best || d < best.d) best = { d, b: bearing(g[i], g[i + 1]) }; } if (best && best.d <= 400) { let b = best.b; if (w.tags.oneway === '-1') b = norm(b + 180); cands.push({ d: best.d, b, hw: w.tags.highway, ref: w.tags.ref || '', id: w.id }); } }
    const rank = k => (k.hw === 'motorway' ? 0 : k.hw === 'trunk' ? 1 : 2);
    const ok = chord == null ? [] : cands.filter(k => adiff(k.b, chord) < 60).sort((a, b) => rank(a) - rank(b) || a.d - b.d);
    const pick = ok[0] || null;
    const newB = pick ? Math.round(pick.b) : (chord != null ? Math.round(chord) : null);
    out.push({ id: x.c.id, road: x.c.road, fw, km: x.p.km, dir: x.p.dir, lat: x.c.lat, lng: x.c.lng, old: x.c.direction_bearing, chord: chord == null ? null : Math.round(chord), chordPairs: inc ? inc.pairs : 0, chordAgree: inc ? +inc.agree.toFixed(2) : null, osm: pick ? Math.round(pick.b) : null, osmDist: pick ? Math.round(pick.d) : null, osmHw: pick ? pick.hw : null, nCands: cands.length, newB, method: pick ? 'osm' : (chord != null ? 'chord' : 'none'), dOldNew: newB == null ? null : Math.round(adiff(newB, x.c.direction_bearing)), dChordOsm: pick && chord != null ? Math.round(adiff(pick.b, chord)) : null });
  }
}
fs.writeFileSync(process.argv[5], JSON.stringify(out, null, 1));
const m = {}; for (const o of out) m[o.method] = (m[o.method] || 0) + 1; console.log('method:', m, 'total', out.length);
const bk = { '<30': 0, '30-60': 0, '60-90': 0, '>=90': 0 }; for (const o of out) { const d = o.dOldNew; bk[d < 30 ? '<30' : d < 60 ? '30-60' : d < 90 ? '60-90' : '>=90']++; } console.log('|舊−新|:', bk);
console.log('\n=== 舊值已判反（≥90°）===');
for (const o of out.filter(o => o.dOldNew >= 90).sort((a, b) => b.dOldNew - a.dOldNew)) console.log(`${String(o.dOldNew).padStart(3)}°  ${o.road.padEnd(18)} 舊=${o.old} 新=${o.newB}（${o.method}${o.osmDist != null ? ' ' + o.osmDist + 'm' : ''}；弦=${o.chord} 對數=${o.chordPairs} 一致=${o.chordAgree}）`);
console.log('\n=== 需人工看：非 OSM／OSM 距離>40m／弦一致度<0.7／OSM 與弦差>45° ===');
for (const o of out.filter(o => o.method !== 'osm' || o.osmDist > 40 || (o.chordAgree != null && o.chordAgree < 0.7) || (o.dChordOsm != null && o.dChordOsm > 45))) console.log(`${o.road.padEnd(18)} 新=${o.newB} method=${o.method} osmDist=${o.osmDist} 弦=${o.chord} 對數=${o.chordPairs} 一致=${o.chordAgree} 弦↔osm=${o.dChordOsm} 舊=${o.old} (${o.lat},${o.lng})`);
