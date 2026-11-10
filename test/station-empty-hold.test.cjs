'use strict';

// 單站（車種）整組歸零守門（健檢 C12／O3）。lib/station-empty-hold.cjs 的純函式 + 假 client 的 I/O 包裝。
// ⛔ 全程假資料、不連網路。run() 層級的整合測試在 test/trigger-swap.test.cjs。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    HOLD_MIN_PREV_ROWS,
    HOLD_RELEASE_MS,
    planEmptyGroupHold,
    fetchAllProdRows,
    planHoldFromDb,
    commitHold,
} = require('../lib/station-empty-hold.cjs');
const { createFakeSupabase } = require('./helpers/fake-supabase.cjs');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-10T11:00:00Z');
const iso = (offsetMin) => new Date(T0 + offsetMin * MIN).toISOString();

// 正式表一組：n 筆、同一個 updated_at
function prodGroup(station, type, n, updatedOffsetMin, region = '2') {
    return Array.from({ length: n }, (_, i) => ({
        id: `id-${station}-${type}-${i}`,
        station_id: station, station_name: `站${station}`, region_id: region, plate_type: type,
        window_id: '01', plate_no: `${station}${type}${i}`, price: 2000, status: 'AVAILABLE',
        updated_at: iso(updatedOffsetMin),
    }));
}
function stagingKeysFor(rows) {
    return rows.map((r) => ({ station_id: r.station_id, region_id: r.region_id, plate_type: r.plate_type, plate_no: r.plate_no }));
}

test('常數：門檻 30 分——第 2 次（≤20 分）必保留、第 3 次（≈40 分）放行', () => {
    assert.equal(HOLD_MIN_PREV_ROWS, 3);
    assert.equal(HOLD_RELEASE_MS, 30 * MIN);
    // 爬取週期 20 分：第 2 次 age ≤ 20 < 30（最舊參考點只會讓 age 更小）；第 3 次 age ≈ 40 − 偏移，偏移 ≤ 10 分即放行
    const cycle = 20;
    assert.ok(cycle < 30 && 2 * cycle >= 30);
});

test('正常波動不觸發：組內仍有資料（含大幅下降）、全數相同、新增', () => {
    const prod = [...prodGroup('20', 'g', 50, -20), ...prodGroup('20', 'h', 10, -20)];
    // g 從 50 掉到 21（真實事件 10/28）、h 不變
    const staging = stagingKeysFor([...prod.filter((r) => r.plate_type === 'g').slice(0, 21), ...prod.filter((r) => r.plate_type === 'h')]);
    const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: staging });
    assert.deepEqual(plan, { hold: [], release: [], restoreRows: [], heldRows: 0 });
});

test('整組歸零觸發：把正式表該組原樣抄回（去掉 id、保留舊 updated_at），其他組不動', () => {
    const g = prodGroup('20', 'g', 50, -20);
    const h = prodGroup('20', 'h', 10, -20);
    const other = prodGroup('21', 'g', 10, -20);
    const plan = planEmptyGroupHold({ prodRows: [...g, ...h, ...other], stagingKeys: stagingKeysFor([...h, ...other]) });
    assert.equal(plan.hold.length, 1);
    assert.equal(plan.hold[0].key, '20|2|g');
    assert.equal(plan.hold[0].prevRows, 50);
    assert.equal(plan.release.length, 0);
    assert.equal(plan.restoreRows.length, 50);
    assert.equal(plan.heldRows, 50);
    assert.ok(plan.restoreRows.every((r) => !('id' in r) && r.plate_type === 'g' && r.station_id === '20'));
    assert.ok(plan.restoreRows.every((r) => r.updated_at === g[0].updated_at), '必須保留舊 updated_at（它就是已保留多久的紀錄）');
});

test('整站消失（兩個車種都不在 staging）→ 兩組都保留', () => {
    const rows = [...prodGroup('52', 'g', 14, -20, '5'), ...prodGroup('52', 'h', 23, -20, '5'), ...prodGroup('51', 'g', 10, -20, '5')];
    const plan = planEmptyGroupHold({ prodRows: rows, stagingKeys: stagingKeysFor(rows.filter((r) => r.station_id === '51')) });
    assert.deepEqual(plan.hold.map((h) => h.key).sort(), ['52|5|g', '52|5|h']);
    assert.equal(plan.restoreRows.length, 37);
});

test('連續 3 輪：第 1、2 次保留，第 3 次放行（模擬 swap 前進）', () => {
    // 以「上一次 swap 的爬取時間＝正式表最新 updated_at」推進；其他組每輪都被刷新成該輪時間。
    let prod = [...prodGroup('20', 'g', 5, 0), ...prodGroup('21', 'g', 10, 0)];
    const results = [];
    for (let round = 1; round <= 4; round++) {
        const crawlMin = round * 20;
        const fresh = prodGroup('21', 'g', 10, crawlMin); // 21 站正常、被刷新
        const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: stagingKeysFor(fresh) });
        results.push({ hold: plan.hold.length, release: plan.release.length, ageMin: ((plan.hold[0] || plan.release[0] || {}).ageMs) / MIN });
        // swap：staging(fresh + 抄回) 取代正式表（放行的組就此消失）
        prod = [...fresh, ...plan.restoreRows];
    }
    assert.deepEqual(results.map((r) => [r.hold, r.release]), [[1, 0], [1, 0], [0, 1], [0, 0]]);
    assert.equal(results[0].ageMin, 0);
    assert.equal(results[1].ageMin, 20);
    assert.equal(results[2].ageMin, 40);
});

test('放行門檻邊界：age 剛好 30 分放行、29 分 59 秒保留', () => {
    const planAt = (freshOffsetMin) => planEmptyGroupHold({
        prodRows: [...prodGroup('20', 'g', 5, 0), ...prodGroup('21', 'g', 10, freshOffsetMin)],
        stagingKeys: stagingKeysFor(prodGroup('21', 'g', 10, 99)),
    });
    assert.equal(planAt(30).release.length, 1);
    assert.equal(planAt(30).hold.length, 0);
    assert.equal(planAt(29.98).hold.length, 1);
});

test('參考點取「本輪有資料的組」中最舊者：上一輪慢輪（組間差 40 分）時，第一次回空仍保留', () => {
    // 上一輪從頭爬到尾拖了 40 分：20 組在輪頭（0）、22 組在輪尾（40）、21 組在中間。
    // 若參考點用「全表最新」(40)，20 組第一次回空就 age=40 被放行；用最舊的有資料組 (21 組=0) → age=0 保留。
    const prod = [...prodGroup('20', 'g', 5, 0), ...prodGroup('21', 'g', 10, 0), ...prodGroup('22', 'g', 10, 40)];
    const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: stagingKeysFor([...prodGroup('21', 'g', 10, 99), ...prodGroup('22', 'g', 10, 99)]) });
    assert.equal(plan.hold.length, 1);
    assert.equal(plan.release.length, 0);
    assert.equal(plan.hold[0].ageMs, 0);
});

test('整站 g+h 同時被保留：不互相參照，仍在有限輪數後一起放行', () => {
    let prod = [...prodGroup('52', 'g', 14, 0, '5'), ...prodGroup('52', 'h', 23, 0, '5'), ...prodGroup('51', 'g', 10, 0, '5')];
    const seen = [];
    for (let round = 1; round <= 5; round++) {
        const fresh = prodGroup('51', 'g', 10, round * 20, '5');
        const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: stagingKeysFor(fresh) });
        seen.push([plan.hold.length, plan.release.length]);
        prod = [...fresh, ...plan.restoreRows];
    }
    assert.deepEqual(seen, [[2, 0], [2, 0], [0, 2], [0, 0], [0, 0]]);
});

test('首次出現的新站：staging 有、正式表沒有 → 不是本守門的事（不抄、不放行）', () => {
    const newStation = prodGroup('90', 'g', 5, 0);
    const plan = planEmptyGroupHold({ prodRows: prodGroup('21', 'g', 10, 0), stagingKeys: stagingKeysFor([...newStation, ...prodGroup('21', 'g', 10, 0)]) });
    assert.deepEqual(plan, { hold: [], release: [], restoreRows: [], heldRows: 0 });
});

test('staging 本來就沒有該站、正式表也沒有 → 什麼都不做（如連江 g、臺東 g 的常態 NoData）', () => {
    const prod = prodGroup('28', 'h', 10, 0); // 連江只有 h；g 組在正式表不存在
    const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: stagingKeysFor(prod) });
    assert.deepEqual(plan, { hold: [], release: [], restoreRows: [], heldRows: 0 });
});

test('小組（< 3 筆）自然售完很常見：不守門，維持原行為', () => {
    const prod = [...prodGroup('83', 'g', 1, 0), ...prodGroup('33', 'g', 2, 0), ...prodGroup('21', 'g', 10, 0)];
    const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: stagingKeysFor(prodGroup('21', 'g', 10, 0)) });
    assert.deepEqual(plan, { hold: [], release: [], restoreRows: [], heldRows: 0 });
    // 剛好 3 筆就要守門
    const three = planEmptyGroupHold({ prodRows: [...prodGroup('82', 'g', 3, 0), ...prodGroup('21', 'g', 10, 0)], stagingKeys: stagingKeysFor(prodGroup('21', 'g', 10, 0)) });
    assert.equal(three.hold.length, 1);
});

test('抄回時跳過 staging 別組已有的同號牌（避免正式表出現同牌兩列）', () => {
    const g = prodGroup('20', 'g', 4, 0);
    const moved = { station_id: '40', region_id: '4', plate_type: 'g', plate_no: g[0].plate_no }; // 同號牌換站出現
    const plan = planEmptyGroupHold({ prodRows: [...g, ...prodGroup('21', 'g', 10, 0)], stagingKeys: [moved, ...stagingKeysFor(prodGroup('21', 'g', 10, 0))] });
    assert.equal(plan.hold.length, 1);
    assert.equal(plan.restoreRows.length, 3);
    assert.ok(plan.restoreRows.every((r) => r.plate_no !== g[0].plate_no));
});

test('時鐘無效（updated_at 缺或壞）→ 不無限保留，放行（維持舊行為）', () => {
    const g = prodGroup('20', 'g', 5, 0).map((r) => ({ ...r, updated_at: null }));
    const plan = planEmptyGroupHold({ prodRows: [...g, ...prodGroup('21', 'g', 10, 0)], stagingKeys: stagingKeysFor(prodGroup('21', 'g', 10, 0)) });
    assert.equal(plan.hold.length, 0);
    assert.equal(plan.release.length, 1);
    assert.equal(plan.release[0].reason, 'no-clock');
});

test('全線停擺後第一輪：放行時鐘看正式表而不是 now，不會因牆鐘過久而一次放行', () => {
    // 正式表 3 小時前的資料；現在（牆鐘）才恢復。該組回空：age = prodMax - groupMax = 0 → 保留
    const prod = [...prodGroup('20', 'g', 5, -180), ...prodGroup('21', 'g', 10, -180)];
    const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: stagingKeysFor(prodGroup('21', 'g', 10, 0)) });
    assert.equal(plan.hold.length, 1);
    assert.equal(plan.release.length, 0);
});

test('fetchAllProdRows：超過 1000 列要分頁讀完；錯誤與非陣列都回 error', async () => {
    const all = Array.from({ length: 2300 }, (_, i) => ({ id: i, station_id: '1', region_id: '1', plate_type: 'g', plate_no: `P${i}`, updated_at: iso(0) }));
    const ranges = [];
    const sb = createFakeSupabase((call) => {
        const [from, to] = call.arg('range', 0) === undefined ? [0, 0] : call.ops.find((o) => o.name === 'range').args;
        ranges.push([from, to]);
        return { data: all.slice(from, to + 1) };
    });
    const { rows, error } = await fetchAllProdRows(sb, (op) => op());
    assert.equal(error, null);
    assert.equal(rows.length, 2300);
    assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);

    const bad = await fetchAllProdRows(createFakeSupabase(() => ({ data: null, error: { message: 'boom' } })), (op) => op());
    assert.equal(bad.rows, null);
    assert.equal(bad.error.message, 'boom');
    const noArray = await fetchAllProdRows(createFakeSupabase(() => ({ count: 5 })), (op) => op());
    assert.equal(noArray.rows, null);
    assert.match(noArray.error.message, /no data array/);
});

test('保留時鐘只在 swap 成功時前進：swap 被其他原因擋下期間 age 凍結、恢復後正常放行', () => {
    let prod = [...prodGroup('20', 'g', 5, 0), ...prodGroup('21', 'g', 10, 0)];
    const swapOk = [true, false, false, true, true]; // 第 2、3 輪 swap 被別的守門擋下
    const log = [];
    swapOk.forEach((ok, i) => {
        const crawlMin = (i + 1) * 20;
        const fresh = prodGroup('21', 'g', 10, crawlMin);
        const plan = planEmptyGroupHold({ prodRows: prod, stagingKeys: stagingKeysFor(fresh) });
        log.push({ hold: plan.hold.length, release: plan.release.length, ageMin: ((plan.hold[0] || plan.release[0]).ageMs) / MIN });
        if (ok) prod = [...fresh, ...plan.restoreRows]; // 擋下的輪次：正式表不動
    });
    assert.deepEqual(log.map((l) => [l.hold, l.release]), [[1, 0], [1, 0], [1, 0], [1, 0], [0, 1]]);
    assert.deepEqual(log.slice(0, 4).map((l) => l.ageMin), [0, 20, 20, 20], '被擋的輪次 age 凍結在 20，不會因牆鐘或重試次數累加');
});

test('多組同時回空：heldRows 為各保留組正式表列數總和（放行的組不計）', () => {
    const a = prodGroup('20', 'g', 50, 0);
    const b = prodGroup('84', 'h', 48, 0, '8');
    const rel = prodGroup('52', 'h', 23, -60, '5'); // 已放行
    const fresh = prodGroup('21', 'g', 10, 0);
    const plan = planEmptyGroupHold({ prodRows: [...a, ...b, ...rel, ...fresh], stagingKeys: stagingKeysFor(fresh) });
    assert.equal(plan.hold.length, 2);
    assert.equal(plan.release.length, 1);
    assert.equal(plan.heldRows, 98);
});

test('planHoldFromDb：只讀不寫；有 ::warning::[Hold] log；讀失敗回 error（fail-closed）', async () => {
    const g = prodGroup('20', 'g', 5, -20);
    const rest = prodGroup('21', 'g', 10, 0);
    const sb = createFakeSupabase((call) => (call.table === 'available_plates' ? { data: [...g, ...rest] } : { data: [] }));
    const lines = [];
    const out = await planHoldFromDb({ supabase: sb, safeQuery: (op) => op(), stagingKeys: stagingKeysFor(rest), log: (m) => lines.push(m) });
    assert.equal(out.error, null);
    assert.equal(out.plan.hold.length, 1);
    assert.equal(out.plan.restoreRows.length, 5);
    assert.equal(sb.calls.some((c) => c.has('insert')), false, '計畫階段不寫入');
    assert.ok(lines.some((l) => l.startsWith('::warning::[Hold]')));

    const bad = await planHoldFromDb({
        supabase: createFakeSupabase(() => ({ data: null, error: { message: 'read boom' } })),
        safeQuery: (op) => op(), stagingKeys: stagingKeysFor(rest), log: () => {},
    });
    assert.equal(bad.error.message, 'read boom');
    assert.equal(bad.plan, null);
});

test('commitHold：單一 insert 抄回；沒有要抄的就不寫入；寫入失敗回 error', async () => {
    const plan = { restoreRows: prodGroup('20', 'g', 5, -20).map(({ id: _id, ...r }) => r) };
    let inserted = null;
    const ok = createFakeSupabase((call) => { inserted = call.arg('insert'); return { data: null }; });
    assert.deepEqual(await commitHold({ supabase: ok, safeQuery: (op) => op(), plan }), { error: null, restored: 5 });
    assert.equal(inserted.length, 5);
    assert.equal(ok.calls.filter((c) => c.has('insert')).length, 1);

    const none = createFakeSupabase(() => ({ data: null }));
    assert.deepEqual(await commitHold({ supabase: none, safeQuery: (op) => op(), plan: { restoreRows: [] } }), { error: null, restored: 0 });
    assert.equal(none.calls.length, 0);

    const fail = createFakeSupabase(() => ({ data: null, error: { message: 'write boom' } }));
    const out = await commitHold({ supabase: fail, safeQuery: (op) => op(), plan });
    assert.equal(out.error.message, 'write boom');
    assert.equal(out.restored, 0);
});
