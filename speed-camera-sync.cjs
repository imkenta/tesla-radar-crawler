'use strict';

/**
 * 台灣固定式測速照相開放資料同步（R7，見 Tesla/TeslaToolbox/docs/nav-gap-analysis-2026-07-04.md）。
 *
 * 目前狀態：僅 --dry-run。本輪不寫任何 DB（Supabase migration 見
 * supabase/migrations-draft/speed_cameras.sql，尚未套用）。
 *
 * 資料來源盤點與各縣市格式陷阱見 docs/speed-camera-sources.md。
 * 解析邏輯單一真理：lib/speed-camera-parser.cjs（測試：test/speed-camera-parser.test.cjs）。
 *
 * 用法：
 *   node speed-camera-sync.cjs --dry-run              輸出正規化 JSON 到 stdout
 *   node speed-camera-sync.cjs --dry-run --out=FILE    輸出正規化 JSON 到指定檔案
 */

const fs = require('fs');
const { parseTaipei, parseNewTaipei, parseKaohsiung } = require('./lib/speed-camera-parser.cjs');

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

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const outArg = args.find((a) => a.startsWith('--out='));
  const outFile = outArg ? outArg.slice('--out='.length) : null;

  if (!isDryRun) {
    console.error('[speed-camera-sync] 目前只支援 --dry-run（不寫任何 DB）。');
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

module.exports = { syncAll, SOURCES };
