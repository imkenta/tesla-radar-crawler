'use strict';

// 快速道路單向測速桿的方向標籤驗證（TeslaToolbox post-launch B-14 候選①，2026-09-28）。
//
// App 自 2026-09-28 起對「快速道路＋單向＋有方位」的桿做「明確反向（夾角 >150°）就排除」。
// 快速道路的 direction_bearing 是官方羅盤標籤，實查 79 支中有 7 支與實際車道差 >150°
// （例：台65線 1.8K「往五股」卻標「北向南」＝標籤寫反）——照標籤排除就會漏報真桿。
// ⇒ 只有離線驗證過（data/expressway-direction-verified.json，產生方式見
//    tools/expressway-directions/README.md）的桿保留方位；其餘一律把 direction_bearing 清空，
//    App 拿不到方位就不做方向排除（照報，修前行為）。表上沒有的新桿同樣清空並回報。

const path = require('path');

const MATCH_RADIUS_M = 30;
const DEFAULT_TABLE_PATH = path.join(__dirname, '..', 'data', 'expressway-direction-verified.json');

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
    const key = String(entry.road || '').trim();
    if (!byRoad.has(key)) byRoad.set(key, []);
    byRoad.get(key).push(entry);
  }
  return byRoad;
}

let cachedDefaultIndex = null;
function defaultIndex() {
  if (!cachedDefaultIndex) cachedDefaultIndex = buildIndex(require(DEFAULT_TABLE_PATH));
  return cachedDefaultIndex;
}

function isExpresswaySingleWithBearing(record) {
  return record
    && record.road_class === 'expressway'
    && record.direction_mode === 'single'
    && record.direction_bearing != null;
}

/**
 * @returns {{records: object[], verified: number, cleared: string[]}}
 *   records 為新陣列（不改動傳入物件）；cleared 是被清空方位（未驗證）的路名。
 */
function applyExpresswayDirectionVerification(records, options = {}) {
  const index = options.table ? buildIndex(options.table) : defaultIndex();
  let verified = 0;
  const cleared = [];
  const out = records.map((record) => {
    if (!isExpresswaySingleWithBearing(record)) return record;
    const candidates = index.get(String(record.road || '').trim()) || [];
    const hit = Number.isFinite(record.lat) && Number.isFinite(record.lng) && candidates.some((entry) =>
      haversineM(record.lat, record.lng, entry.lat, entry.lng) <= MATCH_RADIUS_M
      && entry.label_bearing === record.direction_bearing);
    if (hit) {
      verified += 1;
      return record;
    }
    cleared.push(String(record.road || '').trim());
    return { ...record, direction_bearing: null };
  });
  return { records: out, verified, cleared };
}

function logExpresswayDirectionResult(sourceName, result, log = console.error) {
  if (result.verified === 0 && result.cleared.length === 0) return;
  log(
    `[speed-camera-sync] ${sourceName} 快速道路方向驗證：保留方位 ${result.verified} 筆、` +
      `未驗證清空方位 ${result.cleared.length} 筆（App 對這些桿不做方向排除）`
  );
}

module.exports = {
  applyExpresswayDirectionVerification,
  logExpresswayDirectionResult,
  MATCH_RADIUS_M,
  DEFAULT_TABLE_PATH,
};
