'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseTainan } = require('../lib/speed-camera-parser.cjs');

test('台南官方 2026-10-01 CSV：換行表頭、行政區文字、南往北向，仍 fail closed', () => {
  const records = parseTainan(fs.readFileSync(`${__dirname}/fixtures/speed-camera-tainan-20261001.csv`));
  assert.equal(records.length, 191);
  assert.equal(records.filter(r => r.direction).length, 191);
  assert.equal(records[0].address, '新營區 臺1線290.3公里與東山路口');
  assert.equal(records[0].direction, '南往北向');
  assert.equal(records[0].direction_mode, 'single');
  assert.equal(records[0].direction_bearing, 0);
  assert.equal(records[0].speed_status, 'unknown');
});

test('台南代碼/文字相容，只接受已知行政區；缺必要表頭要報錯', () => {
  for (const district of ['67000010','新營區']) {
    const [r] = parseTainan(Buffer.from(`轄區分局, 行政區 ,設置位置,拍攝 行向,速限\n新營分局,${district},臺1線290.3公里與東山路口,西往東向,50\n`));
    assert.equal(r.address, '新營區 臺1線290.3公里與東山路口');
    assert.equal(r.direction_bearing, 90);
  }
  assert.throws(() => parseTainan(Buffer.from('行政區,地點\n新營區,某路\n')), /表頭/);
});

const { isWithinTainan, enrichTainanFromNpa, fillTainanMissingCoords, NEGATIVE_TTL_MS,
  loadTainanNegativeCache, saveTainanNegativeCache } = require('../lib/tainan-camera-enrichment.cjs');
const { coordLookupKey, dedupeAgainstExisting, toUpsertPayload } = require('../lib/speed-camera-writer.cjs');
const point = (overrides = {}) => ({ source: 'tainan', city: '臺南市', address: '新營區 臺1線290.3公里與東山路口',
  road: '臺1線290.3公里與東山路口', direction: '南往北向', speed_limit: 50, lat: null, lng: null,
  speed_status: 'unknown', taxonomy_basis: 'insufficient_evidence', ...overrides });
const npaPoint = (overrides = {}) => point({ source: 'national-npa', direction: '北向', speed_status: 'confirmed',
  lat: 23.308907, lng: 120.32573, fetched_at: '2026-10-01T00:00:00Z', ...overrides });

test('台南官方市界：含臺南點，拒絕中國、台北及 bbox 內鄰市點與非法值', () => {
  for (const [lat, lng] of [[23.308907,120.32573],[22.920004,120.225494],[23.155445,120.48853]])
    assert.equal(isWithinTainan(lat, lng), true);
  // 高雄阿蓮及嘉義水上皆在台南整體 bbox 內，仍必須被多邊形拒絕。
  for (const [lat, lng] of [[22.883,120.327],[23.428,120.4],[25.03,121.56],[34,113],[null,120.2],[NaN,120.2],['23',120.2]])
    assert.equal(isWithinTainan(lat, lng), false);
});

test('NPA 嚴格逐筆佐證：位置、方向、速限和行政區相符才補 confirmed；trace 進 payload', () => {
  const result = enrichTainanFromNpa([point()], [npaPoint()]);
  assert.equal(result.matches.length, 1);
  const record = result.records[0];
  assert.equal(record.speed_status, 'confirmed');
  assert.equal(record.lat, 23.308907);
  assert.equal(record.direction, '南往北向');
  assert.equal(record.taxonomy_source_url, 'https://data.gov.tw/dataset/7320');
  assert.match(toUpsertPayload(record, '2026-10-01').taxonomy_basis, /coords:official_npa/);
  const { kept } = dedupeAgainstExisting([npaPoint()], [record], 30);
  assert.equal(kept.length, 0); // 全國集原有去重保留原樣。
});

test('NPA 外市／錯里程／錯方向／速限衝突／歧義／非測速一律 fail closed', () => {
  for (const candidate of [npaPoint({city:'高雄市'}),npaPoint({address:'新營區 臺1線290.4公里與東山路口'}),
    npaPoint({direction:'南向'}),npaPoint({lat:22.883,lng:120.327}),npaPoint({speed_limit:60})]) {
    const result = enrichTainanFromNpa([point()], [candidate]);
    assert.equal(result.matches.length, 0);
    assert.equal(result.records[0].lat, null);
    assert.equal(result.records[0].speed_status, 'unknown');
  }
  assert.equal(enrichTainanFromNpa([point()], [npaPoint(),npaPoint()]).matches.length, 0);
  assert.equal(enrichTainanFromNpa([point({speed_status:'rejected'})], [npaPoint()]).matches.length, 0);
  assert.equal(enrichTainanFromNpa([point({speed_measurement_mode:'section_average'})], [npaPoint()]).matches.length, 0);
  assert.equal(enrichTainanFromNpa([point({direction:'雙向'})], [npaPoint({direction:'東西向'})]).matches.length, 0);
  assert.equal(enrichTainanFromNpa([point({address:'臺1線290.3公里與東山路口'})], [npaPoint()]).matches.length, 0);
  const other = point({source:'other',lat:25,lng:121});
  assert.deepEqual(enrichTainanFromNpa([other], [npaPoint()]).records, [other]);
});

test('台南補值對新查／DB沿用／既有列都拒絕市外座標，mock 不真打 Nominatim', async () => {
  const r=point();const key=coordLookupKey(r.source,r.address,r.direction);
  const result = await fillTainanMissingCoords([point({lat:22.883,lng:120.327})],
    new Map([[key,{lat:25,lng:121}]]),async () => ({lat:23.428,lng:120.4}),100);
  assert.equal(result.records[0].lat, null);
  assert.equal(result.geocodeSucceeded,0);
  assert.equal(result.reusedFromDb,0);
});

test('191筆負快取讓尾端91筆下一輪輪到，到期仍優先最久未查者；輸出順序不變', async () => {
  const records=Array.from({length:191},(_,i)=>point({address:`新營區 地址${i}`}));
  const calls=[];const geocode=async q=>(calls.push(q),null),cache={};
  const now=1800000000000;
  const first=await fillTainanMissingCoords(records,new Map(),geocode,100,{cache,now});
  assert.equal(first.geocodeAttempted,100);assert.equal(first.skippedOverCap,91);
  const second=await fillTainanMissingCoords(records,new Map(),geocode,100,{cache,now:now+7*86400000});
  assert.equal(second.geocodeAttempted,91);assert.equal(second.skippedNegativeCache,100);
  assert.equal(calls[100],'臺南市新營區 地址100');
  calls.length=0;
  await fillTainanMissingCoords(records,new Map(),geocode,1,{cache,now:now+NEGATIVE_TTL_MS+8*86400000});
  assert.equal(calls[0],'臺南市新營區 地址0');
  assert.deepEqual(second.records.map(r=>r.address),records.map(r=>r.address));
});

test('負快取跨程序保存，損毀可恢復；既有正確座標不受負快取遮蔽', async (t) => {
  const dir=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'tainan-cache-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=`${dir}/cache.json`;saveTainanNegativeCache({a:123},file);
  assert.deepEqual(loadTainanNegativeCache(file),{a:123});
  fs.writeFileSync(file,'broken');assert.deepEqual(loadTainanNegativeCache(file),{});
  const r=point(),key=coordLookupKey(r.source,r.address,r.direction),cache={[key]:Date.now()};
  const result=await fillTainanMissingCoords([r],new Map([[key,{lat:23.308907,lng:120.32573}]]),
    async()=>{throw new Error('不應 geocode');},100,{cache});
  assert.equal(result.reusedFromDb,1);assert.equal(result.geocodeAttempted,0);
});

test('完整官方快照：106 筆借座標後原有139筆臺南 NPA 點位覆蓋不減', () => {
  const { parseNationalNpa } = require('../lib/speed-camera-parser.cjs');
  const { haversineMeters } = require('../lib/speed-camera-writer.cjs');
  const tainan=parseTainan(fs.readFileSync(`${__dirname}/fixtures/speed-camera-tainan-20261001.csv`));
  const npa=parseNationalNpa(fs.readFileSync(`${__dirname}/fixtures/speed-camera-npa-tainan-20261001.csv`));
  const enrichment=enrichTainanFromNpa(tainan,npa);
  assert.equal(npa.length,139);assert.equal(enrichment.matches.length,106);
  const visible=enrichment.records.filter(r=>r.speed_status==='confirmed'&&r.lat!=null&&r.lng!=null);
  const {kept,droppedCount}=dedupeAgainstExisting(npa,visible,30);
  assert.equal(droppedCount,106);assert.equal(kept.length,33);
  for(const original of npa) assert.ok([...kept,...visible].some(p=>haversineMeters(original.lat,original.lng,p.lat,p.lng)<=30));
  assert.equal(enrichment.records.filter(r=>r.speed_status==='confirmed').length,107);
  assert.equal(enrichment.records.filter(r=>r.speed_status==='unknown').length,83);
});


test('官方第123筆區間：保持平均速率類型，既有/DB/geocode 都不得變單點', async () => {
  const row = parseTainan(fs.readFileSync(`${__dirname}/fixtures/speed-camera-tainan-20261001.csv`))[122];
  assert.equal(row.speed_measurement_mode, 'section_average');
  assert.equal(row.sensor_technology, 'average_speed');
  assert.equal(row.camera_type, 'section');
  assert.match(row.taxonomy_basis, /official_record_override:tainan_pdf:123:page8/);
  for (const existingLat of [null, 22.950447]) {
    const r = {...row, lat:existingLat, lng:existingLat == null ? null : 120.38326};
    const db = new Map([[coordLookupKey(r.source,r.address,r.direction),{lat:22.950447,lng:120.38326}]]);
    const fill = await fillTainanMissingCoords([r],db,async()=>{throw new Error('禁止區間 geocode');},100);
    assert.equal(fill.records[0].lat,null);assert.equal(fill.records[0].lng,null);
    assert.equal(fill.reusedFromDb,0);assert.equal(fill.geocodeAttempted,0);
    assert.equal(fill.skippedNonPoint,1);
  }
  const changedCsv='行政區,設置位置,拍攝行向,速限\n龍崎區,一、市道182線27公里至28公里，超速,雙向,50\n';
  const changed=parseTainan(Buffer.from(changedCsv))[0];
  assert.equal(changed.speed_measurement_mode,'unknown','未核對的新版範圍不可誤套第123筆或推測point');
  assert.match(changed.taxonomy_basis,/ambiguous_non_point_location/);
  const ambiguous = point({address:'新營區 一、某路1公里至2公里處',speed_measurement_mode:'point'});
  const result=await fillTainanMissingCoords([ambiguous],new Map(),async()=>({lat:23.308907,lng:120.32573}),100);
  assert.equal(result.records[0].lat,null);assert.equal(result.geocodeAttempted,0);
});

const { parseIntersectionAddress } = require('../lib/tainan-camera-enrichment.cjs');

test('parseIntersectionAddress：路口型拆兩路，路名含「段」整個保留；非路口型回 null', () => {
  assert.deepEqual(parseIntersectionAddress('中西區 中山路與西華南街口'), { district: '中西區', roadA: '中山路', roadB: '西華南街' });
  assert.deepEqual(parseIntersectionAddress('中西區 中華西路二段與民權路口'), { district: '中西區', roadA: '中華西路二段', roadB: '民權路' });
  assert.deepEqual(parseIntersectionAddress('仁德區 中山路與中正路三段路口'), { district: '仁德區', roadA: '中山路', roadB: '中正路三段' });
  assert.deepEqual(parseIntersectionAddress('永康區 中華路與中山南路交叉口'), { district: '永康區', roadA: '中華路', roadB: '中山南路' });
  for (const addr of ['新營區 臺1線290.3公里與東山路', '新營區 中山路一段', '中山路與中正路口', '', null, undefined])
    assert.equal(parseIntersectionAddress(addr), null);
});

test('台南路口型地址走交點法（一筆計 2 次呼叫）；非路口型維持整串查；上限與負快取沿用', async () => {
  const records = [
    point({ address: '中西區 中山路與西華南街口', direction: '多向' }),
    point({ address: '新營區 某某路一段', direction: '南往北向' }),
  ];
  const full = [], inter = [];
  const fillWith = (cap, cache = {}, extra = {}) => fillTainanMissingCoords(records, new Map(),
    async (q) => (full.push(q), { lat: 23.308907, lng: 120.32573 }), cap,
    { cache, geocodeIntersectionFn: async (...args) => (inter.push(args), { lat: 22.9955535, lng: 120.2098173 }), ...extra });
  const r = await fillWith(100);
  assert.deepEqual(inter, [['臺南市中西區', '中山路', '西華南街']]);
  assert.deepEqual(full, ['臺南市新營區 某某路一段']);
  assert.equal(r.geocodeAttempted, 3); // 交點 2 + 整串 1
  assert.equal(r.geocodeSucceeded, 2);
  assert.equal(r.records[0].lat, 22.9955535);
  assert.match(r.records[0].taxonomy_basis, /coords:nominatim:intersection:tainan_city_boundary/);
  assert.doesNotMatch(r.records[1].taxonomy_basis, /intersection/);

  // 上限 2：交點法吃掉 2，整串那筆超過上限
  inter.length = 0; full.length = 0;
  const capped = await fillWith(2);
  assert.equal(capped.geocodeAttempted, 2);
  assert.equal(capped.skippedOverCap, 1);
  assert.equal(full.length, 0);

  // 上限 1：交點法放不下（需 2）→ 略過；整串那筆仍可查
  inter.length = 0; full.length = 0;
  const one = await fillWith(1);
  assert.equal(inter.length, 0);
  assert.equal(full.length, 1);
  assert.equal(one.geocodeAttempted, 1);

  // 交點法失敗 → 寫負快取；沒傳 geocodeIntersectionFn 就走舊的整串路徑
  const cache = {};
  const failed = await fillTainanMissingCoords([records[0]], new Map(), async () => null, 100,
    { cache, now: 1800000000000, geocodeIntersectionFn: async () => null });
  assert.equal(failed.geocodeSucceeded, 0);
  assert.equal(Object.keys(cache).length, 1);
  const legacy = [];
  await fillTainanMissingCoords([records[0]], new Map(), async (q) => (legacy.push(q), null), 100, {});
  assert.deepEqual(legacy, ['臺南市中西區 中山路與西華南街口']);
});
