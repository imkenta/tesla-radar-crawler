'use strict';

/**
 * Gemini/Gemma 模型備援階梯——純函式，與 AIManager 的 I/O（API 呼叫、log）分離以便測試。
 *
 * 背景：2026-07 Google AI Studio 現行 Gemini 模型配額耗盡，車牌選號爬蟲的 CAPTCHA
 * OCR 管線帶病運轉。Gemma 系列模型走獨立配額池，可作為備援層。
 *
 * 2026-07-05 二次修正（依 AI Studio 儀表板實測配額調整）：
 * 實測 24h 用量 6,815 次遠超單模型池 RPD，階梯擴為四層以分散日配額；
 * 同時新增 429 錯誤分流（見 classifyQuotaError）。
 *
 * 2026-07-05 三次修正（依三 shard 實戰 log，v1 階梯有真 bug）：
 * 1. 連續失敗才升級：成功呼叫重置當前層失敗計數（LadderState.recordSuccess）。
 *    v1 用「累計」語義——中區在多次成功之間累積零星 500 也觸發升級到已死的 31B。
 * 2. 日配額死亡標記改為 per-(key, model)：429 quotaId 含 PerDay（實戰樣本
 *    GenerateRequestsPerDayPerProjectPerModel-FreeTier）→ 該組合本輪標死，選模時
 *    直接跳過、絕不再打（南區實戰卡死在 RPD=20 的 gemini-3-flash-preview 連環 429）。
 * 3. key 協同：同一層先試 shard key，該 (key, model) 死了才試 DEFAULT key，
 *    兩者皆死才升層（取代 v1 的 sticky switchToFallback 全域切 key）。
 *
 * 階梯（sticky——tier 只升不降，同一 process/shard 生命週期內有效）：
 *   Tier 0: gemma-4-26b-a4b-it       連續 API 層失敗 3 次 → 升 Tier 1
 *   Tier 1: gemma-4-31b-it           連續 API 層失敗 2 次 → 升 Tier 2
 *   Tier 2: gemini-3.1-flash-lite    連續 API 層失敗 2 次 → 升 Tier 3
 *   Tier 3: gemini-3-flash-preview   連續 API 層失敗 1 次 → 判定 EXHAUSTED（本請求交回既有失敗處理）
 *
 * 「失敗」＝API 層錯誤（4xx/timeout/網路，或分鐘級限流/5xx 退避重試後仍失敗）計入升級門檻。
 * 429 quotaId 含 PerDay＝該 (key, model) 標死跳選，不走計數（LadderState.markCurrentComboDead）。
 * 429 分鐘級（PerMinute 或無 PerDay 字樣）＝退避（RetryInfo.retryDelay 或 20s）後同 combo
 * 重試 1 次，成功不計數。5xx（見 isServerError）＝退避 5-10 秒後同 combo 重試 1 次，
 * 成功不計數——26B 間歇性 500 不該讓它被踢下主力層。OCR 內容品質判定不算、不動既有邏輯。
 *
 * 呼叫端（AIManager）持有的狀態必須是 per-instance（per-shard/per-process），
 * 不得跨 shard 共用全域狀態或寫檔共享——三個 shard 各自獨立的 API key、各自獨立的階梯進度。
 */

const MODEL_LADDER = Object.freeze([
    { model: 'gemma-4-26b-a4b-it', failuresToEscalate: 3 },
    { model: 'gemma-4-31b-it', failuresToEscalate: 2 },
    { model: 'gemini-3.1-flash-lite', failuresToEscalate: 2 },
    { model: 'gemini-3-flash-preview', failuresToEscalate: 1 },
]);

const EXHAUSTED = 'EXHAUSTED';

// 429 分流判定結果的字串常數。
const QUOTA_PER_MINUTE = 'PER_MINUTE';
const QUOTA_PER_DAY = 'PER_DAY';
const QUOTA_UNKNOWN = 'UNKNOWN';

/**
 * 判定一個 API 層錯誤是否為 429，以及若是 429，屬於「每分鐘限流」還是「每日配額耗盡」。
 *
 * Google Generative AI SDK（@google/generative-ai）的 GoogleGenerativeAIFetchError：
 * - error.status：HTTP status code（429 = RESOURCE_EXHAUSTED）
 * - error.errorDetails：來自回應 body 的 `error.details`（google.rpc 標準格式，
 *   429 配額錯誤通常帶 QuotaFailure，其 violations[].quotaId / quotaMetric 字串
 *   內含 PerDay / PerMinute 字樣，如 GenerateRequestsPerDayPerProjectPerModel）
 * - SDK 原始碼另會把 errorDetails 整段 JSON.stringify 進 e.message 本體，
 *   因此即使拿不到結構化 errorDetails，字串比對 e.message 仍可作為 fallback。
 *
 * 這是防禦性判斷：官方欄位命名可能隨模型/版本略有差異，此處僅抓寬鬆的字樣特徵，
 * 抓不到明確字樣時回傳 QUOTA_UNKNOWN。呼叫端語義（2026-07-05 三次修正）：只有明確
 * 含 PerDay 字樣才標死 (key, model)——標死是本輪不可逆動作，實戰顯示日配額 429 必帶
 * PerDay quotaId；UNKNOWN 視同分鐘級（退避重試 1 次），寧可多等 20 秒也不要把活層標死。
 *
 * @param {Error & { status?: number, errorDetails?: unknown }} error
 * @returns {{ isQuotaError: boolean, quotaWindow: 'PER_MINUTE'|'PER_DAY'|'UNKNOWN'|null, retryAfterMs: number|null }}
 */
function classifyQuotaError(error) {
    const status = error && error.status;
    const message = (error && error.message) || '';
    const isHttp429 = status === 429;
    const looksLikeQuotaText = /quota|resource_exhausted|429/i.test(message);

    if (!isHttp429 && !looksLikeQuotaText) {
        return { isQuotaError: false, quotaWindow: null, retryAfterMs: null };
    }

    // 攤平 errorDetails 到單一字串以便字樣比對（結構化欄位優先，message 字串當 fallback）。
    let detailsText = '';
    if (error && error.errorDetails) {
        try {
            detailsText = JSON.stringify(error.errorDetails);
        } catch {
            detailsText = String(error.errorDetails);
        }
    }
    const haystack = `${detailsText} ${message}`;

    const perDayPattern = /per[_\s-]?day/i;
    const perMinutePattern = /per[_\s-]?minute/i;

    let quotaWindow = QUOTA_UNKNOWN;
    if (perDayPattern.test(haystack)) {
        quotaWindow = QUOTA_PER_DAY;
    } else if (perMinutePattern.test(haystack)) {
        quotaWindow = QUOTA_PER_MINUTE;
    }

    // 嘗試從 RetryInfo（google.rpc.RetryInfo，retryDelay 欄位）取得建議退避秒數。
    let retryAfterMs = null;
    const retryDelayMatch = haystack.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
    if (retryDelayMatch) {
        retryAfterMs = Math.ceil(parseFloat(retryDelayMatch[1]) * 1000);
    }

    return { isQuotaError: true, quotaWindow, retryAfterMs };
}

/**
 * 判定一個 API 層錯誤是否為 Google 端 5xx（暫時性伺服器錯誤）。
 *
 * 背景：26B 間歇性回傳 500，這類錯誤與配額無關、純粹是伺服器暫時性問題，
 * 短暫退避後同層重試往往就會成功——不該把這種瞬斷直接算進升級門檻的失敗計數
 * （那會讓 26B 因為單純運氣不好被過早踢下線，違反「26B 仍是第一層主力」的要求）。
 *
 * @param {Error & { status?: number }} error
 * @returns {boolean}
 */
function isServerError(error) {
    const status = error && error.status;
    if (typeof status === 'number') {
        return status >= 500 && status < 600;
    }
    // status 欄位缺失時，退回字串比對（SDK 有時只在 message 帶狀態碼）。
    const message = (error && error.message) || '';
    return /\[(50\d)\b/.test(message) || /\b50\d\s+(internal|server error|service unavailable|bad gateway)/i.test(message);
}

/**
 * 給定目前層級 index 與該層級累計失敗次數，回傳下一步狀態。
 *
 * @param {number} tierIndex 目前所在的階梯 index（0-based，對應 MODEL_LADDER）
 * @param {number} failureCount 目前層級累計的 API 層失敗次數（本次失敗已計入）
 * @returns {{ tierIndex: number, model: string } | 'EXHAUSTED'}
 *   - 若尚未達到該層級的升級門檻：回傳原 tierIndex（不升級）
 *   - 若達到門檻且下一層存在：回傳升級後的 tierIndex + model
 *   - 若已在最後一層且達到門檻：回傳 'EXHAUSTED'（呼叫端交給既有失敗處理/Tesseract 路徑）
 */
function nextLadderState(tierIndex, failureCount) {
    if (tierIndex < 0 || tierIndex >= MODEL_LADDER.length) {
        throw new RangeError(`nextLadderState: tierIndex 超出範圍: ${tierIndex}`);
    }

    const currentTier = MODEL_LADDER[tierIndex];
    if (failureCount < currentTier.failuresToEscalate) {
        return { tierIndex, model: currentTier.model };
    }

    const nextIndex = tierIndex + 1;
    if (nextIndex >= MODEL_LADDER.length) {
        return EXHAUSTED;
    }
    return { tierIndex: nextIndex, model: MODEL_LADDER[nextIndex].model };
}

/** (key, model) 死亡矩陣的組合識別字串。 */
function comboId(keyName, model) {
    return `${keyName}::${model}`;
}

/**
 * 從 startTierIndex 起（含），依「層內先試 keyNames 順序、層間由低往高」找出第一個
 * 未被標死的 (tier, key) 組合。
 *
 * @param {number} startTierIndex 從哪一層開始找（0-based；≥ 階梯長度 → EXHAUSTED）
 * @param {string[]} keyNames 依優先序排列的 key 名稱（[0]=shard key，之後=DEFAULT key）
 * @param {Set<string>} deadCombos 已標死的 comboId(keyName, model) 集合
 * @returns {{ tierIndex: number, model: string, keyName: string } | 'EXHAUSTED'}
 */
function selectAliveCombo(startTierIndex, keyNames, deadCombos) {
    for (let t = Math.max(0, startTierIndex); t < MODEL_LADDER.length; t++) {
        const model = MODEL_LADDER[t].model;
        for (const keyName of keyNames) {
            if (!deadCombos.has(comboId(keyName, model))) {
                return { tierIndex: t, model, keyName };
            }
        }
    }
    return EXHAUSTED;
}

/**
 * 階梯 + (key, model) 死亡矩陣的完整狀態機——純狀態、零 I/O，AIManager 持有一份，
 * 單元測試直接實例化驗證語義（成功重置計數 / PerDay 判死跳選 / 死亡矩陣選擇）。
 *
 * 語義（2026-07-05 三次修正，依三 shard 實戰 log）：
 * - 連續失敗才升級：recordSuccess() 重置當前 combo 的失敗計數。
 * - 日配額死亡標記 per-(key, model)：markCurrentComboDead() 標死當前組合並重選，
 *   已標死組合在本 process 生命週期內永不再被選中。
 * - key 優先序：每層先試 keyNames[0]（shard key），死了才輪到後面的（DEFAULT key），
 *   同層全死才升層。
 * - sticky：tier 只升不降（markCurrentComboDead 從當前層起找、recordFailure 從下一層起找）。
 */
class LadderState {
    /** @param {string[]} keyNames 依優先序排列的 key 名稱，至少一把。 */
    constructor(keyNames) {
        if (!Array.isArray(keyNames) || keyNames.length === 0) {
            throw new RangeError('LadderState: keyNames 至少要有一把 key');
        }
        this.keyNames = keyNames.slice();
        this.deadCombos = new Set();
        this.tierIndex = 0;
        this.keyName = this.keyNames[0];
        this.failureCount = 0;
    }

    get model() {
        return MODEL_LADDER[this.tierIndex].model;
    }

    /** 成功呼叫：連續失敗語義——重置當前層失敗計數（v1 累計語義 bug 的修正核心）。 */
    recordSuccess() {
        this.failureCount = 0;
    }

    /** 當前 (key, model) 是否已被標死（EXHAUSTED 後殘留指向死 combo 時，呼叫端據此快速失敗）。 */
    isCurrentComboDead() {
        return this.deadCombos.has(comboId(this.keyName, this.model));
    }

    /**
     * 日配額耗盡：標死當前 (key, model)，從「當前層」起重選存活 combo
     * （同層其他 key 優先，全死才升層）。combo 變更後失敗計數歸零（計數屬於 combo）。
     * @returns {{ tierIndex: number, model: string, keyName: string } | 'EXHAUSTED'}
     */
    markCurrentComboDead() {
        this.deadCombos.add(comboId(this.keyName, this.model));
        const next = selectAliveCombo(this.tierIndex, this.keyNames, this.deadCombos);
        if (next === EXHAUSTED) {
            return EXHAUSTED;
        }
        this.tierIndex = next.tierIndex;
        this.keyName = next.keyName;
        this.failureCount = 0;
        return next;
    }

    /**
     * 一般 API 層失敗：連續失敗計數 +1；達當前層門檻 → 從「下一層」起找存活 combo 升級
     * （自動跳過已標死的層，如今日已死的 31B）。
     * @returns {{ escalated: false, exhausted?: true } | { escalated: true, combo: { tierIndex: number, model: string, keyName: string } }}
     *   - escalated:false（無 exhausted）＝未達門檻，停留原 combo，計數保留
     *   - escalated:false + exhausted:true＝達門檻但已無存活層可升，呼叫端交回既有失敗處理
     *   - escalated:true＝已升級至 combo，計數歸零
     */
    recordFailure() {
        this.failureCount++;
        const next = nextLadderState(this.tierIndex, this.failureCount);
        if (next !== EXHAUSTED && next.tierIndex === this.tierIndex) {
            return { escalated: false };
        }
        const alive = selectAliveCombo(this.tierIndex + 1, this.keyNames, this.deadCombos);
        if (alive === EXHAUSTED) {
            return { escalated: false, exhausted: true };
        }
        this.tierIndex = alive.tierIndex;
        this.keyName = alive.keyName;
        this.failureCount = 0;
        return { escalated: true, combo: alive };
    }
}

module.exports = {
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
};
