'use strict';

/**
 * geocoder 模組測試——一律 mock fetch，絕不真打 Nominatim。
 * 測節流時序與錯誤處理（HTTP 非 200、查無結果、網路錯誤、JSON 解析失敗）。
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { createGeocoder, NOMINATIM_BASE_URL } = require('../lib/geocoder.cjs');

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test('geocode：成功查詢回傳 lat/lng，且帶自訂 User-Agent 與正確 URL', async () => {
  const calls = [];
  const fetchImpl = mock.fn(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse([{ lat: '25.033', lon: '121.565' }]);
  });

  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const result = await geocoder.geocode('台南市北門路段');

  assert.deepEqual(result, { lat: 25.033, lng: 121.565 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(NOMINATIM_BASE_URL));
  assert.ok(calls[0].url.includes(encodeURIComponent('台南市北門路段')));
  assert.match(calls[0].options.headers['User-Agent'], /tesla-radar-crawler/);
});

test('geocode：請求帶 countrycodes=tw 與 viewbox/bounded=1（限定台灣範圍，減少跨國誤配候選）', async () => {
  const calls = [];
  const fetchImpl = mock.fn(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse([{ lat: '25.033', lon: '121.565' }]);
  });

  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  await geocoder.geocode('台南市北門路段');

  assert.ok(calls[0].url.includes('countrycodes=tw'), calls[0].url);
  assert.ok(calls[0].url.includes('bounded=1'), calls[0].url);
  assert.ok(calls[0].url.includes('viewbox='), calls[0].url);
});

test('geocode：回傳座標落在台灣邊界外（跨國誤配，如中國同名路名）→ 視為失敗回傳 null', async () => {
  // 案例：「中正路」「中山路口」等台灣常見路名在中國也存在同名，Nominatim 曾誤配到河南/山東等地。
  const fetchImpl = mock.fn(async () => jsonResponse([{ lat: '34.6544515', lon: '112.4306743' }]));
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });

  const result = await geocoder.geocode('北區 公園路與公園南路口');
  assert.equal(result, null);
});

test('geocode：回傳座標剛好在台灣 bbox 邊界內（含金門等外島）→ 正常接受', async () => {
  const fetchImpl = mock.fn(async () => jsonResponse([{ lat: '24.4588', lon: '118.4315' }])); // 金門
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });

  const result = await geocoder.geocode('金門某地址');
  assert.deepEqual(result, { lat: 24.4588, lng: 118.4315 });
});

test('geocode：查無結果（空陣列）回傳 null，不拋例外', async () => {
  const fetchImpl = mock.fn(async () => jsonResponse([]));
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });

  const result = await geocoder.geocode('不存在的地址');
  assert.equal(result, null);
});

test('geocode：HTTP 錯誤（非 200）回傳 null，不拋例外', async () => {
  const fetchImpl = mock.fn(async () => jsonResponse(null, false, 429));
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });

  const result = await geocoder.geocode('某地址');
  assert.equal(result, null);
});

test('geocode：網路層拋錯回傳 null，不向外拋出', async () => {
  const fetchImpl = mock.fn(async () => {
    throw new Error('ECONNRESET');
  });
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });

  const result = await geocoder.geocode('某地址');
  assert.equal(result, null);
});

test('geocode：回應非合法 JSON 回傳 null', async () => {
  const fetchImpl = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  }));
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });

  const result = await geocoder.geocode('某地址');
  assert.equal(result, null);
});

test('geocode：空字串地址直接回傳 null，不呼叫 fetch（節省節流時間）', async () => {
  const fetchImpl = mock.fn(async () => jsonResponse([]));
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });

  const result = await geocoder.geocode('');
  assert.equal(result, null);
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test('geocode：連續呼叫確實節流至少 minIntervalMs（用假的 sleepImpl 驗證節流邏輯，不真的等待）', async () => {
  const fetchImpl = mock.fn(async () => jsonResponse([{ lat: '25', lon: '121' }]));
  const sleepCalls = [];
  const sleepImpl = mock.fn(async (ms) => {
    sleepCalls.push(ms);
  });

  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 1000, sleepImpl });

  await geocoder.geocode('地址一');
  await geocoder.geocode('地址二'); // 緊接著呼叫，應觸發節流等待

  assert.equal(fetchImpl.mock.calls.length, 2);
  assert.equal(sleepCalls.length, 1); // 第一次呼叫沒有前一次請求，不需節流；第二次才需要
  assert.ok(sleepCalls[0] > 0 && sleepCalls[0] <= 1000);
});

test('createGeocoder：傳入非函式的 fetchImpl 應拋出明確錯誤', () => {
  assert.throws(() => createGeocoder({ fetchImpl: 'not-a-function', minIntervalMs: 0 }), /fetch/);
});

// ---- geocodeIntersection：路口 = 兩條路線幾何的最近頂點（一律 mock fetch，絕不真打 Nominatim）----
const line = (coords) => ({ geojson: { type: 'LineString', coordinates: coords } });
function roadFetch(byQuery) {
  const calls = [];
  const fetchImpl = mock.fn(async (url, options) => {
    const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)[1]);
    calls.push({ url, q, options });
    return jsonResponse(byQuery[q] || []);
  });
  return { fetchImpl, calls };
}

test('geocodeIntersection：兩路有共享頂點 → 回傳該點；兩次請求都帶 polygon_geojson=1&limit=5 與自訂 UA', async () => {
  const { fetchImpl, calls } = roadFetch({
    '臺南市中西區西華南街': [line([[120.2090, 22.9950], [120.2098173, 22.9955535]]), line([[120.2098173, 22.9955535], [120.2105, 22.9960]])],
    '臺南市中西區中山路': [line([[120.2098173, 22.9955535], [120.2100, 22.9970]]), { geojson: { type: 'MultiLineString', coordinates: [[[120.2070, 22.9940], [120.2085, 22.9948]]] } }],
  });
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const result = await geocoder.geocodeIntersection('臺南市中西區', '西華南街', '中山路');
  assert.deepEqual(result, { lat: 22.9955535, lng: 120.2098173 });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.url, /polygon_geojson=1/);
    assert.match(c.url, /limit=5/);
    assert.match(c.options.headers['User-Agent'], /tesla-radar-crawler/);
  }
  assert.deepEqual(calls.map((c) => c.q), ['臺南市中西區西華南街', '臺南市中西區中山路']);
});

test('geocodeIntersection：最近頂點 ≤25 m 取中點；>25 m（兩路不相交）回 null；查無／無線幾何回 null', async () => {
  // 緯度 0.0001 度 ≈ 11.1 m：0.0002 ≈ 22 m（接受），0.0003 ≈ 33 m（拒絕）
  const near = roadFetch({
    '臺南市中西區甲路': [line([[120.2, 22.9990]])],
    '臺南市中西區乙路': [line([[120.2, 22.9992]])],
  });
  const ok = await createGeocoder({ fetchImpl: near.fetchImpl, minIntervalMs: 0 }).geocodeIntersection('臺南市中西區', '甲路', '乙路');
  assert.ok(Math.abs(ok.lat - 22.9991) < 1e-9 && ok.lng === 120.2);

  const far = roadFetch({
    '臺南市中西區甲路': [line([[120.2, 22.9990]])],
    '臺南市中西區乙路': [line([[120.2, 22.9993]])],
  });
  assert.equal(await createGeocoder({ fetchImpl: far.fetchImpl, minIntervalMs: 0 }).geocodeIntersection('臺南市中西區', '甲路', '乙路'), null);

  const empty = roadFetch({});
  assert.equal(await createGeocoder({ fetchImpl: empty.fetchImpl, minIntervalMs: 0 }).geocodeIntersection('臺南市中西區', '甲路', '乙路'), null);

  // 只有 Point／Polygon 沒有線幾何
  const noLine = roadFetch({
    '臺南市中西區甲路': [{ geojson: { type: 'Point', coordinates: [120.2, 22.999] } }],
    '臺南市中西區乙路': [line([[120.2, 22.999]])],
  });
  assert.equal(await createGeocoder({ fetchImpl: noLine.fetchImpl, minIntervalMs: 0 }).geocodeIntersection('臺南市中西區', '甲路', '乙路'), null);
});

test('geocodeIntersection：座標在台灣 bbox 外判誤配回 null；HTTP 錯誤回 null 不丟例外；缺參數不發請求', async () => {
  const out = roadFetch({
    '臺南市中西區甲路': [line([[110.0, 30.0]])],
    '臺南市中西區乙路': [line([[110.0, 30.0]])],
  });
  assert.equal(await createGeocoder({ fetchImpl: out.fetchImpl, minIntervalMs: 0 }).geocodeIntersection('臺南市中西區', '甲路', '乙路'), null);

  const failing = mock.fn(async () => jsonResponse(null, false, 503));
  assert.equal(await createGeocoder({ fetchImpl: failing, minIntervalMs: 0 }).geocodeIntersection('臺南市中西區', '甲路', '乙路'), null);

  const none = mock.fn(async () => jsonResponse([]));
  const g = createGeocoder({ fetchImpl: none, minIntervalMs: 0 });
  assert.equal(await g.geocodeIntersection('', '甲路', '乙路'), null);
  assert.equal(await g.geocodeIntersection('臺南市中西區', '甲路', ''), null);
  assert.equal(none.mock.calls.length, 0);
});

test('geocodeIntersection：兩次請求間節流 ≥1.1 秒；同輪重複的路用快取不再請求', async () => {
  const { fetchImpl } = roadFetch({
    '臺南市中西區甲路': [line([[120.2, 22.999]])],
    '臺南市中西區乙路': [line([[120.2, 22.999]])],
    '臺南市中西區丙路': [line([[120.2, 22.999]])],
  });
  const sleepCalls = [];
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 1000, sleepImpl: async (ms) => { sleepCalls.push(ms); } });
  await geocoder.geocodeIntersection('臺南市中西區', '甲路', '乙路');
  assert.equal(fetchImpl.mock.calls.length, 2);
  assert.equal(sleepCalls.length, 1);
  assert.ok(sleepCalls[0] > 1000 && sleepCalls[0] <= 1100, `等待 ${sleepCalls[0]}ms 應 ≤1100 且超過 1000（至少 1.1s 間隔）`);
  await geocoder.geocodeIntersection('臺南市中西區', '甲路', '丙路'); // 甲路已快取，只多查丙路
  assert.equal(fetchImpl.mock.calls.length, 3);
});
