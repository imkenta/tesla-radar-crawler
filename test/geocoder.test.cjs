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
