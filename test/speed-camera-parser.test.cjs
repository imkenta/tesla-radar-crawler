'use strict';

/**
 * 固定式測速照相解析回歸測試（golden master）。
 *
 * 全國無統一格式：編碼不同、座標欄位命名/順序不同、速限欄位偶有非數字內容。
 * 每個縣市的 fixture 都是真實下載資料的樣本節錄（見 docs/speed-camera-sources.md
 * 記錄的原始下載連結），用來把「真實 CSV → 預期正規化輸出」釘成基準。
 *
 * 執行：npm test （= node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseTaipei,
  parseNewTaipei,
  parseKaohsiung,
  parseKaohsiungJson,
  toSpeedLimit,
  toCoord,
} = require('../lib/speed-camera-parser.cjs');

function fixtureBuffer(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name));
}

const FIXED_NOW = '2026-07-04T00:00:00.000Z';

test('parseTaipei：Big5 編碼 CSV 正確轉碼與解析（golden）', () => {
  const buf = fixtureBuffer('speed-camera-taipei.csv');
  const result = parseTaipei(buf, FIXED_NOW);

  assert.equal(result.length, 5);
  assert.deepEqual(result, [
    {
      city: '臺北市',
      address: '承德路3段 敦煌路口',
      road: '承德路3段',
      direction: '南北雙向',
      speed_limit: 50,
      lat: 25.07450558,
      lng: 121.5199333,
      source: 'taipei',
      fetched_at: FIXED_NOW,
    },
    {
      // 速限欄位為多行字串「50(往北)\n60(往南)」，非純數字 → speed_limit 為 null
      city: '臺北市',
      address: '環河北路2段 昌吉街口',
      road: '環河北路2段',
      direction: '南北雙向',
      speed_limit: null,
      lat: 25.06589275,
      lng: 121.5088674,
      source: 'taipei',
      fetched_at: FIXED_NOW,
    },
    {
      city: '臺北市',
      address: '台北橋機車道下橋 近民權西路與延平北路口',
      road: '台北橋機車道下橋',
      direction: '西向東',
      speed_limit: 40,
      lat: 25.06287864,
      lng: 121.5108324,
      source: 'taipei',
      fetched_at: FIXED_NOW,
    },
    {
      city: '臺北市',
      address: '松江路 農安街口',
      road: '松江路',
      direction: '南向北',
      speed_limit: 50,
      lat: 25.06446188,
      lng: 121.5332619,
      source: 'taipei',
      fetched_at: FIXED_NOW,
    },
    {
      // 設置地點欄位為空 → address 只保留設置路段
      city: '臺北市',
      address: '基隆路二段109號前',
      road: '基隆路二段109號前',
      direction: '南往北',
      speed_limit: 50,
      lat: 25.02906139,
      lng: 121.5573087,
      source: 'taipei',
      fetched_at: FIXED_NOW,
    },
  ]);
});

test('parseNewTaipei：UTF-8 BOM CSV 解析、空取締項目不影響座標（golden）', () => {
  const buf = fixtureBuffer('speed-camera-ntpc.csv');
  const result = parseNewTaipei(buf, FIXED_NOW);

  assert.equal(result.length, 3);
  assert.deepEqual(result, [
    {
      city: '新北市',
      address: '八里區 中山路3段與下罟子漁港路口（往八里）',
      road: '中山路3段與下罟子漁港路口（往八里）',
      direction: '西南向東北',
      speed_limit: 50,
      lat: 25.14027,
      lng: 121.38151,
      source: 'new-taipei',
      fetched_at: FIXED_NOW,
    },
    {
      city: '新北市',
      address: '八里區 中華路3段236號長坑國小前（往八里）',
      road: '中華路3段236號長坑國小前（往八里）',
      direction: '南向北',
      speed_limit: 40,
      lat: 25.12536,
      lng: 121.39088,
      source: 'new-taipei',
      fetched_at: FIXED_NOW,
    },
    {
      // 區間測速路段：violation types 為空字串，座標與速限仍正常解析
      city: '新北市',
      address: '石碇區 台9線19K至23.1K（雙向）',
      road: '台9線19K至23.1K（雙向）',
      direction: '東西雙向(區間測速)',
      speed_limit: 40,
      lat: 24.9569297,
      lng: 121.6236371,
      source: 'new-taipei',
      fetched_at: FIXED_NOW,
    },
  ]);
});

test('parseKaohsiung：座標欄位命名「座標緯N度/座標經E度」且順序與其他縣市相反（golden）', () => {
  const buf = fixtureBuffer('speed-camera-kaohsiung.csv');
  const result = parseKaohsiung(buf, FIXED_NOW);

  assert.equal(result.length, 3);
  assert.deepEqual(result, [
    {
      city: '高雄市',
      address: '三民 民族一路與十全一路口',
      road: '民族一路與十全一路口',
      direction: '北向南',
      speed_limit: 60,
      lat: 22.644858,
      lng: 120.314341,
      source: 'kaohsiung',
      fetched_at: FIXED_NOW,
    },
    {
      city: '高雄市',
      address: '三民 民族一路268號前',
      road: '民族一路268號前',
      direction: '南北向',
      speed_limit: 60,
      lat: 22.649855,
      lng: 120.314951,
      source: 'kaohsiung',
      fetched_at: FIXED_NOW,
    },
    {
      // 「速限」欄位為「違左」（違規左轉，非測速）→ speed_limit 為 null，
      // 但仍保留該筆紀錄（篩選是否為測速由上層決定，解析器不擅自丟棄資料）
      city: '高雄市',
      address: '三民 中山高西側便道與九如一路口',
      road: '中山高西側便道與九如一路口',
      direction: '北向南',
      speed_limit: null,
      lat: 22.63776,
      lng: 120.336788,
      source: 'kaohsiung',
      fetched_at: FIXED_NOW,
    },
  ]);
});

test('parseKaohsiungJson：openapi.kcg.gov.tw JSON 鏡像——全量 248 筆與 CSV 主來源逐筆輸出完全一致（golden，fallback 對照組）', () => {
  // fixture 由本機台灣 IP 於 2026-07-05 各下載一次原始驗證取得：
  //   CSV：https://data.kcg.gov.tw/File/directDownload/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b
  //   JSON：https://openapi.kcg.gov.tw/Api/Service/Get/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b
  const csvBuf = fixtureBuffer('speed-camera-kaohsiung-full.csv');
  const jsonBuf = fixtureBuffer('speed-camera-kaohsiung-openapi.json');

  const csvRecords = parseKaohsiung(csvBuf, FIXED_NOW);
  const jsonRecords = parseKaohsiungJson(jsonBuf, FIXED_NOW);

  assert.equal(csvRecords.length, 248);
  assert.equal(jsonRecords.length, 248);
  assert.deepEqual(jsonRecords, csvRecords);
});

test('parseKaohsiungJson：座標欄位與速限欄位處理規則與 CSV 版相同（單筆樣本）', () => {
  const sample = {
    data: [
      {
        Seq: 7,
        編號: '7',
        型式: '線圈數位',
        測照地點: '中山高西側便道與九如一路口',
        測照方向: '北向南',
        速限: '違左',
        行政區: '三民',
        測照型式: '違左',
        座標緯N度: '22.63776',
        座標經E度: '120.336788',
      },
    ],
  };
  const buf = Buffer.from(JSON.stringify(sample), 'utf8');
  const result = parseKaohsiungJson(buf, FIXED_NOW);

  assert.deepEqual(result, [
    {
      city: '高雄市',
      address: '三民 中山高西側便道與九如一路口',
      road: '中山高西側便道與九如一路口',
      direction: '北向南',
      speed_limit: null, // 座標欄位順序（緯在前、經在後）與 CSV 版相同解析規則
      lat: 22.63776,
      lng: 120.336788,
      source: 'kaohsiung',
      fetched_at: FIXED_NOW,
    },
  ]);
});

test('toSpeedLimit：非數字/空值一律回傳 null，不可拋例外', () => {
  assert.equal(toSpeedLimit('50'), 50);
  assert.equal(toSpeedLimit('違左'), null);
  assert.equal(toSpeedLimit(''), null);
  assert.equal(toSpeedLimit(null), null);
  assert.equal(toSpeedLimit(undefined), null);
  assert.equal(toSpeedLimit('50(往北)\n60(往南)'), null);
});

test('toCoord：非數字/空值一律回傳 null', () => {
  assert.equal(toCoord('25.0745'), 25.0745);
  assert.equal(toCoord(''), null);
  assert.equal(toCoord(null), null);
  assert.equal(toCoord('N/A'), null);
});
