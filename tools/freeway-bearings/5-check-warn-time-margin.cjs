// 方向判定實際發生在「預警當下」（桿前 ~500m）——量那一刻的車頭與新／舊方位的夾角，確認彎道上游也有足夠餘裕
const fs = require('fs');
const B = Object.fromEntries(require(process.argv[2]).map(o => [o.road, o]));
const norm = a => ((a % 360) + 360) % 360, adiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)); return d > 180 ? 360 - d : d; };
const out = [];
for (const f of process.argv.slice(3)) {
  let c = null, ct = null;
  const ts = s => { const m = /^\[(\d\d):(\d\d):(\d\d)\.(\d+)\]/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : null; };
  for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = ts(ln); if (t == null) continue;
    let m = /\[Nav-GPS\].*course=(-?\d+(?:\.\d+)?) courseAcc=(\d+(?:\.\d+)?) → ACCEPT/.exec(ln);
    if (m && +m[2] < 30 && +m[1] >= 0) { c = +m[1]; ct = t; continue; }
    m = /觸發預警（無導航）.*road=(國道\S+) .*distance=(\d+)m/.exec(ln);
    if (m && B[m[1]] && ct != null && t - ct < 5) out.push({ f: f.slice(-21, -4), time: ln.slice(1, 9), road: m[1], dist: +m[2], course: c, dOld: Math.round(adiff(c, B[m[1]].old)), dNew: Math.round(adiff(c, B[m[1]].newB)) });
  }
}
console.log('預警當下（有新鮮 GPS course 的）共', out.length, '筆');
for (const r of out) console.log(`${r.f} ${r.time} ${r.road.padEnd(18)} 距離=${String(r.dist).padStart(3)}m 車頭=${String(r.course).padStart(3)}  舊夾角=${String(r.dOld).padStart(3)}  新夾角=${String(r.dNew).padStart(3)}  ${r.dNew > 90 ? '← 新方位會排除（對向）' : ''}`);
const gen = out.filter(r => r.dNew <= 90); console.log('\n真桿（新方位判同向）預警當下夾角：最大', Math.max(...gen.map(r => r.dNew)), '°，平均', (gen.reduce((s, r) => s + r.dNew, 0) / gen.length).toFixed(1), '°');
console.log('同一批真桿用舊羅盤值：最大', Math.max(...gen.map(r => r.dOld)), '°，平均', (gen.reduce((s, r) => s + r.dOld, 0) / gen.length).toFixed(1), '°');
