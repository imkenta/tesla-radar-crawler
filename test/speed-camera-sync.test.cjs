'use strict';

/**
 * speed-camera-sync.cjs 真寫入模式（writeAll / writeSyncLog）測試。
 *
 * 全部 mock：
 *   - globalThis.fetch（下載）：回傳假 CSV buffer，不打真實開放資料 API。
 *   - supabase client：假的 query builder，記錄呼叫參數，不連任何 DB
 *     （production 的 speed_cameras 表尚未建立，本輪嚴禁真實連線驗證）。
 *
 * 涵蓋：upsert onConflict 參數、stale 清除呼叫參數、單一 source 失敗不影響其他 source、
 * sync_logs 彙總欄位正確性。
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const speedCameraSync = require('../speed-camera-sync.cjs');
const { writeAll, writeSyncLog, SOURCES } = speedCameraSync;

// 全域跳過重試退避的真實等待（5s/15s），測試只驗證重試次數與行為，不需要真的等。
speedCameraSync.sleep = async () => {};

const TAIPEI_CSV = Buffer.from(
  '編號,功能,設置路段,設置地點,緯度,經度,轄區,拍攝方向,速限-速度限制,縣市,縣市代碼\n' +
    '1,測速,承德路3段,敦煌路口,25.07450558,121.5199333,大同,南北雙向,50,臺北市,63000\n',
  'utf8'
);

const NTPC_CSV =
  'cityname,regionname,address,deptnm,branchnm,violation types,longitude,latitude,direct,limit\n' +
  '新北市,八里區,中山路3段與下罟子漁港路口（往八里）,,,超速,121.38151,25.14027,西南向東北,50\n';

const KAOHSIUNG_CSV =
  'Seq,編號,型式,測照地點,測照方向,速限,行政區,測照型式,座標緯N度,座標經E度\n' +
  '1,1,固定式,民族一路與十全一路口,北向南,60,三民,測速,22.644858,120.314341\n';

/**
 * 建立一個可鏈式呼叫、記錄呼叫紀錄的假 supabase client。
 * upsertImpl / deleteImpl 依 table 名稱分派行為，供各測試自訂回傳值/錯誤。
 */
function makeFakeSupabase({ upsertImpl, deleteImpl } = {}) {
  const calls = { upsert: [], delete: [] };

  function from(table) {
    return {
      upsert(payload, opts) {
        calls.upsert.push({ table, payload, opts });
        const impl = upsertImpl && upsertImpl(table, payload, opts);
        return Promise.resolve(impl || { error: null });
      },
      delete() {
        const chain = {
          _eq: {},
          _lt: {},
          eq(col, val) {
            chain._eq[col] = val;
            return chain;
          },
          lt(col, val) {
            chain._lt[col] = val;
            return chain;
          },
          select(cols) {
            calls.delete.push({ table, eq: chain._eq, lt: chain._lt, select: cols });
            const impl = deleteImpl && deleteImpl(table, chain._eq, chain._lt);
            return Promise.resolve(impl || { data: [], error: null });
          },
        };
        return chain;
      },
    };
  }

  return { from, calls };
}

function fetchReturning(csvBySourceName) {
  return mock.fn(async (url) => {
    const source = SOURCES.find((s) => s.url === url);
    const body = source ? csvBySourceName[source.name] : null;
    if (body == null) {
      return { ok: false, status: 404 };
    }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  });
}

test('writeAll：三個 source 全部成功 → upsert 帶正確 onConflict、批次時間戳一致', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchReturning({
    taipei: TAIPEI_CSV,
    'new-taipei': NTPC_CSV,
    kaohsiung: KAOHSIUNG_CSV,
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { from, calls } = makeFakeSupabase();
  const supabase = { from };

  const summary = await writeAll(supabase);

  assert.equal(summary.sourceResults.length, 3);
  assert.ok(summary.sourceResults.every((r) => r.ok === true));
  assert.deepEqual(
    summary.sourceResults.map((r) => r.name),
    ['taipei', 'new-taipei', 'kaohsiung']
  );
  assert.deepEqual(
    summary.sourceResults.map((r) => r.written),
    [1, 1, 1]
  );

  assert.equal(calls.upsert.length, 3);
  for (const c of calls.upsert) {
    assert.deepEqual(c.opts, { onConflict: 'source,address,direction' });
    // 每筆 payload 的 updated_at 都等於本輪批次時間戳
    assert.ok(c.payload.every((p) => p.updated_at === summary.batchFetchedAt));
  }

  // stale 清除：每個 source 各呼叫一次 delete，條件為 source= 該名稱、fetched_at < 批次時間戳
  assert.equal(calls.delete.length, 3);
  const deletedSourceNames = calls.delete.map((c) => c.eq.source).sort();
  assert.deepEqual(deletedSourceNames, ['kaohsiung', 'new-taipei', 'taipei']);
  for (const c of calls.delete) {
    assert.equal(c.lt.fetched_at, summary.batchFetchedAt);
  }
});

test('writeAll：direction 為 null 的紀錄 upsert 前已正規化成空字串', async (t) => {
  const originalFetch = globalThis.fetch;
  // 高雄「違左」樣本的 direction 有值；改造一筆 direction 為空字串來源測試正規化情形——
  // 直接用新北市 CSV 但把 direct 欄位留空，驗證 payload.direction === ''。
  const ntpcNoDirection =
    'cityname,regionname,address,deptnm,branchnm,violation types,longitude,latitude,direct,limit\n' +
    '新北市,石碇區,台9線19K至23.1K（雙向）,,,超速,121.6236371,24.9569297,,40\n';

  globalThis.fetch = fetchReturning({
    taipei: null,
    'new-taipei': ntpcNoDirection,
    kaohsiung: null,
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { from, calls } = makeFakeSupabase();
  const supabase = { from };

  const summary = await writeAll(supabase);

  const ntpcResult = summary.sourceResults.find((r) => r.name === 'new-taipei');
  assert.equal(ntpcResult.ok, true);

  const ntpcUpsertCall = calls.upsert.find((c) => c.payload[0].source === 'new-taipei');
  assert.equal(ntpcUpsertCall.payload[0].direction, '');

  // taipei / kaohsiung 下載失敗（回傳 null → fetch 404）→ 不影響 new-taipei 成功
  const taipeiResult = summary.sourceResults.find((r) => r.name === 'taipei');
  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  assert.equal(taipeiResult.ok, false);
  assert.equal(kaohsiungResult.ok, false);
  assert.match(taipeiResult.error, /下載失敗/);
});

test('writeAll：單一 source upsert 失敗不影響其他 source 繼續執行', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchReturning({
    taipei: TAIPEI_CSV,
    'new-taipei': NTPC_CSV,
    kaohsiung: KAOHSIUNG_CSV,
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { from, calls } = makeFakeSupabase({
    upsertImpl: (table, payload) => {
      if (payload[0].source === 'new-taipei') {
        return { error: { message: '模擬 upsert 失敗' } };
      }
      return { error: null };
    },
  });
  const supabase = { from };

  const summary = await writeAll(supabase);

  const taipeiResult = summary.sourceResults.find((r) => r.name === 'taipei');
  const ntpcResult = summary.sourceResults.find((r) => r.name === 'new-taipei');
  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');

  assert.equal(taipeiResult.ok, true);
  assert.equal(ntpcResult.ok, false);
  assert.match(ntpcResult.error, /模擬 upsert 失敗/);
  assert.equal(kaohsiungResult.ok, true);

  // new-taipei upsert 失敗後不應嘗試清 stale（在 upsert 就 throw，不會走到 delete）
  const ntpcDeleteCalls = calls.delete.filter((c) => c.eq.source === 'new-taipei');
  assert.equal(ntpcDeleteCalls.length, 0);
});

test('writeAll：清 stale 失敗也不影響其他 source，且該 source 標記為失敗', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchReturning({
    taipei: TAIPEI_CSV,
    'new-taipei': NTPC_CSV,
    kaohsiung: KAOHSIUNG_CSV,
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { from } = makeFakeSupabase({
    deleteImpl: (table, eqCond) => {
      if (eqCond.source === 'kaohsiung') {
        return { data: null, error: { message: '模擬清 stale 失敗' } };
      }
      return { data: [], error: null };
    },
  });
  const supabase = { from };

  const summary = await writeAll(supabase);

  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  const taipeiResult = summary.sourceResults.find((r) => r.name === 'taipei');
  const ntpcResult = summary.sourceResults.find((r) => r.name === 'new-taipei');

  assert.equal(kaohsiungResult.ok, false);
  assert.match(kaohsiungResult.error, /清除 stale 失敗/);
  assert.equal(taipeiResult.ok, true);
  assert.equal(ntpcResult.ok, true);
});

test('writeAll：來源下載前兩次失敗、第三次成功 → 重試後仍視為成功，且重試 2 次', async (t) => {
  const originalFetch = globalThis.fetch;
  let kaohsiungAttempts = 0;
  globalThis.fetch = mock.fn(async (url) => {
    const source = SOURCES.find((s) => s.url === url);
    if (source && source.name === 'kaohsiung') {
      kaohsiungAttempts++;
      if (kaohsiungAttempts < 3) {
        return { ok: false, status: 503 };
      }
      const buf = Buffer.from(KAOHSIUNG_CSV, 'utf8');
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    const body = source ? { taipei: TAIPEI_CSV, 'new-taipei': NTPC_CSV }[source.name] : null;
    if (body == null) return { ok: false, status: 404 };
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { from } = makeFakeSupabase();
  const supabase = { from };

  const summary = await writeAll(supabase);

  assert.equal(kaohsiungAttempts, 3);
  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  assert.equal(kaohsiungResult.ok, true);
  assert.equal(kaohsiungResult.written, 1);
});

test('writeAll：來源下載連續 3 次都失敗 → 重試用盡後該 source 標記失敗，其他 source 不受影響', async (t) => {
  const originalFetch = globalThis.fetch;
  let kaohsiungAttempts = 0;
  globalThis.fetch = mock.fn(async (url) => {
    const source = SOURCES.find((s) => s.url === url);
    if (source && source.name === 'kaohsiung') {
      kaohsiungAttempts++;
      return { ok: false, status: 500 };
    }
    const body = source ? { taipei: TAIPEI_CSV, 'new-taipei': NTPC_CSV }[source.name] : null;
    if (body == null) return { ok: false, status: 404 };
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { from } = makeFakeSupabase();
  const supabase = { from };

  const summary = await writeAll(supabase);

  assert.equal(kaohsiungAttempts, 3);
  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  const taipeiResult = summary.sourceResults.find((r) => r.name === 'taipei');
  const ntpcResult = summary.sourceResults.find((r) => r.name === 'new-taipei');

  assert.equal(kaohsiungResult.ok, false);
  assert.match(kaohsiungResult.error, /下載失敗 HTTP 500/);
  assert.equal(taipeiResult.ok, true);
  assert.equal(ntpcResult.ok, true);
});

test('writeSyncLog：全部成功 → status COMPLETED，欄位彙總正確', async () => {
  const { from, calls } = makeFakeSupabase();
  const supabase = { from };

  const summary = {
    batchFetchedAt: '2026-07-05T00:00:00.000Z',
    sourceResults: [
      { name: 'taipei', ok: true, written: 143, staleDeleted: 0, error: null },
      { name: 'new-taipei', ok: true, written: 190, staleDeleted: 2, error: null },
      { name: 'kaohsiung', ok: true, written: 248, staleDeleted: 0, error: null },
    ],
  };
  const startTime = new Date('2026-07-05T00:00:00.000Z');

  await writeSyncLog(supabase, summary, startTime);

  assert.equal(calls.upsert.length, 1);
  const logCall = calls.upsert[0];
  assert.equal(logCall.table, 'sync_logs');
  assert.equal(logCall.payload.status, 'COMPLETED');
  assert.equal(logCall.payload.total_plates, 143 + 190 + 248);
  assert.equal(logCall.payload.stations_success, 3);
  assert.equal(logCall.payload.stations_failed, 0);
  assert.equal(logCall.payload.error_summary, null);
  assert.equal(logCall.opts.onConflict, 'run_id');
  assert.match(logCall.payload.run_id, /^speed_camera_sync_\d+$/);
});

test('writeSyncLog：有 source 失敗 → status FAILED，error_summary 含失敗 source 訊息', async () => {
  const { from, calls } = makeFakeSupabase();
  const supabase = { from };

  const summary = {
    batchFetchedAt: '2026-07-05T00:00:00.000Z',
    sourceResults: [
      { name: 'taipei', ok: true, written: 143, staleDeleted: 0, error: null },
      { name: 'new-taipei', ok: false, written: 0, staleDeleted: 0, error: '下載失敗 HTTP 500' },
    ],
  };
  const startTime = new Date('2026-07-05T00:00:00.000Z');

  await writeSyncLog(supabase, summary, startTime);

  const logCall = calls.upsert[0];
  assert.equal(logCall.payload.status, 'FAILED');
  assert.equal(logCall.payload.total_plates, 143);
  assert.equal(logCall.payload.stations_success, 1);
  assert.equal(logCall.payload.stations_failed, 1);
  assert.match(logCall.payload.error_summary, /new-taipei: 下載失敗 HTTP 500/);
});
