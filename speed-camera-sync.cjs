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
 */

const fs = require('fs');
const { parseTaipei, parseNewTaipei, parseKaohsiung } = require('./lib/speed-camera-parser.cjs');
const { toUpsertPayloads } = require('./lib/speed-camera-writer.cjs');

// 各縣市原始資料下載連結（見 docs/speed-camera-sources.md 逐縣市細節）。
const SOURCES = [
  {
    name: 'taipei',
    url: 'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=5012e8ba-5ace-4821-8482-ee07c147fd0a',
    parse: parseTaipei,
  },
  {
    name: 'new-taipei',
    url: 'https://data.ntpc.gov.tw/api/datasets/99f3ff6e-0352-4399-a726-775ab765a1dc/csv/file',
    parse: parseNewTaipei,
  },
  {
    name: 'kaohsiung',
    url: 'https://data.kcg.gov.tw/File/directDownload/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b',
    parse: parseKaohsiung,
  },
];

async function fetchBuffer(url) {
  const fetch = globalThis.fetch || (await import('node-fetch')).default;
  const res = await fetch(url, { headers: { 'User-Agent': 'tesla-radar-crawler/1.0 (speed-camera-sync)' } });
  if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}：${url}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function syncAll() {
  const fetchedAt = new Date().toISOString();
  const results = [];

  for (const source of SOURCES) {
    console.error(`[speed-camera-sync] 下載 ${source.name} ...`);
    try {
      const buffer = await fetchBuffer(source.url);
      const records = source.parse(buffer, fetchedAt);
      console.error(`[speed-camera-sync] ${source.name} 解析出 ${records.length} 筆`);
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
 * @returns {Promise<{ batchFetchedAt: string, sourceResults: Array<{name: string, ok: boolean, written: number, staleDeleted: number, error: string|null}> }>}
 */
async function writeAll(supabase) {
  const batchFetchedAt = new Date().toISOString();
  const sourceResults = [];

  for (const source of SOURCES) {
    const result = { name: source.name, ok: false, written: 0, staleDeleted: 0, error: null };
    try {
      console.error(`[speed-camera-sync] 下載 ${source.name} ...`);
      const buffer = await fetchBuffer(source.url);
      const records = source.parse(buffer, batchFetchedAt);
      console.error(`[speed-camera-sync] ${source.name} 解析出 ${records.length} 筆`);

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

  const failedSources = summary.sourceResults.filter((r) => !r.ok);
  if (failedSources.length > 0) {
    console.error(
      `[speed-camera-sync] ${failedSources.length}/${summary.sourceResults.length} 個 source 寫入失敗，以非零 exit 結束。`
    );
    process.exit(1);
  }
  console.error('[speed-camera-sync] 全部 source 寫入成功。');
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

module.exports = { syncAll, writeAll, writeSyncLog, SOURCES };
