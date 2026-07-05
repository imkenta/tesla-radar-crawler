'use strict';

/**
 * CAPTCHA 嚴格 4 字元截取純函式測試（lib/captcha-parser.cjs）。
 * 全 mock，不打真實 API——26B 讀圖能力已於實戰驗證過，這裡只驗證字串截取邏輯。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractCaptchaCode } = require('../lib/captcha-parser.cjs');

test('實戰碎念樣本：26B 把整段思考吐進回應，仍須截出結尾的 MN8L', () => {
    const rawText = "M8L_ (Wait, let me look closer)... Let's try: MN8L.MN8L";
    assert.equal(extractCaptchaCode(rawText), 'MN8L');
});

test('乾淨回應：只有 4 字元 → 直接採用（大寫正規化）', () => {
    assert.equal(extractCaptchaCode('ab3d'), 'AB3D');
    assert.equal(extractCaptchaCode('WXYZ'), 'WXYZ');
});

test('多個相異候選 → 取最後一個（模型結論在結尾）', () => {
    assert.equal(extractCaptchaCode('First guess: ABCD, no wait, actually WXY9'), 'WXY9');
});

test('零候選（無任何 4 字元英數片段，含中文與長字串無斷點）→ null，呼叫端須拒絕提交', () => {
    assert.equal(extractCaptchaCode('我無法清楚辨識這張圖片。'), null);
    assert.equal(extractCaptchaCode(''), null);
    assert.equal(extractCaptchaCode('   '), null);
});

test('5 字元以上連續英數不得誤切出假 4 字（邊界判定：前後緊鄰仍是英數字元即不合格）', () => {
    assert.equal(extractCaptchaCode('ABCDE'), null); // 5 連續英數，任何 4 字子字串前後都緊鄰另一個英數字元
    assert.equal(extractCaptchaCode('ABCDEF'), null);
});

test('5 字元以上連續英數字串前後被標點包住，內部仍不得切出假 4 字（邊界看字串內部鄰接字元，不受外部標點影響）', () => {
    assert.equal(extractCaptchaCode('validateStr: ABCDEFG.'), null);
});

test('同一 4 字元重複兩次（MN8L.MN8L）→ 兩個相同候選，取最後一個仍是 MN8L', () => {
    assert.equal(extractCaptchaCode('MN8L.MN8L'), 'MN8L');
});

test('候選字元集含數字與字母混合，不分大小寫皆可匹配並正規化為大寫', () => {
    assert.equal(extractCaptchaCode('answer is a1b2'), 'A1B2');
});

test('候選前後為換行符號（模型常見輸出格式）仍可正確切出', () => {
    assert.equal(extractCaptchaCode('思考中...\nMN8L\n完成'), 'MN8L');
});

test('非字串輸入（null/undefined）→ null，不拋錯', () => {
    assert.equal(extractCaptchaCode(null), null);
    assert.equal(extractCaptchaCode(undefined), null);
});

test('候選字元集跨越全形符號邊界（模型偶爾输出中文標點）仍可切出', () => {
    assert.equal(extractCaptchaCode('答案：MN8L。'), 'MN8L');
});
