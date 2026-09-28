// 向 Overpass 取每支快速道路單向桿 60m 內的 motorway／trunk／primary（含幾何與 oneway），存成快取檔
const fs = require('fs');
const rows = require(process.argv[2]).filter(r => r.direction_mode === 'single' && r.lat != null && r.lng != null);
const parts = rows.map(r => `way(around:60,${r.lat},${r.lng})[highway~"^(motorway|trunk|primary)$"];`).join('\n');
const q = `[out:json][timeout:180];(\n${parts}\n);out tags geom;`;
(async () => {
  const eps = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (const ep of eps) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'evstudio-speed-camera-audit/1.0 (one-off offline audit)' }, body: 'data=' + encodeURIComponent(q) });
      if (!r.ok) { console.error(ep, 'HTTP', r.status); continue; }
      const j = await r.json();
      fs.writeFileSync(process.argv[3], JSON.stringify(j));
      console.log('ok from', ep, 'ways', j.elements.length, 'osm ts', j.osm3s && j.osm3s.timestamp_osm_base);
      return;
    } catch (e) { console.error(ep, e.message); }
  }
  process.exit(1);
})();
