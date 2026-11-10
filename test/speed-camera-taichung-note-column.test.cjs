'use strict';

// 2026-11-10 健檢 O4：臺中固定式 PDF 在 2026-10-15 版（115年10月7日）起，部分列的「管轄單位」之後
// 多了備註欄「宣導2月後 執法」。舊 regex 以行尾錨定 `分局\s*※?\s*$`，這 17 列整筆比不中 → 每週被略過，
// 並讓 writeAll 把正式庫原有的 15 筆當 stale 刪掉（其中 14 筆含超速）。fixture 與筆數暴跌閘（50%）都抓不到。
//
// fixture：test/fixtures/speed-camera-taichung-115-10.txt ＝ 官方 PDF（2026-11-10 自警察局公告頁下載）
// 用 pdf-parse getText() 抽出的原始文字全文（14 頁、227 列），保留真實折行（「宣導2月後」常與「執法」分兩行）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseTaichungText } = require('../lib/speed-camera-parser.cjs');

const NOW = '2026-11-10T00:00:00.000Z';
const fullText = fs.readFileSync(path.join(__dirname, 'fixtures', 'speed-camera-taichung-115-10.txt'), 'utf8');

function captureErrors(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.error = orig;
  }
}

test('115-10 版面全文：227 列全部解析、0 筆被略過（舊 regex 只得 210）', () => {
  const { result, lines } = captureErrors(() => parseTaichungText(fullText, NOW));
  assert.equal(result.length, 227);
  assert.deepEqual(lines.filter((l) => l.includes('找不到座標欄位')), []);
  // 無重複 (地點, 方向)：沒有因容許尾綴而把相鄰紀錄吞併
  assert.equal(new Set(result.map((r) => `${r.address}|${r.direction}`)).size, 227);
});

test('備註尾綴只被丟棄：不進 enforcement_items_raw、address、road', () => {
  const result = captureErrors(() => parseTaichungText(fullText, NOW)).result;
  for (const r of result) {
    assert.doesNotMatch(JSON.stringify(r), /宣導|執法/, `${r.address} 夾帶了備註欄`);
  }
});

test('原本漏掉的超速桿現在有解析，欄位正確（折行備註／地點折行／括號地點）', () => {
  const result = captureErrors(() => parseTaichungText(fullText, NOW)).result;
  const byAddress = (needle) => result.find((r) => r.address.includes(needle));

  const wuquan = byAddress('西區五權路與英才路口');
  assert.equal(wuquan.direction, '東往西');
  assert.equal(wuquan.speed_limit, 50);
  assert.equal(wuquan.lat, 24.1414);
  assert.equal(wuquan.lng, 120.66702);
  assert.equal(wuquan.enforcement_items_raw, '闖紅燈、不依標誌、標線、 號誌指示行駛、超速');
  assert.equal(wuquan.speed_status, 'confirmed'); // 含「超速」→ 仍判定為測速桿

  const zhongGong = byAddress('西屯區臺灣大道四段與中工三路口');
  assert.equal(zhongGong.lat, 24.18104);
  assert.equal(zhongGong.lng, 120.63736);
  assert.equal(zhongGong.speed_limit, 50);

  // 地點折行＋括號＋「超速」獨立成行＋備註
  const hanxi = byAddress('旱溪西路6段往潭興路2段36巷口');
  assert.equal(hanxi.enforcement_items_raw, '超速');
  assert.equal(hanxi.speed_limit, 50);
  assert.equal(hanxi.direction, '北往南');

  // 行政區獨立成行（新版面）＋備註
  const tanzi = byAddress('潭子區中山路二段與潭子街一段路口');
  assert.equal(tanzi.direction, '北往南');
  assert.equal(tanzi.speed_limit, 60);
});

test('這 17 列裡 14 列含超速（confirmed）、3 列僅號誌類（rejected）', () => {
  const result = captureErrors(() => parseTaichungText(fullText, NOW)).result;
  const targets = [
    '西區五權路與英才路口', '南區國光路與南門路口', '南屯區公益路二段與文心路一段路口',
    '南屯區永春南路與永春南路888巷', '北屯區松竹路三段與后庄路口', '西屯區環中路二段與環中路二段1036巷口',
    '西屯區臺灣大道四段與中工三路口', '西屯區河南路二段與長安路二段路口', '潭子區中山路二段與潭子街一段路口',
    '潭子區旱溪西路6段往潭興路2段36巷口', '霧峰區吉峰東路', '烏日區中山路三段與學田路口',
    '清水區中華路與高美路口', '清水區中華路與鰲峰路口', '清水區臨港路六段與高美路口',
    '沙鹿區臺灣大道七段與七賢路口', '沙鹿區臺灣大道七段與晉文路口',
  ];
  const found = targets.map((t) => result.find((r) => r.address.includes(t)));
  assert.ok(found.every(Boolean), '17 列都必須存在');
  const confirmed = found.filter((r) => r.speed_status === 'confirmed').length;
  assert.equal(confirmed, 14);
  assert.equal(found.length - confirmed, 3);
});

// ---- 版面變體（行內小樣本，釘住 regex 的容許範圍） ----

function parseSnippet(body) {
  const header = '臺中市政府警察局\n「固定式科學儀器執法設備」取締地點一覽表(115年10月7日)\n設備\n編號 行政區 設置地點 取締項目 座標緯度 座標經度 拍攝方向 速限 管轄單位 備註\n';
  return captureErrors(() => parseTaichungText(header + body, NOW));
}

test('變體：備註與「分局」同一行；「執法」折到下一行', () => {
  const { result, lines } = parseSnippet(
    '1 西區五權路與英才路口 闖紅燈、超速\n24.14140 120.66702 東往西 50 第一分局 宣導2月後\n執法\n'
  );
  assert.equal(lines.length, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0].lat, 24.1414);
});

test('變體：備註與「執法」都在同一行', () => {
  const { result } = parseSnippet('1 西區五權路與英才路口 闖紅燈、超速 24.14140 120.66702 東往西 50 第一分局 宣導2月後 執法\n');
  assert.equal(result.length, 1);
  assert.equal(result[0].speed_limit, 50);
});

test('變體：舊版尾綴「※」（含無空白貼著分局）仍可解析', () => {
  const { result } = parseSnippet(
    '1 西區五權路與英才路口 超速 24.14140 120.66702 東往西 50 第一分局 ※\n2 西區五權路與民生路口 超速 24.14240 120.66802 東往西 50 第一分局※\n'
  );
  assert.equal(result.length, 2);
});

test('變體：沒有尾綴的舊版面不變；缺座標的列仍被略過並記錄（不靜默）', () => {
  const { result, lines } = parseSnippet(
    '1 西區五權路與英才路口 超速 24.14140 120.66702 東往西 50 第一分局\n2 西區無座標路口 超速 東往西 50 第一分局 宣導2月後\n'
  );
  assert.equal(result.length, 1);
  assert.equal(lines.filter((l) => l.includes('第 2 筆找不到座標欄位')).length, 1);
});
