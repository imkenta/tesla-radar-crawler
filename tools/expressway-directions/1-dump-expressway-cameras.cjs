// 唯讀：用 anon key 走 PostgREST 把快速道路 confirmed 桿抓成 JSON（與 App 讀資料的通道相同）
const fs = require('fs');
const url = process.env.VITE_SUPABASE_URL, key = process.env.VITE_SUPABASE_ANON_KEY;
(async () => {
  const q = `${url}/rest/v1/speed_cameras?select=id,source,road,direction,lat,lng,direction_bearing,direction_mode&road_class=eq.expressway&speed_status=eq.confirmed&order=road.asc&limit=1000`;
  const r = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  const rows = await r.json();
  fs.writeFileSync(process.argv[2], JSON.stringify(rows, null, 1));
  console.log('rows', rows.length, 'single', rows.filter(x => x.direction_mode === 'single').length);
})().catch(e => { console.error(e.message); process.exit(1); });
