'use strict';

/**
 * MVDIS 選號表單填寫：逐層「等下一層被重建且安靜」→ 選取 → 驗證，以及送出前的表單完整性檢查。
 *
 * 為什麼存在（2026-10-26 晚間 MVDIS 變慢事故研究）：頁面的下拉是 DWR 非同步串接——
 *   dept   change → getStation()    → refreshStation()   重建 #selStationCode，清空 #selWindowNo/#selPlateType
 *   station change → getWindow()     → refreshWindow()    重建 #selWindowNo，清空 #selPlateType
 *   window change → getPlateType()  → refreshPlateType() 清空並重建 #selCarType/#selEnergyType，
 *                                                          #selPlateType 只留 value=0 的「請選擇」
 *   car/energy change → refreshFilterPlateType()（同步）依 historyStorage 與兩者當下值重填 #selPlateType
 * 舊版用固定 sleep 串 select；MVDIS 回應變慢時，DWR callback 晚到：
 *   - puppeteer 的 page.select 找不到 option 會「靜默取消選取」（不丟錯）；
 *   - 或下一層的重建 callback 晚到，把剛選好的值清掉。
 *
 * 2026-10-26 上線後修正（審查 H1/H2/M1）：
 *   - 「option 存在」不足以證明下一層已重建——原頁重填時舊 option 還在，select 讀回也通過，之後 callback 才回來洗掉。
 *     所以每一層都用 MutationObserver 偵測「下一層的 childList 真的被重建過、且安靜一段時間」再往下選。
 *   - 原頁重填從「第一個錯的欄位」往下補，不再每次從 dept 重來。
 *   - 不再手動補 dispatch change／呼叫 el.onchange()：puppeteer 的 page.select 本身就會 dispatch
 *     input+change（node_modules/puppeteer-core ElementHandle.select），頁面 inline onchange 會因此觸發；
 *     手動再來一次＝每次選取 3 個 DWR、3 個清空 callback。
 *   - quick 路徑（Return 回表單）頁面非同步還原欄位，先輪詢等還原完成再判不全。
 *   - 單次填表有總時間上限（FILL_BUDGET_MS），超過直接回 ok=false，避免一個 attempt 燒數分鐘。
 *
 * page.evaluate／waitForFunction 序列化的函式必須自足（不可參照閉包變數），所以集中在檔案前半段，
 * 也方便 test/mvdis-form.test.cjs 用 jsdom 直接餵 document 驗證。
 */

// 單一 option 等待上限。實測健康回應 <2s；尖峰慢速時 DWR 常見 3–8s，12s 沒出現視同本輪失敗。
const OPTION_WAIT_TIMEOUT_MS = 12000;
// 選完一層後等下一層被重建的上限。
const LAYER_REBUILD_TIMEOUT_MS = 12000;
const PLATE_TYPE_REBUILD_TIMEOUT_MS = LAYER_REBUILD_TIMEOUT_MS; // 舊名相容
// 重建後須連續這麼久沒有新的 DOM 變動才算穩定（吸收重複／遲到的 callback）。
const LAYER_QUIET_MS = 500;
const PLATE_TYPE_QUIET_MS = LAYER_QUIET_MS; // 舊名相容
// 同一頁原地重填的最大次數（仍不全才交回 Full Nav）。
const MAX_FILL_TRIES = 3;
// 單次 fillAndVerifyForm 的總時間上限（含所有重填）。
const FILL_BUDGET_MS = 40000;
// quick 模式：Return 回表單後等頁面非同步還原欄位的上限／輪詢間隔。
const QUICK_RESTORE_WAIT_MS = 4000;
const QUICK_RESTORE_POLL_MS = 250;

const STAGES = Object.freeze(['dept', 'station', 'window', 'type']);
const STAGE_OF_FIELD = Object.freeze({
    selDeptCode: 0, selStationCode: 1, selWindowNo: 2, selCarType: 3, selEnergyType: 3, selPlateType: 3, plateVer: 3,
});
// 需要觀察「被重建」的下拉：dept→station、station→window、window→car/energy
const LAYER_PROBE_IDS = Object.freeze(['selStationCode', 'selWindowNo', 'selCarType']);

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
const isNavigationRace = (e) => !!e && /Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(e.message || '');

/** 有總時間上限時，把單步逾時壓到「剩餘時間」以內（至少 500ms，讓步驟能乾淨失敗）。 */
function budgetedTimeout(base, deadline) {
    if (!deadline) return base;
    return Math.max(500, Math.min(base, deadline - Date.now()));
}

// ---------------------------------------------------------------------------
// 在頁面內執行的函式（自足，勿參照外部變數）
// ---------------------------------------------------------------------------

function optionExistsInPage(sel, val) {
    const el = document.querySelector(sel);
    if (!el) return false;
    return Array.from(el.options).some((o) => o.value === val);
}

function readValueInPage(sel) {
    const el = document.querySelector(sel);
    return el ? el.value : null;
}

/** 安裝（一次）各層的 childList 觀察器；回傳是否全部都在觀察。 */
function installLayerProbesInPage(ids) {
    const probes = window.__mvdisLayerProbes || (window.__mvdisLayerProbes = {});
    let all = true;
    for (const id of ids) {
        if (!probes[id]) {
            const p = { count: 0, last: 0, observing: false };
            probes[id] = p;
            const el = document.getElementById(id);
            if (el && typeof MutationObserver !== 'undefined') {
                new MutationObserver(() => {
                    p.count++;
                    p.last = Date.now();
                }).observe(el, { childList: true });
                p.observing = true;
            }
        }
        if (!probes[id].observing) all = false;
    }
    return all;
}

function resetLayerProbeInPage(id) {
    const p = window.__mvdisLayerProbes && window.__mvdisLayerProbes[id];
    if (p) {
        p.count = 0;
        p.last = 0;
    }
}

/** requireChange：必須至少被重建過一次（選完上一層之後）；否則只要求「目前安靜」。 */
function layerSettledInPage(id, quietMs, requireChange) {
    const p = window.__mvdisLayerProbes && window.__mvdisLayerProbes[id];
    if (!p) return false;
    if (requireChange && p.count === 0) return false;
    return Date.now() - p.last >= quietMs;
}

function clickPlateVerInPage() {
    const radios = document.getElementsByName('plateVer');
    if (radios.length > 0) (Array.from(radios).find((r) => r.value === '2') || radios[0]).click();
}

/**
 * 比照頁面 chkForm() 的欄位規則檢查整張表單；回傳 {missing, values}，missing 空陣列＝可送出。
 * 規則：
 *   - station、window、plateType（資料正確性所繫）：必須等於預期值（expected 缺該鍵則退為「合法」）。
 *   - dept、car、energy：只要求「合法」（非空、非 '0'）——chkForm 也只擋這些；站別與車牌別對了，
 *     它們就由頁面自己的串接保證一致，不必再要求等於預期。
 *   - plateVer：必須有勾選且 value 非空。
 * doc 預設為頁面 document（測試時傳 jsdom document）。
 */
function inspectFormDetailInDoc(expected, doc) {
    const d = doc || document;
    const rules = [
        ['selDeptCode', 'deptId', false],
        ['selStationCode', 'stationId', true],
        ['selWindowNo', 'windowNo', true],
        ['selCarType', 'carType', false],
        ['selEnergyType', 'energyType', false],
        ['selPlateType', 'plateType', true],
    ];
    const want = expected || {};
    const missing = [];
    const values = {};
    for (const [id, key, strict] of rules) {
        const el = d.getElementById(id);
        const val = el ? el.value : null;
        values[id] = val;
        const exp = want[key];
        const hasExp = exp !== undefined && exp !== null && exp !== '';
        if (strict && hasExp) {
            if (val !== String(exp)) missing.push(id);
        } else if (val === null || val === '' || val === '0') {
            missing.push(id);
        }
    }
    const radios = Array.from(d.getElementsByName('plateVer'));
    const checked = radios.find((r) => r.checked);
    values.plateVer = checked ? checked.value : null;
    if (!checked || !checked.value) missing.push('plateVer');
    return { missing, values };
}

/** 只回缺哪些欄位的簡版（相容舊呼叫端與測試）。 */
function inspectFormInDoc(expected, doc) {
    return inspectFormDetailInDoc(expected, doc).missing;
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
 * 等目標 option 出現 → 選取（page.select 自帶 input+change，頁面 inline onchange 因此只觸發一次）→ 驗證確實選到。
 * 失敗丟 FormFieldError（呼叫端決定重填或 Full Nav）。成功回傳 true。
 * 注意：option 存在只代表「有這個選項」，不代表上一層的重建已經結束——需要的話呼叫端須先 waitForLayerSettled。
 */
async function selectWithEvent(page, selector, value, opts = {}) {
    const timeout = budgetedTimeout(opts.optionTimeout ?? OPTION_WAIT_TIMEOUT_MS, opts.deadline);
    try {
        await page.waitForSelector(selector, { timeout });
    } catch (e) {
        if (isTimeoutError(e)) throw new FormFieldError('selector-timeout', selector, value, `${timeout}ms 內元素未出現`);
        throw e;
    }
    await waitForOption(page, selector, value, timeout);
    await page.select(selector, value);
    const actual = await page.evaluate(readValueInPage, selector);
    if (actual !== value) {
        throw new FormFieldError('not-selected', selector, value, `選取後實際值為 ${JSON.stringify(actual)}`);
    }
    return true;
}

/**
 * 等某一層（下拉 id）被 DWR 重建並安靜 quietMs。回傳是否確認（false＝逾時，呼叫端記 log 後照走，
 * 由後續 option 等待與送出前驗證把關）。須先 installLayerProbes；選上一層之前先 resetLayerProbe。
 */
async function waitForLayerSettled(page, id, opts = {}) {
    const timeout = budgetedTimeout(opts.rebuildTimeout ?? LAYER_REBUILD_TIMEOUT_MS, opts.deadline);
    const quietMs = opts.quietMs ?? LAYER_QUIET_MS;
    const requireChange = opts.requireChange !== false;
    try {
        await page.waitForFunction(layerSettledInPage, { timeout, polling: 150 }, id, quietMs, requireChange);
        return true;
    } catch (e) {
        if (isTimeoutError(e)) return false;
        throw e;
    }
}

/**
 * 填表：dept → station → window → car → energy → plateType → plateVer。
 * 每選完 dept／station／window，先等下一層（station／window／car 與 energy）真的被重建且安靜，再選下一個。
 * params: {deptId, stationId, pType, windowNo='01', carType='C', energyType='E'}
 * opts: {from='dept'|'station'|'window'|'type'（從哪一層開始補）, sleep, log, optionTimeout, rebuildTimeout, quietMs, deadline}
 */
async function fillForm(page, params, opts = {}) {
    const sleep = opts.sleep || defaultSleep;
    const log = opts.log || (() => {});
    const from = Math.max(0, STAGES.indexOf(opts.from || 'dept'));
    const windowNo = params.windowNo || '01';

    const observing = await page.evaluate(installLayerProbesInPage, LAYER_PROBE_IDS);
    const settle = async (id, requireChange) => {
        if (!observing) { await sleep(1500); return; } // 無法偵測重建（極不可能）→ 退回保守固定等待
        const ok = await waitForLayerSettled(page, id, { ...opts, requireChange });
        if (!ok) log(`    [Form] 等待 ${id} 被重建逾時，照常往下填（option 等待與送出前驗證把關）。`);
    };
    const choose = async (id, value, probeId) => {
        if (probeId) await page.evaluate(resetLayerProbeInPage, probeId);
        await selectWithEvent(page, id, value, opts);
    };

    if (from <= 0) {
        await choose('#selDeptCode', String(params.deptId), 'selStationCode');
        await settle('selStationCode', true);
    }
    if (from <= 1) {
        await choose('#selStationCode', String(params.stationId), 'selWindowNo');
        await settle('selWindowNo', true);
    }
    if (from <= 2) {
        await choose('#selWindowNo', windowNo, 'selCarType');
        await settle('selCarType', true);
    } else {
        await settle('selCarType', false); // 只補車種以下：確認沒有進行中的重建
    }

    await choose('#selCarType', params.carType || 'C');
    await choose('#selEnergyType', params.energyType || 'E');
    await choose('#selPlateType', String(params.pType));
    await page.evaluate(clickPlateVerInPage);
}

/** Quick Re-query 路徑：只重選車牌別（選項需已存在）。 */
async function quickFillPlateType(page, params, opts = {}) {
    await selectWithEvent(page, '#selPlateType', String(params.pType), opts);
}

function expectedOf(params) {
    return {
        deptId: params.deptId,
        stationId: params.stationId,
        windowNo: params.windowNo || '01',
        carType: params.carType || 'C',
        energyType: params.energyType || 'E',
        plateType: params.pType,
    };
}

async function inspectFormDetail(page, params) {
    return page.evaluate(inspectFormDetailInDoc, expectedOf(params));
}

async function inspectForm(page, params) {
    return (await inspectFormDetail(page, params)).missing;
}

const normalizeInspect = (r) => (Array.isArray(r) ? { missing: r, values: null } : { missing: r.missing, values: r.values || null });
const stageOfMissing = (missing) => Math.min(3, ...missing.map((f) => (f in STAGE_OF_FIELD ? STAGE_OF_FIELD[f] : 0)));
const fmtValues = (v) => (v ? ' 實際值 ' + JSON.stringify(v) : '');

/**
 * quick 模式：Return 回表單後頁面會非同步還原欄位（甚至導航尚未完成）。輪詢檢查直到
 * 「只剩車牌別需要補」或通過，或逾時。導航競態（Execution context was destroyed）視為還沒好，繼續輪詢。
 */
async function waitForQuickRestore(page, params, opts) {
    const sleep = opts.sleep || defaultSleep;
    const inspect = opts.inspect || inspectFormDetail;
    const waitMs = opts.quickRestoreMs ?? QUICK_RESTORE_WAIT_MS;
    const pollMs = opts.quickRestorePollMs ?? QUICK_RESTORE_POLL_MS;
    const until = Date.now() + waitMs;
    let last = { missing: ['selDeptCode'], values: null };
    for (;;) {
        try {
            last = normalizeInspect(await inspect(page, params));
        } catch (e) {
            if (!isNavigationRace(e)) throw e;
        }
        const onlyPlate = last.missing.length === 1 && last.missing[0] === 'selPlateType';
        if (last.missing.length === 0 || onlyPlate) return last;
        if (Date.now() >= until) return last;
        await sleep(pollMs);
    }
}

/**
 * 填表＋送出前驗證，不全就在原頁補，最多 maxTries 次，且總時間不超過 budgetMs（預設 FILL_BUDGET_MS）。
 * - 第一次從 dept 完整填；之後從「第一個錯的欄位」往下補，最後一次保底從 dept 完整重填。
 * - opts.mode === 'quick'：先等頁面還原（waitForQuickRestore）；已通過就不動作；只缺車牌別就只重選它；
 *   其餘缺漏才從第一個錯的欄位補。
 * 回傳 {ok, tries, missing, values, lastError, budgetExceeded}；FormFieldError 被吞下並計一次嘗試，其他錯誤上拋。
 * opts.fill / quickFill / inspect 可注入（測試用）；inspect 可回陣列或 {missing, values}。
 */
async function fillAndVerifyForm(page, params, opts = {}) {
    const maxTries = opts.maxTries ?? MAX_FILL_TRIES;
    const log = opts.log || (() => {});
    const fill = opts.fill || fillForm;
    const quickFill = opts.quickFill || quickFillPlateType;
    const inspect = opts.inspect || inspectFormDetail;
    const deadline = Date.now() + (opts.budgetMs ?? FILL_BUDGET_MS);
    const o = { ...opts, deadline };
    const insp = async () => normalizeInspect(await inspect(page, params));

    let missing = [];
    let values = null;
    let lastError = null;
    let plan = { kind: 'fill', from: 'dept' };

    if (opts.mode === 'quick') {
        const r = await waitForQuickRestore(page, params, opts);
        missing = r.missing;
        values = r.values;
        if (missing.length === 0) return { ok: true, tries: 1, missing: [], values, lastError: null, budgetExceeded: false };
        if (missing.length === 1 && missing[0] === 'selPlateType') plan = { kind: 'quick' };
        else {
            plan = { kind: 'fill', from: STAGES[stageOfMissing(missing)] };
            log(`    [Form] Quick 還原後仍不全：缺 ${missing.join(',')}${fmtValues(values)}，從 ${plan.from} 往下補。`);
        }
    }

    for (let tryNo = 1; tryNo <= maxTries; tryNo++) {
        if (Date.now() >= deadline) {
            log(`    [Form] 填表總時間超過上限（${opts.budgetMs ?? FILL_BUDGET_MS}ms），放棄本 attempt。`);
            return { ok: false, tries: tryNo - 1, missing, values, lastError, budgetExceeded: true };
        }
        try {
            if (plan.kind === 'quick') await quickFill(page, params, o);
            else await fill(page, params, { ...o, from: plan.from });
            lastError = null;
        } catch (e) {
            if (!(e instanceof FormFieldError)) throw e;
            lastError = e;
            log(`    [Form] 填表失敗 ${tryNo}/${maxTries}：${e.message}`);
        }
        const r = await insp();
        missing = r.missing;
        values = r.values;
        if (missing.length === 0) return { ok: true, tries: tryNo, missing: [], values, lastError: null, budgetExceeded: false };
        // 最後一次保底從 dept 完整重填；其餘從第一個錯的欄位往下補
        plan = { kind: 'fill', from: tryNo + 1 >= maxTries ? 'dept' : STAGES[stageOfMissing(missing)] };
        log(`    [Form] 送出前驗證未過 ${tryNo}/${maxTries}：缺 ${missing.join(',')}${fmtValues(values)}` + (tryNo < maxTries ? `，原頁從 ${plan.from} 重填...` : '。'));
    }
    return { ok: false, tries: maxTries, missing, values, lastError, budgetExceeded: false };
}

module.exports = {
    OPTION_WAIT_TIMEOUT_MS,
    LAYER_REBUILD_TIMEOUT_MS,
    PLATE_TYPE_REBUILD_TIMEOUT_MS,
    LAYER_QUIET_MS,
    PLATE_TYPE_QUIET_MS,
    MAX_FILL_TRIES,
    FILL_BUDGET_MS,
    QUICK_RESTORE_WAIT_MS,
    STAGES,
    FormFieldError,
    inspectFormInDoc,
    inspectFormDetailInDoc,
    installLayerProbesInPage,
    waitForOption,
    selectWithEvent,
    waitForLayerSettled,
    fillForm,
    quickFillPlateType,
    inspectForm,
    inspectFormDetail,
    fillAndVerifyForm,
};
