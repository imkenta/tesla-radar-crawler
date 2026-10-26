'use strict';

/**
 * MVDIS 選號表單「送出被拒」原因分類（純函式，與 test/submit-reject-classifier.test.cjs 共用單一真理）。
 *
 * 背景（2026-10-26 晚間 MVDIS 變慢事故研究）：過去 gh-plate-sync.cjs 只要偵測到「任何 dialog」或頁面出現
 * 驗證碼錯誤字串，就印 "Captcha Error detected" 並計入 consecutiveCaptchaRejects；累計 4 次即丟 exit 75
 * 讓 workflow 重抽 WARP。但頁面 chkForm() 在下拉未選齊時也會 alert('請選擇…') 並 return false——
 * 那是「表單沒填完」（DWR 非同步串接晚回、select 靜默取消選取），與驗證碼、與 IP 軟封鎖都無關，
 * 卻被當成驗證碼被拒，累計後誤觸發重抽 WARP 身分。
 *
 * 分類（優先序：alert 是最新鮮的證據；body 字串可能是上一輪殘留）：
 *   有 alert：
 *     - 以「請選擇」開頭、或 chkForm 的「請輸入查詢號碼」 → 'form-incomplete'
 *     - 含「驗證」（chkForm 的「請輸入驗證數字」）                → 'captcha'
 *     - 其他 alert：若 body 同時明確顯示驗證碼錯誤 → 'captcha'；否則 'unknown-dialog'
 *   無 alert：
 *     - body 含「驗證數字輸入錯誤」／「請輸入驗證數字」 → 'captcha'
 *     - 否則 'none'
 *
 * 計數語意（呼叫端遵守）：
 *   - 'captcha' 與 'unknown-dialog' 計入 consecutiveCaptchaRejects（IP 軟封鎖偵測；unknown 保守視同 captcha）。
 *   - 'form-incomplete' 不計入；另以「同站連續」計數，達 FORM_INCOMPLETE_BAILOUT_THRESHOLD 才中止。
 */

const REJECT_TYPES = Object.freeze({
    CAPTCHA: 'captcha',
    FORM_INCOMPLETE: 'form-incomplete',
    UNKNOWN_DIALOG: 'unknown-dialog',
    NONE: 'none',
});

// 同站連續 form-incomplete 達此次數就中止（exit 75，由 workflow 換 Chrome／WARP 身分重來）。
const FORM_INCOMPLETE_BAILOUT_THRESHOLD = 3;

/**
 * @param {{alertMsg?: string|null, bodyFlags?: {captchaWrong?: boolean, captchaEmpty?: boolean}}} input
 * @returns {'captcha'|'form-incomplete'|'unknown-dialog'|'none'}
 */
function classifySubmitReject({ alertMsg, bodyFlags } = {}) {
    const msg = typeof alertMsg === 'string' ? alertMsg.trim() : '';
    const bodyCaptcha = !!(bodyFlags && (bodyFlags.captchaWrong || bodyFlags.captchaEmpty));

    if (msg) {
        if (msg.startsWith('請選擇') || msg.startsWith('請輸入查詢號碼')) return REJECT_TYPES.FORM_INCOMPLETE;
        if (msg.includes('驗證')) return REJECT_TYPES.CAPTCHA;
        return bodyCaptcha ? REJECT_TYPES.CAPTCHA : REJECT_TYPES.UNKNOWN_DIALOG;
    }
    return bodyCaptcha ? REJECT_TYPES.CAPTCHA : REJECT_TYPES.NONE;
}

/** 是否計入 IP 軟封鎖（consecutiveCaptchaRejects）的連續拒絕計數。 */
function countsTowardSoftBlock(type) {
    return type === REJECT_TYPES.CAPTCHA || type === REJECT_TYPES.UNKNOWN_DIALOG;
}

/** log 用：單行、可 grep 統計三類比例（grep "Reject type="）。訊息中的換行折成空白。 */
function formatRejectLog(type, alertMsg, bodyFlags) {
    const msg = typeof alertMsg === 'string' && alertMsg.trim()
        ? alertMsg.replace(/\s+/g, ' ').trim()
        : '(none)';
    const body = [];
    if (bodyFlags && bodyFlags.captchaWrong) body.push('驗證數字輸入錯誤');
    if (bodyFlags && bodyFlags.captchaEmpty) body.push('請輸入驗證數字');
    return `[Fail] Reject type=${type} msg=${msg}` + (body.length ? ` body=${body.join('|')}` : '');
}

/**
 * 同站「表單問題」連續計數（送出前驗證不過、或送出被 chkForm 擋下 form-incomplete，兩者同根因：DWR 下拉狀態異常）。
 * add() 回傳是否已達上限（呼叫端據此 throw exit 75）。成功送出或遇到 captcha 類拒絕就 reset()
 * ——填表成功本身不重置（否則「填表 ok→被擋」交替出現時永遠到不了上限）。
 */
class FormProblemCounter {
    constructor(threshold = FORM_INCOMPLETE_BAILOUT_THRESHOLD) {
        this.threshold = threshold;
        this.count = 0;
        this.last = '';
    }

    add(detail) {
        this.count++;
        this.last = detail;
        return this.count >= this.threshold;
    }

    reset() {
        this.count = 0;
        this.last = '';
    }

    bailMessage(stationName) {
        return `同站（${stationName}）連續 ${this.count} 次表單問題（${this.last}）：MVDIS 頁面下拉狀態異常，交回 workflow 以新 Chrome／身分重來。`;
    }
}

module.exports = {
    FormProblemCounter,
    REJECT_TYPES,
    FORM_INCOMPLETE_BAILOUT_THRESHOLD,
    classifySubmitReject,
    countsTowardSoftBlock,
    formatRejectLog,
};
