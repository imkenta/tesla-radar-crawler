'use strict';

/**
 * Gemini/Gemma 備援階梯純函式測試（lib/ai-model-ladder.cjs）。
 * 全 mock，不打真實 API——真實 API 行為在 gh-plate-sync.cjs 內的 AIManager 整合，
 * 由上線前的活體煙霧測試另外驗證（見 scratchpad/ocr-fallback.md）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_LADDER, EXHAUSTED, nextLadderState } = require('../lib/ai-model-ladder.cjs');

test('階梯定義：三層模型與升級門檻符合規格', () => {
    assert.equal(MODEL_LADDER.length, 3);
    assert.equal(MODEL_LADDER[0].model, 'gemma-4-26b-a4b-it');
    assert.equal(MODEL_LADDER[0].failuresToEscalate, 3);
    assert.equal(MODEL_LADDER[1].model, 'gemma-4-31b-it');
    assert.equal(MODEL_LADDER[1].failuresToEscalate, 2);
    assert.equal(MODEL_LADDER[2].model, 'gemini-3-flash-preview');
    assert.equal(MODEL_LADDER[2].failuresToEscalate, 1);
});

test('Tier 0：失敗次數未達門檻 → 停留在 gemma-4-26b-a4b-it', () => {
    assert.deepEqual(nextLadderState(0, 0), { tierIndex: 0, model: 'gemma-4-26b-a4b-it' });
    assert.deepEqual(nextLadderState(0, 1), { tierIndex: 0, model: 'gemma-4-26b-a4b-it' });
    assert.deepEqual(nextLadderState(0, 2), { tierIndex: 0, model: 'gemma-4-26b-a4b-it' });
});

test('Tier 0：累計滿 3 次失敗 → 升級至 gemma-4-31b-it', () => {
    assert.deepEqual(nextLadderState(0, 3), { tierIndex: 1, model: 'gemma-4-31b-it' });
});

test('Tier 1：失敗次數未達門檻 → 停留在 gemma-4-31b-it', () => {
    assert.deepEqual(nextLadderState(1, 0), { tierIndex: 1, model: 'gemma-4-31b-it' });
    assert.deepEqual(nextLadderState(1, 1), { tierIndex: 1, model: 'gemma-4-31b-it' });
});

test('Tier 1：累計滿 2 次失敗 → 升級至 gemini-3-flash-preview', () => {
    assert.deepEqual(nextLadderState(1, 2), { tierIndex: 2, model: 'gemini-3-flash-preview' });
});

test('Tier 2：失敗次數未達門檻 → 停留在 gemini-3-flash-preview', () => {
    assert.deepEqual(nextLadderState(2, 0), { tierIndex: 2, model: 'gemini-3-flash-preview' });
});

test('Tier 2：再失敗 1 次 → EXHAUSTED（交給既有失敗處理/Tesseract 路徑）', () => {
    assert.equal(nextLadderState(2, 1), EXHAUSTED);
});

test('Tier 2：失敗數超過門檻仍是 EXHAUSTED（不會拋錯或越界）', () => {
    assert.equal(nextLadderState(2, 5), EXHAUSTED);
});

test('sticky：不存在「降級」路徑——函式本身不支援回退，呼叫端不得反向呼叫', () => {
    // 這條測試記錄設計意圖：nextLadderState 只接受「目前 tier + 失敗數」，
    // 沒有任何參數能表達「降回上一層」，升級後呼叫端只應以新 tierIndex 繼續呼叫。
    const escalated = nextLadderState(0, 3);
    assert.equal(escalated.tierIndex, 1);
    // 即使之後在 tier 1 失敗數歸零重新呼叫，也不會回到 tier 0
    assert.deepEqual(nextLadderState(escalated.tierIndex, 0), { tierIndex: 1, model: 'gemma-4-31b-it' });
});

test('邊界：tierIndex 超出範圍會拋 RangeError', () => {
    assert.throws(() => nextLadderState(-1, 0), RangeError);
    assert.throws(() => nextLadderState(3, 0), RangeError);
});
