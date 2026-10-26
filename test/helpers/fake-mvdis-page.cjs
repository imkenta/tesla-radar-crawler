'use strict';

/**
 * 測試用假 puppeteer page：以 jsdom 載入 MVDIS 選號表單節錄（test/fixtures/mvdis-pickno-form.html，
 * 內含真實的 inline onchange 屬性），並用計時器模擬頁面的 DWR 非同步串接
 * （getStation／getWindow／getWindowStatus／getPlateType／refreshFilterPlateType 與其 callback，
 * 邏輯對照 2026-10-26 抓取的 page.html）。可調延遲與「重複 callback」以重現晚間 MVDIS 變慢時的競態。
 *
 * 只實作 lib/mvdis-form.cjs 用到的 page API：waitForSelector／waitForFunction／select／evaluate。
 * select() 比照 puppeteer ElementHandle.select（node_modules/puppeteer-core）：單選時先全部取消選取，
 * 選符合的 option；找不到就不丟錯（靜默取消）；最後各 dispatch 一次 input 與 change。
 * 輪詢間隔採呼叫端給的 polling（預設 16ms 模擬 raf），不壓縮，避免遮蔽真實的競態窗口。
 *
 * window.__calls 計各個 onchange 入口被呼叫幾次（驗證每次選取只觸發一次 DWR）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'mvdis-pickno-form.html');

const STATIONS = [{ value: '10', text: '測試站' }, { value: '11', text: '另一站' }];
const PLATE_TYPE_HISTORY = [{ code: 'g', name: '自用小客車（電動）' }, { code: 'h', name: '租賃小客車（電動）' }];

function makeTimeoutError(msg) {
    const e = new Error(msg);
    e.name = 'TimeoutError';
    return e;
}

function removeOpts(sel) {
    for (let i = sel.options.length - 1; i >= 0; i--) {
        if (sel.options[i].value === '0') continue;
        sel.remove(i);
    }
}

function addOptions(doc, sel, items) {
    for (const it of items) {
        const o = doc.createElement('option');
        o.value = it.value;
        o.textContent = it.text;
        sel.appendChild(o);
    }
}

/**
 * @param {object} opts
 *  stationDelay/windowDelay/plateTypeDelay：各層 DWR 回應延遲(ms)
 *  stationDuplicates/windowDuplicates/plateTypeDuplicates：該層回應額外重複幾次（模擬重複 callback）
 *  duplicateGap：重複 callback 的間隔(ms)
 */
function createFakeMvdisPage(opts = {}) {
    const o = {
        stationDelay: 0, windowDelay: 0, plateTypeDelay: 0,
        stationDuplicates: 0, windowDuplicates: 0, plateTypeDuplicates: 0, duplicateGap: 120,
        ...opts,
    };
    const dom = new JSDOM(fs.readFileSync(FIXTURE, 'utf8'), { runScripts: 'dangerously' });
    const { window } = dom;
    const doc = window.document;
    let history = null; // historyStorage.get('plateTypeHistory')
    const timers = new Set();
    const later = (ms, fn) => {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        timers.add(t);
    };
    const burst = (delay, dups, fn) => { for (let i = 0; i <= dups; i++) later(delay + i * o.duplicateGap, fn); };
    const el = (id) => doc.getElementById(id);
    const calls = { getStation: 0, getWindow: 0, getWindowStatus: 0, getPlateType: 0, refreshFilterPlateType: 0 };
    window.__calls = calls;

    function refreshStation() {
        removeOpts(el('selStationCode')); removeOpts(el('selWindowNo')); removeOpts(el('selPlateType'));
        addOptions(doc, el('selStationCode'), STATIONS);
    }
    function refreshWindow() {
        removeOpts(el('selWindowNo')); removeOpts(el('selPlateType'));
        addOptions(doc, el('selWindowNo'), [{ value: '01', text: '第一窗口' }]);
    }
    function refreshFilterPlateType() {
        const plate = el('selPlateType');
        removeOpts(plate);
        if (el('selCarType').value && el('selEnergyType').value && history) {
            addOptions(doc, plate, history.map((h) => ({ value: h.code, text: h.name })));
        }
    }
    function refreshPlateType() {
        removeOpts(el('selPlateType'));
        removeOpts(el('selCarType'));
        removeOpts(el('selEnergyType'));
        addOptions(doc, el('selCarType'), [{ value: '', text: '請選擇' }, { value: 'C', text: '汽車' }, { value: 'M', text: '機車' }]);
        addOptions(doc, el('selEnergyType'), [{ value: '', text: '請選擇' }, { value: 'C', text: '非電能' }, { value: 'E', text: '純電能' }]);
        history = PLATE_TYPE_HISTORY;
        refreshFilterPlateType();
    }

    // 頁面 inline onchange 屬性呼叫的全域函式
    window.getStation = () => { calls.getStation++; burst(o.stationDelay, o.stationDuplicates, refreshStation); };
    window.getWindow = () => { calls.getWindow++; burst(o.windowDelay, o.windowDuplicates, refreshWindow); };
    window.getWindowStatus = () => { calls.getWindowStatus++; };
    window.getPlateType = () => { calls.getPlateType++; burst(o.plateTypeDelay, o.plateTypeDuplicates, refreshPlateType); };
    window.refreshFilterPlateType = () => { calls.refreshFilterPlateType++; refreshFilterPlateType(); };

    // 在 jsdom 全域環境下同步執行頁面函式（模擬 puppeteer 序列化後在頁面執行）
    function runInPage(fn, args) {
        const saved = {};
        const names = ['document', 'window', 'Event', 'MutationObserver'];
        for (const n of names) saved[n] = Object.getOwnPropertyDescriptor(globalThis, n);
        try {
            globalThis.document = doc;
            globalThis.window = window;
            globalThis.Event = window.Event;
            globalThis.MutationObserver = window.MutationObserver;
            return fn(...args);
        } finally {
            for (const n of names) {
                if (saved[n]) Object.defineProperty(globalThis, n, saved[n]);
                else delete globalThis[n];
            }
        }
    }
    const pollMs = (polling) => (typeof polling === 'number' ? polling : 16);

    const page = {
        dom,
        doc,
        calls,
        async evaluate(fn, ...args) { return runInPage(fn, args); },
        async waitForSelector(sel, { timeout = 30000 } = {}) {
            const start = Date.now();
            while (!doc.querySelector(sel)) {
                if (Date.now() - start > timeout) throw makeTimeoutError(`Waiting for selector \`${sel}\` failed`);
                await new Promise((r) => setTimeout(r, 16));
            }
        },
        async waitForFunction(fn, { timeout = 30000, polling } = {}, ...args) {
            const start = Date.now();
            for (;;) {
                if (runInPage(fn, args)) return;
                if (Date.now() - start > timeout) throw makeTimeoutError('Waiting failed: ' + timeout + 'ms exceeded');
                await new Promise((r) => setTimeout(r, pollMs(polling)));
            }
        },
        async select(sel, ...values) {
            const s = doc.querySelector(sel);
            if (!s) throw new Error(`No element matches ${sel}`);
            for (const opt of Array.from(s.options)) opt.selected = false;
            const picked = [];
            for (const opt of Array.from(s.options)) {
                if (values.includes(opt.value)) { opt.selected = true; picked.push(opt.value); break; }
            }
            s.dispatchEvent(new window.Event('input', { bubbles: true }));
            s.dispatchEvent(new window.Event('change', { bubbles: true }));
            return picked;
        },
        // ---- 測試輔助 ----
        value(id) { return el(id).value; },
        stop() { for (const t of timers) clearTimeout(t); timers.clear(); dom.window.close(); },
        wipeCarAndEnergy() { refreshPlateType(); }, // 模擬遲到的 refreshPlateType
        /** 直接把整張表單設成「已填好」（不經 DWR）。 */
        presetFilled() {
            refreshStation(); refreshWindow(); refreshPlateType();
            el('selDeptCode').value = '2'; el('selStationCode').value = '10'; el('selWindowNo').value = '01';
            el('selCarType').value = 'C'; el('selEnergyType').value = 'E'; refreshFilterPlateType(); el('selPlateType').value = 'g';
        },
        /**
         * 模擬 doReturnWithData 回到表單：站別／窗口／車牌別由 history 立刻還原，
         * 但 dept／車種／能源在 restoreDelay 之後才非同步還原（之前是空的）。
         */
        simulateQuickReturn({ restoreDelay = 800 } = {}) {
            page.presetFilled();
            el('selDeptCode').value = '0'; el('selCarType').value = ''; el('selEnergyType').value = '';
            later(restoreDelay, () => { el('selDeptCode').value = '2'; el('selCarType').value = 'C'; el('selEnergyType').value = 'E'; refreshFilterPlateType(); el('selPlateType').value = 'g'; });
        },
    };
    return page;
}

module.exports = { createFakeMvdisPage, FIXTURE };
