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
  parseTaoyuan,
  parseTainan,
  parseTaichung,
  parseNationalNpa,
  cleanTainanLocation,
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

test('parseTaoyuan：Big5 編碼 CSV，且「經度/緯度」欄位在不同設備類別下順序相反時仍正確判斷（golden）', () => {
  // fixture 由本機台灣 IP 於 2026-07-05 從 opendata.tycg.gov.tw 實測下載節錄，
  // 涵蓋兩種欄位順序：「固定式測速照相設備」經度在前（與表頭一致），
  // 「路口多功能測速照相設備」「區間平均速率測速照相設備」緯度在前（與表頭不一致，實測發現的陷阱）。
  const buf = fixtureBuffer('speed-camera-taoyuan.csv');
  const result = parseTaoyuan(buf, FIXED_NOW);

  assert.equal(result.length, 4);
  assert.deepEqual(result, [
    {
      city: '桃園市',
      address: '桃園區 成功路三段235號前',
      road: '成功路三段235號前',
      direction: '往桃園市區方向',
      speed_limit: 40,
      lat: 25.00729,
      lng: 121.32475,
      source: 'taoyuan',
      fetched_at: FIXED_NOW,
    },
    {
      city: '桃園市',
      address: '桃園區 春日路561號前',
      road: '春日路561號前',
      direction: '往桃園市區方向',
      speed_limit: 50,
      lat: 25.005,
      lng: 121.31246,
      source: 'taoyuan',
      fetched_at: FIXED_NOW,
    },
    {
      // 「路口多功能測速照相設備」：來源欄位順序是 緯度,經度（與表頭「經度,緯度」相反）
      // 解析器依數值大小判斷，仍正確輸出 lat<27, lng>119
      city: '桃園市',
      address: '桃園區 國際路二段與大興西路三段路口',
      road: '國際路二段與大興西路三段路口',
      direction: '國際路上雙向',
      speed_limit: 50,
      lat: 25.002139,
      lng: 121.286824,
      source: 'taoyuan',
      fetched_at: FIXED_NOW,
    },
    {
      // 「區間平均速率測速照相設備」：同樣是緯度,經度順序（陷阱）
      city: '桃園市',
      address: '龜山區 萬壽路一段18.9K至20K',
      road: '萬壽路一段18.9K至20K',
      direction: '往龜山(南)(區間測速)',
      speed_limit: 50,
      lat: 25.011771,
      lng: 121.375618,
      source: 'taoyuan',
      fetched_at: FIXED_NOW,
    },
  ]);
});

test('parseTainan：UTF-8 BOM CSV，行政區代碼轉區名、設置位置清理雜訊、lat/lng 一律 null（golden）', () => {
  // fixture 由本機於 2026-07-05 從 data.tainan.gov.tw 實測下載節錄，涵蓋：
  //   row0：地點描述+系統類型敘述+違規項目【】列舉（典型格式）
  //   row1：同上，較短
  //   row2：【區間平均速率執法系統】標籤在開頭、內容為雙路段複合敘述（清理後仍混雜里程資訊，
  //         geocode 準確度存疑但不視為失敗，見 docs/speed-camera-sources.md）
  //   row3：設置位置文字已內含行政區名（與行政區代碼轉出的區名重複，屬來源資料本身瑕疵，
  //         不特別去重——geocode 仍可用，只是文字稍冗）
  //   row4：全形括號（） + 【】混合
  const buf = fixtureBuffer('speed-camera-tainan.csv');
  const result = parseTainan(buf, FIXED_NOW);

  assert.equal(result.length, 5);
  assert.deepEqual(result, [
    {
      city: '臺南市',
      address: '東區 北門路段(火車站前圓環至青年路)自動辨識違規停車及不依標線行駛科技執法系統',
      road: '北門路段(火車站前圓環至青年路)自動辨識違規停車及不依標線行駛科技執法系統',
      direction: '雙向',
      speed_limit: 50,
      lat: null,
      lng: null,
      source: 'tainan',
      fetched_at: FIXED_NOW,
    },
    {
      city: '臺南市',
      address: '中西區 中華西路與府前路口路口多功能違規科技執法系統',
      road: '中華西路與府前路口路口多功能違規科技執法系統',
      direction: '北向',
      speed_limit: 60,
      lat: null,
      lng: null,
      source: 'tainan',
      fetched_at: FIXED_NOW,
    },
    {
      // 開頭【區間平均速率執法系統】標籤被去掉，保留後面雙路段複合敘述（無結尾【】可再截斷）
      city: '臺南市',
      address:
        '龍崎區 一、市道182線27.2248公里至28.358公里處(往高雄)，速限50公里，取締項目：超速，偵測長度：1133.2公尺。二、市道182線28.3378公里至27.1907公里處(往關廟)，速限50公里，取締項目：超速，偵測長度：1147.1公尺。',
      road: '一、市道182線27.2248公里至28.358公里處(往高雄)，速限50公里，取締項目：超速，偵測長度：1133.2公尺。二、市道182線28.3378公里至27.1907公里處(往關廟)，速限50公里，取締項目：超速，偵測長度：1147.1公尺。',
      direction: '雙向',
      speed_limit: 50,
      lat: null,
      lng: null,
      source: 'tainan',
      fetched_at: FIXED_NOW,
    },
    {
      // 設置位置本身已含「安平區」，與行政區代碼轉出的「安平區」重複，不特別去重
      city: '臺南市',
      address: '安平區 安平區永華路二段和建平路口',
      road: '安平區永華路二段和建平路口',
      direction: '多向',
      speed_limit: 50,
      lat: null,
      lng: null,
      source: 'tainan',
      fetched_at: FIXED_NOW,
    },
    {
      city: '臺南市',
      address: '歸仁區 歸仁圓環（與中山路段交織之行人穿越道）',
      road: '歸仁圓環（與中山路段交織之行人穿越道）',
      direction: '東、西雙向',
      speed_limit: 50,
      lat: null,
      lng: null,
      source: 'tainan',
      fetched_at: FIXED_NOW,
    },
  ]);
});

test('cleanTainanLocation：開頭標籤與結尾違規列舉皆正確去除', () => {
  assert.equal(
    cleanTainanLocation('中華西路與府前路口路口多功能違規科技執法系統【闖紅燈、紅燈右轉等】'),
    '中華西路與府前路口路口多功能違規科技執法系統'
  );
  assert.equal(
    cleanTainanLocation('【區間平均速率執法系統】市道182線27K至28K處(往高雄)'),
    '市道182線27K至28K處(往高雄)'
  );
  assert.equal(cleanTainanLocation(''), '');
  assert.equal(cleanTainanLocation(null), '');
});

test('parseTaichung：文字型 PDF（非掃描），跨頁抽取、備註換行、座標欄位皆正確解析（golden）', async () => {
  // fixture 為官方「固定式科學儀器執法設備」取締地點一覽表 PDF 的前 2 頁節錄
  // （2026-07-05 從 police.taichung.gov.tw 表單下載頁面實測下載，全 14 頁 229 筆已驗證
  // 為文字層非掃描影像；本 fixture 涵蓋跨頁抽取 31 筆，含備註換行「(往XX方向)」case）。
  const buf = fixtureBuffer('speed-camera-taichung.pdf');
  const result = await parseTaichung(buf, FIXED_NOW);

  assert.equal(result.length, 31);
  assert.deepEqual(result[0], {
    city: '臺中市',
    address: '中區 中區建國路與民權路口',
    road: '中區建國路與民權路口',
    direction: '西往東',
    speed_limit: 50,
    lat: 24.13584,
    lng: 120.68225,
    source: 'taichung',
    fetched_at: FIXED_NOW,
  });
  assert.deepEqual(result[1], {
    city: '臺中市',
    address: '中區 中區三民路三段與公園路口',
    road: '中區三民路三段與公園路口',
    direction: '北往南',
    speed_limit: 50,
    lat: 24.14563,
    lng: 120.68389,
    source: 'taichung',
    fetched_at: FIXED_NOW,
  });
  // 第 15 筆：設置地點後方有備註換行「(往五權路方向)」，應併入 address/road
  assert.deepEqual(result[14], {
    city: '臺中市',
    address: '北區 北區三民路三段與崇德路一段路口 (往五權路方向)',
    road: '北區三民路三段與崇德路一段路口 (往五權路方向)',
    direction: '北往南',
    speed_limit: 50,
    lat: 24.15467,
    lng: 120.68617,
    source: 'taichung',
    fetched_at: FIXED_NOW,
  });
  // 最後一筆（跨頁後第 31 筆，第 2 頁最末列，驗證跨頁銜接無遺漏無錯位）
  assert.deepEqual(result[30], {
    city: '臺中市',
    address: '南區 南區復興路一段129號前',
    road: '南區復興路一段129號前',
    direction: '東往西',
    speed_limit: 60,
    lat: 24.11106,
    lng: 120.64844,
    source: 'taichung',
    fetched_at: FIXED_NOW,
  });
});

test('parseNationalNpa：只跳過無效座標說明列，縣市與國道路段分類全部保留（golden）', () => {
  // fixture 節錄自 data.gov.tw/dataset/7320「測速執法設置點」真實下載（2026-07-05，
  // 見 docs/speed-camera-sources.md）：金門縣x2、宜蘭縣、臺北市（六都，parser 層保留，
  // 六都與自建源的重複收錄改由 speed-camera-sync.cjs 執行期座標聯集去重）、
  // 國道一號、嘉義市，共 7 筆原始列。
  const buf = fixtureBuffer('speed-camera-national-npa.csv');
  const result = parseNationalNpa(buf, FIXED_NOW);

  assert.equal(result.length, 6); // 只跳過無有效座標的中文說明列；6 筆真實資料全部保留
  assert.deepEqual(result, [
    {
      city: '金門縣',
      address: '金湖鎮 金湖鎮黃海路(陽明湖路段)',
      road: '金湖鎮黃海路(陽明湖路段)',
      direction: '南北雙向',
      speed_limit: 60,
      lat: 24.458809,
      lng: 118.43147,
      source: 'national-npa',
      fetched_at: FIXED_NOW,
    },
    {
      city: '金門縣',
      address: '金城鎮 金城鎮西海路一段(水頭路段)',
      road: '金城鎮西海路一段(水頭路段)',
      direction: '東西雙向',
      speed_limit: 50,
      lat: 24.411718,
      lng: 118.29999,
      source: 'national-npa',
      fetched_at: FIXED_NOW,
    },
    {
      city: '宜蘭縣',
      address: '宜蘭市 台9線78k中山路五段南下',
      road: '台9線78k中山路五段南下',
      direction: '南北雙向',
      speed_limit: 60,
      lat: 24.778543,
      lng: 121.75933,
      source: 'national-npa',
      fetched_at: FIXED_NOW,
    },
    {
      // 臺北市（六都）：RegionName 為空字串，address 只保留 Address；
      // parser 層不排除六都，見上方測試說明。
      city: '臺北市',
      address: '自強隧道區間測速',
      road: '自強隧道區間測速',
      direction: '南北雙向',
      speed_limit: 50,
      lat: 25.090601,
      lng: 121.549255,
      source: 'national-npa',
      fetched_at: FIXED_NOW,
    },
    {
      city: '國道一號',
      address: '國道一號南向306.1公里',
      road: '國道一號南向306.1公里',
      direction: '往南',
      speed_limit: 110,
      lat: 23.16412,
      lng: 120.2315,
      source: 'national-npa',
      fetched_at: FIXED_NOW,
    },
    {
      city: '嘉義市',
      address: '東區 忠孝路與義教街口',
      road: '忠孝路與義教街口',
      direction: '南向北(超速闖紅燈)',
      speed_limit: 50,
      lat: 23.498264,
      lng: 120.4515,
      source: 'national-npa',
      fetched_at: FIXED_NOW,
    },
  ]);

  // 座標抽驗：全數落在台灣地理範圍（大略 lat 21-26、lng 118-123）
  for (const r of result) {
    assert.ok(r.lat > 21 && r.lat < 26, `lat 超出範圍：${r.lat}`);
    assert.ok(r.lng > 118 && r.lng < 123, `lng 超出範圍：${r.lng}`);
  }
});

test('parseNationalNpa：CityName 空白或任意內容都不構成排除條件', () => {
  const csv = Buffer.from(
    'CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit\n' +
      ',,未分類但有座標,,,121.61,24.90,北向,80\n' +
      '任意分類文字,,另一個有效點,,,121.70,24.95,南向,60\n',
    'utf8'
  );

  const result = parseNationalNpa(csv, FIXED_NOW);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((record) => record.city), ['', '任意分類文字']);
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
