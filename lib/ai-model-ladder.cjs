'use strict';

/**
 * Gemini/Gemma 模型備援階梯——純函式，與 AIManager 的 I/O（API 呼叫、log）分離以便測試。
 *
 * 背景：2026-07 Google AI Studio 現行 Gemini 模型配額耗盡，車牌選號爬蟲的 CAPTCHA
 * OCR 管線帶病運轉。Gemma 系列模型走獨立配額池，可作為備援層。
 *
 * 階梯（sticky——只升不降，同一 process/shard 生命週期內有效）：
 *   Tier 0: gemma-4-26b-a4b-it      累計 API 層失敗 3 次 → 升 Tier 1
 *   Tier 1: gemma-4-31b-it          累計 API 層失敗 2 次 → 升 Tier 2
 *   Tier 2: gemini-3-flash-preview  累計 API 層失敗 1 次 → 判定 EXHAUSTED（本請求交回既有失敗處理）
 *
 * 「失敗」＝API 層錯誤（429/4xx/5xx/timeout/網路），OCR 內容品質判定不算、不動既有邏輯。
 *
 * 呼叫端（AIManager）持有的狀態必須是 per-instance（per-shard/per-process），
 * 不得跨 shard 共用全域狀態或寫檔共享——三個 shard 各自獨立的 API key、各自獨立的階梯進度。
 */

const MODEL_LADDER = Object.freeze([
    { model: 'gemma-4-26b-a4b-it', failuresToEscalate: 3 },
    { model: 'gemma-4-31b-it', failuresToEscalate: 2 },
    { model: 'gemini-3-flash-preview', failuresToEscalate: 1 },
]);

const EXHAUSTED = 'EXHAUSTED';

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

module.exports = { MODEL_LADDER, EXHAUSTED, nextLadderState };
