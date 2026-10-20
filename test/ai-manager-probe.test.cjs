'use strict';

/**
 * AIManager 回探第一層的行為測試（2026-09-15）。
 *
 * AIManager 位於 gh-plate-sync.cjs，require 時會直接跑爬蟲，無法 import。因此從正式原始碼
 * 切出 class 本體，以 new Function 注入假的 Gemini SDK、時鐘、計時器與 logger 後，執行
 * 真正的 generateContent／maybeProbeFirstTier——測的是正式程式碼，不是複本。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ladder = require('../lib/ai-model-ladder.cjs');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'gh-plate-sync.cjs'), 'utf8');
const CLASS_SRC = SRC.slice(SRC.indexOf('class AIManager {'), SRC.indexOf('// Multi-Key Sharding Setup'));
const TIMEOUT_MS = 30; // 取代正式的 25s 本地逾時，讓測試跑得快
const NO_ESCAPE_TIMEOUT_MS = 20; // 取代正式的 12s「無處可逃風暴」逾時（須與 TIMEOUT_MS 不同才能分辨）
const M26 = 'gemma-4-26b-a4b-it';
const LITE = 'gemini-3.5-flash-lite';
const realSetTimeout = setTimeout;

function httpError(status, message, errorDetails) {
    const e = new Error(message);
    e.status = status;
    if (errorDetails) e.errorDetails = errorDetails;
    return e;
}
const perDay429 = () => httpError(429, '[429 Too Many Requests] quota', [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }]);
const perMinute429 = () => httpError(429, '[429 Too Many Requests] quota', [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }]);
const e503 = () => httpError(503, '[503 Service Unavailable] high demand');
const okResult = () => ({ response: { text: () => 'ABCD' } });

/**
 * script：依序消耗的步驟 { model, outcome }，outcome 為
 *   'ok' | 'hang'（永不回應→觸發本地逾時）| 'late-ok' | 'late-err'（逾時後才回應）| Error 物件
 */
function makeHarness(script, opts = {}) {
    const T = opts.timeoutMs ?? TIMEOUT_MS;
    const hedgeEnabled = opts.hedge === true;
    const hedgeAfterMs = opts.hedgeAfterMs ?? 0;
    const calls = [];
    const logs = [];
    const clock = { now: 1_000_000 };
    const waits = []; // 退避等待請求的毫秒數（退避本身立即完成，只記錄請求值供斷言）
    class FakeGenAI {
        constructor(apiKey) { this.apiKey = apiKey; }
        getGenerativeModel({ model }) {
            const apiKey = this.apiKey;
            return {
                generateContent: () => {
                    calls.push({ apiKey, model });
                    const step = script.shift();
                    if (!step) return Promise.reject(new Error('SCRIPT_EXHAUSTED'));
                    if (step.model !== model) return Promise.reject(new Error(`WRONG_MODEL expected ${step.model} got ${model}`));
                    const o = step.outcome;
                    if (o === 'ok') return Promise.resolve(okResult());
                    if (o === 'hang') return new Promise(() => {});
                    if (o === 'late-ok') return new Promise((r) => realSetTimeout(() => r(okResult()), T * 3));
                    if (o === 'late-err') return new Promise((_, j) => realSetTimeout(() => j(e503()), T * 3));
                    // { after: ms, then: 'ok' | Error }：延遲 ms 後成功／失敗（對沖測試用）
                    if (o && typeof o === 'object' && !(o instanceof Error) && typeof o.after === 'number') {
                        return new Promise((res, rej) => realSetTimeout(() => (o.then === 'ok' ? res(okResult()) : rej(o.then)), o.after));
                    }
                    return Promise.reject(o);
                },
            };
        }
    }
    const fakeProcess = {
        env: { GEMINI_API_KEY_NORTH: 'k-north', GEMINI_API_KEY: 'k-default' },
        exit: (code) => { throw new Error(`process.exit(${code})`); },
    };
    const fakeConsole = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
    const fakeDate = { now: () => clock.now };
    // 退避等待（5–10s、20s）一律立即完成；只保留本地逾時計時器（已縮為 TIMEOUT_MS）。
    const fakeSetTimeout = (fn, ms) => {
        if (ms === T || ms === NO_ESCAPE_TIMEOUT_MS || (hedgeEnabled && ms === hedgeAfterMs)) return realSetTimeout(fn, ms);
        waits.push(ms);
        return realSetTimeout(fn, 0);
    };

    const factory = new Function(
        'resolveShardKeys', 'LadderState', 'GoogleGenerativeAI', 'AI_CALL_TIMEOUT_MS', 'EXHAUSTED',
        'isUnsupportedLocationError', 'classifyQuotaError', 'QUOTA_PER_DAY', 'isServerError',
        'SERVER_ERROR_STORM_WINDOW_MS', 'SERVER_ERROR_STORM_THRESHOLD', 'FIRST_TIER_PROBE_INTERVAL_MS',
        'NO_ESCAPE_STORM_CALL_TIMEOUT_MS', 'NO_ESCAPE_STORM_BACKOFF_MIN_MS', 'NO_ESCAPE_STORM_BACKOFF_MAX_MS',
        'AI_HEDGE_ENABLED', 'HEDGE_AFTER_MS',
        'console', 'process', 'Date', 'setTimeout', 'clearTimeout',
        `${CLASS_SRC}\nreturn AIManager;`,
    );
    const AIManager = factory(
        ladder.resolveShardKeys, ladder.LadderState, FakeGenAI, T, ladder.EXHAUSTED,
        ladder.isUnsupportedLocationError, ladder.classifyQuotaError, ladder.QUOTA_PER_DAY, ladder.isServerError,
        ladder.SERVER_ERROR_STORM_WINDOW_MS, ladder.SERVER_ERROR_STORM_THRESHOLD, ladder.FIRST_TIER_PROBE_INTERVAL_MS,
        NO_ESCAPE_TIMEOUT_MS, ladder.NO_ESCAPE_STORM_BACKOFF_MIN_MS, ladder.NO_ESCAPE_STORM_BACKOFF_MAX_MS,
        hedgeEnabled, hedgeAfterMs,
        fakeConsole, fakeProcess, fakeDate, fakeSetTimeout, clearTimeout,
    );
    return { mgr: new AIManager('NORTH'), calls, logs, clock, waits };
}

/** 讓 manager 停在 flash-lite 並滿足回探間隔：下一次 maybeProbeFirstTier 就會回探。 */
function readyToProbe(h) {
    h.mgr.ladder.tierIndex = 1;
    h.mgr.init();
    h.mgr.maybeProbeFirstTier(); // 惰性起算
    h.clock.now += ladder.FIRST_TIER_PROBE_INTERVAL_MS;
}

const models = (h) => h.calls.map((c) => c.model);

test('AIManager：未滿回探間隔 → 不回探，本張照用 flash-lite', async () => {
    const h = makeHarness([{ model: LITE, outcome: 'ok' }]);
    h.mgr.ladder.tierIndex = 1;
    h.mgr.init();
    h.mgr.maybeProbeFirstTier();
    h.clock.now += ladder.FIRST_TIER_PROBE_INTERVAL_MS - 1;
    h.mgr.maybeProbeFirstTier();
    await h.mgr.generateContent(['x']);
    assert.deepEqual(models(h), [LITE]);
    assert.ok(!h.logs.some((l) => l.includes('回探')));
});

test('AIManager：回探成功 → 留在 26B，並印出可解析的回探開始／成功 log', async () => {
    const h = makeHarness([{ model: M26, outcome: 'ok' }]);
    readyToProbe(h);
    h.mgr.maybeProbeFirstTier();
    assert.equal(h.mgr.modelName, M26);
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.equal(h.mgr.ladder.tierIndex, 0);
    assert.equal(h.mgr.ladder.isProbing, false);
    assert.ok(h.logs.some((l) => l.includes(`🔁 [AI] 回探第一層 → GEMINI_API_KEY_NORTH/${M26}`)));
    assert.ok(h.logs.some((l) => l.includes(`✅ [AI] 回探成功，留在第一層 → GEMINI_API_KEY_NORTH/${M26}`)));
});

test('AIManager：回探遇本地逾時 → 回到 flash-lite 重試本張；回探的逾時不進風暴窗、5xx 退避旗標未被消耗', async () => {
    const h = makeHarness([
        { model: M26, outcome: 'hang' },     // 回探：本地逾時
        { model: LITE, outcome: e503() },    // 回到原層：flash-lite 一次 5xx
        { model: LITE, outcome: 'ok' },      // 5xx 退避重試成功（旗標若被回探消耗就不會有這次重試）
    ]);
    readyToProbe(h);
    h.mgr.maybeProbeFirstTier();
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.deepEqual(models(h), [M26, LITE, LITE]);
    assert.equal(h.mgr.ladder.tierIndex, 1);
    assert.equal(h.mgr.ladder.isProbing, false);
    assert.equal(h.mgr.ladder.serverErrorTimes.length, 1, '只有 flash-lite 自己的 5xx 進風暴窗');
    assert.equal(h.mgr.ladder.deadCombos.size, 0);
    assert.ok(h.logs.some((l) => l.includes(`↩️  [AI] 回探失敗 @ GEMINI_API_KEY_NORTH/${M26}（仍不穩），回到原層 → GEMINI_API_KEY_NORTH/${LITE}`)));
});

test('AIManager：回探遇 PerDay 429 → 標死該 26B combo、回到 flash-lite；下次回探改用另一把 key 的 26B', async () => {
    const h = makeHarness([
        { model: M26, outcome: perDay429() },
        { model: LITE, outcome: 'ok' },
        { model: M26, outcome: 'ok' },
    ]);
    readyToProbe(h);
    h.mgr.maybeProbeFirstTier();
    await h.mgr.generateContent(['x']);
    assert.equal(h.mgr.ladder.tierIndex, 1);
    assert.ok(h.mgr.ladder.deadCombos.has(ladder.comboId('GEMINI_API_KEY_NORTH', M26)));
    assert.ok(h.logs.some((l) => l.includes('日配額耗盡，已標死')));

    h.clock.now += ladder.FIRST_TIER_PROBE_INTERVAL_MS;
    h.mgr.maybeProbeFirstTier();
    assert.equal(h.mgr.currentKeyName, 'GEMINI_API_KEY');
    await h.mgr.generateContent(['x']);
    assert.equal(h.mgr.ladder.tierIndex, 0);
    assert.deepEqual(h.calls.map((c) => `${c.apiKey}/${c.model}`), [`k-north/${M26}`, `k-north/${LITE}`, `k-default/${M26}`]);
});

test('AIManager：回探遇分鐘級 429 → 不標死；回到 flash-lite 後分鐘級退避旗標仍可用', async () => {
    const h = makeHarness([
        { model: M26, outcome: perMinute429() },
        { model: LITE, outcome: perMinute429() },
        { model: LITE, outcome: 'ok' },
    ]);
    readyToProbe(h);
    h.mgr.maybeProbeFirstTier();
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.equal(h.mgr.ladder.deadCombos.size, 0);
    assert.deepEqual(models(h), [M26, LITE, LITE]);
    assert.ok(h.logs.some((l) => l.includes('分鐘級限流')));
});

test('AIManager：逾時觀測只記錄不改流程——晚到的成功與失敗都記錄，且無 unhandledRejection', async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    try {
        const h = makeHarness([
            { model: M26, outcome: 'late-ok' },   // 26B 逾時（其實晚到成功）→ 5xx 退避重試
            { model: M26, outcome: 'late-err' },  // 再逾時（晚到失敗）→ 風暴 2 次 → 升 flash-lite
            { model: LITE, outcome: 'ok' },
        ]);
        const r = await h.mgr.generateContent(['x']);
        assert.equal(r.response.text(), 'ABCD');
        assert.deepEqual(models(h), [M26, M26, LITE]);
        await new Promise((resolve) => realSetTimeout(resolve, TIMEOUT_MS * 8));
        assert.ok(h.logs.some((l) => l.includes(`🔎 [AI] 逾時後觀測 @ GEMINI_API_KEY_NORTH/${M26}：`) && l.includes('才回應成功')));
        assert.ok(h.logs.some((l) => l.includes(`🔎 [AI] 逾時後觀測 @ GEMINI_API_KEY_NORTH/${M26}：`) && l.includes('才回應失敗（503）')));
        assert.equal(h.mgr.ladder.tierIndex, 1, '觀測不得影響階梯：仍由風暴偵測正常升級');
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(unhandled, 0);
});

// --- 無處可逃的風暴（2026-10-01）---

test('AIManager：無處可逃的風暴 → 逾時縮短、5xx 退避縮為 1–3s；一般情況仍是 25s 逾時與 5–10s 退避', async () => {
    const h = makeHarness([
        { model: M26, outcome: e503() },     // 呼叫 1：窗內第 1 筆，一般 5–10s 退避
        { model: M26, outcome: e503() },     // 窗內第 2 筆 → 風暴且備援層全死 → 啟動模式；退避旗標已用 → throw
        { model: M26, outcome: 'late-ok' },  // 呼叫 2：模式下的短逾時（NO_ESCAPE_TIMEOUT_MS）→ 視同 5xx → 短退避
        { model: M26, outcome: 'ok' },       // 短退避後重試成功
    ]);
    // 備援兩層、兩把 key 全數 PerDay 標死（9/30 實況）：只剩 26B。
    for (const k of ['GEMINI_API_KEY_NORTH', 'GEMINI_API_KEY']) {
        h.mgr.ladder.deadCombos.add(ladder.comboId(k, ladder.MODEL_LADDER[1].model));
        h.mgr.ladder.deadCombos.add(ladder.comboId(k, ladder.MODEL_LADDER[2].model));
    }

    await assert.rejects(() => h.mgr.generateContent(['x']), /503/);
    assert.equal(h.waits.length, 1);
    assert.ok(h.waits[0] >= 5000 && h.waits[0] < 10000, `一般退避應為 5–10s，實得 ${h.waits[0]}`);
    assert.equal(h.mgr.ladder.isNoEscapeStorm(h.clock.now), true);

    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.equal(h.waits.length, 2);
    assert.ok(h.waits[1] >= ladder.NO_ESCAPE_STORM_BACKOFF_MIN_MS && h.waits[1] < ladder.NO_ESCAPE_STORM_BACKOFF_MAX_MS,
        `無處可逃退避應為 1–3s，實得 ${h.waits[1]}`);
    await new Promise((resolve) => realSetTimeout(resolve, NO_ESCAPE_TIMEOUT_MS * 8));
    assert.ok(h.logs.some((l) => l.includes('逾時後觀測') && l.includes(`已被 ${NO_ESCAPE_TIMEOUT_MS / 1000}s 逾時捨棄`)),
        '呼叫 2 應使用短逾時');
    assert.ok(h.logs.some((l) => l.includes('無處可逃的風暴')));
});

test('AIManager：還有存活的備援層時照舊升級，逾時與退避維持一般值', async () => {
    const h = makeHarness([
        { model: M26, outcome: 'late-ok' },  // 一般逾時（TIMEOUT_MS）
        { model: M26, outcome: e503() },     // 窗內第 2 筆 → 升級到 3.5
        { model: LITE, outcome: 'ok' },
    ]);
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.equal(h.mgr.ladder.tierIndex, 1);
    assert.equal(h.mgr.ladder.isNoEscapeStorm(h.clock.now), false);
    await new Promise((resolve) => realSetTimeout(resolve, TIMEOUT_MS * 8));
    assert.ok(h.logs.some((l) => l.includes(`已被 ${TIMEOUT_MS / 1000}s 逾時捨棄`)));
    assert.ok(h.waits.every((w) => w >= 5000), '一般退避 5–10s');
});

// --- 對沖＋逾時呼叫續戰（2026-10-20）---
// 逾時 120ms、對沖門檻 30ms（取代正式 25s／8s）；「過載模式」靠預先塞 overloadTimes 開啟。
const HT = 120;
const HA = 30;
const L31 = 'gemini-3.1-flash-lite';
function hedgeHarness(script, { overloaded = true } = {}) {
    const h = makeHarness(script, { hedge: true, timeoutMs: HT, hedgeAfterMs: HA });
    if (overloaded) h.mgr.ladder.overloadTimes = [h.clock.now, h.clock.now, h.clock.now];
    return h;
}
const tick = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

test('對沖：過載模式下原層超過門檻未回 → 同時問下一個模型，先到先用，且不等原層', async () => {
    const h = hedgeHarness([
        { model: M26, outcome: { after: 100, then: 'ok' } },   // 原層很慢
        { model: LITE, outcome: 'ok' },                         // 對沖目標立刻成功
    ]);
    const t0 = Date.now();
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.ok(Date.now() - t0 < 90, '應在對沖目標回應時返回，不等 100ms 的原層');
    assert.deepEqual(models(h), [M26, LITE]);
    assert.ok(h.logs.some((l) => l.includes('🏇 [AI] 對沖（過載模式）') && l.includes(`GEMINI_API_KEY_NORTH/${LITE}`)));
    assert.ok(h.logs.some((l) => l.includes('🏁 [AI] 採用對沖結果') && l.includes(LITE)));
    await tick(120);
});

test('對沖：非過載模式不對沖（平時零額外請求）', async () => {
    const h = hedgeHarness([{ model: M26, outcome: { after: 60, then: 'ok' } }], { overloaded: false });
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.deepEqual(models(h), [M26]);
    assert.ok(!h.logs.some((l) => l.includes('對沖')));
});

test('對沖：AI_HEDGE=off（旗標 false）即使過載也不對沖、逾時呼叫不續戰——與舊行為相同', async () => {
    const h = makeHarness([
        { model: M26, outcome: 'late-ok' },
        { model: M26, outcome: e503() },
        { model: LITE, outcome: 'ok' },
    ]);
    h.mgr.ladder.overloadTimes = [h.clock.now, h.clock.now, h.clock.now];
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.deepEqual(models(h), [M26, M26, LITE]);
    assert.ok(!h.logs.some((l) => l.includes('對沖') || l.includes('採用')));
    await tick(TIMEOUT_MS * 5);
});

test('對沖：原層贏就照常返回，不採用對沖、不記風暴', async () => {
    const h = hedgeHarness([
        { model: M26, outcome: { after: 50, then: 'ok' } },
        { model: LITE, outcome: { after: 100, then: 'ok' } },
    ]);
    const before = h.mgr.ladder.overloadTimes.length;
    await h.mgr.generateContent(['x']);
    assert.ok(h.logs.some((l) => l.includes('🏇 [AI] 對沖')));
    assert.ok(!h.logs.some((l) => l.includes('採用')));
    assert.equal(h.mgr.ladder.overloadTimes.length, before, '原層贏不算過載事件');
    await tick(120);
});

test('對沖：連續被對沖超車兩次 → 計入風暴窗而升級到對沖目標層（原層又慢又每張都對沖是浪費）', async () => {
    const h = hedgeHarness([
        { model: M26, outcome: { after: 100, then: 'ok' } }, { model: LITE, outcome: 'ok' },
        { model: M26, outcome: { after: 100, then: 'ok' } }, { model: LITE, outcome: 'ok' },
    ]);
    await h.mgr.generateContent(['x']);
    assert.equal(h.mgr.ladder.tierIndex, 0, '第一次超車只記一筆，未達風暴門檻');
    await h.mgr.generateContent(['x']);
    assert.equal(h.mgr.ladder.tierIndex, 1);
    assert.equal(h.mgr.modelName, LITE);
    assert.ok(h.logs.some((l) => l.includes('慢到被對沖超車') && l.includes('升級')));
    await tick(120);
});

test('對沖：對沖目標回 PerDay 429 → 只標死該 combo，不動當前層，原層照樣完成', async () => {
    const h = hedgeHarness([
        { model: M26, outcome: { after: 70, then: 'ok' } },
        { model: LITE, outcome: perDay429() },
    ]);
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.ok(h.mgr.ladder.deadCombos.has(ladder.comboId('GEMINI_API_KEY_NORTH', LITE)));
    assert.equal(h.mgr.ladder.tierIndex, 0);
    assert.ok(h.logs.some((l) => l.includes('對沖目標日配額耗盡')));
});

test('對沖：沒有存活的異模型 → 不對沖；同模型另一把 key 不算對沖目標', async () => {
    const h = hedgeHarness([{ model: M26, outcome: { after: 60, then: 'ok' } }]);
    for (const k of ['GEMINI_API_KEY_NORTH', 'GEMINI_API_KEY']) {
        h.mgr.ladder.deadCombos.add(ladder.comboId(k, LITE));
        h.mgr.ladder.deadCombos.add(ladder.comboId(k, L31));
    }
    await h.mgr.generateContent(['x']);
    assert.deepEqual(models(h), [M26]);
});

test('逾時呼叫續戰：逾時的原層呼叫稍後成功，贏過退避後重試的新呼叫（零額外請求）', async () => {
    const h = hedgeHarness([
        { model: M26, outcome: { after: 200, then: 'ok' } },  // 逾時（120ms）後 80ms 到
        { model: M26, outcome: 'hang' },                       // 退避後的重試永不回
    ], { overloaded: false });
    const t0 = Date.now();
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.ok(Date.now() - t0 < 260, '應在先前逾時呼叫的 200ms 晚到時返回，不必等重試的 120ms 逾時');
    assert.deepEqual(models(h), [M26, M26]);
    assert.ok(h.logs.some((l) => l.includes('採用先前逾時呼叫的晚到結果')));
    assert.equal(h.mgr.ladder.tierIndex, 0, '晚到結果不是對沖，不額外記風暴');
});

test('逾時呼叫續戰：晚到的失敗不影響流程；重試成功照常返回；無 unhandledRejection', async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    try {
        const h = hedgeHarness([
            { model: M26, outcome: { after: 200, then: e503() } },
            { model: M26, outcome: 'ok' },
        ], { overloaded: false });
        const r = await h.mgr.generateContent(['x']);
        assert.equal(r.response.text(), 'ABCD');
        assert.deepEqual(models(h), [M26, M26]);
        await tick(250);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(unhandled, 0);
});

test('對沖：回探中不對沖（回探語義要乾淨）', async () => {
    const h = hedgeHarness([{ model: M26, outcome: { after: 70, then: 'ok' } }]);
    readyToProbe(h);
    h.mgr.maybeProbeFirstTier();
    assert.equal(h.mgr.ladder.isProbing, true);
    const r = await h.mgr.generateContent(['x']);
    assert.equal(r.response.text(), 'ABCD');
    assert.deepEqual(models(h), [M26]);
    assert.equal(h.mgr.ladder.tierIndex, 0);
});
