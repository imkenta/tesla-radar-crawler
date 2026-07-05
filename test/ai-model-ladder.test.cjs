'use strict';

/**
 * Gemini/Gemma 備援階梯純函式測試（lib/ai-model-ladder.cjs）。
 * 全 mock，不打真實 API——真實 API 行為在 gh-plate-sync.cjs 內的 AIManager 整合，
 * 由上線前的活體煙霧測試另外驗證（見 scratchpad/ocr-ladder-v2.md）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    MODEL_LADDER,
    EXHAUSTED,
    nextLadderState,
    classifyQuotaError,
    isServerError,
    QUOTA_PER_MINUTE,
    QUOTA_PER_DAY,
    QUOTA_UNKNOWN,
} = require('../lib/ai-model-ladder.cjs');

test('階梯定義：四層模型與升級門檻符合規格（2026-07-05 依實測配額擴充）', () => {
    assert.equal(MODEL_LADDER.length, 4);
    assert.equal(MODEL_LADDER[0].model, 'gemma-4-26b-a4b-it');
    assert.equal(MODEL_LADDER[0].failuresToEscalate, 3);
    assert.equal(MODEL_LADDER[1].model, 'gemma-4-31b-it');
    assert.equal(MODEL_LADDER[1].failuresToEscalate, 2);
    assert.equal(MODEL_LADDER[2].model, 'gemini-3.1-flash-lite');
    assert.equal(MODEL_LADDER[2].failuresToEscalate, 2);
    assert.equal(MODEL_LADDER[3].model, 'gemini-3-flash-preview');
    assert.equal(MODEL_LADDER[3].failuresToEscalate, 1);
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

test('Tier 1：累計滿 2 次失敗 → 升級至 gemini-3.1-flash-lite', () => {
    assert.deepEqual(nextLadderState(1, 2), { tierIndex: 2, model: 'gemini-3.1-flash-lite' });
});

test('Tier 2：失敗次數未達門檻 → 停留在 gemini-3.1-flash-lite', () => {
    assert.deepEqual(nextLadderState(2, 0), { tierIndex: 2, model: 'gemini-3.1-flash-lite' });
    assert.deepEqual(nextLadderState(2, 1), { tierIndex: 2, model: 'gemini-3.1-flash-lite' });
});

test('Tier 2：累計滿 2 次失敗 → 升級至 gemini-3-flash-preview', () => {
    assert.deepEqual(nextLadderState(2, 2), { tierIndex: 3, model: 'gemini-3-flash-preview' });
});

test('Tier 3：失敗次數未達門檻 → 停留在 gemini-3-flash-preview', () => {
    assert.deepEqual(nextLadderState(3, 0), { tierIndex: 3, model: 'gemini-3-flash-preview' });
});

test('Tier 3：再失敗 1 次 → EXHAUSTED（交給既有失敗處理/Tesseract 路徑）', () => {
    assert.equal(nextLadderState(3, 1), EXHAUSTED);
});

test('Tier 3：失敗數超過門檻仍是 EXHAUSTED（不會拋錯或越界）', () => {
    assert.equal(nextLadderState(3, 5), EXHAUSTED);
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
    assert.throws(() => nextLadderState(4, 0), RangeError);
});

// --- 429 分流：classifyQuotaError ---

test('classifyQuotaError：非 429/quota 相關錯誤 → isQuotaError=false', () => {
    const result = classifyQuotaError(new Error('network timeout'));
    assert.equal(result.isQuotaError, false);
    assert.equal(result.quotaWindow, null);
    assert.equal(result.retryAfterMs, null);
});

test('classifyQuotaError：HTTP 429 + errorDetails 內含 PerMinute quotaId → PER_MINUTE', () => {
    const err = new Error('[429 Too Many Requests] Quota exceeded');
    err.status = 429;
    err.errorDetails = [
        {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
                { quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' },
            ],
        },
    ];
    const result = classifyQuotaError(err);
    assert.equal(result.isQuotaError, true);
    assert.equal(result.quotaWindow, QUOTA_PER_MINUTE);
});

test('classifyQuotaError：HTTP 429 + errorDetails 內含 PerDay quotaId → PER_DAY', () => {
    const err = new Error('[429 Too Many Requests] Quota exceeded');
    err.status = 429;
    err.errorDetails = [
        {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
                { quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model', quotaId: 'GenerateRequestsPerDayPerProjectPerModel' },
            ],
        },
    ];
    const result = classifyQuotaError(err);
    assert.equal(result.isQuotaError, true);
    assert.equal(result.quotaWindow, QUOTA_PER_DAY);
});

test('classifyQuotaError：errorDetails 缺失時 fallback 比對 message 字串本體（SDK 會把 details JSON.stringify 進 message）', () => {
    const err = new Error('[429 Too Many Requests] Quota exceeded [{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}]');
    err.status = 429;
    // 故意不設 errorDetails，模擬結構化欄位拿不到的情形
    const result = classifyQuotaError(err);
    assert.equal(result.isQuotaError, true);
    assert.equal(result.quotaWindow, QUOTA_PER_DAY);
});

test('classifyQuotaError：429 但字樣完全抓不到 Per(Day|Minute) → QUOTA_UNKNOWN（呼叫端應視同每日耗盡處理）', () => {
    const err = new Error('[429 Too Many Requests] Resource exhausted');
    err.status = 429;
    const result = classifyQuotaError(err);
    assert.equal(result.isQuotaError, true);
    assert.equal(result.quotaWindow, QUOTA_UNKNOWN);
});

test('classifyQuotaError：無 status 欄位但 message 含 quota 字樣仍判定為 quota 錯誤', () => {
    const err = new Error('Error: quota exceeded for this model, please retry later (PerMinute)');
    const result = classifyQuotaError(err);
    assert.equal(result.isQuotaError, true);
    assert.equal(result.quotaWindow, QUOTA_PER_MINUTE);
});

test('classifyQuotaError：解析 RetryInfo.retryDelay 秒數轉為 retryAfterMs', () => {
    const err = new Error('[429 Too Many Requests] Quota exceeded');
    err.status = 429;
    err.errorDetails = [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'PerMinute' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '13s' },
    ];
    const result = classifyQuotaError(err);
    assert.equal(result.quotaWindow, QUOTA_PER_MINUTE);
    assert.equal(result.retryAfterMs, 13000);
});

test('classifyQuotaError：無 RetryInfo 時 retryAfterMs 為 null（呼叫端自行預設 20s）', () => {
    const err = new Error('[429 Too Many Requests] Quota exceeded');
    err.status = 429;
    err.errorDetails = [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }];
    const result = classifyQuotaError(err);
    assert.equal(result.retryAfterMs, null);
});

// --- 5xx 退避：isServerError ---

test('isServerError：status=500 → true', () => {
    const err = new Error('[500 Internal Server Error]');
    err.status = 500;
    assert.equal(isServerError(err), true);
});

test('isServerError：status=503 → true（Service Unavailable 也算暫時性）', () => {
    const err = new Error('[503 Service Unavailable]');
    err.status = 503;
    assert.equal(isServerError(err), true);
});

test('isServerError：status=429（配額錯誤）→ false，不與 5xx 退避路徑混淆', () => {
    const err = new Error('[429 Too Many Requests]');
    err.status = 429;
    assert.equal(isServerError(err), false);
});

test('isServerError：status=400（客戶端錯誤）→ false', () => {
    const err = new Error('[400 Bad Request]');
    err.status = 400;
    assert.equal(isServerError(err), false);
});

test('isServerError：無 status 欄位但 message 帶 [500 ...] 字樣 → fallback 判定 true', () => {
    const err = new Error('[500 Internal Server Error] something went wrong');
    assert.equal(isServerError(err), true);
});

test('isServerError：無 status 且 message 無 5xx 字樣（如純網路逾時）→ false', () => {
    const err = new Error('network timeout');
    assert.equal(isServerError(err), false);
});
