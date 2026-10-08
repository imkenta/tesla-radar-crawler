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

// 路口法（geocodeIntersection）：兩條路線幾何的最近頂點距離上限，與每次請求的最小間隔（≥1.1s，留餘裕）。
const INTERSECTION_MAX_DISTANCE_M = 25;
const ROAD_QUERY_MIN_INTERVAL_MS = 1100;

function haversineMeters(p, q) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(q.lat - p.lat);
  const dLng = toRad(q.lng - p.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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
  const roadVertexCache = new Map();

  async function throttle(intervalMs = minIntervalMs) {
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (lastRequestAt > 0 && elapsed < intervalMs) {
      await sleepImpl(intervalMs - elapsed);
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

  /**
   * 查一條路的線幾何（polygon_geojson=1&limit=5），回傳所有 LineString／MultiLineString 頂點
   * （[{lat,lng}]）。查無、網路／HTTP／JSON 錯誤一律回 null（不丟例外）；沒有線幾何回空陣列。
   * 節流間隔至少 1.1 秒（minIntervalMs 為 0 的測試除外）。
   */
  async function fetchRoadVertices(query) {
    // 同一輪內多個路口共用同一條路（如中西區中山路）：已查到的線幾何直接重用，省請求。
    if (roadVertexCache.has(query)) return roadVertexCache.get(query);
    await throttle(minIntervalMs > 0 ? Math.max(minIntervalMs, ROAD_QUERY_MIN_INTERVAL_MS) : 0);
    const viewbox = `${TW_BBOX.minLng},${TW_BBOX.maxLat},${TW_BBOX.maxLng},${TW_BBOX.minLat}`;
    const url =
      `${NOMINATIM_BASE_URL}?format=json&limit=5&polygon_geojson=1&countrycodes=tw&viewbox=${viewbox}&bounded=1` +
      `&q=${encodeURIComponent(query)}`;
    let response;
    try {
      response = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
    } catch (err) {
      console.error(`[geocoder] 網路錯誤：${err.message}（road=${query}）`);
      return null;
    }
    if (!response.ok) {
      console.error(`[geocoder] HTTP ${response.status}（road=${query}）`);
      return null;
    }
    let results;
    try {
      results = await response.json();
    } catch (err) {
      console.error(`[geocoder] 回應非合法 JSON（road=${query}）`);
      return null;
    }
    if (!Array.isArray(results)) return null;
    const vertices = [];
    for (const item of results) {
      const geo = item && item.geojson;
      if (!geo) continue;
      const lines = geo.type === 'LineString' ? [geo.coordinates]
        : geo.type === 'MultiLineString' ? geo.coordinates : [];
      for (const line of lines) {
        if (!Array.isArray(line)) continue;
        for (const point of line) {
          if (!Array.isArray(point)) continue;
          const lng = Number(point[0]);
          const lat = Number(point[1]);
          if (Number.isFinite(lat) && Number.isFinite(lng)) vertices.push({ lat, lng });
        }
      }
    }
    roadVertexCache.set(query, vertices);
    return vertices;
  }

  /**
   * 路口型地址（「A路與B街口」）：Nominatim 不吃這種描述，改成各查一次 `<縣市><區><路名>` 的線幾何，
   * 找兩條路頂點間最近的一對；距離 ≤ INTERSECTION_MAX_DISTANCE_M 視為路口，回傳該對的中點，
   * 否則（查無、無線幾何、兩路不相交）回 null。座標過台灣 bbox 驗證。固定發 2 次請求。
   * @param {string} district 含縣市的區名前綴，例如「臺南市中西區」
   * @param {string} roadA
   * @param {string} roadB
   * @returns {Promise<{lat: number, lng: number} | null>}
   */
  async function geocodeIntersection(district, roadA, roadB) {
    if (!district || !roadA || !roadB) return null;
    const a = await fetchRoadVertices(`${district}${roadA}`);
    const b = await fetchRoadVertices(`${district}${roadB}`);
    if (!a || !b || a.length === 0 || b.length === 0) return null;
    let best = null;
    for (const pa of a) {
      for (const pb of b) {
        const d = haversineMeters(pa, pb);
        if (best === null || d < best.d) best = { d, pa, pb };
      }
    }
    if (!best || best.d > INTERSECTION_MAX_DISTANCE_M) return null;
    const lat = (best.pa.lat + best.pb.lat) / 2;
    const lng = (best.pa.lng + best.pb.lng) / 2;
    if (!isWithinTaiwanBbox(lat, lng)) {
      console.error(`[geocoder] 路口座標落在台灣邊界外，判定誤配（${district}${roadA}×${roadB}）`);
      return null;
    }
    return { lat, lng };
  }

  return { geocode, geocodeIntersection };
}

module.exports = {
  createGeocoder, NOMINATIM_BASE_URL, MIN_INTERVAL_MS, DEFAULT_USER_AGENT,
  INTERSECTION_MAX_DISTANCE_M, ROAD_QUERY_MIN_INTERVAL_MS,
};
