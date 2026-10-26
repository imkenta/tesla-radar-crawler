'use strict';

/**
 * 送出被拒原因分類（lib/submit-reject-classifier.cjs）。
 * alert 字串表直接從 test/fixtures/mvdis-chkform.js.txt（MVDIS 頁面 chkForm() 原始碼節錄）解析，
 * 頁面改字就會在這裡紅燈。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REJECT_TYPES,
  FORM_INCOMPLETE_BAILOUT_THRESHOLD,
  classifySubmitReject,
  countsTowardSoftBlock,
  formatRejectLog,
} = require('../lib/submit-reject-classifier.cjs');

const chkFormSrc = fs.readFileSync(path.join(__dirname, 'fixtures', 'mvdis-chkform.js.txt'), 'utf8');
const chkFormAlerts = [...chkFormSrc.matchAll(/alert\('([^']+)'\)/g)].map((m) => m[1]);

test('fixture 解析：chkForm 共 8 個 alert（含驗證碼那則）', () => {
  assert.equal(chkFormAlerts.length, 8);
  assert.ok(chkFormAlerts.includes('請輸入驗證數字'));
  assert.ok(chkFormAlerts.includes('請選擇車牌樣式'));
});

test('chkForm 每一個「請選擇…」alert 都是 form-incomplete', () => {
  const selects = chkFormAlerts.filter((m) => m.startsWith('請選擇'));
  assert.equal(selects.length, 6); // 監理單位／領牌地點／車種別／能源別／車牌別／車牌樣式
  for (const msg of selects) {
    assert.equal(classifySubmitReject({ alertMsg: msg }), REJECT_TYPES.FORM_INCOMPLETE, msg);
  }
});

test('chkForm 其餘 alert：請輸入查詢號碼＝form-incomplete，請輸入驗證數字＝captcha', () => {
  assert.equal(classifySubmitReject({ alertMsg: '請輸入查詢號碼' }), REJECT_TYPES.FORM_INCOMPLETE);
  assert.equal(classifySubmitReject({ alertMsg: '請輸入驗證數字' }), REJECT_TYPES.CAPTCHA);
});

test('chkForm 所有 alert 字串都有明確分類（不會落到 unknown-dialog）', () => {
  for (const msg of chkFormAlerts) {
    assert.notEqual(classifySubmitReject({ alertMsg: msg }), REJECT_TYPES.UNKNOWN_DIALOG, msg);
  }
});

test('驗證碼錯誤：body 字串（無 alert）→ captcha', () => {
  assert.equal(classifySubmitReject({ bodyFlags: { captchaWrong: true } }), REJECT_TYPES.CAPTCHA);
  assert.equal(classifySubmitReject({ bodyFlags: { captchaEmpty: true } }), REJECT_TYPES.CAPTCHA);
  assert.equal(classifySubmitReject({ alertMsg: null, bodyFlags: { captchaWrong: true, captchaEmpty: false } }), REJECT_TYPES.CAPTCHA);
});

test('未知 alert → unknown-dialog；若 body 同時明確顯示驗證碼錯誤 → captcha', () => {
  const msg = '提醒您，若您的車為進口車，本站目前不提供選號的服務';
  assert.equal(classifySubmitReject({ alertMsg: msg }), REJECT_TYPES.UNKNOWN_DIALOG);
  assert.equal(classifySubmitReject({ alertMsg: '系統忙碌中，請稍後再試' }), REJECT_TYPES.UNKNOWN_DIALOG);
  assert.equal(classifySubmitReject({ alertMsg: msg, bodyFlags: { captchaWrong: true } }), REJECT_TYPES.CAPTCHA);
});

test('alert 是最新鮮證據：「請選擇」alert 勝過殘留的 body 驗證碼字串', () => {
  assert.equal(
    classifySubmitReject({ alertMsg: '請選擇車牌別', bodyFlags: { captchaWrong: true } }),
    REJECT_TYPES.FORM_INCOMPLETE,
  );
});

test('沒有任何被拒訊號 → none（空字串、空白、undefined 一律視為沒有 alert）', () => {
  assert.equal(classifySubmitReject({}), REJECT_TYPES.NONE);
  assert.equal(classifySubmitReject(), REJECT_TYPES.NONE);
  assert.equal(classifySubmitReject({ alertMsg: '', bodyFlags: {} }), REJECT_TYPES.NONE);
  assert.equal(classifySubmitReject({ alertMsg: '   ', bodyFlags: { captchaWrong: false, captchaEmpty: false } }), REJECT_TYPES.NONE);
});

test('前後空白不影響分類', () => {
  assert.equal(classifySubmitReject({ alertMsg: '  請選擇能源別\n' }), REJECT_TYPES.FORM_INCOMPLETE);
});

test('只有 captcha／unknown-dialog 計入 IP 軟封鎖計數', () => {
  assert.equal(countsTowardSoftBlock(REJECT_TYPES.CAPTCHA), true);
  assert.equal(countsTowardSoftBlock(REJECT_TYPES.UNKNOWN_DIALOG), true);
  assert.equal(countsTowardSoftBlock(REJECT_TYPES.FORM_INCOMPLETE), false);
  assert.equal(countsTowardSoftBlock(REJECT_TYPES.NONE), false);
});

test('同站 form-incomplete 上限為 3', () => {
  assert.equal(FORM_INCOMPLETE_BAILOUT_THRESHOLD, 3);
});

test('log 格式：單行、含 type= 與 msg=，可 grep 統計三類', () => {
  const line = formatRejectLog(REJECT_TYPES.FORM_INCOMPLETE, '請選擇車種別', { captchaWrong: false });
  assert.equal(line, '[Fail] Reject type=form-incomplete msg=請選擇車種別');
  assert.match(formatRejectLog(REJECT_TYPES.CAPTCHA, null, { captchaWrong: true }), /^\[Fail\] Reject type=captcha msg=\(none\) body=驗證數字輸入錯誤$/);
  const multi = formatRejectLog(REJECT_TYPES.UNKNOWN_DIALOG, '第一行\n第二行', {});
  assert.equal(multi.includes('\n'), false);
  assert.match(multi, /type=unknown-dialog msg=第一行 第二行/);
});

// ---------------------------------------------------------------------------
// H3：同站「表單問題」連續計數（送出前驗證不過＋form-incomplete 合併）
// ---------------------------------------------------------------------------
const { FormProblemCounter } = require('../lib/submit-reject-classifier.cjs');

test('FormProblemCounter：連續 3 次表單問題才達上限（預設門檻＝FORM_INCOMPLETE_BAILOUT_THRESHOLD）', () => {
  const c = new FormProblemCounter();
  assert.equal(c.add('送出前驗證不過，缺 selWindowNo'), false);
  assert.equal(c.add('送出前驗證不過，缺 selCarType'), false);
  assert.equal(c.add('送出被表單驗證擋下 form-incomplete'), true); // 兩種來源合併計數
  assert.equal(c.count, 3);
  assert.match(c.bailMessage('臺北區'), /同站（臺北區）連續 3 次表單問題（送出被表單驗證擋下 form-incomplete）/);
});

test('FormProblemCounter：成功或 captcha 類拒絕後 reset，重新計數', () => {
  const c = new FormProblemCounter();
  c.add('a'); c.add('b');
  c.reset();
  assert.equal(c.count, 0);
  assert.equal(c.add('c'), false);
});

test('FormProblemCounter：門檻可調（H3 建議 2～3）', () => {
  const c = new FormProblemCounter(2);
  assert.equal(c.add('x'), false);
  assert.equal(c.add('y'), true);
});
