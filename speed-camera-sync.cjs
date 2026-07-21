'use strict';

/**
 * 台灣固定式測速照相開放資料同步（R7，見 Tesla/TeslaToolbox/docs/nav-gap-analysis-2026-07-04.md）。
 *
 * 兩種模式：
 *   --dry-run           輸出正規化 JSON 到 stdout（或 --out=FILE），不連 DB（預設）
 *   --write              upsert 進 public.speed_cameras + 清 stale + 寫 sync_logs（需 Supabase env）
 *
 * ⚠️ production 的 speed_cameras 表建立前，--write 不可對 production 執行
 * （見 supabase/migrations-draft/speed_cameras.sql 檔頭說明）。
 *
 * 資料來源盤點與各縣市格式陷阱見 docs/speed-camera-sources.md。
 * 解析邏輯單一真理：lib/speed-camera-parser.cjs（測試：test/speed-camera-parser.test.cjs）。
 * 寫入 payload/stale 判定純函式：lib/speed-camera-writer.cjs（測試：test/speed-camera-writer.test.cjs）。
 *
 * 用法：
 *   node speed-camera-sync.cjs --dry-run              輸出正規化 JSON 到 stdout
 *   node speed-camera-sync.cjs --dry-run --out=FILE    輸出正規化 JSON 到指定檔案
 *   node speed-camera-sync.cjs --write                 真寫入 Supabase（需 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）
 *
 * 來源新鮮度黃燈政策（--write 專用）：
 * 高雄源（data.kcg + openapi.kcg 兩主機）已實錘對境外 IP 地理封鎖，GitHub Actions（美國
 * runner）永遠抓不到，但該資料一年才更新一次，且可由本機（台灣 IP）手動刷新。若某 source
 * 下載（含 fallback）全部失敗，改查 DB 內該 source 現有資料的 fetched_at：距今在
 * STALE_OK_DAYS 天內視為「黃燈」（庫存仍新鮮，不計入失敗），超過門檻或無資料才是紅燈。
 */

const fs = require('fs');
const {
  parseTaipei,
  parseNewTaipei,
  parseKaohsiung,
  parseKaohsiungJson,
  parseTaoyuan,
  parseTainan,
  parseTaichung,
  parseNationalNpa,
} = require('./lib/speed-camera-parser.cjs');
const {
  toUpsertPayloads,
  coordLookupKey,
  fillMissingCoords,
  dedupeAgainstExisting,
} = require('./lib/speed-camera-writer.cjs');
const { createGeocoder } = require('./lib/geocoder.cjs');

// 單輪 --write 最多對 Nominatim 呼叫的 geocode 次數上限（見 fillMissingCoords）。
// 台南首次回填 72 筆超過此上限時，需分多輪執行才能補完（下一輪起，已補到座標的
// 地址會在 fillMissingCoords 第一步直接從 DB 沿用，不會重複呼叫 Nominatim）。
const GEOCODE_MAX_CALLS_PER_RUN = Number(process.env.SPEEDCAM_GEOCODE_MAX_CALLS) || 100;

// 全國集（national-npa）與六都自建源的執行期聯集去重距離門檻（公尺）。
// 見 lib/speed-camera-writer.cjs dedupeAgainstExisting 與 docs/speed-camera-sources.md。
const NATIONAL_NPA_DEDUPE_THRESHOLD_M = 30;

// 各縣市原始資料下載連結（見 docs/speed-camera-sources.md 逐縣市細節）。
//
// fallbackUrls：主 URL 全部重試用盡仍失敗時的備援入口（不同主機）。目前只有高雄有——
// data.kcg.gov.tw 從 GitHub Actions（美國 runner）連續 timeout/fetch failed，本機台灣 IP
// 正常，高度懷疑地理封鎖；openapi.kcg.gov.tw 是不同主機（不同 IP），JSON 格式，
// 輸出 schema 經 248 筆全量比對與 CSV 版逐欄位一致（見 lib/speed-camera-parser.cjs
// parseKaohsiungJson 與 test/speed-camera-parser.test.cjs）。
const SOURCES = [
  {
    name: 'taipei',
    url: 'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=5012e8ba-5ace-4821-8482-ee07c147fd0a',
    parse: parseTaipei,
    fallbackUrls: [],
  },
  {
    name: 'new-taipei',
    url: 'https://data.ntpc.gov.tw/api/datasets/99f3ff6e-0352-4399-a726-775ab765a1dc/csv/file',
    parse: parseNewTaipei,
    fallbackUrls: [],
  },
  {
    name: 'kaohsiung',
    url: 'https://data.kcg.gov.tw/File/directDownload/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b',
    parse: parseKaohsiung,
    fallbackUrls: [
      {
        url: 'https://openapi.kcg.gov.tw/Api/Service/Get/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b',
        parse: parseKaohsiungJson,
      },
    ],
  },
  {
    name: 'taoyuan',
    url: 'https://opendata.tycg.gov.tw/api/dataset/ecd45ee5-4489-436b-bd08-7d4e4111c4a4/resource/6feee4ed-0221-40f2-bca1-980669e8d554/download',
    parse: parseTaoyuan,
    fallbackUrls: [],
  },
  {
    name: 'tainan',
    url: 'https://data.tainan.gov.tw/File/DirectDownload/1c7e82f0-d6b2-4b20-aeff-5c768100f82c',
    parse: parseTainan,
    fallbackUrls: [],
    // 台南來源無座標欄位，--write 模式需在 upsert 前跑 geocode 補值（見 writeAll）。
    needsGeocode: true,
  },
  {
    // 台中無結構化開放資料，來源是官方 PDF（文字型，非掃描，見 lib/speed-camera-parser.cjs
    // parseTaichung 與 docs/speed-camera-sources.md）。已含座標，不需 geocode。
    name: 'taichung',
    url: 'https://www.police.taichung.gov.tw/filedownload?file=downlod/202605151635480.pdf&filedisplay=%E8%87%BA%E4%B8%AD%E5%B8%82%E6%94%BF%E5%BA%9C%E8%AD%A6%E5%AF%9F%E5%B1%80%E5%9F%B7%E8%A1%8C%E5%9B%BA%E5%AE%9A%E5%BC%8F%E7%A7%91%E5%AD%B8%E5%84%80%E5%99%A8%E5%9F%B7%E6%B3%95%E8%A8%AD%E5%82%99%E5%8F%96%E7%B7%A0%E5%9C%B0%E9%BB%9E%E4%B8%80%E8%A6%BD%E8%A1%A83.pdf&flag=doc',
    parse: parseTaichung,
    fallbackUrls: [],
  },
  {
    // 警政署全國集「測速執法設置點」（data.gov.tw/dataset/7320）。parser 不依 CityName、
    // 縣市字尾或道路名稱排除任何有效座標；六都、其他縣市及國道／公路資料全部保留。
    // 與自建源的重複收錄只由 writeAll 的座標聯集去重處理（見 dedupeAgainstExisting）：
    // 與本輪其他六個來源座標 haversine ≤30m 視為同一點才丟棄，其餘完整保留。
    // 必須排在 SOURCES 陣列最後，writeAll 才能在處理它之前先收集完其他六源的座標。
    name: 'national-npa',
    url: 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/D737B2D5-B478-42C9-BE8C-94A5FBB7D907/download',
    parse: parseNationalNpa,
    fallbackUrls: [],
    dedupeAgainstOtherSources: true,
  },
];

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRY_DELAYS_MS = [5_000, 15_000]; // 第 1 次失敗後等 5s 重試，第 2 次失敗後等 15s 重試

const FALLBACK_MAX_ATTEMPTS = 2;
const FALLBACK_RETRY_DELAY_MS = 3_000; // 每個 fallback 入口內部重試前的短退避
const MAX_TOTAL_ATTEMPTS = FETCH_MAX_ATTEMPTS + FALLBACK_MAX_ATTEMPTS * 3; // 硬上界（主 URL + 最多 3 個 fallback 入口）

// 來源新鮮度黃燈門檻（天）：抓取全敗時，庫存資料在此天數內視為可容忍，不計入失敗。
const STALE_OK_DAYS = Number(process.env.SPEEDCAM_STALE_OK_DAYS) || 60;

// module.exports.sleep 可在測試中被覆寫以跳過真實等待；正式執行永遠是真實 delay。
function sleep(ms) {
  return module.exports.sleep(ms);
}
function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBufferOnce(url) {
  const fetch = globalThis.fetch || (await import('node-fetch')).default;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'tesla-radar-crawler/1.0 (speed-camera-sync)' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}：${url}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 對單一 URL 下載，失敗時最多重試 maxAttempts 次。
 * 每次重試都印一行 log（來源名、第幾次嘗試、錯誤摘要），方便從 Actions log 判斷
 * 是單次抖動還是穩定性封鎖。全部嘗試皆失敗才拋出最後一次的錯誤。
 *
 * @param {string} url
 * @param {string} logLabel 用於 log 前綴（來源名，fallback 時額外標註主機名）
 * @param {number} maxAttempts
 * @param {number[]|number} retryDelaysMs 每次重試前的等待毫秒數（陣列依索引取值，或單一數字每次相同）
 */
async function fetchWithRetry(url, logLabel, maxAttempts, retryDelaysMs) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchBufferOnce(url);
    } catch (err) {
      lastErr = err;
      console.error(`[speed-camera-sync] ${logLabel} 重試 ${attempt}/${maxAttempts} 失敗：${err.message}`);
      if (attempt < maxAttempts) {
        const delay = Array.isArray(retryDelaysMs) ? retryDelaysMs[attempt - 1] : retryDelaysMs;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

/**
 * 下載某個 source 的資料：先重試主 URL（FETCH_MAX_ATTEMPTS 次），全敗後依序嘗試
 * source.fallbackUrls（每個 fallback 入口最多 FALLBACK_MAX_ATTEMPTS 次、短退避）。
 * 每次切換到新的鏡像都印一行 log（含主機名），方便從 log 判斷實際走了哪個入口。
 * 總嘗試次數受 MAX_TOTAL_ATTEMPTS 硬上界保護。全部入口皆失敗才拋出最後一次的錯誤。
 *
 * @param {object} source SOURCES 內的一筆
 * @returns {Promise<{ buffer: Buffer, parse: Function }>}
 */
async function fetchSourceBuffer(source) {
  let totalAttempts = 0;
  const primaryAttempts = Math.min(FETCH_MAX_ATTEMPTS, MAX_TOTAL_ATTEMPTS);

  try {
    const buffer = await fetchWithRetry(source.url, source.name, primaryAttempts, FETCH_RETRY_DELAYS_MS);
    return { buffer, parse: source.parse };
  } catch (err) {
    totalAttempts += primaryAttempts;
    let lastErr = err;

    for (const fallback of source.fallbackUrls || []) {
      if (totalAttempts >= MAX_TOTAL_ATTEMPTS) break;
      const host = new URL(fallback.url).host;
      console.error(`[speed-camera-sync] ${source.name} 主來源失敗，改用鏡像 ${host} ...`);

      const attemptsLeft = Math.min(FALLBACK_MAX_ATTEMPTS, MAX_TOTAL_ATTEMPTS - totalAttempts);
      try {
        const buffer = await fetchWithRetry(
          fallback.url,
          `${source.name} 鏡像(${host})`,
          attemptsLeft,
          FALLBACK_RETRY_DELAY_MS
        );
        return { buffer, parse: fallback.parse || source.parse };
      } catch (fallbackErr) {
        totalAttempts += attemptsLeft;
        lastErr = fallbackErr;
      }
    }

    throw lastErr;
  }
}

/**
 * 查詢某 source 在 DB 現有資料的最新 fetched_at，回傳距今天數（無資料回傳 null）。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} sourceName
 * @returns {Promise<number|null>}
 */
async function getStaleDaysForSource(supabase, sourceName) {
  const { data, error } = await supabase
    .from('speed_cameras')
    .select('fetched_at')
    .eq('source', sourceName)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data || !data.fetched_at) return null;
  const ageMs = Date.now() - new Date(data.fetched_at).getTime();
  return ageMs / (24 * 60 * 60 * 1000);
}

/**
 * 查詢某 source 在 DB 現有的座標，組成 coordLookupKey → {lat,lng} 的 Map，
 * 供 fillMissingCoords 判斷「這個地址是否已經 geocode 過」，避免重複打 Nominatim。
 * 只抓 lat/lng 皆非 null 的列（沒座標的列查了也沒用）。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} sourceName
 * @returns {Promise<Map<string, {lat: number, lng: number}>>}
 */
async function getExistingCoordsForSource(supabase, sourceName) {
  const { data, error } = await supabase
    .from('speed_cameras')
    .select('address, direction, lat, lng')
    .eq('source', sourceName)
    .not('lat', 'is', null)
    .not('lng', 'is', null);
  if (error || !data) return new Map();

  const map = new Map();
  for (const row of data) {
    map.set(coordLookupKey(sourceName, row.address, row.direction), { lat: row.lat, lng: row.lng });
  }
  return map;
}

async function syncAll() {
  const fetchedAt = new Date().toISOString();
  const results = [];
  // national-npa 執行期聯集去重用：累積其他六個自建 source 已解析出的座標點位
  // （dry-run 不連 DB，台南無 geocode 補值，座標為 null，不會參與比對，見
  // dedupeAgainstExisting 的說明；行為與 --write 模式一致地繼承這個既有限制）。
  const collectedPoints = [];

  for (const source of SOURCES) {
    console.error(`[speed-camera-sync] 下載 ${source.name} ...`);
    try {
      const { buffer, parse } = await fetchSourceBuffer(source);
      let records = await parse(buffer, fetchedAt);
      console.error(`[speed-camera-sync] ${source.name} 解析出 ${records.length} 筆`);

      if (source.dedupeAgainstOtherSources) {
        const before = records.length;
        const { kept, droppedCount } = dedupeAgainstExisting(
          records,
          collectedPoints,
          NATIONAL_NPA_DEDUPE_THRESHOLD_M
        );
        records = kept;
        console.error(
          `[speed-camera-sync] ${source.name} 聯集去重：原始 ${before} 筆 → 與既有源重疊丟棄 ${droppedCount} 筆 → 保留 ${records.length} 筆`
        );
      } else {
        for (const r of records) {
          if (r.lat != null && r.lng != null) collectedPoints.push({ lat: r.lat, lng: r.lng });
        }
      }

      results.push(...records);
    } catch (err) {
      console.error(`[speed-camera-sync] ${source.name} 失敗：${err.message}`);
    }
  }

  return results;
}

/**
 * 真寫入模式：逐 source 下載、解析、upsert、清 stale。
 * 任一 source 失敗（下載/解析/upsert/清理）都不影響其他 source 繼續執行；
 * 每個 source 的結果（成功/失敗）彙總後回傳，由呼叫端決定 exit code 與寫入 sync_logs。
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} [opts]
 * @param {{geocode: (address: string) => Promise<{lat:number,lng:number}|null>}} [opts.geocoder] 測試注入 mock geocoder；預設 lib/geocoder.cjs 的真實 Nominatim 實例。
 * @returns {Promise<{ batchFetchedAt: string, sourceResults: Array<{name: string, ok: boolean, stale: boolean, staleDays: number|null, written: number, staleDeleted: number, error: string|null}> }>}
 */
async function writeAll(supabase, opts = {}) {
  const batchFetchedAt = new Date().toISOString();
  const sourceResults = [];
  // 共用同一個 geocoder 實例：Nominatim 1 req/s 節流是跨 source 全域的，
  // 不是每個 source 各自 1 req/s（避免多個需要 geocode 的來源疊加超過節流限制）。
  const geocoder = opts.geocoder || createGeocoder();
  // national-npa 執行期聯集去重用：累積其他六個自建 source 已解析（含台南 geocode
  // 補值後）的座標點位，見 SOURCES 內 national-npa 項與 dedupeAgainstExisting 說明。
  const collectedPoints = [];

  for (const source of SOURCES) {
    const result = { name: source.name, ok: false, stale: false, staleDays: null, written: 0, staleDeleted: 0, error: null };
    try {
      console.error(`[speed-camera-sync] 下載 ${source.name} ...`);
      const { buffer, parse } = await fetchSourceBuffer(source);
      let records = await parse(buffer, batchFetchedAt);
      console.error(`[speed-camera-sync] ${source.name} 解析出 ${records.length} 筆`);

      if (records.length === 0) {
        // 解析出 0 筆通常代表來源格式跑版或抓取異常，不是「這次真的沒資料」。
        // 丟到下面既有的 catch，走原本的 stale-tolerance 判斷，避免誤刪既有資料。
        throw new Error('解析出 0 筆，可能是來源格式跑版或抓取異常，中止本輪避免誤刪既有資料');
      }

      if (source.needsGeocode) {
        const existingCoords = await getExistingCoordsForSource(supabase, source.name);
        const fillResult = await fillMissingCoords(
          records,
          existingCoords,
          (address) => geocoder.geocode(address),
          GEOCODE_MAX_CALLS_PER_RUN
        );
        records = fillResult.records;
        console.error(
          `[speed-camera-sync] ${source.name} geocode 補值：沿用 DB ${fillResult.reusedFromDb} 筆、` +
            `新查 ${fillResult.geocodeAttempted} 筆（成功 ${fillResult.geocodeSucceeded}）、` +
            `超過單輪上限未處理 ${fillResult.skippedOverCap} 筆`
        );
      }

      if (source.dedupeAgainstOtherSources) {
        const before = records.length;
        const { kept, droppedCount } = dedupeAgainstExisting(
          records,
          collectedPoints,
          NATIONAL_NPA_DEDUPE_THRESHOLD_M
        );
        records = kept;
        console.error(
          `[speed-camera-sync] ${source.name} 聯集去重：原始 ${before} 筆 → 與既有源重疊丟棄 ${droppedCount} 筆 → 保留 ${records.length} 筆`
        );
      } else {
        for (const r of records) {
          if (r.lat != null && r.lng != null) collectedPoints.push({ lat: r.lat, lng: r.lng });
        }
      }

      const payloads = toUpsertPayloads(records, batchFetchedAt);

      if (payloads.length > 0) {
        const { error: upsertError } = await supabase
          .from('speed_cameras')
          .upsert(payloads, { onConflict: 'source,address,direction' });
        if (upsertError) throw new Error(`upsert 失敗：${upsertError.message}`);
      }
      result.written = payloads.length;

      // 清 stale：同一 source 底下，fetched_at 早於本輪批次時間戳的列已不在本輪來源資料中，須刪除。
      const { data: staleRows, error: staleSelectError } = await supabase
        .from('speed_cameras')
        .delete()
        .eq('source', source.name)
        .lt('fetched_at', batchFetchedAt)
        .select('id');
      if (staleSelectError) throw new Error(`清除 stale 失敗：${staleSelectError.message}`);
      result.staleDeleted = staleRows ? staleRows.length : 0;

      result.ok = true;
      console.error(
        `[speed-camera-sync] ${source.name} 寫入完成：upsert ${result.written} 筆，清除 stale ${result.staleDeleted} 筆`
      );
    } catch (err) {
      result.error = err.message;
      console.error(`[speed-camera-sync] ${source.name} 寫入失敗：${err.message}`);

      // 來源新鮮度黃燈：抓取全敗時查 DB 庫存新鮮度，仍新鮮則不計入失敗。
      const staleDays = await getStaleDaysForSource(supabase, source.name);
      if (staleDays !== null && staleDays <= STALE_OK_DAYS) {
        result.ok = true;
        result.stale = true;
        result.staleDays = staleDays;
        console.error(
          `[speed-camera-sync] ⚠️ ${source.name} 抓取失敗但庫存資料仍新鮮（${staleDays.toFixed(1)} 天前），視為可容忍`
        );
      }
    }
    sourceResults.push(result);
  }

  return { batchFetchedAt, sourceResults };
}

/**
 * 把 writeAll() 的結果彙總寫入 sync_logs（沿用 gh-plate-sync.cjs 的表格式，
 * 欄位語意借用：total_plates→本輪 upsert 總筆數，stations_success/failed→source 成功/失敗數）。
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ batchFetchedAt: string, sourceResults: Array<object> }} summary
 * @param {Date} startTime
 */
async function writeSyncLog(supabase, summary, startTime) {
  const endTime = new Date();
  const runtimeSec = (endTime - startTime) / 1000;
  const totalWritten = summary.sourceResults.reduce((sum, r) => sum + r.written, 0);
  const successCount = summary.sourceResults.filter((r) => r.ok).length;
  const failedCount = summary.sourceResults.filter((r) => !r.ok).length;
  const errorSummary = summary.sourceResults
    .filter((r) => !r.ok)
    .map((r) => `${r.name}: ${r.error}`)
    .join('\n')
    .substring(0, 2000);

  const { error } = await supabase.from('sync_logs').upsert(
    {
      run_id: `speed_camera_sync_${Date.now()}`,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      status: failedCount === 0 ? 'COMPLETED' : 'FAILED',
      total_plates: totalWritten,
      stations_success: successCount,
      stations_failed: failedCount,
      error_summary: errorSummary || null,
      runtime_sec: runtimeSec,
    },
    { onConflict: 'run_id' }
  );

  if (error) console.error(`[speed-camera-sync] 寫入 sync_logs 失敗：${error.message}`);
}

async function runWriteMode() {
  const { createClient } = require('@supabase/supabase-js');

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[speed-camera-sync] --write 模式需要 VITE_SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const startTime = new Date();

  const summary = await writeAll(supabase);
  await writeSyncLog(supabase, summary, startTime);

  const okSources = summary.sourceResults.filter((r) => r.ok && !r.stale);
  const staleSources = summary.sourceResults.filter((r) => r.ok && r.stale);
  const failedSources = summary.sourceResults.filter((r) => !r.ok);

  console.error(
    `[speed-camera-sync] 摘要：成功 ${okSources.length}／黃燈 ${staleSources.length}／失敗 ${failedSources.length}` +
      (staleSources.length > 0
        ? `（黃燈來源：${staleSources.map((r) => `${r.name} ${r.staleDays.toFixed(1)}天前`).join('、')}）`
        : '')
  );

  if (failedSources.length > 0) {
    console.error(
      `[speed-camera-sync] ${failedSources.length}/${summary.sourceResults.length} 個 source 寫入失敗，以非零 exit 結束。`
    );
    process.exit(1);
  }
  console.error('[speed-camera-sync] 全部 source 寫入成功（含黃燈容忍）。');
}

async function main() {
  const args = process.argv.slice(2);
  const isWrite = args.includes('--write');
  const isDryRun = args.includes('--dry-run');
  const outArg = args.find((a) => a.startsWith('--out='));
  const outFile = outArg ? outArg.slice('--out='.length) : null;

  if (isWrite) {
    await runWriteMode();
    return;
  }

  if (!isDryRun) {
    console.error('[speed-camera-sync] 目前只支援 --dry-run（不寫任何 DB）或 --write。');
    process.exit(1);
  }

  const records = await syncAll();
  const json = JSON.stringify(records, null, 2);

  if (outFile) {
    fs.writeFileSync(outFile, json, 'utf8');
    console.error(`[speed-camera-sync] 已輸出 ${records.length} 筆到 ${outFile}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[speed-camera-sync] 致命錯誤：', err);
    process.exit(1);
  });
}

module.exports = {
  syncAll,
  writeAll,
  writeSyncLog,
  SOURCES,
  sleep: realSleep,
  getExistingCoordsForSource,
  GEOCODE_MAX_CALLS_PER_RUN,
};
