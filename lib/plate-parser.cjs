'use strict';

/**
 * MVDIS 選號結果頁的「純解析邏輯」——單一真理來源。
 *
 * 同時被兩邊使用：
 *   1. 線上爬蟲 gh-plate-sync.cjs，透過 `page.evaluate(extractPlates)` 在 Chromium
 *      browser context 執行（此時 rootDoc 為 undefined，自動退回 browser 的 document）。
 *   2. 回歸測試 test/plate-parser.test.cjs，透過 jsdom 餵真實 HTML fixture
 *      （此時呼叫端傳入 jsdom 的 document 當 rootDoc）。
 *
 * ⛔ 嚴格約束（否則 page.evaluate 序列化會壞）：
 *   - 函式本體只能引用「自己的參數」與「browser 全域（document）」。
 *   - 禁止 closure 捕捉 module 作用域變數、禁止 require、禁止 Node API。
 *   - 任何 helper 必須定義在函式「內部」（才會一起被序列化送進 browser）。
 *
 * innerText vs textContent：真實 browser（puppeteer）有 innerText；jsdom 沒有
 * （回傳 undefined），只有 textContent。下面一律 `innerText ?? textContent`：
 *   - browser：innerText 有定義 → 行為與舊版逐字一致。
 *   - jsdom  ：退回 textContent → 測試才跑得動。
 */

/**
 * 從結果頁抽出可選車牌。
 * @param {Document} [rootDoc] 測試傳入 jsdom document；線上不傳，用 browser document。
 * @returns {{no: string, price: string}[]}
 */
function extractPlates(rootDoc) {
  const d = rootDoc || (typeof document !== 'undefined' ? document : null);
  if (!d) return [];
  const txt = (el) => (el == null ? '' : ((el.innerText != null ? el.innerText : el.textContent) || ''));
  return Array.from(d.querySelectorAll('.number_cell')).map((el) => ({
    no: txt(el.querySelector('.number')).trim(),
    price: txt(el.querySelector('.price')).split('元')[0].replace(/,/g, '').trim(),
  })).filter((x) => x.no);
}

/**
 * 解析分頁/總筆數/查無資料狀態。
 * @param {Document} [rootDoc]
 * @returns {{current:number,total:number,count:number,noData:boolean,hasNextButton?:boolean}}
 */
function parsePageInfoFromDoc(rootDoc) {
  const d = rootDoc || (typeof document !== 'undefined' ? document : null);
  const body = d && d.body;
  const text = body ? ((body.innerText != null ? body.innerText : body.textContent) || '') : '';

  // 1. 先判「查無資料」
  if (text.includes('查無資料') || text.includes('尚無可供選號') || text.includes('對不起')) {
    return { current: 1, total: 1, count: 0, noData: true };
  }

  // 2. 總筆數
  const countMatch = text.match(/共\s*(\d+)\s*筆/) || text.match(/總數[:：]\s*(\d+)\s*面/);
  const count = countMatch ? parseInt(countMatch[1]) : 0;

  // 3. 分頁（MVDIS「頁次：1 / 2」）
  let current = 1;
  let total = 1;
  const pageMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*頁/) || text.match(/第\s*(\d+)\s*頁[，,]\s*共\s*(\d+)\s*頁/);
  if (pageMatch) {
    current = parseInt(pageMatch[1]);
    total = parseInt(pageMatch[2]);
  }

  // 4. 安全網：看得到下一頁按鈕就至少多跑一輪
  const hasNextButton = !!(d && (d.querySelector('input[name="status_next_page"]') || d.querySelector('#next')));
  if (total === 1 && hasNextButton) {
    total = 2;
  }

  return { current, total, count, noData: false, hasNextButton };
}

module.exports = { extractPlates, parsePageInfoFromDoc };
