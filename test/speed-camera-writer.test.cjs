'use strict';

/**
 * 測速照相「真寫入模式」純函式邏輯測試。
 *
 * 只測 lib/speed-camera-writer.cjs 的純函式（payload 組裝、stale 判定），
 * 不碰 supabase client——client 呼叫在 speed-camera-sync.cjs 的 mock 測試另外驗證。
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  toUpsertPayload,
  toUpsertPayloads,
  isStale,
  coordLookupKey,
  fillMissingCoords,
  haversineMeters,
  dedupeAgainstExisting,
} = require('../lib/speed-camera-writer.cjs');

test('toUpsertPayload：direction 為 null 正規化成空字串', () => {
  const record = {
    city: '臺南市',
    address: '北門路段',
    road: null,
    direction: null,
    speed_limit: null,
    lat: null,
    lng: null,
    source: 'tainan',
    fetched_at: '2026-07-04T00:00:00.000Z',
  };
  const payload = toUpsertPayload(record, '2026-07-05T00:00:00.000Z');

  assert.equal(payload.direction, '');
  assert.equal(payload.road, null);
  assert.equal(payload.updated_at, '2026-07-05T00:00:00.000Z');
});

test('toUpsertPayload：direction 為 undefined 也正規化成空字串', () => {
  const record = {
    city: '臺南市',
    address: '北門路段',
    source: 'tainan',
    fetched_at: '2026-07-04T00:00:00.000Z',
  };
  const payload = toUpsertPayload(record, '2026-07-05T00:00:00.000Z');
  assert.equal(payload.direction, '');
});

test('toUpsertPayload：有值的 direction 原樣保留', () => {
  const record = {
    city: '臺北市',
    address: '承德路3段 敦煌路口',
    road: '承德路3段',
    direction: '南北雙向',
    speed_limit: 50,
    lat: 25.07450558,
    lng: 121.5199333,
    source: 'taipei',
    fetched_at: '2026-07-04T00:00:00.000Z',
  };
  const payload = toUpsertPayload(record, '2026-07-05T00:00:00.000Z');
  assert.equal(payload.direction, '南北雙向');
  assert.equal(payload.speed_limit, 50);
  assert.equal(payload.updated_at, '2026-07-05T00:00:00.000Z');
});

test('toUpsertPayload：測速確認、道路類別與方向語意完整寫入', () => {
  const payload = toUpsertPayload({
    city: '國道五號',
    address: '雪山隧道南下',
    road: '國道五號',
    direction: '南下',
    speed_limit: 90,
    lat: 24.9,
    lng: 121.7,
    speed_status: 'confirmed',
    enforcement_items_raw: null,
    classification_basis: 'source_contract:speed_only',
    camera_type: 'fixed',
    road_class: 'freeway',
    road_level: 'tunnel',
    direction_mode: 'single',
    direction_bearing: 180,
    source: 'national-npa',
    fetched_at: '2026-07-22T00:00:00.000Z',
  }, '2026-07-22T00:00:00.000Z');

  assert.equal(payload.speed_status, 'confirmed');
  assert.equal(payload.camera_type, 'fixed');
  assert.equal(payload.road_class, 'freeway');
  assert.equal(payload.direction_mode, 'single');
  assert.equal(payload.direction_bearing, 180);
  assert.equal(payload.classification_basis, 'source_contract:speed_only');
});

test('toUpsertPayload：所有筆都帶上同一個本輪批次 updated_at', () => {
  const records = [
    { city: 'A', address: 'a', source: 's', fetched_at: 't1' },
    { city: 'B', address: 'b', source: 's', fetched_at: 't2' },
  ];
  const payloads = toUpsertPayloads(records, '2026-07-05T00:00:00.000Z');
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every((p) => p.updated_at === '2026-07-05T00:00:00.000Z'));
});

test('isStale：既有列 fetched_at 早於本輪批次 → true（該清除）', () => {
  assert.equal(isStale('2026-07-04T00:00:00.000Z', '2026-07-05T00:00:00.000Z'), true);
});

test('isStale：既有列 fetched_at 等於本輪批次 → false（本輪剛寫入，不清）', () => {
  assert.equal(isStale('2026-07-05T00:00:00.000Z', '2026-07-05T00:00:00.000Z'), false);
});

test('isStale：既有列 fetched_at 晚於本輪批次 → false（不應發生，但不誤刪）', () => {
  assert.equal(isStale('2026-07-06T00:00:00.000Z', '2026-07-05T00:00:00.000Z'), false);
});

test('isStale：既有列 fetched_at 缺失（null/undefined）→ true（視為 stale，保守清除）', () => {
  assert.equal(isStale(null, '2026-07-05T00:00:00.000Z'), true);
  assert.equal(isStale(undefined, '2026-07-05T00:00:00.000Z'), true);
});

// --- fillMissingCoords（台南等無座標縣市的 geocode 補值流程） ---

function record(overrides = {}) {
  return {
    city: '臺南市',
    address: '北區 某路口',
    road: '某路口',
    direction: '雙向',
    speed_limit: 50,
    lat: null,
    lng: null,
    source: 'tainan',
    fetched_at: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

test('coordLookupKey：組合 source/address/direction，direction 缺省視為空字串', () => {
  assert.equal(coordLookupKey('tainan', '北區 某路口', '雙向'), 'tainan 北區 某路口 雙向');
  assert.equal(coordLookupKey('tainan', '北區 某路口', null), 'tainan 北區 某路口 ');
  assert.equal(coordLookupKey('tainan', '北區 某路口', undefined), 'tainan 北區 某路口 ');
});

test('fillMissingCoords：已有座標的紀錄原樣通過，不查 DB 也不 geocode', async () => {
  const records = [record({ lat: 23.1, lng: 120.2 })];
  const geocodeFn = mock.fn(async () => ({ lat: 0, lng: 0 }));

  const result = await fillMissingCoords(records, new Map(), geocodeFn, 100);

  assert.equal(geocodeFn.mock.callCount(), 0);
  assert.equal(result.records[0].lat, 23.1);
  assert.equal(result.records[0].lng, 120.2);
  assert.equal(result.geocodeAttempted, 0);
  assert.equal(result.reusedFromDb, 0);
});

test('fillMissingCoords：DB 已有同 (source,address,direction) 座標 → 直接沿用，絕不重複 geocode', async () => {
  const r = record();
  const key = coordLookupKey(r.source, r.address, r.direction);
  const existingCoordsByKey = new Map([[key, { lat: 23.001, lng: 120.201 }]]);
  const geocodeFn = mock.fn(async () => ({ lat: 999, lng: 999 }));

  const result = await fillMissingCoords([r], existingCoordsByKey, geocodeFn, 100);

  assert.equal(geocodeFn.mock.callCount(), 0);
  assert.equal(result.records[0].lat, 23.001);
  assert.equal(result.records[0].lng, 120.201);
  assert.equal(result.reusedFromDb, 1);
  assert.equal(result.geocodeAttempted, 0);
});

test('fillMissingCoords：新地址（DB 無既有座標）→ 呼叫 geocodeFn，且 source=tainan 補「臺南市」前綴消歧義', async () => {
  const r = record({ address: '北區 全新地址' });
  const geocodeFn = mock.fn(async (address) => {
    assert.equal(address, '臺南市北區 全新地址');
    return { lat: 23.05, lng: 120.15 };
  });

  const result = await fillMissingCoords([r], new Map(), geocodeFn, 100);

  assert.equal(geocodeFn.mock.callCount(), 1);
  assert.equal(result.records[0].lat, 23.05);
  assert.equal(result.records[0].lng, 120.15);
  assert.equal(result.geocodeAttempted, 1);
  assert.equal(result.geocodeSucceeded, 1);
});

test('fillMissingCoords：geocode 查無結果（回傳 null）→ 該筆留 null，不拋錯、不計入失敗', async () => {
  const r = record({ address: '北區 查無此地址' });
  const geocodeFn = mock.fn(async () => null);

  const result = await fillMissingCoords([r], new Map(), geocodeFn, 100);

  assert.equal(result.records[0].lat, null);
  assert.equal(result.records[0].lng, null);
  assert.equal(result.geocodeAttempted, 1);
  assert.equal(result.geocodeSucceeded, 0);
});

test('fillMissingCoords：單輪 geocode 上限——超過上限的紀錄不呼叫 geocodeFn，留 null 待下輪', async () => {
  const records = [
    record({ address: '地址1' }),
    record({ address: '地址2' }),
    record({ address: '地址3' }),
  ];
  const geocodeFn = mock.fn(async () => ({ lat: 1, lng: 1 }));

  const result = await fillMissingCoords(records, new Map(), geocodeFn, 2);

  assert.equal(geocodeFn.mock.callCount(), 2);
  assert.equal(result.geocodeAttempted, 2);
  assert.equal(result.skippedOverCap, 1);
  assert.equal(result.records[0].lat, 1);
  assert.equal(result.records[1].lat, 1);
  assert.equal(result.records[2].lat, null); // 第 3 筆超過上限，本輪不處理
});

test('fillMissingCoords：僅 source===tainan 補「臺南市」前綴，其他 source 原樣傳入 geocodeFn（不誤傷其他來源）', async () => {
  const records = [
    record({ source: 'tainan', address: '北區 某路口' }),
    record({ source: 'kaohsiung', address: '某路口' }),
  ];
  const geocodeFn = mock.fn(async (address) => ({ lat: 22.5, lng: 120.3, address }));

  await fillMissingCoords(records, new Map(), geocodeFn, 100);

  assert.equal(geocodeFn.mock.calls[0].arguments[0], '臺南市北區 某路口');
  assert.equal(geocodeFn.mock.calls[1].arguments[0], '某路口');
});

test('fillMissingCoords：混合情境——已有座標/DB沿用/新geocode/查無結果 同批次皆正確處理', async () => {
  const withCoords = record({ address: '地址A', lat: 1, lng: 2 });
  const dbReuse = record({ address: '地址B' });
  const newGeocode = record({ address: '地址C' });
  const geocodeFails = record({ address: '地址D' });

  const existingCoordsByKey = new Map([
    [coordLookupKey('tainan', '地址B', '雙向'), { lat: 10, lng: 20 }],
  ]);
  const geocodeFn = mock.fn(async (address) => {
    if (address === '臺南市地址C') return { lat: 30, lng: 40 };
    if (address === '臺南市地址D') return null;
    throw new Error(`不應呼叫 geocodeFn(${address})`);
  });

  const result = await fillMissingCoords(
    [withCoords, dbReuse, newGeocode, geocodeFails],
    existingCoordsByKey,
    geocodeFn,
    100
  );

  assert.deepEqual(
    result.records.map((r) => [r.lat, r.lng]),
    [
      [1, 2],
      [10, 20],
      [30, 40],
      [null, null],
    ]
  );
  assert.equal(result.reusedFromDb, 1);
  assert.equal(result.geocodeAttempted, 2); // 只有地址C、地址D 呼叫（地址A有座標不查、地址B沿用DB不查）
  assert.equal(result.geocodeSucceeded, 1);
});

// --- haversineMeters / dedupeAgainstExisting（全國集執行期聯集去重） ---

test('haversineMeters：同一點距離為 0', () => {
  assert.equal(haversineMeters(25.0745, 121.5199, 25.0745, 121.5199), 0);
});

test('haversineMeters：已知兩點距離約略正確（新北市八里區同址飄移約 1.7 公尺）', () => {
  const d = haversineMeters(25.14027, 121.38151, 25.14028, 121.38152);
  assert.ok(d > 0 && d < 5, `預期 0~5 公尺，實際 ${d}`);
});

test('haversineMeters：相距明顯遙遠的兩點（台北 vs 金門，實測約 319 公里）', () => {
  const d = haversineMeters(25.0745, 121.5199, 24.4588, 118.4315);
  assert.ok(d > 300_000 && d < 340_000, `預期約 300~340 公里，實際 ${d} 公尺`);
});

test('dedupeAgainstExisting：距離在門檻內（同一支）→ 丟棄', () => {
  const nationalRecords = [{ city: '新北市', address: 'a', lat: 25.14028, lng: 121.38152 }];
  const existingPoints = [{ lat: 25.14027, lng: 121.38151 }];
  const { kept, droppedCount } = dedupeAgainstExisting(nationalRecords, existingPoints, 30);
  assert.equal(kept.length, 0);
  assert.equal(droppedCount, 1);
});

test('dedupeAgainstExisting：距離超過門檻（不同支）→ 保留', () => {
  // 兩點相距約 240 公里，遠超 30m 門檻
  const nationalRecords = [{ city: '金門縣', address: 'a', lat: 24.4588, lng: 118.4315 }];
  const existingPoints = [{ lat: 25.0745, lng: 121.5199 }];
  const { kept, droppedCount } = dedupeAgainstExisting(nationalRecords, existingPoints, 30);
  assert.equal(kept.length, 1);
  assert.equal(droppedCount, 0);
  assert.deepEqual(kept[0], nationalRecords[0]);
});

test('dedupeAgainstExisting：門檻邊界——剛好在門檻內外的兩筆分別判同/判異', () => {
  // 以基準點 (25,121) 為中心，構造一筆距離明顯 <30m、一筆明顯 >30m 的全國集紀錄
  const base = { lat: 25, lng: 121 };
  // 緯度 1 度約 111km，0.0001 度約 11.1m（< 30m）
  const near = { city: 'X', address: 'near', lat: 25.0001, lng: 121 };
  // 0.001 度約 111m（> 30m）
  const far = { city: 'Y', address: 'far', lat: 25.001, lng: 121 };

  const { kept, droppedCount } = dedupeAgainstExisting([near, far], [base], 30);
  assert.equal(droppedCount, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].address, 'far');
});

test('dedupeAgainstExisting：不比對 direction/方向——純距離判斷，方向描述不同也視為同一支', () => {
  // 見 dedupeAgainstExisting 文件註解：各 source 方向欄位語意不統一，
  // 勉強比對方向反而容易漏丟重複點，因此設計上刻意不比對 direction。
  const nationalRecords = [{ city: '新北市', address: 'a', direction: '往八里', lat: 25.14028, lng: 121.38152 }];
  const existingPoints = [{ lat: 25.14027, lng: 121.38151, direction: '往淡水' }]; // 方向描述完全不同
  const { kept, droppedCount } = dedupeAgainstExisting(nationalRecords, existingPoints, 30);
  assert.equal(droppedCount, 1);
  assert.equal(kept.length, 0);
});

test('dedupeAgainstExisting：國道與公路分類不享有文字例外，相同座標仍視為重複點', () => {
  const nationalRecords = [
    { city: '國道五號', address: '北上16.9公里', lat: 24.901, lng: 121.61 },
    { city: '台2已線', address: '不同點位', lat: 24.95, lng: 121.7 },
  ];
  const existingPoints = [{ lat: 24.901, lng: 121.61 }];

  const { kept, droppedCount } = dedupeAgainstExisting(nationalRecords, existingPoints, 30);

  assert.equal(droppedCount, 1);
  assert.deepEqual(kept, [nationalRecords[1]]);
});

test('dedupeAgainstExisting：existingPoints 為空陣列 → 全部保留', () => {
  const nationalRecords = [
    { city: 'A', address: 'a', lat: 25, lng: 121 },
    { city: 'B', address: 'b', lat: 24, lng: 120 },
  ];
  const { kept, droppedCount } = dedupeAgainstExisting(nationalRecords, [], 30);
  assert.equal(kept.length, 2);
  assert.equal(droppedCount, 0);
});

test('dedupeAgainstExisting：existingPoints 內混雜無座標(lat/lng null)的既有列 → 該列不參與比對，不誤判', () => {
  const nationalRecords = [{ city: '臺南市', address: 'a', lat: 23.0, lng: 120.2 }];
  // 台南自建源本身若尚未 geocode，既有點位 lat/lng 會是 null——這種列必須被忽略，
  // 不能讓 null vs 數字的比較意外判定為距離 0（同一支）。
  const existingPoints = [{ lat: null, lng: null }];
  const { kept, droppedCount } = dedupeAgainstExisting(nationalRecords, existingPoints, 30);
  assert.equal(kept.length, 1);
  assert.equal(droppedCount, 0);
});

test('dedupeAgainstExisting：全國集紀錄混合重疊與獨有 → 各自正確分流，且保留原順序', () => {
  const overlapping = { city: '新北市', address: '重疊點', lat: 25.14028, lng: 121.38152 };
  const unique1 = { city: '金門縣', address: '獨有點1', lat: 24.458809, lng: 118.43147 };
  const unique2 = { city: '宜蘭縣', address: '獨有點2', lat: 24.778543, lng: 121.75933 };
  const existingPoints = [{ lat: 25.14027, lng: 121.38151 }];

  const { kept, droppedCount } = dedupeAgainstExisting(
    [overlapping, unique1, unique2],
    existingPoints,
    30
  );

  assert.equal(droppedCount, 1);
  assert.deepEqual(kept, [unique1, unique2]);
});
