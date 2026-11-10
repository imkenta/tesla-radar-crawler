'use strict';

// 2026-11-10 健檢 🟡4：doSubmit 的後備分支原本在 Node 端寫 `typeof window.doSubmit`，
// Node 沒有 window → ReferenceError。這裡用 jsdom 當「瀏覽器端」：page.evaluate(fn) 會把 fn 丟進
// jsdom window 執行，而測試行程本身（Node 端）刻意沒有 window，與真實環境一致。

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { submitMvdisForm } = require('../lib/mvdis-form.cjs');

function makePage(html, { visibleButtons = false, onDoSubmit } = {}) {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const { window } = dom;
    window.Element.prototype.scrollIntoView = () => {};
    if (visibleButtons) {
        window.Element.prototype.getBoundingClientRect = () => ({ width: 40, height: 20, left: 100, top: 200 });
    }
    if (onDoSubmit) window.doSubmit = onDoSubmit;
    const mouse = { moves: [], clicks: [] };
    return {
        mouse: {
            move: async (x, y) => { mouse.moves.push([x, y]); },
            click: async (x, y) => { mouse.clicks.push([x, y]); },
        },
        // 模擬 puppeteer：函式序列化後在「瀏覽器端」執行
        evaluate: async (fn) => window.eval(`(${fn.toString()})()`),
        record: mouse,
    };
}

const noSleep = async () => {};

test('前提：測試行程的 Node 端沒有 window（與真實環境一致）', () => {
    assert.equal(typeof window, 'undefined');
});

test('找不到確認按鈕、頁面有全域 doSubmit → 走 page.evaluate 後備（不再丟 ReferenceError）', async () => {
    let called = 0;
    const page = makePage('<body><p>no buttons</p></body>', { onDoSubmit: () => { called++; } });
    const result = await submitMvdisForm(page, noSleep);
    assert.equal(result, 'CALLED_SCRIPT_FALLBACK');
    assert.equal(called, 1);
    assert.equal(page.record.clicks.length, 0);
});

test('找不到按鈕、頁面也沒有 doSubmit → NOT_FOUND（不丟例外）', async () => {
    const page = makePage('<body><p>no buttons</p></body>');
    assert.equal(await submitMvdisForm(page, noSleep), 'NOT_FOUND');
});

test('doSubmit 不是函式（例如被覆寫成字串）→ 視為不存在', async () => {
    const page = makePage('<body></body>', { onDoSubmit: 'oops' });
    assert.equal(await submitMvdisForm(page, noSleep), 'NOT_FOUND');
});

test('找得到可見的確認按鈕 → 實體滑鼠點擊其中心，不呼叫後備', async () => {
    let called = 0;
    const page = makePage('<body><a onclick="doSubmit()">確定</a></body>', { visibleButtons: true, onDoSubmit: () => { called++; } });
    const result = await submitMvdisForm(page, noSleep);
    assert.equal(result, 'PHYSICAL_CLICK_A');
    assert.deepEqual(page.record.clicks, [[120, 210]]);
    assert.equal(called, 0);
});

test('按鈕存在但不可見（寬高為 0）→ 視為找不到，改走後備', async () => {
    let called = 0;
    const page = makePage('<body><a onclick="doSubmit()">確定</a></body>', { visibleButtons: false, onDoSubmit: () => { called++; } });
    assert.equal(await submitMvdisForm(page, noSleep), 'CALLED_SCRIPT_FALLBACK');
    assert.equal(called, 1);
});

test('doSubmit() 同步導航導致 evaluate 以「Execution context was destroyed」拒絕 → 視為已送出', async () => {
    const page = makePage('<body></body>', { onDoSubmit: () => { throw new Error('Execution context was destroyed, most likely because of a navigation.'); } });
    assert.equal(await submitMvdisForm(page, noSleep), 'CALLED_SCRIPT_FALLBACK');
});

test('doSubmit() 丟其他錯誤 → 照常拋出，不被吞掉', async () => {
    const page = makePage('<body></body>', { onDoSubmit: () => { throw new Error('Protocol error: Target closed'); } });
    await assert.rejects(() => submitMvdisForm(page, noSleep), /Target closed/);
});
