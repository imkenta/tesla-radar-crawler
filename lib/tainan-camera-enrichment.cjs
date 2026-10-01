'use strict';

// 台南專用：逐筆官方佐證與市界檢查；不改全國集及其他來源的解析／去重。
const fs = require('node:fs');
const path = require('node:path');
const boundary = require('../data/tainan-boundary.json');
const { parseDirection } = require('./speed-camera-metadata.cjs');
const { coordLookupKey } = require('./speed-camera-writer.cjs');
const { hasNonPointLocation } = require('./tainan-camera-evidence.cjs');
const NPA_SOURCE_URL = 'https://data.gov.tw/dataset/7320';
const NEGATIVE_TTL_MS = 30 * 86400000;
const DEFAULT_CACHE_FILE = path.join(__dirname, '..', '.cache', 'tainan-geocode-v1.json');

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isWithinTainan(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    boundary.coordinates.some(rings => inRing(lng, lat, rings[0]) &&
      !rings.slice(1).some(ring => inRing(lng, lat, ring)));
}

function normalizeLocation(raw) {
  // 僅消除分隔符、台/臺與「公里處」差異。路名、數字、里程、附註均不可模糊消除。
  return String(raw || '').replace(/台/g, '臺').replace(/公里處/g, '公里')
    .replace(/[\s，、,（）()]/g, '').replace(/([\u4e00-\u9fff])-([\u4e00-\u9fff])/g, '$1$2').replace(/與/g, '');
}

function directionKey(raw) {
  const text = String(raw || '').replace(/\s+/g, '').replace(/([往向][東西南北]+)向$/, '$1');
  const parsed = parseDirection(text);
  if (parsed.mode === 'single') return `single:${parsed.bearing}`;
  // 東西雙向、南北雙向、多向不等於不分軸的雙向。
  if (/^(雙向)$/.test(text)) return 'both';
  if (/^(東西|西東)(向|雙向)?$/.test(text)) return 'axis:EW';
  if (/^(南北|北南)(向|雙向)?$/.test(text)) return 'axis:NS';
  return null;
}

function matchKey(record) {
  const address = String(record.address || '').trim();
  if (hasNonPointLocation(record)) return null;
  // 要有行政區；沒有里程的路口則必須整個位置相同。複合區間不借單點座標。
  if (!/^[\u4e00-\u9fff]{1,3}區\s/.test(address) || /區間|平均速率|一、|二、/.test(address)) return null;
  const direction = directionKey(record.direction);
  if (!direction || !record.road) return null;
  return `${normalizeLocation(address)}|${direction}`;
}

function enrichTainanFromNpa(records, npaRecords) {
  const index = new Map();
  for (const candidate of npaRecords) {
    if (candidate.source !== 'national-npa' || candidate.city !== '臺南市' ||
        candidate.speed_status !== 'confirmed') continue;
    const key = matchKey(candidate);
    if (!key) continue;
    const bucket = index.get(key) || [];
    bucket.push(candidate); // 重複／矛盾的候選一律拒絕，不取第一筆。
    index.set(key, bucket);
  }
  const matches = [];
  const reasons = {};
  const enriched = records.map(record => {
    if (record.source !== 'tainan') return record;
    const sanitized = !hasNonPointLocation(record) && isWithinTainan(record.lat, record.lng)
      ? record : { ...record, lat: null, lng: null };
    const key = matchKey(record), candidates = key ? index.get(key) || [] : [];
    let reason;
    if (record.speed_status === 'rejected') reason = 'explicit_non_speed';
    else if (!key) reason = 'unusable_location_or_direction';
    else if (candidates.length !== 1) reason = candidates.length ? 'ambiguous_npa_match' : 'no_exact_npa_match';
    else if (!isWithinTainan(candidates[0].lat, candidates[0].lng)) reason = 'npa_outside_tainan';
    if (reason) {
      reasons[reason] = (reasons[reason] || 0) + 1;
      return sanitized;
    }
    const npa = candidates[0];
    // 速限衝突可能代表設備換點；不借座標、不升分類。
    if (record.speed_limit == null || record.speed_limit !== npa.speed_limit) {
      reasons.speed_limit_conflict = (reasons.speed_limit_conflict || 0) + 1;
      return sanitized;
    }
    matches.push({ address: record.address, direction: record.direction, npa_address: npa.address,
      npa_direction: npa.direction, lat: npa.lat, lng: npa.lng, key });
    return {
      // 僅在嚴格逐筆命中後採用 NPA 道路 identity，供既有快速道路方向驗證表精確匹配。
      // address／direction／enforcement_items_raw 保留地方原文；NPA 原文仍記在 trace。
      ...sanitized, road: npa.road, lat: npa.lat, lng: npa.lng, speed_status: 'confirmed',
      classification_basis: 'official_point_match:national-npa:location+direction+speed_limit',
      speed_measurement_mode: 'point',
      taxonomy_basis: `${record.taxonomy_basis};speed_measurement_mode:official_point_match:national-npa;coords:official_npa:${JSON.stringify({ address: npa.address, road: npa.road, direction: npa.direction, key })}`,
      taxonomy_source_url: NPA_SOURCE_URL, taxonomy_observed_at: npa.fetched_at,
    };
  });
  return { records: enriched, matches, reasons };
}

function loadTainanNegativeCache(file = DEFAULT_CACHE_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.version === 1 && value.entries && typeof value.entries === 'object' ? value.entries : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[tainan] 負快取讀取失敗，改用空快取');
    return {};
  }
}

function saveTainanNegativeCache(entries, file = DEFAULT_CACHE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function fillTainanMissingCoords(records, existing, geocodeFn, cap, { cache = {}, now = Date.now() } = {}) {
  const filled = records.map(record => record.source !== 'tainan' ||
    (!hasNonPointLocation(record) && isWithinTainan(record.lat, record.lng))
    ? record : { ...record, lat: null, lng: null });
  const pending = [];
  let reusedFromDb = 0, skippedNegativeCache = 0, skippedOverCap = 0, skippedNonPoint = 0, geocodeAttempted = 0, geocodeSucceeded = 0;
  for (let i = 0; i < filled.length; i++) {
    const record = filled[i];
    if (record.source !== 'tainan' || isWithinTainan(record.lat, record.lng)) continue;
    if (hasNonPointLocation(record)) { skippedNonPoint++; continue; }
    const key = coordLookupKey(record.source, record.address, record.direction);
    const coords = existing.get(key);
    if (coords && isWithinTainan(coords.lat, coords.lng)) {
      filled[i] = { ...record, lat: coords.lat, lng: coords.lng };
      reusedFromDb++;
      delete cache[key];
      continue;
    }
    const last = Number.isFinite(cache[key]) ? cache[key] : 0;
    if (last > 0 && now - last < NEGATIVE_TTL_MS) { skippedNegativeCache++; continue; }
    pending.push({ i, key, last });
  }
  // 從未查過優先，其次最久沒查過；即使快取同時到期，也不會永遠重打前 100 筆。
  pending.sort((a, b) => a.last - b.last || a.i - b.i);
  for (const { i, key } of pending) {
    if (geocodeAttempted >= cap) { skippedOverCap++; continue; }
    geocodeAttempted++;
    const record = filled[i];
    let result;
    try { result = await geocodeFn(`臺南市${record.address}`); } catch { result = null; }
    if (result && isWithinTainan(result.lat, result.lng)) {
      filled[i] = { ...record, lat: result.lat, lng: result.lng,
        taxonomy_basis: `${record.taxonomy_basis};coords:nominatim:tainan_city_boundary` };
      geocodeSucceeded++;
      delete cache[key];
    } else cache[key] = now;
  }
  // 淘汰已移除地址，避免無限增長。
  const active = new Set(records.map(r => coordLookupKey(r.source, r.address, r.direction)));
  for (const key of Object.keys(cache)) if (!active.has(key)) delete cache[key];
  return { records: filled, reusedFromDb, skippedNegativeCache, skippedOverCap, skippedNonPoint, geocodeAttempted, geocodeSucceeded };
}

module.exports = { isWithinTainan, matchKey, directionKey, enrichTainanFromNpa, fillTainanMissingCoords,
  loadTainanNegativeCache, saveTainanNegativeCache, NEGATIVE_TTL_MS, DEFAULT_CACHE_FILE, NPA_SOURCE_URL };
