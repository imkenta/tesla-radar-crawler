'use strict';

/**
 * Nominatim (OpenStreetMap) geocode 模組。
 *
 * 用途：補齊缺座標的測速照相資料（如台南，見 docs/speed-camera-sources.md）。
 *
 * ⛔ 使用限制（Nominatim usage policy）：
 *   - 節流 1 req/s（本模組內建）。
 *   - 必須帶自訂 User-Agent（禁止用預設 UA，會被 ban）。
 *   - 測試絕不可真打 Nominatim：test/geocoder.test.cjs 一律 mock fetch。
 *
 * 注入 fetchImpl 供測試替換，避免真實網路呼叫。
 */

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1000; // 1 req/s
const DEFAULT_USER_AGENT = 'tesla-radar-crawler/1.0 (speed-camera-sync; contact: skbankitrd@gmail.com)';

// 台灣邊界（bbox，WGS84）：lat 20~27, lng 117~123。涵蓋本島＋外島（金門約 118.3、馬祖約 119.9）。
// 用途二：
//   1. Nominatim 查詢帶 countrycodes=tw + viewbox/bounded=1，優先命中台灣結果。
//   2. 縱深防禦：不論 countrycodes 有沒有生效，回傳座標一律驗證落在此 bbox 內，
//      不在界內視為誤配（如「中正路」「中山路口」同名地址被配到中國），回傳 null。
const TW_BBOX = { minLat: 20, maxLat: 27, minLng: 117, maxLng: 123 };

function isWithinTaiwanBbox(lat, lng) {
  return (
    lat >= TW_BBOX.minLat &&
    lat <= TW_BBOX.maxLat &&
    lng >= TW_BBOX.minLng &&
    lng <= TW_BBOX.maxLng
  );
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 預設 global fetch；測試注入 mock。
 * @param {string} [opts.userAgent]
 * @param {number} [opts.minIntervalMs] 節流間隔（測試可縮短，正式程式碼不可）。
 * @param {Function} [opts.sleepImpl] 節流用的等待函式；測試可替換成立即 resolve。
 */
function createGeocoder(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const minIntervalMs = opts.minIntervalMs != null ? opts.minIntervalMs : MIN_INTERVAL_MS;
  const sleepImpl = opts.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (typeof fetchImpl !== 'function') {
    throw new Error('geocoder 需要 fetch 實作（global fetch 或注入 opts.fetchImpl）');
  }

  let lastRequestAt = 0;

  async function throttle() {
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (lastRequestAt > 0 && elapsed < minIntervalMs) {
      await sleepImpl(minIntervalMs - elapsed);
    }
    lastRequestAt = Date.now();
  }

  /**
   * 查詢單一地址，回傳第一筆結果的座標。查無結果或錯誤一律回傳 null（不丟例外），
   * 呼叫端自行決定是否重試／記錄。
   * @param {string} address
   * @returns {Promise<{lat: number, lng: number} | null>}
   */
  async function geocode(address) {
    if (!address || !address.trim()) return null;

    await throttle();

    // countrycodes=tw：限定台灣（Nominatim ISO 3166-1 alpha-2，小寫）。
    // viewbox+bounded=1：bbox 內優先/限定搜尋範圍，與 countrycodes 雙重收斂候選結果。
    const viewbox = `${TW_BBOX.minLng},${TW_BBOX.maxLat},${TW_BBOX.maxLng},${TW_BBOX.minLat}`;
    const url =
      `${NOMINATIM_BASE_URL}?format=json&limit=1&countrycodes=tw&viewbox=${viewbox}&bounded=1` +
      `&q=${encodeURIComponent(address)}`;
    let response;
    try {
      response = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
    } catch (err) {
      console.error(`[geocoder] 網路錯誤：${err.message}（address=${address}）`);
      return null;
    }

    if (!response.ok) {
      console.error(`[geocoder] HTTP ${response.status}（address=${address}）`);
      return null;
    }

    let results;
    try {
      results = await response.json();
    } catch (err) {
      console.error(`[geocoder] 回應非合法 JSON（address=${address}）`);
      return null;
    }

    if (!Array.isArray(results) || results.length === 0) return null;

    const lat = Number(results[0].lat);
    const lng = Number(results[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    if (!isWithinTaiwanBbox(lat, lng)) {
      console.error(`[geocoder] 座標落在台灣邊界外，判定誤配，回傳 null（address=${address}, lat=${lat}, lng=${lng}）`);
      return null;
    }

    return { lat, lng };
  }

  return { geocode };
}

module.exports = { createGeocoder, NOMINATIM_BASE_URL, MIN_INTERVAL_MS, DEFAULT_USER_AGENT };
