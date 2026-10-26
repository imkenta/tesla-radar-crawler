'use strict';

/**
 * 測試用假 puppeteer page：以 jsdom 載入 MVDIS 選號表單節錄（test/fixtures/mvdis-pickno-form.html），
 * 並用計時器模擬頁面的 DWR 非同步串接（refreshStation／refreshWindow／refreshPlateType／refreshFilterPlateType，
 * 邏輯對照 2026-10-26 抓取的 page.html）。可調延遲與「重複 callback」以重現晚間 MVDIS 變慢時的競態。
 *
 * 只實作 lib/mvdis-form.cjs 用到的 page API：waitForSelector／waitForFunction／select／evaluate。
 * select() 刻意比照 puppeteer：找不到 option 時不丟錯、結果是「沒有任何選取」（靜默取消）。
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
 * @param {{stationDelay?:number, windowDelay?:number, plateTypeDelay?:number, plateTypeDuplicates?:number, duplicateGap?:number}} opts
 *   plateTypeDuplicates：refreshPlateType 額外重複觸發次數（模擬 change 事件被重複觸發 → DWR 重複 callback）
 */
function createFakeMvdisPage(opts = {}) {
    const o = {
        stationDelay: 0, windowDelay: 0, plateTypeDelay: 0, plateTypeDuplicates: 0, duplicateGap: 120,
        ...opts,
    };
    const dom = new JSDOM(fs.readFileSync(FIXTURE, 'utf8'));
    const { window } = dom;
    const doc = window.document;
    let history = null; // historyStorage.get('plateTypeHistory')
    const timers = new Set();
    const later = (ms, fn) => {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        timers.add(t);
    };

    const el = (id) => doc.getElementById(id);

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

    el('selDeptCode').addEventListener('change', () => {
        later(o.stationDelay, () => {
            removeOpts(el('selStationCode')); removeOpts(el('selWindowNo')); removeOpts(el('selPlateType'));
            addOptions(doc, el('selStationCode'), STATIONS);
        });
    });
    el('selStationCode').addEventListener('change', () => {
        later(o.windowDelay, () => {
            removeOpts(el('selWindowNo')); removeOpts(el('selPlateType'));
            addOptions(doc, el('selWindowNo'), [{ value: '01', text: '第一窗口' }]);
        });
    });
    el('selWindowNo').addEventListener('change', () => {
        for (let i = 0; i <= o.plateTypeDuplicates; i++) later(o.plateTypeDelay + i * o.duplicateGap, refreshPlateType);
    });
    el('selCarType').addEventListener('change', refreshFilterPlateType);
    el('selEnergyType').addEventListener('change', refreshFilterPlateType);

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

    const page = {
        dom,
        doc,
        async evaluate(fn, ...args) { return runInPage(fn, args); },
        async waitForSelector(sel, { timeout = 30000 } = {}) {
            const start = Date.now();
            while (!doc.querySelector(sel)) {
                if (Date.now() - start > timeout) throw makeTimeoutError(`Waiting for selector \`${sel}\` failed`);
                await new Promise((r) => setTimeout(r, 20));
            }
        },
        async waitForFunction(fn, { timeout = 30000, polling = 100 } = {}, ...args) {
            const start = Date.now();
            for (;;) {
                if (runInPage(fn, args)) return;
                if (Date.now() - start > timeout) throw makeTimeoutError('Waiting failed: ' + timeout + 'ms exceeded');
                await new Promise((r) => setTimeout(r, Math.min(typeof polling === 'number' ? polling : 20, 20)));
            }
        },
        // 比照 puppeteer：先全部取消選取，再選符合 value 的 option；找不到就維持「沒有選取」，且不丟錯。
        async select(sel, ...values) {
            const s = doc.querySelector(sel);
            if (!s) throw new Error(`No element matches ${sel}`);
            for (const opt of Array.from(s.options)) opt.selected = false;
            const picked = [];
            for (const v of values) {
                const opt = Array.from(s.options).find((x) => x.value === v);
                if (opt) { opt.selected = true; picked.push(opt.value); }
            }
            s.dispatchEvent(new window.Event('input', { bubbles: true }));
            s.dispatchEvent(new window.Event('change', { bubbles: true }));
            return picked;
        },
        // 測試輔助
        value(id) { return el(id).value; },
        stop() { for (const t of timers) clearTimeout(t); timers.clear(); dom.window.close(); },
        wipeCarAndEnergy() { refreshPlateType(); }, // 模擬遲到的 refreshPlateType
    };
    return page;
}

module.exports = { createFakeMvdisPage, FIXTURE };
