'use strict';

// 國道單向測速桿的「實際道路走向」覆寫（TeslaToolbox docs/post-launch-issues.md C-64）。
//
// `parseDirection` 由官方文字換算出的 direction_bearing 是羅盤值（北向＝0°、南向＝180°…），
// 是路線的名義方向、不是該處道路的實際走向。App 對國道單向桿用它判斷同向／對向，
// 在東西走向的路段（國一汐止—林口、國三木柵—中和…）會整個判反：對向桿誤報、真桿被排除
// （2026-09-19 實車：五楊北向 38.8K 到 109m 才報）。
//
// 這裡用一張**離線算好、人看過**的表覆寫（data/freeway-bearing-overrides.json，
// 產生方式見 tools/freeway-bearings/README.md）。同步流程本身不連 OSM、不做幾何運算：
//   - 表內有、且座標仍在 MATCH_RADIUS_M 內 → 用表上的方位；
//   - 表內標 keep_compass（來源座標可疑等）→ 維持羅盤值，不警告；
//   - 表內沒有（新桿、改名、座標搬家）→ 維持羅盤值，並回報給呼叫端印警告，提醒重跑離線工具。
// ⛔ 任何對不上的情況都退回羅盤值＝修前行為；這張表只會讓判定變準，不會讓沒處理到的桿變差。

const path = require('path');

const MATCH_RADIUS_M = 30;
const DEFAULT_TABLE_PATH = path.join(__dirname, '..', 'data', 'freeway-bearing-overrides.json');

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function buildIndex(table) {
  const byRoad = new Map();
  for (const entry of (table && table.entries) || []) {
    if (!byRoad.has(entry.road)) byRoad.set(entry.road, []);
    byRoad.get(entry.road).push(entry);
  }
  return byRoad;
}

let cachedDefaultIndex = null;
function defaultIndex() {
  if (!cachedDefaultIndex) cachedDefaultIndex = buildIndex(require(DEFAULT_TABLE_PATH));
  return cachedDefaultIndex;
}

function isFreewaySingle(record) {
  return record
    && record.road_class === 'freeway'
    && record.direction_mode === 'single'
    && Number.isFinite(record.lat)
    && Number.isFinite(record.lng);
}

/**
 * @returns {{records: object[], applied: number, keptCompass: number, unmatched: string[]}}
 *   records 為新陣列（不改動傳入物件）；unmatched 是「國道單向桿但表上找不到」的路名。
 */
function applyFreewayBearingOverrides(records, options = {}) {
  const index = options.table ? buildIndex(options.table) : defaultIndex();
  let applied = 0;
  let keptCompass = 0;
  const unmatched = [];

  const out = records.map((record) => {
    if (!isFreewaySingle(record)) return record;
    const candidates = index.get(String(record.road || '').trim()) || [];
    let best = null;
    for (const entry of candidates) {
      const d = haversineM(record.lat, record.lng, entry.lat, entry.lng);
      if (d <= MATCH_RADIUS_M && (!best || d < best.d)) best = { entry, d };
    }
    if (!best) {
      unmatched.push(String(record.road || '').trim());
      return record;
    }
    if (best.entry.keep_compass) {
      keptCompass += 1;
      return record;
    }
    applied += 1;
    return { ...record, direction_bearing: best.entry.bearing };
  });

  return { records: out, applied, keptCompass, unmatched };
}

function logFreewayBearingResult(sourceName, result, log = console.error) {
  if (result.applied === 0 && result.keptCompass === 0 && result.unmatched.length === 0) return;
  log(
    `[speed-camera-sync] ${sourceName} 國道方位表：套用實際走向 ${result.applied} 筆、` +
      `依表維持羅盤值 ${result.keptCompass} 筆、表上找不到 ${result.unmatched.length} 筆`
  );
  if (result.unmatched.length > 0) {
    log(
      `[speed-camera-sync] ⚠️ ${sourceName} 有國道單向桿不在方位表內（新桿、改名或座標搬家），` +
        `已退回羅盤值；請重跑 tools/freeway-bearings 更新 data/freeway-bearing-overrides.json：` +
        result.unmatched.slice(0, 10).join('、') + (result.unmatched.length > 10 ? '…' : '')
    );
  }
}

module.exports = {
  applyFreewayBearingOverrides,
  logFreewayBearingResult,
  MATCH_RADIUS_M,
  DEFAULT_TABLE_PATH,
};
