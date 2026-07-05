'use strict';

/**
 * 台灣固定式測速照相開放資料「純解析邏輯」——單一真理來源。
 *
 * 全國無統一格式（見 docs/speed-camera-sources.md）：編碼不同（Big5 / UTF-8 BOM）、
 * 座標欄位命名與順序不同、「速限」欄位偶爾混入非數字內容。每個縣市一個 parse 函式，
 * 全部輸出同一正規化 schema：
 *   { city, address, road, direction, speed_limit, lat, lng, source, fetched_at }
 *
 * 缺座標的縣市（如台南）lat/lng 回傳 null，留待 lib/geocoder.cjs 補齊。
 *
 * 測試：test/speed-camera-parser.test.cjs 用 test/fixtures/speed-camera-*.csv
 * （golden master，真實資料樣本）。
 */

const { parse } = require('csv-parse/sync');
const iconv = require('iconv-lite');

/**
 * 把字串轉成 number，非數字（如高雄「違左」、空字串）一律回傳 null。
 * @param {string} raw
 * @returns {number|null}
 */
function toSpeedLimit(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把字串轉成座標 number，空值/NaN 一律回傳 null。
 * @param {string} raw
 * @returns {number|null}
 */
function toCoord(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(buffer, encoding) {
  // Node 內建 Buffer.toString() 不支援 big5，一律透過 iconv-lite 解碼
  // （utf8/utf-8 由 iconv-lite 處理也沒問題，行為與內建一致）。
  const text = iconv.decode(buffer, encoding);
  return parse(text, { columns: true, skip_empty_lines: true, bom: true });
}

/**
 * 台北市固定測速照相地點表。原始編碼 Big5。
 * 欄位：編號,功能,設置路段,設置地點,緯度,經度,轄區,拍攝方向,速限-速度限制,縣市,縣市代碼
 * @param {Buffer} buffer 原始檔案內容（Big5 編碼）
 * @param {string} [fetchedAt] ISO timestamp；預設 now
 * @returns {object[]} 正規化紀錄
 */
function parseTaipei(buffer, fetchedAt = new Date().toISOString()) {
  const rows = parseCsv(buffer, 'big5');
  return rows.map((row) => ({
    city: '臺北市',
    address: [row['設置路段'], row['設置地點']].filter(Boolean).join(' '),
    road: row['設置路段'] || null,
    direction: row['拍攝方向'] || null,
    speed_limit: toSpeedLimit(row['速限-速度限制']),
    lat: toCoord(row['緯度']),
    lng: toCoord(row['經度']),
    source: 'taipei',
    fetched_at: fetchedAt,
  }));
}

/**
 * 新北市固定式測速照相（全市總表）。UTF-8 with BOM。
 * 欄位：cityname,regionname,address,deptnm,branchnm,violation types,longitude,latitude,direct,limit
 * @param {Buffer} buffer
 * @param {string} [fetchedAt]
 * @returns {object[]}
 */
function parseNewTaipei(buffer, fetchedAt = new Date().toISOString()) {
  const rows = parseCsv(buffer, 'utf8');
  return rows.map((row) => ({
    city: '新北市',
    address: [row.regionname, row.address].filter(Boolean).join(' '),
    road: row.address || null,
    direction: row.direct || null,
    speed_limit: toSpeedLimit(row.limit),
    lat: toCoord(row.latitude),
    lng: toCoord(row.longitude),
    source: 'new-taipei',
    fetched_at: fetchedAt,
  }));
}

/**
 * 高雄市固定式違規照相設備及科技執法設置地點。UTF-8 with BOM。
 * 欄位：Seq,編號,型式,測照地點,測照方向,速限,行政區,測照型式,座標緯N度,座標經E度
 * ⚠️ 座標欄位命名為「座標緯N度／座標經E度」（緯在前、經在後），與其他縣市順序相反，
 * 解析時務必依欄位名取值，不可依欄位順序假設。
 * @param {Buffer} buffer
 * @param {string} [fetchedAt]
 * @returns {object[]}
 */
function parseKaohsiung(buffer, fetchedAt = new Date().toISOString()) {
  const rows = parseCsv(buffer, 'utf8');
  return rows.map((row) => ({
    city: '高雄市',
    address: [row['行政區'], row['測照地點']].filter(Boolean).join(' '),
    road: row['測照地點'] || null,
    direction: row['測照方向'] || null,
    speed_limit: toSpeedLimit(row['速限']),
    lat: toCoord(row['座標緯N度']),
    lng: toCoord(row['座標經E度']),
    source: 'kaohsiung',
    fetched_at: fetchedAt,
  }));
}

/**
 * 高雄市固定式違規照相設備及科技執法設置地點——JSON API 版本（fallback 用）。
 * 主來源 data.kcg.gov.tw（CSV）遭地理封鎖時，改打 openapi.kcg.gov.tw（不同主機）。
 * 回傳格式為 `{ data: [...] }`，每筆物件欄位與 CSV 版表頭同名（中文欄位）。
 * 輸出 schema 與 parseKaohsiung（CSV 版）逐欄位一致，已用真實下載資料 248 筆全量比對驗證零差異。
 * @param {Buffer} buffer JSON API 原始回應內容（UTF-8）
 * @param {string} [fetchedAt]
 * @returns {object[]}
 */
function parseKaohsiungJson(buffer, fetchedAt = new Date().toISOString()) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  const rows = parsed.data || [];
  return rows.map((row) => ({
    city: '高雄市',
    address: [row['行政區'], row['測照地點']].filter(Boolean).join(' '),
    road: row['測照地點'] || null,
    direction: row['測照方向'] || null,
    speed_limit: toSpeedLimit(row['速限']),
    lat: toCoord(row['座標緯N度']),
    lng: toCoord(row['座標經E度']),
    source: 'kaohsiung',
    fetched_at: fetchedAt,
  }));
}

/**
 * 桃園市固定式測速照相。原始編碼 Big5。
 * 欄位：設備類別,設置縣市代碼,設置行政區,設置行政區代碼,設置地址,管轄警局,管轄警局機關代碼,
 *       管轄分局,管轄分局機關代碼,經度,緯度,拍攝方向,速限
 * 地址是片段（如「成功路三段235號前」），組完整地址需拼接「設置行政區」。
 *
 * ⚠️ 陷阱（實測發現，非文件記載）：表頭寫「經度,緯度」，但「固定式測速照相設備」類型
 * 該兩欄確實是 經度,緯度 順序；「路口多功能測速照相設備」「區間平均速率測速照相設備」
 * 兩種類型的同兩欄卻是 緯度,經度（順序相反），全檔 171 筆中有 58 筆屬於此陷阱。
 * 因此不可依欄位名/欄位順序取值，改用數值大小判斷：台灣經度(~119-122) 恆大於緯度(~21-27)，
 * 兩欄取值後何者較大即為經度。
 * @param {Buffer} buffer 原始檔案內容（Big5 編碼）
 * @param {string} [fetchedAt]
 * @returns {object[]}
 */
function parseTaoyuan(buffer, fetchedAt = new Date().toISOString()) {
  const rows = parseCsv(buffer, 'big5');
  return rows.map((row) => {
    const colA = toCoord(row['經度']);
    const colB = toCoord(row['緯度']);
    // 兩欄何者數值較大即為經度（台灣經度 ~119-122 恆大於緯度 ~21-27）。
    let lng = null;
    let lat = null;
    if (colA != null && colB != null) {
      if (colA > colB) {
        lng = colA;
        lat = colB;
      } else {
        lng = colB;
        lat = colA;
      }
    }
    return {
      city: '桃園市',
      address: [row['設置行政區'], row['設置地址']].filter(Boolean).join(' '),
      road: row['設置地址'] || null,
      direction: row['拍攝方向'] || null,
      speed_limit: toSpeedLimit(row['速限']),
      lat,
      lng,
      source: 'taoyuan',
      fetched_at: fetchedAt,
    };
  });
}

module.exports = {
  parseTaipei,
  parseNewTaipei,
  parseKaohsiung,
  parseKaohsiungJson,
  parseTaoyuan,
  toSpeedLimit,
  toCoord,
};
