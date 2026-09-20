// 向 Overpass 取每支國道桿周邊 120m 內的 motorway／motorway_link（含幾何），存成快取檔
const fs = require('fs');
const rows = require(process.argv[2]).filter(r => r.direction_mode === 'single');
const parts = rows.map(r => `way(around:120,${r.lat},${r.lng})[highway~"^(motorway|motorway_link|trunk)$"];`).join('\n');
const q = `[out:json][timeout:180];(\n${parts}\n);out tags geom;`;
(async () => {
  const eps = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (const ep of eps) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'evstudio-speed-camera-bearing/1.0 (one-off offline audit)' }, body: 'data=' + encodeURIComponent(q) });
      if (!r.ok) { console.error(ep, 'HTTP', r.status); continue; }
      const j = await r.json();
      fs.writeFileSync(process.argv[3], JSON.stringify(j));
      console.log('ok from', ep, 'ways', j.elements.length, 'osm ts', j.osm3s && j.osm3s.timestamp_osm_base);
      return;
    } catch (e) { console.error(ep, e.message); }
  }
  process.exit(1);
})();
