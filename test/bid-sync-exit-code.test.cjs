'use strict';

// 健檢 O5（2026-11-10）：bid-announce-sync / bidding-plates-sync 的部分失敗原本不影響 exit code → workflow 假綠。
// 這裡把 puppeteer-extra 與 @supabase/supabase-js 換成假物件（require.cache 注入），直接跑兩支腳本的 run()，
// 驗證：真正失敗時回傳 1、完整成功回傳 0、單站失敗不會讓其他站已成功的 upsert 作廢。
// ⛔ 不連任何網路／資料庫；不載入 .env（腳本只在 require.main === module 時才讀 .env）。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fake-supabase.cjs');

const ROOT = path.join(__dirname, '..');

function injectModule(name, exports) {
    const resolved = require.resolve(name, { paths: [ROOT] });
    const previous = require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
    return () => {
        if (previous) require.cache[resolved] = previous;
        else delete require.cache[resolved];
    };
}

/**
 * 載入腳本（每次都是全新模組實例，因為 supabase client 是模組層級）。
 * 回傳 { run, restore, state }。
 */
function loadScript(file, { supabase, page }) {
    const state = { browserClosed: 0 };
    const restores = [];
    const stealth = () => ({});
    restores.push(injectModule('puppeteer-extra-plugin-stealth', stealth));
    restores.push(injectModule('puppeteer-extra', {
        use() {},
        launch: async () => ({
            newPage: async () => page,
            close: async () => { state.browserClosed++; },
        }),
    }));
    restores.push(injectModule('@supabase/supabase-js', { createClient: () => supabase }));

    const savedEnv = { u: process.env.VITE_SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.VITE_SUPABASE_URL = 'http://supabase.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

    const scriptPath = path.join(ROOT, file);
    delete require.cache[scriptPath];
    const mod = require(scriptPath);

    return {
        run: mod.run,
        state,
        restore() {
            delete require.cache[scriptPath];
            restores.reverse().forEach((r) => r());
            if (savedEnv.u === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = savedEnv.u;
            if (savedEnv.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.k;
        },
    };
}

async function runQuiet(run) {
    const orig = { log: console.log, error: console.error, warn: console.warn, setTimeout: global.setTimeout };
    const lines = [];
    const push = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    console.log = push;
    console.error = push;
    console.warn = push;
    // 腳本內有數個固定 3~5 秒的 sleep；測試只關心流程，把等待壓成 1ms（結束後還原）。
    global.setTimeout = (fn, ms, ...rest) => orig.setTimeout(fn, Math.min(ms || 0, 1), ...rest);
    try {
        return { code: await run(), lines };
    } finally {
        Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn });
        global.setTimeout = orig.setTimeout;
    }
}

// ---------------------------------------------------------------- bid-announce-sync

const STATION_DATA = [{ id: '1', stations: [{ id: '10', name: '測試站' }] }];
const ANNOUNCE_ROW = ['測試站', '電動自小客', 'AAA-0000', 'AAA-9999', '1151110 10:00:00', '1151120 10:00:00', '1151125 10:00:00'];

function makeAnnouncePage({ gotoFails = false } = {}) {
    return {
        setUserAgent: async () => {},
        goto: async () => { if (gotoFails) throw new Error('net::ERR_TIMED_OUT'); },
        waitForNavigation: async () => {},
        select: async () => {},
        evaluate: async (fn) => {
            const src = String(fn);
            if (src.includes('#total')) return 1;
            if (src.includes('號牌起號')) return [ANNOUNCE_ROW];
            return undefined;
        },
    };
}

function makeAnnounceSupabase({ upsertError = null } = {}) {
    return createFakeSupabase((call) => {
        if (call.table === 'system_configs') return { data: { value: STATION_DATA } };
        if (call.table === 'bid_announcements' && call.has('upsert')) return { error: upsertError };
        return { data: null };
    });
}

test('bid-announce-sync：完整成功 → 0，且寫入公告', async () => {
    const sb = makeAnnounceSupabase();
    const s = loadScript('bid-announce-sync.cjs', { supabase: sb, page: makeAnnouncePage() });
    try {
        const { code, lines } = await runQuiet(s.run);
        assert.equal(code, 0, lines.join('\n'));
        assert.ok(sb.calls.some((c) => c.table === 'bid_announcements' && c.has('upsert')));
        assert.ok(lines.some((l) => /Announcements synced successfully/.test(l)));
        assert.equal(s.state.browserClosed, 1);
    } finally { s.restore(); }
});

test('bid-announce-sync：頁面載入 3 次都失敗 → 回傳 1（原本永遠 0 的假綠）', async () => {
    const sb = makeAnnounceSupabase();
    const s = loadScript('bid-announce-sync.cjs', { supabase: sb, page: makeAnnouncePage({ gotoFails: true }) });
    try {
        const { code, lines } = await runQuiet(s.run);
        assert.equal(code, 1, lines.join('\n'));
        assert.ok(lines.some((l) => /Could not load announce page after 3 attempts/.test(l)));
        assert.ok(lines.some((l) => /marking run as failed/.test(l)));
        assert.equal(s.state.browserClosed, 1, '失敗時仍要關瀏覽器');
    } finally { s.restore(); }
});

test('bid-announce-sync：upsert 失敗 → 回傳 1，且不印 synced successfully', async () => {
    const sb = makeAnnounceSupabase({ upsertError: { message: 'permission denied' } });
    const s = loadScript('bid-announce-sync.cjs', { supabase: sb, page: makeAnnouncePage() });
    try {
        const { code, lines } = await runQuiet(s.run);
        assert.equal(code, 1);
        assert.ok(lines.some((l) => /Upsert error in chunk: permission denied/.test(l)));
        assert.ok(!lines.some((l) => /Announcements synced successfully/.test(l)));
    } finally { s.restore(); }
});

test('bid-announce-sync：整體爬取例外（catch 區塊）→ 回傳 1', async () => {
    const page = makeAnnouncePage();
    page.select = async () => { throw new Error('selector gone'); };
    const s = loadScript('bid-announce-sync.cjs', { supabase: makeAnnounceSupabase(), page });
    try {
        const { code, lines } = await runQuiet(s.run);
        assert.equal(code, 1);
        assert.ok(lines.some((l) => /Scrape failed/.test(l)));
    } finally { s.restore(); }
});

test('bid-announce-sync：站台設定載入失敗 → 回傳 1（不再 process.exit，方便測試）', async () => {
    const sb = createFakeSupabase((call) => (call.table === 'system_configs' ? { data: null, error: { message: 'no row' } } : { data: null }));
    const s = loadScript('bid-announce-sync.cjs', { supabase: sb, page: makeAnnouncePage() });
    try {
        const { code } = await runQuiet(s.run);
        assert.equal(code, 1);
    } finally { s.restore(); }
});

// ---------------------------------------------------------------- bidding-plates-sync

function makeBiddingSupabase({ upsertError = null } = {}) {
    const active = ['10', '11'].map((code) => ({
        section_code: '1', station_code: code, plate_type: '電動自小客',
        start_plate: 'AAA-0000', end_plate: 'ZZZ-9999',
        start_time: '2026-11-01T00:00:00Z', end_time: '2026-12-01T00:00:00Z',
    }));
    return createFakeSupabase((call) => {
        if (call.table === 'bid_announcements' && call.has('gte')) return { data: active };
        if (call.table === 'bidding_plates' && call.has('upsert')) return { error: upsertError };
        if (call.table === 'bidding_plates' && call.has('select')) return { data: [] }; // 沒有已結標的牌
        if (call.table === 'bid_announcement_watchlist') return { data: [] };
        if (call.table === 'watchlist') return { data: [] };
        if (call.rpc === 'claim_plate_subscription_matches') return { data: [] };
        return { data: null };
    });
}

function makeBiddingPage({ failStation = null } = {}) {
    return {
        setUserAgent: async () => {},
        goto: async () => {},
        waitForNavigation: async () => {},
        click: async () => {},
        select: async (selector, value) => {
            if (selector === '#stationCode' && value === failStation) throw new Error('Navigation timeout');
        },
        evaluate: async (fn) => {
            const src = String(fn);
            if (src.includes('txtPage')) return { current: 1, total: 1, hasNextButton: false };
            if (src.includes('號牌類別')) {
                return [{ plateNo: 'ABC-1234', plateType: '電動自小客', basePrice: '1,000', currentBid: '2,000', bidCount: '3', endTimeStr: '1151120 10:00:00' }];
            }
            return undefined;
        },
    };
}

const upsertCalls = (sb) => sb.calls.filter((c) => c.table === 'bidding_plates' && c.has('upsert'));

test('bidding-plates-sync：全部站成功 → 0', async () => {
    const sb = makeBiddingSupabase();
    const s = loadScript('bidding-plates-sync.cjs', { supabase: sb, page: makeBiddingPage() });
    try {
        const { code, lines } = await runQuiet(s.run);
        assert.equal(code, 0, lines.join('\n'));
        assert.equal(upsertCalls(sb).length, 1);
    } finally { s.restore(); }
});

test('bidding-plates-sync：單站爬取失敗 → 回傳 1 並在 log 列出失敗站，但其他站已爬到的資料照常 upsert', async () => {
    const sb = makeBiddingSupabase();
    const s = loadScript('bidding-plates-sync.cjs', { supabase: sb, page: makeBiddingPage({ failStation: '10' }) });
    try {
        const { code, lines } = await runQuiet(s.run);
        assert.equal(code, 1, lines.join('\n'));
        assert.ok(lines.some((l) => /1\/2 station\(s\) failed to crawl: 10/.test(l)), lines.join('\n'));
        // 部分成功的寫入不作廢：站 11 的牌仍被 upsert（站 10 沒有）
        const calls = upsertCalls(sb);
        assert.equal(calls.length, 1);
        const rows = calls[0].ops.find((o) => o.name === 'upsert').args[0];
        assert.deepEqual([...new Set(rows.map((r) => r.station_id))], ['11']);
        assert.equal(s.state.browserClosed, 1);
    } finally { s.restore(); }
});

test('bidding-plates-sync：upsert 失敗 → 回傳 1（既有語意不變）', async () => {
    const sb = makeBiddingSupabase({ upsertError: { message: 'boom' } });
    const s = loadScript('bidding-plates-sync.cjs', { supabase: sb, page: makeBiddingPage() });
    try {
        const { code, lines } = await runQuiet(s.run);
        assert.equal(code, 1);
        assert.ok(lines.some((l) => /Completed with data write errors/.test(l)));
    } finally { s.restore(); }
});

test('bidding-plates-sync：目前沒有進行中的標案 → 0（不爬、不開瀏覽器）', async () => {
    const sb = createFakeSupabase((call) => (call.table === 'bid_announcements' && call.has('gte') ? { data: [] } : { data: [] }));
    const s = loadScript('bidding-plates-sync.cjs', { supabase: sb, page: makeBiddingPage() });
    try {
        const { code } = await runQuiet(s.run);
        assert.equal(code, 0);
        assert.equal(s.state.browserClosed, 0);
    } finally { s.restore(); }
});

test('bidding-plates-sync：通知流程的 log 不含收件人 email', async () => {
    const sb = createFakeSupabase((call) => {
        if (call.table === 'bid_announcements' && call.has('gte')) return { data: [] };
        if (call.table === 'bidding_plates' && call.has('select')) {
            return { data: [{ plate_no: 'ABC-1234', plate_type: '電動自小客', current_bid: 5000, bid_count: 2, end_time: '2026-11-01T00:00:00Z' }] };
        }
        if (call.table === 'watchlist' && call.has('select')) return { data: [{ id: 1, plate_no: 'ABC-1234', email: 'carol@example.com' }] };
        return { data: null };
    });
    const s = loadScript('bidding-plates-sync.cjs', { supabase: sb, page: makeBiddingPage() });
    const saved = { u: process.env.SMTP_USER, p: process.env.SMTP_PASS };
    delete process.env.SMTP_USER; // 走 dry-run 分支：舊版會把整封信連同收件人印出
    delete process.env.SMTP_PASS;
    try {
        const { lines } = await runQuiet(s.run);
        const out = lines.join('\n');
        assert.ok(!out.includes('carol@example.com'), out);
        assert.match(out, /c\*\*\*@example\.com/);
        assert.ok(!out.includes('<div style='), '不得把整封信 HTML 印進公開 log');
    } finally {
        if (saved.u !== undefined) process.env.SMTP_USER = saved.u;
        if (saved.p !== undefined) process.env.SMTP_PASS = saved.p;
        s.restore();
    }
});
