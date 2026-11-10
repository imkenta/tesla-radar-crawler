'use strict';

// trigger_swap.cjs 是 swap 前「唯一的一道防線」（檔頭自述）。2026-11-10 健檢 O6 前它沒有任何測試，
// 且載入即 run()（連線上庫）。本檔鎖住：重複鍵守門、筆數異常守門、shard 新鮮度、熔斷回讀、
// sync_metadata upsert 結果檢查（缺口一），以及「被 require 時絕不執行 run()」。
// ⛔ 全程使用假 Supabase（test/helpers/fake-supabase.cjs），不連任何網路。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const swap = require('../trigger_swap.cjs');
const { SHARD_NAMES } = require('../lib/shard-config.cjs');
const { createFakeSupabase } = require('./helpers/fake-supabase.cjs');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const freshIso = new Date(NOW - 10 * 60 * 1000).toISOString();

// ---------- 載入安全 ----------

test('被 require 時不會執行 run()、不會讀 env、不會 process.exit', () => {
    // 在乾淨子行程、完全沒有 Supabase env 的情況下 require：舊版會 process.exit(1) 或直接連線。
    const result = spawnSync(process.execPath, ['-e', `
        const m = require(${JSON.stringify(path.join(__dirname, '..', 'trigger_swap.cjs'))});
        console.log(typeof m.run, typeof m.checkDuplicateKeys);
    `], {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..', 'test'), // 非 repo 根目錄：確保不會碰到 .env
        env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /function function/);
    assert.doesNotMatch(result.stdout + result.stderr, /Triggering Final Swap|Missing Supabase/);
});

// ---------- 純函式守門 ----------

test('checkShardMeta：缺列／狀態不是 COMPLETED／過期／查詢錯誤各自擋下', () => {
    assert.equal(swap.checkShardMeta('NORTH', { meta: { status: 'COMPLETED', last_run_at: freshIso }, error: null, now: NOW }), null);

    assert.match(swap.checkShardMeta('NORTH', { meta: null, error: null, now: NOW }).message, /no sync_metadata row \(plates_sync_shard_NORTH\)/);
    assert.match(swap.checkShardMeta('NORTH', { meta: { status: 'RUNNING', last_run_at: freshIso }, error: null, now: NOW }).message, /status is "RUNNING"/);
    const stale = new Date(NOW - swap.SHARD_FRESHNESS_WINDOW_MS - 1000).toISOString();
    assert.match(swap.checkShardMeta('NORTH', { meta: { status: 'COMPLETED', last_run_at: stale }, error: null, now: NOW }).message, /stale/);
    assert.match(swap.checkShardMeta('NORTH', { meta: { status: 'COMPLETED', last_run_at: 'not-a-date' }, error: null, now: NOW }).message, /stale/);
    assert.match(swap.checkShardMeta('NORTH', { meta: null, error: { message: 'boom' }, now: NOW }).message, /Failed to check sync_metadata for shard NORTH: boom/);
});

test('checkStagingCount：0 筆安全略過、低於下限中止、足量通過', () => {
    assert.equal(swap.checkStagingCount(0).skip, true);
    const tooFew = swap.checkStagingCount(swap.MIN_STAGING_COUNT - 1);
    assert.ok(tooFew && !tooFew.skip);
    assert.match(tooFew.message, /floor 50/);
    assert.equal(swap.checkStagingCount(swap.MIN_STAGING_COUNT), null);
});

test('checkDuplicateKeys：同一 (站,區,類別,牌) 出現兩次即中止，訊息帶範例鍵', () => {
    const row = (plate_no, extra = {}) => ({ station_id: '40', region_id: '4', plate_type: 'g', plate_no, ...extra });
    assert.equal(swap.checkDuplicateKeys([row('A'), row('B'), row('A', { plate_type: 'h' })]), null);
    const verdict = swap.checkDuplicateKeys([row('A'), row('B'), row('A')]);
    assert.match(verdict.message, /1 duplicated plate keys \(e\.g\. 40\|4\|g\|A×2\)/);
});

test('checkDropRatio：正式表 0 筆不比；下降剛好 20% 通過、超過即中止', () => {
    assert.equal(swap.checkDropRatio(0, 10), null);
    assert.equal(swap.checkDropRatio(1000, 800), null); // 正好 20%：不超過
    const verdict = swap.checkDropRatio(1000, 799);
    assert.match(verdict.message, /dropped 20\.1% vs production \(1000 → 799\)/);
    assert.equal(swap.checkDropRatio(1000, 1500), null); // 變多交給重複鍵守門
});

test('checkCircuitBreaker：只有 SKIPPED_CIRCUIT_BREAKER 才中止', () => {
    assert.equal(swap.checkCircuitBreaker(null), null);
    assert.equal(swap.checkCircuitBreaker({ status: 'COMPLETED' }), null);
    assert.match(swap.checkCircuitBreaker({ status: 'SKIPPED_CIRCUIT_BREAKER', status_message: 'drop' }).message, /Circuit breaker tripped.*drop/);
});

// ---------- run() 整合（假 client） ----------

function makeScenario(overrides = {}) {
    const o = {
        shardMeta: { status: 'COMPLETED', last_run_at: freshIso },
        stagingCount: 1000,
        prodCount: 1000,
        stagingKeys: Array.from({ length: 1000 }, (_, i) => ({ station_id: '40', region_id: '4', plate_type: 'g', plate_no: `P${i}` })),
        prodRows: [], // 單組歸零守門讀的正式表（預設空＝沒有可保留的組）
        prodReadError: null,
        insertError: null,
        duplicateOnInsert: false, // 模擬 insert 重試造成同一批列進了兩次
        swapError: null,
        metaAfterSwap: { status: 'COMPLETED', status_message: null },
        metaUpsertError: null,
        ...overrides,
    };
    const notified = { sold: 0, sub: 0 };
    const sb = createFakeSupabase((call) => {
        if (call.rpc === 'swap_plates_data') return { data: null, error: o.swapError };
        if (call.rpc === 'claim_plate_subscription_matches') { notified.sub++; return { data: [] }; }
        if (call.table === 'sync_metadata') {
            if (call.has('upsert')) return { data: null, error: o.metaUpsertError };
            if (call.eq('key') === 'plates_full_sync') return { data: o.metaAfterSwap };
            return { data: o.shardMeta };
        }
        if (call.table === 'available_plates_staging') {
            if (call.has('insert')) {
                if (o.insertError) return { data: null, error: o.insertError };
                // 模擬真實 DB：抄回的列進了 staging，後續讀鍵會看到它們
                o.stagingKeys = o.stagingKeys.concat(call.arg('insert'), o.duplicateOnInsert ? call.arg('insert') : []);
                return { data: null };
            }
            if (call.has('range')) {
                const [from, to] = call.ops.find((op) => op.name === 'range').args;
                return { data: o.stagingKeys.slice(from, to + 1) };
            }
            return { count: o.stagingCount };
        }
        if (call.table === 'available_plates') {
            if (call.has('range')) {
                if (o.prodReadError) return { data: null, error: o.prodReadError };
                const [from, to] = call.ops.find((op) => op.name === 'range').args;
                return { data: o.prodRows.slice(from, to + 1) };
            }
            return { count: o.prodCount };
        }
        if (call.table === 'plate_changes') { notified.sold++; return { data: null, error: { message: 'none' } }; }
        return { data: [] };
    });
    const ctx = { supabase: sb, safeQuery: (op) => op(), sendEmail: async () => true, now: () => NOW };
    return { sb, ctx, notified, o };
}

const swapCalled = (sb) => sb.calls.some((c) => c.rpc === 'swap_plates_data');

async function quiet(fn) {
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try {
        return { result: await fn(), lines };
    } finally {
        Object.assign(console, orig);
    }
}

test('run：全部守門通過 → swap、回寫 sync_metadata、跑兩段通知、exit 0', async () => {
    const { sb, ctx, notified } = makeScenario();
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 0);
    assert.ok(swapCalled(sb));
    assert.equal(notified.sold, 1);
    assert.equal(notified.sub, 1);
    assert.ok(sb.calls.some((c) => c.table === 'sync_metadata' && c.has('upsert')));
});

test('run：staging 有重複鍵 → exit 1，且 swap RPC 從未被呼叫', async () => {
    const dup = Array.from({ length: 1000 }, (_, i) => ({ station_id: '40', region_id: '4', plate_type: 'g', plate_no: `P${i}` }));
    dup[999] = { ...dup[0] };
    const { sb, ctx } = makeScenario({ stagingKeys: dup });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.ok(lines.some((l) => /duplicated plate keys/.test(l)));
});

test('run：staging 低於最低筆數 → exit 1、不 swap', async () => {
    const { sb, ctx } = makeScenario({ stagingCount: 10, stagingKeys: [] });
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
});

test('run：staging 相對正式表暴跌 → exit 1、不 swap', async () => {
    const { sb, ctx } = makeScenario({ stagingCount: 1000, prodCount: 2000 });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.ok(lines.some((l) => /dropped 50\.0%/.test(l)));
});

test('run：staging 為 0 → 安全略過（exit 0）且不 swap，維持原語意', async () => {
    const { sb, ctx } = makeScenario({ stagingCount: 0 });
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 0);
    assert.equal(swapCalled(sb), false);
});

test('run：任一 shard 狀態不是 COMPLETED → exit 1，連 staging 都不查', async () => {
    const { sb, ctx } = makeScenario({ shardMeta: { status: 'RUNNING', last_run_at: freshIso } });
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.equal(sb.calls.some((c) => c.table === 'available_plates_staging'), false);
    // 只檢查到第一個壞 shard 就停
    assert.equal(sb.calls.filter((c) => c.table === 'sync_metadata').length, 1);
    assert.ok(SHARD_NAMES.length > 1);
});

test('run：swap 後回讀到熔斷狀態 → exit 1，且不覆寫成 COMPLETED', async () => {
    const { sb, ctx } = makeScenario({ metaAfterSwap: { status: 'SKIPPED_CIRCUIT_BREAKER', status_message: 'x' } });
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(sb.calls.some((c) => c.table === 'sync_metadata' && c.has('upsert')), false);
});

test('run：swap 成功但 sync_metadata upsert 失敗 → 印明確錯誤、exit 1，仍跑完兩段通知（缺口一）', async () => {
    const { sb, ctx, notified } = makeScenario({ metaUpsertError: { message: 'permission denied' } });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.ok(swapCalled(sb), 'swap 已上線');
    assert.ok(lines.some((l) => /failed to update sync_metadata plates_full_sync: permission denied/.test(l)));
    // 售出通知是 at-most-once：不可因 metadata 寫入失敗就跳過
    assert.equal(notified.sold, 1);
    assert.equal(notified.sub, 1);
});

test('safeQuery：重試耗盡回 Max retries reached，退避用注入的 sleep、錯誤訊息中的 email 被遮罩', async () => {
    const waits = [];
    const { result, lines } = await quiet(() => swap.safeQuery(
        async () => ({ error: { message: 'duplicate key (alice@example.com)' } }),
        3,
        async (ms) => { waits.push(ms); },
    ));
    assert.equal(result.error.message, 'Max retries reached');
    assert.deepEqual(waits, [10000, 15000]); // 沿用既有退避公式 (maxRetries+1-retries)*5s
    assert.ok(lines.every((l) => !l.includes('alice@example.com')));
    assert.ok(lines.some((l) => l.includes('a***@example.com')));
});

test('sendEmail dry-run：只印遮罩收件人與主旨，不印整封信，且仍回傳 true', async () => {
    const saved = { u: process.env.SMTP_USER, p: process.env.SMTP_PASS };
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    try {
        const sb = createFakeSupabase(() => ({ data: null }));
        const { result, lines } = await quiet(() => swap.sendEmail(sb, 'bob@example.com', '[T] subject', '<p>SECRET-BODY bob@example.com</p>'));
        assert.equal(result, true);
        const out = lines.join('\n');
        assert.ok(!out.includes('bob@example.com'));
        assert.ok(!out.includes('SECRET-BODY'));
        assert.ok(out.includes('b***@example.com'));
    } finally {
        if (saved.u !== undefined) process.env.SMTP_USER = saved.u;
        if (saved.p !== undefined) process.env.SMTP_PASS = saved.p;
    }
});

// ---------- 單組歸零保留（C12）整合 ----------

const heldGroupRows = (offsetMin, n = 5) => Array.from({ length: n }, (_, i) => ({
    id: `x${i}`, station_id: '20', station_name: '臺北市區監理所', region_id: '2', plate_type: 'g',
    window_id: '01', plate_no: `H${i}`, price: 2000, status: 'AVAILABLE',
    updated_at: new Date(NOW + offsetMin * 60 * 1000).toISOString(),
}));
// 正式表：被保留的 20/2/g 組 + 一組仍有新資料的 40/4/g（updated_at 由呼叫端決定「上一次 swap 的時間」）
const prodWith = (heldRows, freshOffsetMin) => [
    ...heldRows,
    ...Array.from({ length: 10 }, (_, i) => ({ id: `y${i}`, station_id: '40', station_name: '臺北區', region_id: '4', plate_type: 'g', window_id: '01', plate_no: `P${i}`, price: 2000, status: 'AVAILABLE', updated_at: new Date(NOW + freshOffsetMin * 60 * 1000).toISOString() })),
];

test('run：某站車種整組回空、正式表有 5 筆 → 抄回 staging 後照常 swap（不會 REMOVED），exit 0，成功訊息註明保留', async () => {
    const { sb, ctx, o } = makeScenario({ prodRows: prodWith(heldGroupRows(-20), -20) });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 0);
    assert.ok(swapCalled(sb));
    const ins = sb.calls.filter((c) => c.table === 'available_plates_staging' && c.has('insert'));
    assert.equal(ins.length, 1);
    const restored = ins[0].arg('insert');
    assert.equal(restored.length, 5);
    assert.ok(restored.every((r) => !('id' in r) && r.station_id === '20'));
    assert.equal(o.stagingKeys.length, 1005, '抄回的列進了 staging');
    assert.ok(lines.some((l) => /::warning::\[Hold\] 20 \/ 2 \/ g/.test(l)));
    // 抄回發生在 swap 之前
    const order = sb.calls.map((c) => (c.rpc === 'swap_plates_data' ? 'swap' : c.has('insert') ? 'insert' : null)).filter(Boolean);
    assert.deepEqual(order, ['insert', 'swap']);
    const upsert = sb.calls.find((c) => c.table === 'sync_metadata' && c.has('upsert'));
    assert.match(upsert.arg('upsert').status_message, /不含沿用上一輪的 5 筆；1 組本輪回空/);
});

test('run：連續空夠久（age ≥ 30 分）→ 放行：不抄回、照常 swap（真正售完的組不會永遠卡住）', async () => {
    const { sb, ctx } = makeScenario({ prodRows: prodWith(heldGroupRows(-40), 0) });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 0);
    assert.ok(swapCalled(sb));
    assert.equal(sb.calls.some((c) => c.has('insert')), false);
    assert.ok(lines.some((l) => /\[Hold-Release\] 20 \/ 2 \/ g/.test(l)));
});

test('run：讀正式表失敗 → fail-closed（exit 1、不 swap）', async () => {
    const { sb, ctx } = makeScenario({ prodReadError: { message: 'prod read boom' } });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.ok(lines.some((l) => /empty-group hold.*prod read boom/.test(l)));
});

test('run：抄回 insert 失敗 → fail-closed（exit 1、不 swap）', async () => {
    const { sb, ctx } = makeScenario({ prodRows: prodWith(heldGroupRows(-20), -20), insertError: { message: 'insert boom' } });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.ok(lines.some((l) => /insert boom/.test(l)));
});

test('run：筆數下限看「本輪實際抓到的」——不會被抄回的舊列墊高而放過殘缺批次', async () => {
    // 本輪只抓到 10 筆，正式表有 600 筆：若先抄回再檢查下限就會通過。必須先擋下，且完全不讀正式表。
    const bigProd = Array.from({ length: 600 }, (_, i) => ({ id: `z${i}`, station_id: String(20 + (i % 6)), region_id: '2', plate_type: 'g', plate_no: `Z${i}`, updated_at: iso0() }));
    function iso0() { return new Date(NOW).toISOString(); }
    const { sb, ctx } = makeScenario({ stagingCount: 10, stagingKeys: [], prodRows: bigProd });
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.equal(sb.calls.some((c) => c.table === 'available_plates' && c.has('range')), false);
});

test('run：下降閘分子分母都扣掉保留列——殘缺批次不會因抄回而過關（20% 閘照擋、且不寫入）', async () => {
    const { sb, ctx } = makeScenario({ stagingCount: 1000, prodCount: 2000, prodRows: prodWith(heldGroupRows(-20), -20) });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.ok(lines.some((l) => /dropped 49\.9% vs production \(1995 → 1000, excluding 5 held rows\)/.test(l)));
    assert.equal(sb.calls.some((c) => c.has('insert')), false);
});

test('run：抄回後複檢到重複鍵（例如 insert 重試重複寫入）→ exit 1、不 swap', async () => {
    const { sb, ctx } = makeScenario({ prodRows: prodWith(heldGroupRows(-20), -20), duplicateOnInsert: true });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.ok(lines.some((l) => /duplicated plate keys/.test(l)));
});

// ---------- 保留期間 × 下降閘（P1-1／P1-2） ----------

const mkRows = (station, type, n, offsetMin, region = '2', prefix = '') => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${station}${type}${i}`, station_id: station, station_name: `站${station}`, region_id: region, plate_type: type,
    window_id: '01', plate_no: `${prefix}${station}${type}${i}`, price: 2000, status: 'AVAILABLE',
    updated_at: new Date(NOW + offsetMin * 60 * 1000).toISOString(),
}));
const keysOf = (rows) => rows.map((r) => ({ station_id: r.station_id, region_id: r.region_id, plate_type: r.plate_type, plate_no: r.plate_no }));

// 正式表 1000 列：兩個大組同時回空（100 + 86 = 18.6%）+ 814 列正常組（updated_at = 上一次 swap 的時間 0）
function multiHeldScenario({ heldOffsetMin, freshNow, ...extra }) {
    const heldA = mkRows('20', 'g', 100, heldOffsetMin);
    const heldB = mkRows('84', 'h', 86, heldOffsetMin, '8');
    const fresh = mkRows('40', 'g', 814, 0, '4');
    const prodRows = [...heldA, ...heldB, ...fresh];
    return makeScenario({
        prodRows, prodCount: prodRows.length,
        stagingKeys: keysOf(fresh).slice(0, freshNow), stagingCount: freshNow,
        ...extra,
    });
}

test('P1-1：保留第 2 輪、多站合計 18.6%，本輪再淨降 20 筆——舊公式會擋死（20.6%），新公式照常 swap', async () => {
    // 舊公式 (1000-794)/1000 = 20.6% > 20% → 擋下 → 不 swap → 時鐘不前進 → 永遠保留且每輪 exit 1
    const { sb, ctx } = multiHeldScenario({ heldOffsetMin: -20, freshNow: 794 });
    assert.ok(swap.checkDropRatio(1000, 794), '前提：不扣保留列時舊公式會擋');
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 0, lines.join('\n'));
    assert.ok(swapCalled(sb));
    assert.equal(sb.calls.filter((c) => c.has('insert')).length, 1);
    assert.equal(sb.calls.find((c) => c.has('insert')).arg('insert').length, 186);
});

test('P1-1：保留第 3 輪（age 40 分）→ 放行；放行輪不扣除，嚴格度與舊版相同', async () => {
    // 放行輪：186 列真的要被移除。fresh 815 → (1000-815)/1000 = 18.5% 通過；794 → 20.6% 擋下（與舊版一致）
    const pass = multiHeldScenario({ heldOffsetMin: -40, freshNow: 815 });
    const r1 = await quiet(() => swap.run(pass.ctx));
    assert.equal(r1.result, 0);
    assert.ok(swapCalled(pass.sb));
    assert.equal(pass.sb.calls.some((c) => c.has('insert')), false, '放行：不抄回');
    assert.ok(r1.lines.some((l) => /\[Hold-Release\] 20 \/ 2 \/ g/.test(l)));

    const blocked = multiHeldScenario({ heldOffsetMin: -40, freshNow: 794 });
    const r2 = await quiet(() => swap.run(blocked.ctx));
    assert.equal(r2.result, 1);
    assert.equal(swapCalled(blocked.sb), false);
});

test('P1-1：保留列超過正式表 20% → exit 1、不寫入、不 swap（大量整組歸零不得被保留洗白）', async () => {
    const heldA = mkRows('20', 'g', 150, -20);
    const heldB = mkRows('84', 'h', 101, -20, '8'); // 251 / 1000 = 25.1%
    const fresh = mkRows('40', 'g', 749, 0, '4');
    const prodRows = [...heldA, ...heldB, ...fresh];
    const { sb, ctx } = makeScenario({ prodRows, prodCount: prodRows.length, stagingKeys: keysOf(fresh), stagingCount: fresh.length });
    const { result, lines } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.equal(sb.calls.some((c) => c.has('insert')), false);
    assert.ok(lines.some((l) => /251 rows are held.*> 20% of production 1000/.test(l)));
});

test('checkHeldCap／checkDropRatio(heldRows)：上限剛好 20% 通過、超過即中止；扣除後的分母為 0 不誤擋', () => {
    assert.equal(swap.checkHeldCap(1000, 200), null);
    assert.match(swap.checkHeldCap(1000, 201).message, /201 rows are held/);
    assert.equal(swap.checkHeldCap(0, 0), null);
    assert.equal(swap.checkDropRatio(1000, 794, 186), null); // (814-794)/814 = 2.5%
    assert.match(swap.checkDropRatio(1000, 600, 186).message, /\(814 → 600, excluding 186 held rows\)/);
    assert.equal(swap.checkDropRatio(100, 0, 100), null);
});

test('P1-1 反例檢查：被保留的組不會讓「殘缺的非保留部分」過關——非保留部分仍受同一個 20% 閘', async () => {
    // 保留 186（18.6%），其餘 814 只抓到 600（-26%）：舊閘與新閘都必須擋
    const { sb, ctx } = multiHeldScenario({ heldOffsetMin: -20, freshNow: 600 });
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 1);
    assert.equal(swapCalled(sb), false);
    assert.equal(sb.calls.some((c) => c.has('insert')), false);
});

test('P2-3：抄回的 insert 不重試（safeQuery maxRetries=1），其餘查詢維持預設重試', async () => {
    const seen = [];
    const { sb, ctx } = makeScenario({ prodRows: prodWith(heldGroupRows(-20), -20) });
    ctx.safeQuery = (op, maxRetries) => { seen.push(maxRetries); return op(); };
    const original = sb.from.bind(sb);
    const insertRetries = [];
    sb.from = (table) => {
        const chain = original(table);
        return table === 'available_plates_staging'
            ? new Proxy(chain, { get: (t, prop) => (prop === 'insert' ? (...a) => { insertRetries.push(seen[seen.length - 1]); return t.insert(...a); } : t[prop]) })
            : chain;
    };
    const { result } = await quiet(() => swap.run(ctx));
    assert.equal(result, 0);
    assert.deepEqual(insertRetries, [1]);
    assert.ok(seen.includes(1) && seen.some((v) => v === undefined));
});
