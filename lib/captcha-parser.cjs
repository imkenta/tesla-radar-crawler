'use strict';

/**
 * Gemma/Gemini CAPTCHA 回應的「嚴格 4 字元截取」——純函式，與 AIManager 的 I/O
 * （API 呼叫、log）分離以便測試。
 *
 * 背景：2026-07 實戰 log 顯示 gemma-4-26b-a4b-it 會把整段思考過程吐進回應
 * （例：`M8L_ (Wait, let me look closer)... Let's try: MN8L.MN8L`），
 * 舊解析邏輯（見 gh-plate-sync.cjs 舊版 solveCaptcha）用 `text.slice(-4)` 保底，
 * 一定會回傳某個「看起來像 4 字元」的字串，即使那是垃圾（例如從碎念裡硬切），
 * 導致 CAPTCHA 送出必壞、觸發最貴的完整重導航循環。
 *
 * 本模組不再保底：抓不到明確 4 字元候選就回傳 null，呼叫端必須把 null 視為
 * 本地失敗、重打 AI，絕不可把 null/垃圾字串送進表單。
 */

// 候選字元集：與現有程式碼對 MVDIS 驗證碼的既有認知一致（英文字母 + 數字，大小寫不分）。
// 前後用零寬度邊界排除英數字元，避免從 5+ 長字串（如 "ABCDE"）誤切出假 4 字候選
// （negative lookbehind/lookahead：緊鄰的字元若也是英數，代表這 4 字只是更長字串的中段）。
const CANDIDATE_PATTERN = /(?<![A-Za-z0-9])[A-Za-z0-9]{4}(?![A-Za-z0-9])/g;

/**
 * 從模型回應全文嚴格截取 4 字元 CAPTCHA 答案。
 *
 * 規則：
 *   - 唯一候選 → 採用該候選。
 *   - 多個相異候選 → 取「最後一個」（模型的最終結論通常落在回應結尾；
 *     實戰樣本 `MN8L_ ... MN8L.MN8L` 最後結論即為 MN8L）。
 *   - 零候選 → 回傳 null（呼叫端不得提交，須視為本地失敗重打 AI）。
 *
 * @param {string} rawText 模型回應的原始文字（未經任何處理）
 * @returns {string|null} 大寫 4 字元答案；找不到合格候選則為 null
 */
function extractCaptchaCode(rawText) {
    if (typeof rawText !== 'string' || rawText.length === 0) {
        return null;
    }

    const matches = rawText.match(CANDIDATE_PATTERN);
    if (!matches || matches.length === 0) {
        return null;
    }

    return matches[matches.length - 1].toUpperCase();
}

module.exports = { extractCaptchaCode };
