// 用實車 log 當 ground truth：每支「已通過」的國道桿，取通過當下前後的 GPS course，檢查新方位是否與實際行車方向同向
const fs = require('fs');
const B = Object.fromEntries(require(process.argv[2]).map(o => [o.road, o]));
const norm = a => ((a % 360) + 360) % 360, adiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)); return d > 180 ? 360 - d : d; };
const logs = process.argv.slice(3);
const rowsOut = []; 
for (const f of logs) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  let lastCourse = null, lastCourseT = null;
  const ts = s => { const m = /^\[(\d\d):(\d\d):(\d\d)\.(\d+)\]/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : null; };
  for (const ln of lines) {
    const t = ts(ln); if (t == null) continue;
    let m = /\[Nav-GPS\].*course=(-?\d+(?:\.\d+)?) courseAcc=(\d+(?:\.\d+)?) → ACCEPT/.exec(ln);
    if (m && +m[2] < 30 && +m[1] >= 0) { lastCourse = +m[1]; lastCourseT = t; continue; }
    m = /\[SpeedCamera\] 已通過（無導航[^）]*）road=(國道\S+)/.exec(ln);
    if (m) {
      const road = m[1]; const b = B[road];
      const fresh = lastCourseT != null && t - lastCourseT < 5;
      rowsOut.push({ log: f.split('/').pop().slice(8, 25), time: ln.slice(1, 9), road, course: fresh ? lastCourse : null, old: b ? b.old : null, neu: b ? b.newB : null, method: b ? b.method : 'NA' });
    }
  }
}
let okNew = 0, okOld = 0, n = 0, skipped = 0;
for (const r of rowsOut) {
  if (r.course == null || r.neu == null) { skipped++; continue; }
  n++; const dn = adiff(r.course, r.neu), dold = adiff(r.course, r.old);
  r.dNew = Math.round(dn); r.dOld = Math.round(dold);
  if (dn < 90) okNew++; if (dold < 90) okOld++;
}
console.log(`實車通過事件 ${rowsOut.length}（其中 ${skipped} 筆通過當下無新鮮 GPS course，多為隧道內，略過）`);
console.log(`以通過當下車頭為準：新方位判同向 ${okNew}/${n}；舊羅盤值判同向 ${okOld}/${n}`);
console.log('\n新方位與實際車頭的夾角分佈：'); const bk = { '<20': 0, '20-40': 0, '40-60': 0, '60-90': 0, '>=90': 0 }; for (const r of rowsOut) if (r.dNew != null) bk[r.dNew < 20 ? '<20' : r.dNew < 40 ? '20-40' : r.dNew < 60 ? '40-60' : r.dNew < 90 ? '60-90' : '>=90']++; console.log(bk);
console.log('舊羅盤值與實際車頭的夾角分佈：'); const bo = { '<20': 0, '20-40': 0, '40-60': 0, '60-90': 0, '>=90': 0 }; for (const r of rowsOut) if (r.dOld != null) bo[r.dOld < 20 ? '<20' : r.dOld < 40 ? '20-40' : r.dOld < 60 ? '40-60' : r.dOld < 90 ? '60-90' : '>=90']++; console.log(bo);
console.log('\n逐筆（舊夾角 ≥60° 或 新夾角 ≥40° 的才列）：');
for (const r of rowsOut) if (r.dNew != null && (r.dOld >= 60 || r.dNew >= 40)) console.log(`${r.log} ${r.time} ${r.road.padEnd(18)} 車頭=${r.course} 舊=${r.old}(差${r.dOld}) 新=${r.neu}(差${r.dNew}) ${r.method}`);
