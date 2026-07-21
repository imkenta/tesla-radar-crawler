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
const { PDFParse } = require('pdf-parse');

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

/**
 * 台南市行政區代碼 → 行政區名稱對照表。
 * 來源：臺南市政府資料開放平台「臺南市各區代碼」
 * https://data.tainan.gov.tw/File/DirectDownload/5b389f60-dee6-425a-8a40-f5cb2f949cf1
 * （實測下載驗證，2026-07-05）。只列測速照相資料集實際出現的 14 碼；
 * 未收錄的代碼會被忽略（city 仍輸出，但地址不含行政區名，留供人工排查）。
 */
const TAINAN_DISTRICT_CODES = {
  '67000010': '新營區',
  '67000020': '鹽水區',
  '67000030': '白河區',
  '67000040': '柳營區',
  '67000050': '後壁區',
  '67000060': '東山區',
  '67000070': '麻豆區',
  '67000080': '下營區',
  '67000090': '六甲區',
  '67000100': '官田區',
  '67000110': '大內區',
  '67000120': '佳里區',
  '67000130': '學甲區',
  '67000140': '西港區',
  '67000150': '七股區',
  '67000160': '將軍區',
  '67000170': '北門區',
  '67000180': '新化區',
  '67000190': '善化區',
  '67000200': '新市區',
  '67000210': '安定區',
  '67000220': '山上區',
  '67000230': '玉井區',
  '67000240': '楠西區',
  '67000250': '南化區',
  '67000260': '左鎮區',
  '67000270': '仁德區',
  '67000280': '歸仁區',
  '67000290': '關廟區',
  '67000300': '龍崎區',
  '67000310': '永康區',
  '67000320': '東區',
  '67000330': '南區',
  '67000340': '北區',
  '67000350': '安南區',
  '67000360': '安平區',
  '67000370': '中西區',
};

/**
 * 清理台南「設置位置」欄位：原始文字混雜地點描述、系統類型標籤與違規項目列舉，
 * 例：「北門路段(...)自動辨識違規停車及不依標線行駛科技執法系統【違規停車、...】」
 * 或「【區間平均速率執法系統】一、市道182線27.2248公里至...」（標籤在開頭）。
 * 規則：
 *   1. 開頭若為【標籤】，去掉該標籤，保留其後內容。
 *   2. 其後若還有【...】（違規項目列舉），從該處截斷到底。
 * 清理後仍可能殘留系統類型字樣（如「...科技執法系統」）或複合路段描述
 * （區間測速常見「一、...二、...」雙方向敘述），這類殘餘不影響 geocode 可用性，
 * 交給 Nominatim 自行盡力匹配；查無結果時 geocode 回傳 null，不視為失敗。
 * @param {string} raw
 * @returns {string}
 */
function cleanTainanLocation(raw) {
  if (!raw) return '';
  let text = raw.trim();
  const leadingLabel = text.match(/^【[^】]*】([\s\S]*)$/);
  if (leadingLabel) {
    text = leadingLabel[1].trim();
  }
  text = text.replace(/【[\s\S]*$/, '').trim();
  return text;
}

/**
 * 台南市智慧管理科技執法設備設置地點。UTF-8 with BOM。
 * 欄位：轄區分局,行政區,設置位置,拍攝行向,速限
 * 無座標欄位（lat/lng 一律 null，交由 geocode 流程補值，見 speed-camera-sync.cjs）。
 * 「行政區」欄位是行政區代碼（非文字），需查 TAINAN_DISTRICT_CODES 轉換。
 * 「設置位置」欄位混雜地點描述與違規項目列舉，見 cleanTainanLocation()。
 * @param {Buffer} buffer
 * @param {string} [fetchedAt]
 * @returns {object[]}
 */
function parseTainan(buffer, fetchedAt = new Date().toISOString()) {
  const rows = parseCsv(buffer, 'utf8');
  return rows.map((row) => {
    const districtName = TAINAN_DISTRICT_CODES[row['行政區']] || null;
    const cleanedLocation = cleanTainanLocation(row['設置位置']);
    return {
      city: '臺南市',
      address: [districtName, cleanedLocation].filter(Boolean).join(' '),
      road: cleanedLocation || null,
      direction: row['拍攝行向'] || null,
      speed_limit: toSpeedLimit(row['速限']),
      lat: null,
      lng: null,
      source: 'tainan',
      fetched_at: fetchedAt,
    };
  });
}

/**
 * 台中市政府警察局「固定式科學儀器執法設備」取締地點一覽表。PDF（文字型，非掃描）。
 * 官方來源：臺中市政府警察局交通警察大隊「表單下載」頁面
 * https://www.police.taichung.gov.tw/traffic/home.jsp?id=55&parentpath=0,5,53
 * （2026-07-05 實測下載驗證，229 筆，逐頁 pdftotext/pdf-parse 抽取皆確認為可靠文字層，非掃描影像）。
 *
 * 已含座標（座標緯度/座標經度），不需 geocode。
 *
 * PDF 版面規律（每筆紀錄跨 2 行，偶爾因备註/取締項目換行變 3-4 行）：
 *   <編號> <行政區> <設置地點>[ (備註，如往XX方向) ]
 *   <取締項目（可能再換行）> <座標緯度> <座標經度> <拍攝方向> <速限> <管轄單位>[ ※]
 * 新紀錄邊界＝行首為「數字 + 空白 + 東京都式行政區(X區) + 空白」；
 * 座標列尾端固定為「緯度 經度 方向 速限 XX分局」，偶爾多印一個 ※ 註記符號（本身無額外語意，
 * 忽略即可）。全 229 筆已用真實 PDF 驗證：座標皆落在台中市範圍、無重複 (行政區+設置地點, 方向) 組合。
 *
 * @param {Buffer} buffer 原始 PDF 檔案內容
 * @param {string} [fetchedAt]
 * @returns {Promise<object[]>} 正規化紀錄（async，因 pdf-parse 文字抽取為非同步 API）
 */
async function parseTaichung(buffer, fetchedAt = new Date().toISOString()) {
  const parser = new PDFParse({ data: buffer });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  // 去掉「-- N of M --」分頁標記行，讓跨頁的紀錄（若有）仍能正確銜接。
  text = text.replace(/^-- \d+ of \d+ --\n?/gm, '');
  const lines = text.split('\n');

  const rowStartRe = /^(\d+)\s+(\S+區)\s+(.*)$/;
  const coordLineRe = /(\d{2}\.\d+)\s+(\d{3}\.\d+)\s+(\S+)\s+(\d+)\s+(\S+分局)\s*※?\s*$/;
  const violationStartRe = /(闖紅燈|不依標誌)/;

  const records = [];
  let currentNo = null;
  let currentDistrict = null;
  let bufferLines = [];

  function flush() {
    if (currentNo == null) return;
    const fullText = bufferLines.join(' ');
    const m = coordLineRe.exec(fullText);
    if (!m) {
      console.error(`[parseTaichung] 第 ${currentNo} 筆找不到座標欄位，略過：${fullText.slice(0, 80)}`);
      return;
    }
    const [, lat, lng, direction, speedLimit, unit] = m;
    const beforeCoord = fullText.slice(0, m.index).trim();

    const vm = violationStartRe.exec(beforeCoord);
    // location 部分含「編號 行政區 設置地點[備註]」前綴，去掉編號與行政區前綴只留設置地點。
    const locationWithPrefix = vm ? beforeCoord.slice(0, vm.index).trim() : beforeCoord;
    const locMatch = /^\d+\s+\S+區\s+(.*)$/.exec(locationWithPrefix);
    const location = (locMatch ? locMatch[1] : locationWithPrefix).trim();

    records.push({
      city: '臺中市',
      address: [currentDistrict, location].filter(Boolean).join(' '),
      road: location || null,
      direction: direction || null,
      speed_limit: toSpeedLimit(speedLimit),
      lat: toCoord(lat),
      lng: toCoord(lng),
      source: 'taichung',
      fetched_at: fetchedAt,
    });
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '臺中市政府警察局' || line.includes('取締地點一覽表') || line.startsWith('設備') || line.startsWith('編號')) {
      continue;
    }
    const m = rowStartRe.exec(line);
    if (m) {
      flush();
      currentNo = m[1];
      currentDistrict = m[2];
      bufferLines = [line];
    } else if (currentNo != null) {
      bufferLines.push(line);
    }
  }
  flush();

  return records;
}

/**
 * 警政署全國集「測速執法設置點」（data.gov.tw/dataset/7320）。UTF-8 with BOM。
 * 欄位：CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit
 *
 * ⚠️ 陷阱（實測發現，非文件記載）：原始 CSV 為雙層表頭——第 1 行英文欄位名
 * （csv-parse 的 columns:true 已消耗掉），第 2 行是中文欄位說明（「設置縣市,設置市區鄉鎮,...」），
 * 從第 3 行起才是真實資料。若不跳過第 2 行，會把這行說明文字當成一筆假紀錄混入輸出
 * （CityName 會是「設置縣市」這種非縣市格式字串）。判斷方式：Longitude/Latitude
 * 兩欄無法解析為有限數字者視為表頭說明列，一律跳過（比寫死 row index 更穩健，
 * 未來來源若增刪列不會誤刪真實資料）。
 *
 * CityName 可能是行政縣市，也可能是「國道五號」「國道3甲」「台2已線」等道路分類。
 * parser 不依任何名稱、字尾或道路文字排除資料；只要經緯度有效就完整保留。跨來源重複點
 * 統一交由 speed-camera-sync.cjs 的座標聯集去重處理（haversine ≤30m 視為同一點）。
 *
 * 已知缺口：連江縣（馬祖）本資料集查無資料（0 筆），見 docs/speed-camera-sources.md。
 *
 * @param {Buffer} buffer 原始檔案內容（UTF-8 with BOM）
 * @param {string} [fetchedAt]
 * @returns {object[]}
 */
function parseNationalNpa(buffer, fetchedAt = new Date().toISOString()) {
  const rows = parseCsv(buffer, 'utf8');
  const records = [];
  for (const row of rows) {
    const lat = toCoord(row.Latitude);
    const lng = toCoord(row.Longitude);
    if (lat == null || lng == null) continue; // 中文欄位說明列（或缺座標的髒列）

    records.push({
      city: (row.CityName || '').trim(),
      address: [row.RegionName, row.Address].filter(Boolean).join(' '),
      road: row.Address || null,
      direction: row.direct || null,
      speed_limit: toSpeedLimit(row.limit),
      lat,
      lng,
      source: 'national-npa',
      fetched_at: fetchedAt,
    });
  }
  return records;
}

module.exports = {
  parseTaipei,
  parseNewTaipei,
  parseKaohsiung,
  parseKaohsiungJson,
  parseTaoyuan,
  parseTainan,
  parseTaichung,
  parseNationalNpa,
  cleanTainanLocation,
  TAINAN_DISTRICT_CODES,
  toSpeedLimit,
  toCoord,
};
