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
    comboId,
    selectAliveCombo,
    LadderState,
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

test('classifyQuotaError：429 但字樣完全抓不到 Per(Day|Minute) → QUOTA_UNKNOWN（呼叫端視同分鐘級：退避重試，不標死——標死限明確 PerDay）', () => {
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

// --- classifyQuotaError：實戰樣本 ---

test('classifyQuotaError：實戰 quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier → PER_DAY（南區連環 429 樣本）', () => {
    const err = new Error('[429 Too Many Requests] You exceeded your current quota');
    err.status = 429;
    err.errorDetails = [
        {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '39s' },
    ];
    const result = classifyQuotaError(err);
    assert.equal(result.isQuotaError, true);
    assert.equal(result.quotaWindow, QUOTA_PER_DAY);
    // retryDelay 照樣被解析出來，但呼叫端對 PER_DAY 絕不使用它（日配額退避無意義，直接標死）
    assert.equal(result.retryAfterMs, 39000);
});

// --- 死亡矩陣選擇：selectAliveCombo ---

const KEYS = ['GEMINI_API_KEY_CENTRAL', 'GEMINI_API_KEY'];

test('selectAliveCombo：全存活 → tier0 + 第一把 key（shard key 優先）', () => {
    assert.deepEqual(selectAliveCombo(0, KEYS, new Set()), {
        tierIndex: 0, model: 'gemma-4-26b-a4b-it', keyName: 'GEMINI_API_KEY_CENTRAL',
    });
});

test('selectAliveCombo：tier0 shard key 標死 → 同層改用 DEFAULT key（26B 主力地位保住）', () => {
    const dead = new Set([comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it')]);
    assert.deepEqual(selectAliveCombo(0, KEYS, dead), {
        tierIndex: 0, model: 'gemma-4-26b-a4b-it', keyName: 'GEMINI_API_KEY',
    });
});

test('selectAliveCombo：tier0 兩把 key 全死 → 升 tier1 且回到 shard key 優先', () => {
    const dead = new Set([
        comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it'),
        comboId('GEMINI_API_KEY', 'gemma-4-26b-a4b-it'),
    ]);
    assert.deepEqual(selectAliveCombo(0, KEYS, dead), {
        tierIndex: 1, model: 'gemma-4-31b-it', keyName: 'GEMINI_API_KEY_CENTRAL',
    });
});

test('selectAliveCombo：中間層整層死＋下一層 shard 死 → 選到部分存活層的 DEFAULT key', () => {
    // 從 tier1 起找：tier1 兩把 key 全死、tier2 shard key 死 → 應選 tier2 + DEFAULT
    const dead = new Set([
        comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-31b-it'),
        comboId('GEMINI_API_KEY', 'gemma-4-31b-it'),
        comboId('GEMINI_API_KEY_CENTRAL', 'gemini-3.1-flash-lite'),
    ]);
    assert.deepEqual(selectAliveCombo(1, KEYS, dead), {
        tierIndex: 2, model: 'gemini-3.1-flash-lite', keyName: 'GEMINI_API_KEY',
    });
});

test('selectAliveCombo：全部標死 → EXHAUSTED', () => {
    const dead = new Set();
    for (const tier of MODEL_LADDER) {
        for (const k of KEYS) dead.add(comboId(k, tier.model));
    }
    assert.equal(selectAliveCombo(0, KEYS, dead), EXHAUSTED);
});

test('selectAliveCombo：startTierIndex 超過最後一層 → EXHAUSTED（最後一層達門檻升級的邊界）', () => {
    assert.equal(selectAliveCombo(MODEL_LADDER.length, KEYS, new Set()), EXHAUSTED);
});

test('selectAliveCombo：單一 key（無 shard key 的部署場景）也可運作', () => {
    const dead = new Set([comboId('GEMINI_API_KEY', 'gemma-4-26b-a4b-it')]);
    assert.deepEqual(selectAliveCombo(0, ['GEMINI_API_KEY'], dead), {
        tierIndex: 1, model: 'gemma-4-31b-it', keyName: 'GEMINI_API_KEY',
    });
});

// --- LadderState：連續失敗語義 + PerDay 判死 + 死亡矩陣整合 ---

test('LadderState：初始狀態 = tier0 + 第一把 key，計數 0', () => {
    const s = new LadderState(KEYS);
    assert.equal(s.tierIndex, 0);
    assert.equal(s.model, 'gemma-4-26b-a4b-it');
    assert.equal(s.keyName, 'GEMINI_API_KEY_CENTRAL');
    assert.equal(s.failureCount, 0);
});

test('LadderState：成功重置失敗計數——成功之間的零星失敗永不累積升級（中區實戰 v1 bug 回歸測試）', () => {
    const s = new LadderState(KEYS);
    // 模擬中區實戰：零星 500 與成功交錯，總失敗次數（20）遠超 tier0 門檻（3）
    for (let round = 0; round < 10; round++) {
        assert.equal(s.recordFailure().escalated, false); // 連續失敗 1（< 3）
        assert.equal(s.recordFailure().escalated, false); // 連續失敗 2（< 3）
        s.recordSuccess(); // 成功 → 計數歸零
        assert.equal(s.failureCount, 0);
    }
    assert.equal(s.tierIndex, 0); // v1 累計語義會在此升級到已死的 31B；v2 必須仍在 26B 主力層
    assert.equal(s.model, 'gemma-4-26b-a4b-it');
});

test('LadderState：連續 3 次失敗 → 升級 tier1，計數歸零，key 回到 shard 優先', () => {
    const s = new LadderState(KEYS);
    assert.equal(s.recordFailure().escalated, false);
    assert.equal(s.recordFailure().escalated, false);
    const out = s.recordFailure();
    assert.equal(out.escalated, true);
    assert.deepEqual(out.combo, { tierIndex: 1, model: 'gemma-4-31b-it', keyName: 'GEMINI_API_KEY_CENTRAL' });
    assert.equal(s.failureCount, 0);
});

test('LadderState：PerDay 判死當前 combo → 同層先換 key，不跳層（26B 主力地位保住）', () => {
    const s = new LadderState(KEYS);
    const next = s.markCurrentComboDead();
    assert.deepEqual(next, { tierIndex: 0, model: 'gemma-4-26b-a4b-it', keyName: 'GEMINI_API_KEY' });
    assert.equal(s.failureCount, 0);
    assert.equal(s.isCurrentComboDead(), false); // 新 combo 是活的
});

test('LadderState：同層兩把 key 先後判死 → 跳層，且已死 combo 留在矩陣中永不再被選中', () => {
    const s = new LadderState(KEYS);
    s.markCurrentComboDead(); // (CENTRAL, 26b) 死 → (DEFAULT, 26b)
    const next = s.markCurrentComboDead(); // (DEFAULT, 26b) 也死 → 跳 tier1
    assert.deepEqual(next, { tierIndex: 1, model: 'gemma-4-31b-it', keyName: 'GEMINI_API_KEY_CENTRAL' });
    assert.equal(s.deadCombos.has(comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it')), true);
    assert.equal(s.deadCombos.has(comboId('GEMINI_API_KEY', 'gemma-4-26b-a4b-it')), true);
});

test('LadderState：門檻升級時自動跳過已判死的層（今日實戰：31B 已死應零成本被跳過）', () => {
    const s = new LadderState(['GEMINI_API_KEY_CENTRAL']);
    s.deadCombos.add(comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-31b-it')); // 31B 本日已死
    s.recordFailure();
    s.recordFailure();
    const out = s.recordFailure(); // 連續 3 敗達 tier0 門檻
    assert.equal(out.escalated, true);
    assert.equal(s.model, 'gemini-3.1-flash-lite'); // 跳過已死的 31B 直達 3.1-flash-lite
});

test('LadderState：所有 combo 逐一判死 → 最後一次 markCurrentComboDead 回傳 EXHAUSTED', () => {
    const s = new LadderState(['GEMINI_API_KEY']);
    let last = null;
    for (let i = 0; i < MODEL_LADDER.length; i++) {
        last = s.markCurrentComboDead();
    }
    assert.equal(last, EXHAUSTED);
    assert.equal(s.isCurrentComboDead(), true); // 呼叫端據此快速失敗，絕不再打已死 combo
});

test('LadderState：最後一層達門檻且無處可升 → escalated:false + exhausted:true（交回既有失敗處理）', () => {
    const s = new LadderState(['GEMINI_API_KEY']);
    s.tierIndex = MODEL_LADDER.length - 1; // 直接置於最後一層（門檻 1）
    const out = s.recordFailure();
    assert.equal(out.escalated, false);
    assert.equal(out.exhausted, true);
});

test('LadderState：keyNames 為空 → 建構時拋 RangeError', () => {
    assert.throws(() => new LadderState([]), RangeError);
});
