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
