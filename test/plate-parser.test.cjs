'use strict';

/**
 * MVDIS 解析回歸測試（golden master）。
 *
 * 為什麼存在：爬蟲最致命的失敗不是「崩潰」，而是「靜默回空」——MVDIS 改版、
 * class 名變動、或有人改壞解析，會讓爬蟲跑完卻收 0 筆，production 表被清空，
 * 而沒有任何例外。這組測試把「真實 HTML → 預期車牌」釘成基準：解析一壞就紅。
 *
 * 測的是線上真正用的程式碼：lib/plate-parser.cjs 同時被 gh-plate-sync.cjs
 * 透過 page.evaluate 使用。這裡用 jsdom 餵 test/fixtures 下的真實結構 HTML。
 *
 * 執行：npm test （= node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { extractPlates, parsePageInfoFromDoc } = require('../lib/plate-parser.cjs');

function docFromFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return new JSDOM(html).window.document;
}
function docFromHTML(html) {
  return new JSDOM(html).window.document;
}

test('extractPlates：從真實結果頁抽出車牌（golden）', () => {
  const doc = docFromFixture('mvdis-plates-page1.html');
  const plates = extractPlates(doc);

  // 6 個 .number_cell 中，1 個缺 .number 應被濾掉 → 5 筆
  assert.equal(plates.length, 5);

  // 完整逐筆基準：價格去逗號、去「元」
  assert.deepEqual(plates, [
    { no: 'EBP-1571', price: '2000' },
    { no: 'EBP-1575', price: '2000' },
    { no: 'EBP-2888', price: '10000' },
    { no: 'EBP-6666', price: '36000' },
    { no: 'EBP-0001', price: '' }, // 有號無價：price 為空字串，插入時 parseInt('')||0 → 0
  ]);
});

test('extractPlates：缺 .number 的畸形 cell 不可使整批崩潰', () => {
  const doc = docFromHTML(
    '<div class="number_cell"><span class="price">5,000元</span></div>'
  );
  assert.doesNotThrow(() => extractPlates(doc));
  assert.deepEqual(extractPlates(doc), []);
});

test('extractPlates：價格逗號與「元」字一律剝除', () => {
  const doc = docFromHTML(
    '<div class="number_cell"><span class="number">AAA-1234</span>' +
    '<span class="price">1,234,567元</span></div>'
  );
  assert.deepEqual(extractPlates(doc), [{ no: 'AAA-1234', price: '1234567' }]);
});

test('parsePageInfoFromDoc：解析總筆數 / 分頁 / 下一頁按鈕（golden）', () => {
  const doc = docFromFixture('mvdis-plates-page1.html');
  const info = parsePageInfoFromDoc(doc);

  assert.equal(info.noData, false);
  assert.equal(info.count, 6);          // 共 6 筆
  assert.equal(info.current, 1);        // 頁次 1 / 2 頁
  assert.equal(info.total, 2);
  assert.equal(info.hasNextButton, true);
});

test('parsePageInfoFromDoc：「查無資料」頁回 noData=true（golden）', () => {
  const doc = docFromFixture('mvdis-no-data.html');
  const info = parsePageInfoFromDoc(doc);
  assert.equal(info.noData, true);
  assert.equal(info.count, 0);
});

test('parsePageInfoFromDoc：支援「第 N 頁，共 M 頁」格式', () => {
  const doc = docFromHTML('<body>共 12 筆　第 2 頁，共 3 頁</body>');
  const info = parsePageInfoFromDoc(doc);
  assert.equal(info.count, 12);
  assert.equal(info.current, 2);
  assert.equal(info.total, 3);
});

test('parsePageInfoFromDoc：無分頁字串但有下一頁按鈕 → total 至少強制為 2', () => {
  const doc = docFromHTML('<body>共 50 筆<input name="status_next_page"></body>');
  const info = parsePageInfoFromDoc(doc);
  assert.equal(info.total, 2);
  assert.equal(info.hasNextButton, true);
});

test('parsePageInfoFromDoc：單頁、無按鈕 → total=1', () => {
  const doc = docFromHTML('<body>共 3 筆</body>');
  const info = parsePageInfoFromDoc(doc);
  assert.equal(info.total, 1);
  assert.equal(info.hasNextButton, false);
});
