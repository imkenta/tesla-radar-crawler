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
 * upsertImpl / deleteImpl / selectImpl 依 table 名稱分派行為，供各測試自訂回傳值/錯誤。
 * selectImpl(table, eqCond) 用於黃燈政策查詢 max(fetched_at)：
 *   .from('speed_cameras').select('fetched_at').eq('source', name).order(...).limit(1).maybeSingle()
 */
function makeFakeSupabase({ upsertImpl, deleteImpl, selectImpl } = {}) {
  const calls = { upsert: [], delete: [], select: [] };

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
      select(cols) {
        const chain = {
          _eq: {},
          eq(col, val) {
            chain._eq[col] = val;
            return chain;
          },
          order() {
            return chain;
          },
          limit() {
            return chain;
          },
          maybeSingle() {
            calls.select.push({ table, cols, eq: chain._eq });
            const impl = selectImpl && selectImpl(table, chain._eq);
            return Promise.resolve(impl || { data: null, error: null });
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

test('writeAll：高雄主來源(data.kcg.gov.tw)全敗 → 切換到鏡像(openapi.kcg.gov.tw) JSON 成功，且印出切換 log', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logLines = [];
  console.error = (...args) => logLines.push(args.join(' '));

  const kaohsiungSource = SOURCES.find((s) => s.name === 'kaohsiung');
  const fallbackUrl = kaohsiungSource.fallbackUrls[0].url;
  let primaryAttempts = 0;
  let fallbackAttempts = 0;

  const KAOHSIUNG_JSON = JSON.stringify({
    data: [
      {
        Seq: 1,
        編號: '1',
        型式: '固定式',
        測照地點: '民族一路與十全一路口',
        測照方向: '北向南',
        速限: '60',
        行政區: '三民',
        測照型式: '測速',
        座標緯N度: '22.644858',
        座標經E度: '120.314341',
      },
    ],
  });

  globalThis.fetch = mock.fn(async (url) => {
    if (url === kaohsiungSource.url) {
      primaryAttempts++;
      return { ok: false, status: 522 }; // 模擬地理封鎖：連線逾時/失敗
    }
    if (url === fallbackUrl) {
      fallbackAttempts++;
      const buf = Buffer.from(KAOHSIUNG_JSON, 'utf8');
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    const source = SOURCES.find((s) => s.url === url);
    const body = source ? { taipei: TAIPEI_CSV, 'new-taipei': NTPC_CSV }[source.name] : null;
    if (body == null) return { ok: false, status: 404 };
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const { from } = makeFakeSupabase();
  const supabase = { from };

  const summary = await writeAll(supabase);

  // 主 URL 用盡重試（FETCH_MAX_ATTEMPTS=3），才切到 fallback；fallback 第一次就成功。
  assert.equal(primaryAttempts, 3);
  assert.equal(fallbackAttempts, 1);

  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  assert.equal(kaohsiungResult.ok, true);
  assert.equal(kaohsiungResult.written, 1);

  // 切換 log 必須含主機名 openapi.kcg.gov.tw，方便從 Actions log 判斷走了哪個入口。
  assert.ok(
    logLines.some((line) => line.includes('kaohsiung') && line.includes('openapi.kcg.gov.tw') && line.includes('鏡像')),
    `未找到切換 log，實際 log：\n${logLines.join('\n')}`
  );
});

test('writeAll：來源下載連續 3 次都失敗、fallback 鏡像也全失敗 → 重試用盡後該 source 標記失敗，其他 source 不受影響', async (t) => {
  const originalFetch = globalThis.fetch;
  let kaohsiungAttempts = 0;
  let fallbackAttempts = 0;
  const kaohsiungSource = SOURCES.find((s) => s.name === 'kaohsiung');
  const fallbackUrl = kaohsiungSource.fallbackUrls[0].url;

  globalThis.fetch = mock.fn(async (url) => {
    if (url === kaohsiungSource.url) {
      kaohsiungAttempts++;
      return { ok: false, status: 500 };
    }
    if (url === fallbackUrl) {
      fallbackAttempts++;
      return { ok: false, status: 500 };
    }
    const source = SOURCES.find((s) => s.url === url);
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

  assert.equal(kaohsiungAttempts, 3); // 主 URL 用盡 FETCH_MAX_ATTEMPTS
  assert.equal(fallbackAttempts, 2); // fallback 用盡 FALLBACK_MAX_ATTEMPTS
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

// --- 來源新鮮度黃燈政策（--write 專用） ---
//
// 高雄源已知境外 IP 地理封鎖，主 URL + fallback 全敗時改查 DB 庫存新鮮度：
// 新鮮（≤ STALE_OK_DAYS）→ 黃燈（ok=true, stale=true，不計入失敗）；
// 過期或無資料 → 照舊紅燈（ok=false）。

function allSourcesFailFetch() {
  return mock.fn(async () => ({ ok: false, status: 522 }));
}

test('writeAll：黃燈 — source 全部下載失敗但 DB 庫存新鮮（10 天前）→ 標記 ok=true, stale=true，不計入失敗', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = allSourcesFailFetch();
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const { from, calls } = makeFakeSupabase({
    selectImpl: (table, eqCond) => {
      if (table === 'speed_cameras' && eqCond.source === 'kaohsiung') {
        return { data: { fetched_at: tenDaysAgo }, error: null };
      }
      return { data: null, error: null };
    },
  });
  const supabase = { from };

  const summary = await writeAll(supabase);

  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  assert.equal(kaohsiungResult.ok, true);
  assert.equal(kaohsiungResult.stale, true);
  assert.ok(kaohsiungResult.staleDays < 11 && kaohsiungResult.staleDays > 9);

  // taipei / new-taipei 無 fallback，全敗且 DB 無資料 → 照舊紅燈
  const taipeiResult = summary.sourceResults.find((r) => r.name === 'taipei');
  assert.equal(taipeiResult.ok, false);
  assert.equal(taipeiResult.stale, false);

  assert.ok(calls.select.some((c) => c.eq.source === 'kaohsiung'));
});

test('writeAll：紅燈 — source 下載失敗且 DB 庫存已過期（90 天前，超過預設 60 天門檻）→ 照舊計入失敗', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = allSourcesFailFetch();
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { from } = makeFakeSupabase({
    selectImpl: (table, eqCond) => {
      if (table === 'speed_cameras' && eqCond.source === 'kaohsiung') {
        return { data: { fetched_at: ninetyDaysAgo }, error: null };
      }
      return { data: null, error: null };
    },
  });
  const supabase = { from };

  const summary = await writeAll(supabase);

  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  assert.equal(kaohsiungResult.ok, false);
  assert.equal(kaohsiungResult.stale, false);
  assert.match(kaohsiungResult.error, /下載失敗|清除 stale/);
});

test('writeAll：紅燈 — source 下載失敗且 DB 無該 source 任何資料 → 照舊計入失敗', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = allSourcesFailFetch();
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { from } = makeFakeSupabase(); // 預設 select 回傳 { data: null, error: null }
  const supabase = { from };

  const summary = await writeAll(supabase);

  const kaohsiungResult = summary.sourceResults.find((r) => r.name === 'kaohsiung');
  assert.equal(kaohsiungResult.ok, false);
  assert.equal(kaohsiungResult.stale, false);
  assert.equal(kaohsiungResult.staleDays, null);
});

test('syncAll（--dry-run 用）：完全不查詢 supabase，下載失敗行為不受黃燈政策影響', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = allSourcesFailFetch();
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { syncAll } = speedCameraSync;
  const records = await syncAll();

  // 全部來源下載失敗（無 fallback 成功），dry-run 不連 DB，直接回傳空陣列。
  assert.deepEqual(records, []);
});
