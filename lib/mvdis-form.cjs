'use strict';

/**
 * MVDIS 選號表單填寫：等選項出現 → 選取 → 驗證，以及送出前的表單完整性檢查。
 *
 * 為什麼存在（2026-10-26 晚間 MVDIS 變慢事故研究）：頁面的下拉是 DWR 非同步串接——
 *   dept   change → getStation()    → refreshStation()   重建 #selStationCode/#selWindowNo/#selPlateType
 *   station change → getWindow()     → refreshWindow()    重建 #selWindowNo/#selPlateType
 *   window change → getPlateType()  → refreshPlateType() 清空並重建 #selCarType/#selEnergyType，
 *                                                          #selPlateType 只留 value=0 的「請選擇」
 *   car/energy change → refreshFilterPlateType()（同步）依 historyStorage 與兩者當下值重填 #selPlateType
 * 舊版用固定 sleep 串 select；MVDIS 回應變慢時，DWR callback 晚到：
 *   - puppeteer 的 page.select 找不到 option 會「靜默取消選取」（不丟錯）；
 *   - 或 refreshPlateType 晚到，把剛選好的車種／能源清掉。
 * 結果送出時 chkForm() alert('請選擇…') 並 return false。
 *
 * 本模組的做法：每一步先等目標 option 出現再選、選完驗證確實選到；window 之後用 MutationObserver 偵測
 * #selCarType 被 refreshPlateType 重建並等「安靜期」（排除重複 callback）；送 AI 辨識之前再驗證整張表單。
 *
 * page.evaluate／waitForFunction 序列化的函式必須自足（不可參照閉包變數），所以集中在檔案前半段，
 * 也方便 test/mvdis-form.test.cjs 用 jsdom 直接餵 document 驗證。
 */

// 單一 option 等待上限。實測健康回應 <2s；尖峰慢速時 DWR 常見 3–8s，12s 沒出現視同本輪失敗。
const OPTION_WAIT_TIMEOUT_MS = 12000;
// window 選完後等 refreshPlateType 重建 car/energy 的上限。
const PLATE_TYPE_REBUILD_TIMEOUT_MS = 12000;
// 重建後須連續這麼久沒有新的 DOM 變動才算穩定（吸收 change 事件重複觸發造成的重複 callback）。
const PLATE_TYPE_QUIET_MS = 600;
// dept／station 之後的最短喘息（等重複 callback 落地）；真正的等待靠 option 出現。
const STAGE_SETTLE_MS = 300;
// 同一頁原地重填的最大次數（仍不全才交回 Full Nav）。
const MAX_FILL_TRIES = 3;

class FormFieldError extends Error {
    /**
     * @param {'option-timeout'|'selector-timeout'|'not-selected'} code
     */
    constructor(code, selector, value, detail) {
        super(`表單欄位 ${selector}=${value} 失敗（${code}）${detail ? '：' + detail : ''}`);
        this.name = 'FormFieldError';
        this.code = code;
        this.selector = selector;
        this.value = value;
    }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTimeoutError = (e) => !!e && e.name === 'TimeoutError';

// ---------------------------------------------------------------------------
// 在頁面內執行的函式（自足，勿參照外部變數）
// ---------------------------------------------------------------------------

function optionExistsInPage(sel, val) {
    const el = document.querySelector(sel);
    if (!el) return false;
    return Array.from(el.options).some((o) => o.value === val);
}

function dispatchChangeInPage(sel) {
    const el = document.querySelector(sel);
    if (el) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (el.onchange) el.onchange();
    }
}

function readValueInPage(sel) {
    const el = document.querySelector(sel);
    return el ? el.value : null;
}

/** 安裝（一次）並歸零 #selCarType 重建偵測；回傳是否真的在觀察。 */
function installPlateTypeProbeInPage() {
    const car = document.querySelector('#selCarType');
    if (!window.__mvdisPlateTypeProbe) {
        const probe = { count: 0, last: 0, observing: false };
        window.__mvdisPlateTypeProbe = probe;
        if (car && typeof MutationObserver !== 'undefined') {
            new MutationObserver(() => {
                probe.count++;
                probe.last = Date.now();
            }).observe(car, { childList: true });
            probe.observing = true;
        }
    }
    const p = window.__mvdisPlateTypeProbe;
    p.count = 0;
    p.last = 0;
    return p.observing;
}

function plateTypeSettledInPage(quietMs) {
    const p = window.__mvdisPlateTypeProbe;
    return !!p && p.count > 0 && Date.now() - p.last >= quietMs;
}

function clickPlateVerInPage() {
    const radios = document.getElementsByName('plateVer');
    if (radios.length > 0) (Array.from(radios).find((r) => r.value === '2') || radios[0]).click();
}

/**
 * 比照頁面 chkForm() 的欄位規則（再加嚴為「等於預期值」），回傳有問題的欄位名清單；空陣列＝可送出。
 * expected 缺某鍵時退為「非空且非 '0'」。doc 預設為頁面 document（測試時傳 jsdom document）。
 */
function inspectFormInDoc(expected, doc) {
    const d = doc || document;
    const fields = [
        ['selDeptCode', 'deptId'],
        ['selStationCode', 'stationId'],
        ['selWindowNo', 'windowNo'],
        ['selCarType', 'carType'],
        ['selEnergyType', 'energyType'],
        ['selPlateType', 'plateType'],
    ];
    const want = expected || {};
    const missing = [];
    for (const [id, key] of fields) {
        const el = d.getElementById(id);
        const val = el ? el.value : null;
        const exp = want[key];
        if (exp !== undefined && exp !== null && exp !== '') {
            if (val !== String(exp)) missing.push(id);
        } else if (val === null || val === '' || val === '0') {
            missing.push(id);
        }
    }
    const radios = Array.from(d.getElementsByName('plateVer'));
    const checked = radios.find((r) => r.checked);
    if (!checked || !checked.value) missing.push('plateVer');
    return missing;
}

// ---------------------------------------------------------------------------
// Node 端
// ---------------------------------------------------------------------------

async function waitForOption(page, selector, value, timeout = OPTION_WAIT_TIMEOUT_MS) {
    try {
        await page.waitForFunction(optionExistsInPage, { timeout, polling: 200 }, selector, value);
    } catch (e) {
        if (isTimeoutError(e)) throw new FormFieldError('option-timeout', selector, value, `${timeout}ms 內選項未出現`);
        throw e;
    }
}

/**
 * 等目標 option 出現 → 選取 → 觸發 change → 驗證確實選到。失敗丟 FormFieldError（呼叫端決定重填或 Full Nav）。
 * 成功回傳 true。
 */
async function selectWithEvent(page, selector, value, opts = {}) {
    const timeout = opts.optionTimeout ?? OPTION_WAIT_TIMEOUT_MS;
    try {
        await page.waitForSelector(selector, { timeout });
    } catch (e) {
        if (isTimeoutError(e)) throw new FormFieldError('selector-timeout', selector, value, `${timeout}ms 內元素未出現`);
        throw e;
    }
    await waitForOption(page, selector, value, timeout);
    await page.select(selector, value);
    await page.evaluate(dispatchChangeInPage, selector);
    const actual = await page.evaluate(readValueInPage, selector);
    if (actual !== value) {
        throw new FormFieldError('not-selected', selector, value, `選取後實際值為 ${JSON.stringify(actual)}`);
    }
    return true;
}

/**
 * window 選取後等 refreshPlateType 重建 car/energy 並安靜下來。回傳是否確認重建完成
 * （false＝逾時，呼叫端記 log 後照走，由送出前驗證把關）。須先呼叫 installPlateTypeProbe。
 */
async function waitForPlateTypeSettled(page, opts = {}) {
    const timeout = opts.timeout ?? PLATE_TYPE_REBUILD_TIMEOUT_MS;
    const quietMs = opts.quietMs ?? PLATE_TYPE_QUIET_MS;
    try {
        await page.waitForFunction(plateTypeSettledInPage, { timeout, polling: 150 }, quietMs);
        return true;
    } catch (e) {
        if (isTimeoutError(e)) return false;
        throw e;
    }
}

/**
 * 完整填表：dept → station → window → (等 refreshPlateType 穩定) → car → energy → plateType → plateVer。
 * params: {deptId, stationId, pType, windowNo='01', carType='C', energyType='E'}
 * opts: {sleep, log, optionTimeout, settleMs, rebuildTimeout, quietMs}
 */
async function fillForm(page, params, opts = {}) {
    const sleep = opts.sleep || defaultSleep;
    const log = opts.log || (() => {});
    const settleMs = opts.settleMs ?? STAGE_SETTLE_MS;
    const sel = { optionTimeout: opts.optionTimeout };
    const windowNo = params.windowNo || '01';

    await selectWithEvent(page, '#selDeptCode', String(params.deptId), sel);
    await sleep(settleMs);
    await selectWithEvent(page, '#selStationCode', String(params.stationId), sel);
    await sleep(settleMs);

    const observing = await page.evaluate(installPlateTypeProbeInPage);
    await selectWithEvent(page, '#selWindowNo', windowNo, sel);
    if (observing) {
        const settled = await waitForPlateTypeSettled(page, { timeout: opts.rebuildTimeout, quietMs: opts.quietMs });
        if (!settled) log('    [Form] 等待車種/能源選項重建逾時，照常往下填（送出前驗證把關）。');
    } else {
        await sleep(1500); // 無法偵測重建（極不可能）→ 退回保守固定等待
    }

    await selectWithEvent(page, '#selCarType', params.carType || 'C', sel);
    await selectWithEvent(page, '#selEnergyType', params.energyType || 'E', sel);
    await selectWithEvent(page, '#selPlateType', String(params.pType), sel);
    await page.evaluate(clickPlateVerInPage);
}

/** Quick Re-query 路徑：只重選車牌別（選項需已存在）。 */
async function quickFillPlateType(page, params, opts = {}) {
    await selectWithEvent(page, '#selPlateType', String(params.pType), { optionTimeout: opts.optionTimeout });
}

async function inspectForm(page, params) {
    const expected = {
        deptId: params.deptId,
        stationId: params.stationId,
        windowNo: params.windowNo || '01',
        carType: params.carType || 'C',
        energyType: params.energyType || 'E',
        plateType: params.pType,
    };
    return page.evaluate(inspectFormInDoc, expected);
}

/**
 * 填表＋送出前驗證，不全就在原頁重填，最多 maxTries 次。
 * opts.mode === 'quick'：第一次只重選車牌別（Quick Re-query），不全才退成完整重填。
 * 回傳 {ok, tries, missing, lastError}；FormFieldError 被吞下並計一次嘗試，其他錯誤（頁面已死等）照常上拋。
 * opts.fill / quickFill / inspect 可注入（測試用）。
 */
async function fillAndVerifyForm(page, params, opts = {}) {
    const maxTries = opts.maxTries ?? MAX_FILL_TRIES;
    const log = opts.log || (() => {});
    const fill = opts.fill || fillForm;
    const quickFill = opts.quickFill || quickFillPlateType;
    const inspect = opts.inspect || inspectForm;

    let missing = [];
    let lastError = null;
    for (let tryNo = 1; tryNo <= maxTries; tryNo++) {
        try {
            if (tryNo === 1 && opts.mode === 'quick') await quickFill(page, params, opts);
            else await fill(page, params, opts);
            lastError = null;
        } catch (e) {
            if (!(e instanceof FormFieldError)) throw e;
            lastError = e;
            log(`    [Form] 填表失敗 ${tryNo}/${maxTries}：${e.message}`);
        }
        missing = await inspect(page, params);
        if (missing.length === 0) return { ok: true, tries: tryNo, missing: [], lastError: null };
        log(`    [Form] 送出前驗證未過 ${tryNo}/${maxTries}：缺 ${missing.join(',')}` + (tryNo < maxTries ? '，原頁重填...' : '。'));
    }
    return { ok: false, tries: maxTries, missing, lastError };
}

module.exports = {
    OPTION_WAIT_TIMEOUT_MS,
    PLATE_TYPE_REBUILD_TIMEOUT_MS,
    PLATE_TYPE_QUIET_MS,
    STAGE_SETTLE_MS,
    MAX_FILL_TRIES,
    FormFieldError,
    inspectFormInDoc,
    installPlateTypeProbeInPage,
    waitForOption,
    selectWithEvent,
    waitForPlateTypeSettled,
    fillForm,
    quickFillPlateType,
    inspectForm,
    fillAndVerifyForm,
};
