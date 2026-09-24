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
    SERVER_ERROR_STORM_THRESHOLD,
    SERVER_ERROR_STORM_WINDOW_MS,
    FIRST_TIER_PROBE_INTERVAL_MS,
    nextLadderState,
    comboId,
    selectAliveCombo,
    LadderState,
    classifyQuotaError,
    isUnsupportedLocationError,
    isServerError,
    QUOTA_PER_MINUTE,
    QUOTA_PER_DAY,
    QUOTA_UNKNOWN,
} = require('../lib/ai-model-ladder.cjs');

// --- 不支援地區：基礎設施 fatal，不得污染模型階梯 ---

test('isUnsupportedLocationError：Gemini 實戰 400 地區錯誤 → true', () => {
    const err = new Error('[400 Bad Request] User location is not supported for the API use.');
    err.status = 400;
    assert.equal(isUnsupportedLocationError(err), true);
});

test('isUnsupportedLocationError：SDK 未提供 status 時仍由精確訊息判定 → true', () => {
    const err = new Error('Error fetching from generativelanguage.googleapis.com: User location is not supported for the API use.');
    assert.equal(isUnsupportedLocationError(err), true);
});

test('isUnsupportedLocationError：其他 400 請求錯誤不得誤判', () => {
    const err = new Error('[400 Bad Request] API key not valid.');
    err.status = 400;
    assert.equal(isUnsupportedLocationError(err), false);
});

test('isUnsupportedLocationError：429 配額錯誤不得誤判', () => {
    const err = new Error('[429 Too Many Requests] User quota exceeded.');
    err.status = 429;
    assert.equal(isUnsupportedLocationError(err), false);
});

test('階梯定義：兩層模型與升級門檻符合規格（2026-09-15 依多日統計移除 31B 與 flash-preview）', () => {
    assert.equal(MODEL_LADDER.length, 2);
    assert.equal(MODEL_LADDER[0].model, 'gemma-4-26b-a4b-it');
    assert.equal(MODEL_LADDER[0].failuresToEscalate, 3);
    assert.equal(MODEL_LADDER[1].model, 'gemini-3.1-flash-lite');
    assert.equal(MODEL_LADDER[1].failuresToEscalate, 2);
    const models = MODEL_LADDER.map((t) => t.model);
    assert.ok(!models.includes('gemma-4-31b-it'), '31B 風暴中終局成功率 47%，已移除');
    assert.ok(!models.includes('gemini-3-flash-preview'), 'flash-preview 日配額一碰就死、觸發全部重爬，已移除');
});

test('Tier 0：失敗次數未達門檻 → 停留在 gemma-4-26b-a4b-it', () => {
    assert.deepEqual(nextLadderState(0, 0), { tierIndex: 0, model: 'gemma-4-26b-a4b-it' });
    assert.deepEqual(nextLadderState(0, 1), { tierIndex: 0, model: 'gemma-4-26b-a4b-it' });
    assert.deepEqual(nextLadderState(0, 2), { tierIndex: 0, model: 'gemma-4-26b-a4b-it' });
});

test('Tier 0：累計滿 3 次失敗 → 升級至 gemini-3.1-flash-lite', () => {
    assert.deepEqual(nextLadderState(0, 3), { tierIndex: 1, model: 'gemini-3.1-flash-lite' });
});

test('Tier 1（末層 flash-lite）：失敗次數未達門檻 → 停留', () => {
    assert.deepEqual(nextLadderState(1, 0), { tierIndex: 1, model: 'gemini-3.1-flash-lite' });
    assert.deepEqual(nextLadderState(1, 1), { tierIndex: 1, model: 'gemini-3.1-flash-lite' });
});

test('Tier 1（末層）：失敗達 2 次 → EXHAUSTED（交給既有失敗處理）', () => {
    assert.equal(nextLadderState(1, 2), EXHAUSTED);
});

test('Tier 1（末層）：失敗數超過門檻仍是 EXHAUSTED（不會拋錯或越界）', () => {
    assert.equal(nextLadderState(1, 5), EXHAUSTED);
});

test('sticky：nextLadderState 不存在「降級」路徑（回到 26B 只能經由回探或 PerDay 回填）', () => {
    const escalated = nextLadderState(0, 3);
    assert.equal(escalated.tierIndex, 1);
    assert.deepEqual(nextLadderState(escalated.tierIndex, 0), { tierIndex: 1, model: 'gemini-3.1-flash-lite' });
});

test('邊界：tierIndex 超出範圍會拋 RangeError', () => {
    assert.throws(() => nextLadderState(-1, 0), RangeError);
    assert.throws(() => nextLadderState(MODEL_LADDER.length, 0), RangeError);
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

test('selectAliveCombo：tier0 兩把 key 全死 → 升 tier1（flash-lite）且回到 shard key 優先', () => {
    const dead = new Set([
        comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it'),
        comboId('GEMINI_API_KEY', 'gemma-4-26b-a4b-it'),
    ]);
    assert.deepEqual(selectAliveCombo(0, KEYS, dead), {
        tierIndex: 1, model: 'gemini-3.1-flash-lite', keyName: 'GEMINI_API_KEY_CENTRAL',
    });
});

test('selectAliveCombo：tier0 整層死＋下一層 shard key 死 → 選到下一層的 DEFAULT key', () => {
    const dead = new Set([
        comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it'),
        comboId('GEMINI_API_KEY', 'gemma-4-26b-a4b-it'),
        comboId('GEMINI_API_KEY_CENTRAL', 'gemini-3.1-flash-lite'),
    ]);
    assert.deepEqual(selectAliveCombo(0, KEYS, dead), {
        tierIndex: 1, model: 'gemini-3.1-flash-lite', keyName: 'GEMINI_API_KEY',
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
        tierIndex: 1, model: 'gemini-3.1-flash-lite', keyName: 'GEMINI_API_KEY',
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
    assert.deepEqual(out.combo, { tierIndex: 1, model: 'gemini-3.1-flash-lite', keyName: 'GEMINI_API_KEY_CENTRAL' });
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
    assert.deepEqual(next, { tierIndex: 1, model: 'gemini-3.1-flash-lite', keyName: 'GEMINI_API_KEY_CENTRAL' });
    assert.equal(s.deadCombos.has(comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it')), true);
    assert.equal(s.deadCombos.has(comboId('GEMINI_API_KEY', 'gemma-4-26b-a4b-it')), true);
});

test('LadderState：最後一層兩把 key 判死但前層仍活著 → 回到第一個存活 combo，不得誤報全階梯耗盡', () => {
    const s = new LadderState(KEYS);
    s.tierIndex = MODEL_LADDER.length - 1;
    s.keyName = KEYS[0];

    const sameTierFallback = s.markCurrentComboDead();
    assert.deepEqual(sameTierFallback, {
        tierIndex: MODEL_LADDER.length - 1,
        model: 'gemini-3.1-flash-lite',
        keyName: 'GEMINI_API_KEY',
    });

    const wrapped = s.markCurrentComboDead();
    assert.deepEqual(wrapped, {
        tierIndex: 0,
        model: 'gemma-4-26b-a4b-it',
        keyName: 'GEMINI_API_KEY_CENTRAL',
    });
    assert.equal(s.deadCombos.size, 2);
    assert.equal(s.isCurrentComboDead(), false);
});

test('LadderState：門檻升級時自動跳過已判死的 combo（flash-lite 的 shard key 已死 → 改用 DEFAULT key）', () => {
    const s = new LadderState(KEYS);
    s.deadCombos.add(comboId('GEMINI_API_KEY_CENTRAL', 'gemini-3.1-flash-lite'));
    s.recordFailure();
    s.recordFailure();
    const out = s.recordFailure(); // 連續 3 敗達 tier0 門檻
    assert.equal(out.escalated, true);
    assert.equal(s.model, 'gemini-3.1-flash-lite');
    assert.equal(s.keyName, 'GEMINI_API_KEY');
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
    s.tierIndex = MODEL_LADDER.length - 1; // 直接置於最後一層
    let out = null;
    for (let i = 0; i < MODEL_LADDER[MODEL_LADDER.length - 1].failuresToEscalate; i++) out = s.recordFailure();
    assert.equal(out.escalated, false);
    assert.equal(out.exhausted, true);
});

test('LadderState：keyNames 為空 → 建構時拋 RangeError', () => {
    assert.throws(() => new LadderState([]), RangeError);
});

// --- 5xx 風暴偵測（2026-08-30 四次修正，SOUTH 分片實戰）---
// 503 過載風暴與零星成功交錯時，「連續失敗」門檻被 recordSuccess 不斷歸零、
// 永遠升不了級，shard 卡在過載模型上把 18 分鐘 lane 預算耗光。

test('recordServerError：窗內未達門檻 → 不升級、停留原 combo', () => {
    const s = new LadderState(['GEMINI_API_KEY_SOUTH']);
    const t0 = 1_000_000;
    for (let i = 0; i < SERVER_ERROR_STORM_THRESHOLD - 1; i++) {
        assert.deepEqual(s.recordServerError(t0 + i * 30_000), { escalated: false });
    }
    assert.equal(s.model, 'gemma-4-26b-a4b-it');
});

test('recordServerError：窗內達門檻 → 升級到下一層，且「中間夾成功」不歸零風暴窗（核心回歸）', () => {
    const s = new LadderState(['GEMINI_API_KEY_SOUTH']);
    const t0 = 1_000_000;
    let out = null;
    for (let i = 0; i < SERVER_ERROR_STORM_THRESHOLD; i++) {
        out = s.recordServerError(t0 + i * 90_000);
        s.recordSuccess(); // 實戰情境：503 之間夾雜成功的 CAPTCHA 解答
    }
    assert.equal(out.escalated, true);
    assert.equal(s.model, 'gemini-3.1-flash-lite');
    assert.equal(s.failureCount, 0); // combo 變更後計數歸零
    assert.deepEqual(s.serverErrorTimes, []); // 風暴窗歸零
});

test('recordServerError：事件散落在窗外（間歇性 500）→ 永遠達不到門檻、26B 主力層不動', () => {
    const s = new LadderState(['GEMINI_API_KEY_SOUTH']);
    const t0 = 1_000_000;
    const spacing = SERVER_ERROR_STORM_WINDOW_MS + 1_000;
    let out = null;
    for (let i = 0; i < SERVER_ERROR_STORM_THRESHOLD + 2; i++) {
        out = s.recordServerError(t0 + i * spacing);
    }
    assert.equal(out.escalated, false);
    assert.equal(s.model, 'gemma-4-26b-a4b-it');
});

test('recordServerError：升級時跳過 PerDay 已標死的 combo（flash-lite 的 shard key 已死 → DEFAULT key）', () => {
    const s = new LadderState(['GEMINI_API_KEY_SOUTH', 'GEMINI_API_KEY']);
    s.deadCombos.add(comboId('GEMINI_API_KEY_SOUTH', 'gemini-3.1-flash-lite'));
    const t0 = 1_000_000;
    let out = null;
    for (let i = 0; i < SERVER_ERROR_STORM_THRESHOLD; i++) {
        out = s.recordServerError(t0 + i * 1_000);
    }
    assert.equal(out.escalated, true);
    assert.equal(s.model, 'gemini-3.1-flash-lite');
    assert.equal(s.keyName, 'GEMINI_API_KEY');
});

test('recordServerError：末層也風暴 → 繞回第一層（2026-09-24：flash-lite 零成功卻被死守）', () => {
    const s = new LadderState(['GEMINI_API_KEY_CENTRAL']);
    s.tierIndex = MODEL_LADDER.length - 1;
    s.failureCount = 1;
    s.higherTierSinceMs = 500_000;
    const t0 = 1_000_000;
    let out = null;
    for (let i = 0; i < SERVER_ERROR_STORM_THRESHOLD; i++) {
        out = s.recordServerError(t0 + i * 1_000);
    }
    assert.equal(out.escalated, true);
    assert.equal(out.wrapped, true);
    assert.deepEqual(out.combo, { tierIndex: 0, model: MODEL_LADDER[0].model, keyName: 'GEMINI_API_KEY_CENTRAL' });
    assert.equal(s.tierIndex, 0);
    assert.equal(s.failureCount, 0);
    assert.deepEqual(s.serverErrorTimes, []);
    assert.equal(s.higherTierSinceMs, null);
});

test('recordServerError：26B 與 flash-lite 輪流風暴 → 在兩層間來回，不會卡死任何一層', () => {
    const s = new LadderState(['GEMINI_API_KEY_CENTRAL']);
    const t0 = 1_000_000;
    const seen = [];
    for (let round = 0; round < 4; round++) {
        let out = null;
        for (let i = 0; i < SERVER_ERROR_STORM_THRESHOLD; i++) {
            out = s.recordServerError(t0 + round * 60_000 + i * 1_000);
        }
        assert.equal(out.escalated, true);
        seen.push(s.model);
    }
    assert.deepEqual(seen, [
        MODEL_LADDER[1].model, MODEL_LADDER[0].model, MODEL_LADDER[1].model, MODEL_LADDER[0].model,
    ]);
});

test('recordServerError：只剩末層存活（第一層已 PerDay 標死）→ escalated:false + exhausted:true（呼叫端維持退避重試）', () => {
    const s = new LadderState(['GEMINI_API_KEY_SOUTH']);
    s.deadCombos.add(comboId('GEMINI_API_KEY_SOUTH', MODEL_LADDER[0].model));
    s.tierIndex = MODEL_LADDER.length - 1;
    const t0 = 1_000_000;
    let out = null;
    for (let i = 0; i < SERVER_ERROR_STORM_THRESHOLD; i++) {
        out = s.recordServerError(t0 + i * 1_000);
    }
    assert.equal(out.escalated, false);
    assert.equal(out.exhausted, true);
    assert.equal(s.model, MODEL_LADDER[MODEL_LADDER.length - 1].model); // 停留原層，不污染狀態
});

test('recordFailure 升級時同步清空 5xx 風暴窗（計數屬於 combo）', () => {
    const s = new LadderState(['GEMINI_API_KEY_SOUTH']);
    s.recordServerError(1_000_000);
    s.recordFailure();
    s.recordFailure();
    const out = s.recordFailure(); // 連續 3 敗升級
    assert.equal(out.escalated, true);
    assert.deepEqual(s.serverErrorTimes, []);
});

// --- 回探第一層（2026-09-15 五次修正）---
// 階梯只升不降；移除 flash-preview 後 PerDay 回填不再觸發，改由時間式回探讓風暴過後回到 26B。

function escalatedState(keys = KEYS) {
    const s = new LadderState(keys);
    s.recordFailure();
    s.recordFailure();
    s.recordFailure(); // 連續 3 敗 → flash-lite
    assert.equal(s.tierIndex, 1);
    return s;
}

test('回探：間隔常數固定 5 分鐘（風暴窗 10 分鐘的一半）', () => {
    assert.equal(FIRST_TIER_PROBE_INTERVAL_MS, 5 * 60 * 1000);
    assert.equal(FIRST_TIER_PROBE_INTERVAL_MS * 2, SERVER_ERROR_STORM_WINDOW_MS);
});

test('回探：已在第一層 → 永不回探', () => {
    const s = new LadderState(KEYS);
    assert.equal(s.maybeStartFirstTierProbe(1_000_000), null);
    assert.equal(s.maybeStartFirstTierProbe(1_000_000 + 60 * 60 * 1000), null);
    assert.equal(s.isProbing, false);
    assert.equal(s.tierIndex, 0);
});

test('回探：升到較高層後惰性起算，未滿間隔不回探，滿間隔切到 26B', () => {
    const s = escalatedState();
    const t0 = 1_000_000;
    assert.equal(s.maybeStartFirstTierProbe(t0), null); // 起算
    assert.equal(s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS - 1), null);
    const probe = s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS);
    assert.deepEqual(probe, { tierIndex: 0, model: 'gemma-4-26b-a4b-it', keyName: 'GEMINI_API_KEY_CENTRAL' });
    assert.equal(s.isProbing, true);
    assert.equal(s.model, 'gemma-4-26b-a4b-it');
});

test('回探成功：recordSuccess 回報 true 並留在第一層，之後不再回探', () => {
    const s = escalatedState();
    const t0 = 1_000_000;
    s.maybeStartFirstTierProbe(t0);
    s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS);
    assert.equal(s.recordSuccess(), true);
    assert.equal(s.isProbing, false);
    assert.equal(s.tierIndex, 0);
    assert.equal(s.higherTierSinceMs, null);
    assert.equal(s.maybeStartFirstTierProbe(t0 + 3 * FIRST_TIER_PROBE_INTERVAL_MS), null);
});

test('非回探中的成功：recordSuccess 回報 false（呼叫端不印回探成功 log）', () => {
    assert.equal(new LadderState(KEYS).recordSuccess(), false);
    assert.equal(escalatedState().recordSuccess(), false);
});

test('回探失敗：原封還原較高層 combo（含失敗計數與風暴窗），並從失敗當下重新起算間隔', () => {
    const s = escalatedState();
    const t0 = 1_000_000;
    s.recordFailure(); // flash-lite 累積 1 次失敗（門檻 2，未達）
    s.recordServerError(t0 - 1_000); // flash-lite 風暴窗內 1 筆（門檻 2，未達）
    s.maybeStartFirstTierProbe(t0);
    s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS);
    assert.equal(s.isProbing, true);
    assert.equal(s.failureCount, 0); // 回探中的 26B 從乾淨狀態開始

    const tFail = t0 + FIRST_TIER_PROBE_INTERVAL_MS + 30_000;
    const restored = s.abortFirstTierProbe(tFail);
    assert.deepEqual(restored, { tierIndex: 1, model: 'gemini-3.1-flash-lite', keyName: 'GEMINI_API_KEY_CENTRAL' });
    assert.equal(s.isProbing, false);
    assert.equal(s.failureCount, 1);
    assert.deepEqual(s.serverErrorTimes, [t0 - 1_000]);
    assert.equal(s.deadCombos.size, 0); // 一般回探失敗不標死任何 combo
    assert.equal(s.maybeStartFirstTierProbe(tFail + FIRST_TIER_PROBE_INTERVAL_MS - 1), null);
    assert.notEqual(s.maybeStartFirstTierProbe(tFail + FIRST_TIER_PROBE_INTERVAL_MS), null);
});

test('回探遇 PerDay 429：標死該 26B combo，下次回探改用另一把 key 的 26B', () => {
    const s = escalatedState();
    const t0 = 1_000_000;
    s.maybeStartFirstTierProbe(t0);
    s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS);
    s.abortFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS, { markDead: true });
    assert.equal(s.deadCombos.has(comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it')), true);
    assert.equal(s.tierIndex, 1);
    const next = s.maybeStartFirstTierProbe(t0 + 2 * FIRST_TIER_PROBE_INTERVAL_MS);
    assert.deepEqual(next, { tierIndex: 0, model: 'gemma-4-26b-a4b-it', keyName: 'GEMINI_API_KEY' });
});

test('回探：第一層所有 key 都已 PerDay 標死 → 永不回探', () => {
    const s = escalatedState();
    s.deadCombos.add(comboId('GEMINI_API_KEY_CENTRAL', 'gemma-4-26b-a4b-it'));
    s.deadCombos.add(comboId('GEMINI_API_KEY', 'gemma-4-26b-a4b-it'));
    const t0 = 1_000_000;
    s.maybeStartFirstTierProbe(t0);
    assert.equal(s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS), null);
    assert.equal(s.maybeStartFirstTierProbe(t0 + 10 * FIRST_TIER_PROBE_INTERVAL_MS), null);
    assert.equal(s.tierIndex, 1);
    assert.equal(s.isProbing, false);
});

test('回探中不重複開新回探；未在回探中 abort 回傳 null 且不動狀態', () => {
    const s = escalatedState();
    const t0 = 1_000_000;
    s.maybeStartFirstTierProbe(t0);
    s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS);
    assert.equal(s.maybeStartFirstTierProbe(t0 + 5 * FIRST_TIER_PROBE_INTERVAL_MS), null);
    assert.equal(s.isProbing, true);

    const fresh = escalatedState();
    assert.equal(fresh.abortFirstTierProbe(t0), null);
    assert.equal(fresh.tierIndex, 1);
    assert.equal(fresh.isProbing, false);
});

test('回探：PerDay 回填回到第一層後計時清空', () => {
    const s = new LadderState(KEYS);
    s.tierIndex = 1; // 置於末層 flash-lite
    const t0 = 1_000_000;
    s.maybeStartFirstTierProbe(t0); // 起算
    assert.equal(s.higherTierSinceMs, t0);
    s.markCurrentComboDead(); // (CENTRAL, flash-lite) 死 → (DEFAULT, flash-lite)
    assert.equal(s.higherTierSinceMs, t0); // 同層換 key 不換層，計時保留
    s.markCurrentComboDead(); // (DEFAULT, flash-lite) 也死 → 回填 26B
    assert.equal(s.tierIndex, 0);
    assert.equal(s.higherTierSinceMs, null); // 換層當下即清空，不等下一次 maybeStart
    assert.equal(s.maybeStartFirstTierProbe(t0 + FIRST_TIER_PROBE_INTERVAL_MS), null);
    assert.equal(s.higherTierSinceMs, null);
});

test('回探中呼叫其他轉移一律拒絕且不改狀態（防呼叫端日後改分支順序時靜默壞掉）', () => {
    const s = escalatedState();
    s.maybeStartFirstTierProbe(1_000_000);
    s.maybeStartFirstTierProbe(1_000_000 + FIRST_TIER_PROBE_INTERVAL_MS);
    assert.throws(() => s.recordFailure(), /回探中不得呼叫 recordFailure/);
    assert.throws(() => s.recordServerError(2_000_000), /回探中不得呼叫 recordServerError/);
    assert.throws(() => s.markCurrentComboDead(), /回探中不得呼叫 markCurrentComboDead/);
    assert.equal(s.isProbing, true);
    assert.equal(s.failureCount, 0);
    assert.deepEqual(s.serverErrorTimes, []);
    assert.equal(s.deadCombos.size, 0);
});

test('升級換層時回探計時清空（重新在新層起算）', () => {
    const s = new LadderState(KEYS);
    s.higherTierSinceMs = 123; // 模擬殘留的舊計時
    s.recordFailure();
    s.recordFailure();
    s.recordFailure(); // 升到 flash-lite
    assert.equal(s.tierIndex, 1);
    assert.equal(s.higherTierSinceMs, null);
});
