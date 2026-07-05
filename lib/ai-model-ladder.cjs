'use strict';

/**
 * Gemini/Gemma 模型備援階梯——純函式，與 AIManager 的 I/O（API 呼叫、log）分離以便測試。
 *
 * 背景：2026-07 Google AI Studio 現行 Gemini 模型配額耗盡，車牌選號爬蟲的 CAPTCHA
 * OCR 管線帶病運轉。Gemma 系列模型走獨立配額池，可作為備援層。
 *
 * 2026-07-05 二次修正（依 AI Studio 儀表板實測配額調整）：
 * 實測 24h 用量 6,815 次遠超單模型池 RPD，階梯擴為四層以分散日配額；
 * 同時新增 429 錯誤分流（見 classifyQuotaError）——避免「每分鐘限流」誤判為
 * 「每日耗盡」而浪費升級門檻的失敗計數。
 *
 * 階梯（sticky——只升不降，同一 process/shard 生命週期內有效）：
 *   Tier 0: gemma-4-26b-a4b-it       累計 API 層失敗 3 次 → 升 Tier 1
 *   Tier 1: gemma-4-31b-it           累計 API 層失敗 2 次 → 升 Tier 2
 *   Tier 2: gemini-3.1-flash-lite    累計 API 層失敗 2 次 → 升 Tier 3
 *   Tier 3: gemini-3-flash-preview   累計 API 層失敗 1 次 → 判定 EXHAUSTED（本請求交回既有失敗處理）
 *
 * 「失敗」＝API 層錯誤（429 每日配額耗盡/4xx/timeout/網路，或 5xx 退避後仍失敗）計入升級門檻。
 * 429 每分鐘限流＝退避後同層重試，不計入升級門檻（見 classifyQuotaError + gh-plate-sync.cjs 呼叫端）。
 * 5xx（Google 端暫時性錯誤，見 isServerError）＝退避 5-10 秒後同層重試 1 次，
 * 重試仍失敗才計入升級門檻——26B 間歇性 500 不該讓它被過早踢下主力層。
 * OCR 內容品質判定不算、不動既有邏輯。
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
 * 抓不到明確字樣時回傳 QUOTA_UNKNOWN（呼叫端應視同「每日耗盡」處理，寧可保守升級
 * 也不要在真正日配額耗盡時原地重試空耗時間）。
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

module.exports = {
    MODEL_LADDER,
    EXHAUSTED,
    nextLadderState,
    classifyQuotaError,
    isServerError,
    QUOTA_PER_MINUTE,
    QUOTA_PER_DAY,
    QUOTA_UNKNOWN,
};
