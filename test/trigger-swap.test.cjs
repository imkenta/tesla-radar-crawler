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
            if (call.has('range')) {
                const [from, to] = call.ops.find((op) => op.name === 'range').args;
                return { data: o.stagingKeys.slice(from, to + 1) };
            }
            return { count: o.stagingCount };
        }
        if (call.table === 'available_plates') return { count: o.prodCount };
        if (call.table === 'plate_changes') { notified.sold++; return { data: null, error: { message: 'none' } }; }
        return { data: [] };
    });
    const ctx = { supabase: sb, safeQuery: (op) => op(), sendEmail: async () => true, now: () => NOW };
    return { sb, ctx, notified };
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
