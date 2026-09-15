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
const M26 = 'gemma-4-26b-a4b-it';
const LITE = 'gemini-3.1-flash-lite';
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
function makeHarness(script) {
    const calls = [];
    const logs = [];
    const clock = { now: 1_000_000 };
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
                    if (o === 'late-ok') return new Promise((r) => realSetTimeout(() => r(okResult()), TIMEOUT_MS * 3));
                    if (o === 'late-err') return new Promise((_, j) => realSetTimeout(() => j(e503()), TIMEOUT_MS * 3));
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
    const fakeSetTimeout = (fn, ms) => realSetTimeout(fn, ms === TIMEOUT_MS ? ms : 0);

    const factory = new Function(
        'resolveShardKeys', 'LadderState', 'GoogleGenerativeAI', 'AI_CALL_TIMEOUT_MS', 'EXHAUSTED',
        'isUnsupportedLocationError', 'classifyQuotaError', 'QUOTA_PER_DAY', 'isServerError',
        'SERVER_ERROR_STORM_WINDOW_MS', 'SERVER_ERROR_STORM_THRESHOLD', 'FIRST_TIER_PROBE_INTERVAL_MS',
        'console', 'process', 'Date', 'setTimeout', 'clearTimeout',
        `${CLASS_SRC}\nreturn AIManager;`,
    );
    const AIManager = factory(
        ladder.resolveShardKeys, ladder.LadderState, FakeGenAI, TIMEOUT_MS, ladder.EXHAUSTED,
        ladder.isUnsupportedLocationError, ladder.classifyQuotaError, ladder.QUOTA_PER_DAY, ladder.isServerError,
        ladder.SERVER_ERROR_STORM_WINDOW_MS, ladder.SERVER_ERROR_STORM_THRESHOLD, ladder.FIRST_TIER_PROBE_INTERVAL_MS,
        fakeConsole, fakeProcess, fakeDate, fakeSetTimeout, clearTimeout,
    );
    return { mgr: new AIManager('NORTH'), calls, logs, clock };
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
