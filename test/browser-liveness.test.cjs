/**
 * lib/browser-liveness.cjs 回歸測試（2026-10-19 "Attempted to use detached Frame" 事故）。
 *
 * 根因：wrapper 的 `timeout --signal=TERM --kill-after=15s` 在 lane 牆鐘到期時送 SIGTERM，
 * puppeteer 預設的 handleSIGTERM 只關 Chrome、node 繼續跑最多 15 秒，page 的 main frame 被
 * dispose 成殭屍，Nav 重試三次拿同一個死 frame。全 mock，不開真 Chrome。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    isPageUsable,
    assertPageUsable,
    createDeadPageError,
    createDeadlineShutdown,
} = require('../lib/browser-liveness.cjs');

function fakePage({ closed = false, connected = true, frameDetached = false, mainFrameThrows = false } = {}) {
    return {
        isClosed: () => closed,
        browser: () => ({ connected }),
        mainFrame: () => {
            if (mainFrameThrows) throw new Error('Requesting main frame too early!');
            return { detached: frameDetached };
        },
    };
}

test('isPageUsable：健康頁面為 true', () => {
    assert.equal(isPageUsable(fakePage()), true);
});

test('isPageUsable：瀏覽器斷線（lane 到期 SIGTERM 關掉 Chrome）為 false', () => {
    assert.equal(isPageUsable(fakePage({ connected: false })), false);
});

test('isPageUsable：main frame 已被 dispose（detached Frame 殭屍）為 false', () => {
    assert.equal(isPageUsable(fakePage({ frameDetached: true })), false);
});

test('isPageUsable：頁面已關閉／mainFrame() 本身 throw／沒有 page 都是 false，不得往外拋', () => {
    assert.equal(isPageUsable(fakePage({ closed: true })), false);
    assert.equal(isPageUsable(fakePage({ mainFrameThrows: true })), false);
    assert.equal(isPageUsable(null), false);
    assert.equal(isPageUsable({ isClosed() { throw new Error('boom'); } }), false);
});

test('assertPageUsable：殭屍 page 丟帶 exitCode 的錯誤，健康 page 靜默通過', () => {
    assert.doesNotThrow(() => assertPageUsable(fakePage(), '測試站', 75));
    const cause = new Error("Attempted to use detached Frame 'ABC'.");
    assert.throws(
        () => assertPageUsable(fakePage({ frameDetached: true }), '屏東監理站 站中導航', 75, cause),
        (err) => {
            assert.equal(err.exitCode, 75);
            assert.equal(err.deadPage, true);
            assert.match(err.message, /屏東監理站 站中導航/);
            assert.match(err.message, /detached Frame 'ABC'/);
            return true;
        }
    );
});

test('createDeadPageError：沒有 cause 也能建立', () => {
    const err = createDeadPageError('x', 75);
    assert.equal(err.exitCode, 75);
    assert.doesNotMatch(err.message, /undefined/);
});

test('createDeadlineShutdown：只跑一次 flush，跑完用 143 結束，二次訊號被忽略', async () => {
    const calls = [];
    const sd = createDeadlineShutdown({
        flush: async () => { calls.push('flush'); },
        exit: (code) => calls.push(`exit:${code}`),
        graceMs: 1000,
    });
    assert.equal(sd.isShuttingDown(), false);
    const p = sd.run('SIGTERM');
    assert.equal(sd.isShuttingDown(), true, '一收到訊號主流程就必須能偵測到，才能在副作用前停手');
    await p;
    await sd.run('SIGTERM');
    await sd.run('SIGHUP');
    assert.deepEqual(calls, ['flush', 'exit:143']);
});

test('createDeadlineShutdown：flush 卡死時到 graceMs 仍然結束（必須先於 wrapper 的 --kill-after=15s）', async () => {
    let exitCode = null;
    const started = Date.now();
    const sd = createDeadlineShutdown({
        flush: () => new Promise(() => {}), // 永遠不回
        exit: (code) => { exitCode = code; },
        graceMs: 50,
    });
    await sd.run('SIGTERM');
    assert.equal(exitCode, 143);
    assert.ok(Date.now() - started < 1000);
});

test('createDeadlineShutdown：flush 丟錯也一定結束，且錯誤只記 log', async () => {
    const logs = [];
    let exitCode = null;
    const sd = createDeadlineShutdown({
        flush: async () => { throw new Error('supabase down'); },
        exit: (code) => { exitCode = code; },
        log: (m) => logs.push(m),
        graceMs: 1000,
    });
    await sd.run('SIGTERM');
    assert.equal(exitCode, 143);
    assert.ok(logs.some(m => m.includes('supabase down')));
});

test('createDeadlineShutdown：handle() 不丟未處理的 rejection，且立即標記關機中', async () => {
    let exited = false;
    const sd = createDeadlineShutdown({
        flush: async () => {},
        exit: () => { exited = true; },
        graceMs: 1000,
    });
    sd.handle('SIGTERM');
    assert.equal(sd.isShuttingDown(), true);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(exited, true);
});

// ---- 來源層守門：確保爬蟲真的接上這些機制（gh-plate-sync.cjs require 時會直接開跑，無法 import）----

const SRC = fs.readFileSync(path.join(__dirname, '..', 'gh-plate-sync.cjs'), 'utf8');

test('crawler：puppeteer 不再代管 SIGTERM／SIGHUP，改由 deadlineShutdown 收尾', () => {
    assert.match(SRC, /handleSIGTERM:\s*false/);
    assert.match(SRC, /handleSIGHUP:\s*false/);
    assert.match(SRC, /process\.once\('SIGTERM',\s*\(\)\s*=>\s*deadlineShutdown\.handle\('SIGTERM'\)\)/);
    assert.doesNotMatch(SRC, /handleSIGINT:\s*false/, 'SIGINT 維持 puppeteer 預設');
    // graceMs 必須小於 wrapper 的 --kill-after=15s
    const grace = SRC.match(/graceMs:\s*(\d+)/);
    assert.ok(grace && Number(grace[1]) < 15000, 'graceMs 必須小於 15s');
    const wrapper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-plate-shard-with-recovery.sh'), 'utf8');
    assert.match(wrapper, /--kill-after=15s/);
});

test('crawler：Nav 迴圈在 goto 前與失敗後都檢查頁面存活，殭屍 page 不再睡 8s 重試', () => {
    const nav = SRC.slice(SRC.indexOf('for (let navTry = 0; navTry < 3; navTry++)'), SRC.indexOf('if (!navOk) {'));
    const before = nav.indexOf('assertPageUsable(page,');
    const gotoCall = nav.indexOf('await page.goto(MVDIS_URL');
    const catchAssert = nav.indexOf('assertPageUsable(page,', gotoCall);
    const sleep8 = nav.indexOf('await sleep(8000)');
    assert.ok(before > -1 && before < gotoCall, 'goto 前要先 assertPageUsable');
    assert.ok(catchAssert > gotoCall && catchAssert < sleep8, 'goto 失敗後、sleep 前要先 assertPageUsable');
    assert.match(nav, /MVDIS_PREFLIGHT_EXIT_CODE/);
});

test('crawler：到期關機中不得刪 staging／換站；站層 catch 的殭屍 page 走 exit 75 而非「跳過本站」', () => {
    const stationFn = SRC.slice(SRC.indexOf('async function processStation('));
    const park = stationFn.indexOf('await parkIfShuttingDown();');
    const del = stationFn.indexOf(".from('available_plates_staging').delete()");
    assert.ok(park > -1 && del > -1 && park < del, '刪 staging 前必須先停手');

    const loop = SRC.slice(SRC.indexOf('await processStation(page, deptId, station);'));
    const catchStart = loop.indexOf('} catch (stationErr) {');
    const bail75 = loop.indexOf('stationErr.exitCode === MVDIS_PREFLIGHT_EXIT_CODE');
    const usable = loop.indexOf('if (!isPageUsable(page))');
    const skipMsg = loop.indexOf('發生未攔截錯誤，跳過本站');
    assert.ok(catchStart > -1 && bail75 > catchStart && usable > bail75 && skipMsg > usable);
    assert.match(loop.slice(catchStart, bail75), /parkIfShuttingDown\(\)/, 'catch 一開頭就要停手，避免把關機造成的錯誤記成站失敗');
});

test('crawler：不得放寬既有保護——擋 swap 守門、連環驗證碼 bail、Resume 仍在', () => {
    assert.match(SRC, /blocking swap to avoid false "sold" notifications/);
    assert.match(SRC, /CAPTCHA_REJECT_BAILOUT_THRESHOLD\s*=\s*4/);
    assert.match(SRC, /recordCompletedStation\(COMPLETED_STATIONS_FILE, completedStations, station\.id\)/);
    assert.match(SRC, /navAbortErr\.exitCode\s*=\s*MVDIS_PREFLIGHT_EXIT_CODE/);
});
