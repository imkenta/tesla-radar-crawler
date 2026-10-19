/**
 * 瀏覽器／頁面存活判斷與 lane 牆鐘到期的關機協調（純函式，與回歸測試共用單一真理：
 * test/browser-liveness.test.cjs）。
 *
 * 背景（2026-10-19 "Attempted to use detached Frame" 事故）：
 * run-plate-shard-with-recovery.sh 用 `timeout --signal=TERM --kill-after=15s` 當 lane 牆鐘硬預算。
 * SIGTERM 到達 node 後，puppeteer 預設的 handleSIGTERM 只會把 Chrome 關掉、node 本身不結束，
 * 於是接下來最多 15 秒爬蟲在「Chrome 已死」的狀態下繼續跑：page 的 main frame 被 puppeteer
 * dispose（FrameManager.#onClientDisconnect），之後每次 page.goto 都丟
 * "Attempted to use detached Frame '<同一個 id>'"，Nav 重試 3 次用的是同一個殭屍 page，
 * 站被誤標 FAILED。頁面一旦成為殭屍就不可能復活（連 browser.newPage() 都回 Connection closed），
 * 所以正解不是「換 frame／換 page 重試」，而是：到期時乾淨關機、其餘情況快速失敗交回 wrapper。
 */

/**
 * 這個 page 還能不能做事。任何一項不成立就是殭屍：頁面已關、瀏覽器已斷線、main frame 已被 dispose。
 * 全程 try/catch——puppeteer 在 frame tree 失效時 mainFrame() 本身也可能 throw。
 */
function isPageUsable(page) {
    try {
        if (!page) return false;
        if (typeof page.isClosed === 'function' && page.isClosed()) return false;
        const browser = typeof page.browser === 'function' ? page.browser() : null;
        if (browser && browser.connected === false) return false;
        const frame = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
        if (frame && frame.detached === true) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * 建立「頁面已成殭屍」錯誤；exitCode 由呼叫端傳入（gh-plate-sync 用 75＝可重抽，
 * 交回 workflow 以 fresh Chrome／新 WARP 身分重來）。
 */
function createDeadPageError(context, exitCode, cause) {
    const reason = cause && cause.message ? `（${cause.message}）` : '';
    const err = new Error(`瀏覽器或頁面已失效，無法繼續（${context}）${reason}：交回 workflow 以新的 Chrome 程序重來。`);
    err.exitCode = exitCode;
    err.deadPage = true;
    return err;
}

/** 頁面不可用就直接丟 createDeadPageError，可用則什麼都不做。 */
function assertPageUsable(page, context, exitCode, cause) {
    if (!isPageUsable(page)) throw createDeadPageError(context, exitCode, cause);
}

/**
 * lane 牆鐘到期（SIGTERM／SIGHUP）時的關機協調。
 *  - flush：async，負責關瀏覽器、寫 sync_metadata／sync_logs（呼叫端自行組裝）。
 *  - exit：結束 process 的函式（正式環境傳 process.exit，測試傳假的）。
 *  - graceMs：flush 的硬上限，必須小於 wrapper 的 --kill-after（15s），否則會被 SIGKILL 搶先、統計寫不出去。
 * 只會執行一次；之後 isShuttingDown() 恆為 true，主流程用它在每個副作用前停手。
 */
function createDeadlineShutdown({ flush, exit, log = () => {}, graceMs = 10000, exitCode = 143 }) {
    let started = false;

    async function run(signal) {
        if (started) return;
        started = true;
        log(`[Shutdown] 收到 ${signal}（lane 牆鐘預算到期）：停止爬取，關閉瀏覽器並寫入統計後結束，不把這段時間內的站誤標為失敗。`);
        let timer;
        const deadline = new Promise(resolve => { timer = setTimeout(resolve, graceMs); });
        try {
            await Promise.race([Promise.resolve().then(flush), deadline]);
        } catch (e) {
            log(`[Shutdown] 收尾時發生錯誤（忽略，仍然結束）：${e && e.message ? e.message : e}`);
        } finally {
            clearTimeout(timer);
            exit(exitCode);
        }
    }

    return {
        handle: (signal) => { void run(signal); },
        run,
        isShuttingDown: () => started,
    };
}

module.exports = { isPageUsable, createDeadPageError, assertPageUsable, createDeadlineShutdown };
