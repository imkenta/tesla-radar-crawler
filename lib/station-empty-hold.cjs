'use strict';

/**
 * 單站（車種）整組歸零守門（2026-11-10 健檢 C12／O3）。
 *
 * 問題：gh-plate-sync.cjs 把「某站某車種回 0 筆」當成功（NoData 在連江 g、臺東 g 等站是常態，不能判失敗）。
 * 若是抓取異常（頁面改版、被擋後回空頁），該組車牌就從 staging 缺席 → swap_plates_data() 的
 * REMOVED diff 把它們全部當成「已售出」→ 對收藏者寄假通知。單組只佔全量 ≤10%，過不了 20% 下降閘。
 *
 * 做法（swap 前、trigger_swap.cjs 呼叫）：
 *   正式表 available_plates 某組 (station_id, region_id, plate_type) 有 ≥ HOLD_MIN_PREV_ROWS 筆，
 *   而本輪 staging 該組 0 筆 → 把正式表該組「原樣抄回 staging」（保留舊 updated_at），
 *   swap 的 diff 看到的就是「沒變」，不會 REMOVED、不會寄信。
 *
 * 不新增任何狀態：已保留多久，直接由被抄回那組的 updated_at 表示（swap 會原樣帶過去）。
 * 放行時鐘用「正式表裡、本輪 staging 仍有資料的各組，其 updated_at 取最舊者」當參考點（ref），而不是 now：
 *   age = ref − 該組自己的最新 updated_at。每個「真的有換上線」的輪次 age 增加約一個爬取週期（20 分）；
 *   全線停擺後的第一輪不會因為牆鐘過了很久就一次放行。
 *   取「最舊」是刻意偏向多保留：同輪內各組爬取時間不同（實測 6443 輪：spread p50 6.8／p95 14.3／max 30.9 分），
 *   用最新的 updated_at 當參考會讓早爬的組在慢輪提早放行；用最舊者誤差只會偏向多保留一輪。
 *   參考點只取「本輪有資料」的組——被保留中的組不會互相參照而永遠卡住。
 *   age ≥ HOLD_RELEASE_MS 才接受歸零（真的售完的組不會永遠卡住）。
 *
 * 這道守門要保護的不可逆後果（trigger_swap.cjs processSoldNotifications）：寄出「已售出」信後，
 * 會把該使用者的 watchlist 紀錄刪掉。所以假售出不只是一封錯信——使用者的收藏也跟著消失，無法復原。
 *
 * 已知降級：放行時鐘靠「成功 swap 的間隔」前進。若兩次成功 swap 之間隔了 ≥30 分（輪次被其他守門擋下、
 * 或排程停擺後恢復），一個才剛開始回空的組，第 2 次回空就會放行（第 1 次回空仍必保留）。
 * 這是無新增狀態的取捨，下限仍是「至少連續 2 次回空」。
 *
 * 與下降閘的關係（trigger_swap.cjs）：被保留的組本輪不會被移除，所以下降閘的分子分母都扣掉保留列
 * （否則保留期間多組合計接近 20% 時，再有一點淨降就被擋 → 不 swap → 時鐘不前進 → 保留永不到期而卡死）；
 * 同時保留列總數有上限（MAX_DROP_RATIO × 正式表），超過就 exit 1 讓人來看，避免大量整組歸零被保留「洗白」。
 *
 * 純函式 + 薄的 I/O 包裝（planHoldFromDb 讀、commitHold 寫）；測試見 test/station-empty-hold.test.cjs。
 */

// 組內正式表至少幾筆才守門。⚠️ 這是判斷，不是資料推出的：sync_logs 只有「站合計」、plate_changes 沒有車種且只留 3 天，
// 拿不到車種層級的歷史。已知：站合計 90 天 191,660 筆 SUCCESS 觀察零次為 0；正式表 55 組中 1～2 筆的組有 3 組
// （33g、83g、21h），這種組自然賣完是常態，守門只會平白延後通知，故排除；≥3 筆者整組同輪消失視為可疑。
const HOLD_MIN_PREV_ROWS = 3;

// 放行門檻 30 分。爬取週期 20 分（外部排程，實測 :04/:24/:44 起跑）。參考點取最舊者（見檔頭），
// 使 age ≈ 20×(第幾次回空−1) − 該組在上一輪內相對輪起點的偏移（0～spread，通常 <15 分，最大 31 分）：
//   第 1 次：≈0 → 保留；第 2 次：≤20 → 保留（< 30，即使慢輪也不會提早放行）；
//   第 3 次：≈40−偏移 ≥ 30（偏移 ≤10 分，約八成以上的輪次）→ 放行；偏移較大才延到第 4 次（60−31 ≥ 30 必放行）。
// 即「連續 3 輪（偶爾 4 輪）都回空才接受」：保留 2～3 輪、約 40～60 分鐘延遲。
const HOLD_RELEASE_MS = 30 * 60 * 1000;

const PROD_COLUMNS = 'station_id, station_name, region_id, plate_type, window_id, plate_no, price, status, updated_at';
// PostgREST max-rows=1000 會靜默截斷，一律分頁讀完。
const PAGE_SIZE = 1000;

function groupKey(row) {
    return [row.station_id, row.region_id, row.plate_type].join('|');
}

function toMs(value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : NaN;
}

/**
 * @param {object} input
 * @param {Array<object>} input.prodRows     正式表所有列（含 updated_at 與寫回需要的欄位）
 * @param {Array<object>} input.stagingKeys  本輪 staging 的 {station_id, region_id, plate_type, plate_no}
 * @param {number} [input.minPrevRows]
 * @param {number} [input.releaseMs]
 * @returns {{hold: Array, release: Array, restoreRows: Array, heldRows: number}}
 *   hold:    [{key, prevRows, ageMs}]             —— 本輪保留（把正式表該組抄回 staging）
 *   release: [{key, prevRows, ageMs, reason}]     —— 已連續歸零夠久（或沒有可用時鐘），接受歸零
 *   restoreRows: 要插回 staging 的列（已去掉 id；已排除 staging 內別組已有的同號牌）
 *   heldRows: 被保留的各組在正式表的列數總和（下降閘分子分母要扣掉的數字）
 */
function planEmptyGroupHold({ prodRows, stagingKeys, minPrevRows = HOLD_MIN_PREV_ROWS, releaseMs = HOLD_RELEASE_MS }) {
    const stagingGroupCounts = new Map();
    const stagingPlates = new Set();
    for (const r of stagingKeys) {
        const k = groupKey(r);
        stagingGroupCounts.set(k, (stagingGroupCounts.get(k) || 0) + 1);
        stagingPlates.add(r.plate_no);
    }

    const prodGroups = new Map();
    for (const r of prodRows) {
        const k = groupKey(r);
        if (!prodGroups.has(k)) prodGroups.set(k, []);
        prodGroups.get(k).push(r);
    }
    const maxMs = (rows) => {
        let m = NaN;
        for (const r of rows) {
            const t = toMs(r.updated_at);
            if (Number.isFinite(t) && (!Number.isFinite(m) || t > m)) m = t;
        }
        return m;
    };

    // 參考點：本輪 staging 仍有資料的各組（正式表端）的最新 updated_at 之中最舊的那個。
    let refMs = NaN;
    for (const [key, rows] of prodGroups) {
        if ((stagingGroupCounts.get(key) || 0) === 0) continue;
        const t = maxMs(rows);
        if (Number.isFinite(t) && (!Number.isFinite(refMs) || t < refMs)) refMs = t;
    }

    const hold = [];
    const release = [];
    const restoreRows = [];

    for (const [key, rows] of prodGroups) {
        if (rows.length < minPrevRows) continue; // 小組：維持原行為
        if ((stagingGroupCounts.get(key) || 0) > 0) continue; // 本輪有資料（含部分下降）：不在本守門範圍

        const groupMaxMs = maxMs(rows);
        // 沒有可用時鐘：不能無限保留（會讓售完的組永遠卡住），維持舊行為＝接受歸零。
        if (!Number.isFinite(refMs) || !Number.isFinite(groupMaxMs)) {
            release.push({ key, prevRows: rows.length, ageMs: NaN, reason: 'no-clock' });
            continue;
        }
        const ageMs = refMs - groupMaxMs;
        if (ageMs >= releaseMs) {
            release.push({ key, prevRows: rows.length, ageMs, reason: 'consecutive-empty' });
            continue;
        }
        hold.push({ key, prevRows: rows.length, ageMs });
        for (const r of rows) {
            if (stagingPlates.has(r.plate_no)) continue; // 同號牌已在別組出現（換站）：不重複塞
            const { id: _id, ...rest } = r;
            restoreRows.push(rest);
        }
    }
    const heldRows = hold.reduce((sum, h) => sum + h.prevRows, 0);
    return { hold, release, restoreRows, heldRows };
}

async function fetchAllProdRows(supabase, safeQuery) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await safeQuery(() => supabase
            .from('available_plates')
            .select(PROD_COLUMNS)
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1));
        if (error) return { rows: null, error };
        if (!Array.isArray(data)) return { rows: null, error: { message: 'available_plates read returned no data array' } };
        rows.push(...data);
        if (data.length < PAGE_SIZE) return { rows, error: null };
    }
}

const fmtMin = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 60000)} 分` : '無時鐘');

/**
 * 第一步（只讀）：讀正式表、算保留計畫、印 log。fail-closed：讀失敗回 {error}。
 * 不寫入——下降閘與保留上限要先看 plan.heldRows 再決定要不要 commit。
 *
 * @returns {Promise<{error: object|null, plan: object|null}>}
 */
async function planHoldFromDb({ supabase, safeQuery, stagingKeys, log = console.log }) {
    const { rows: prodRows, error } = await fetchAllProdRows(supabase, safeQuery);
    if (error) return { error, plan: null };
    const plan = planEmptyGroupHold({ prodRows, stagingKeys });

    for (const h of plan.hold) {
        log(`::warning::[Hold] ${h.key.replace(/\|/g, ' / ')} 本輪回空，但正式表有 ${h.prevRows} 筆（距最後一次有資料 ${fmtMin(h.ageMs)}）：沿用上一輪資料、不替換，避免誤發「已售出」通知；連續空 ${Math.round(HOLD_RELEASE_MS / 60000)} 分鐘以上才接受。`);
    }
    for (const r of plan.release) {
        log(`[Hold-Release] ${r.key.replace(/\|/g, ' / ')} 已連續回空（正式表 ${r.prevRows} 筆，距最後一次有資料 ${fmtMin(r.ageMs)}，${r.reason}）：接受歸零，交給 swap 移除。`);
    }
    return { error: null, plan };
}

/**
 * 第二步（寫）：把保留的列單一 insert 抄回 staging。
 * 此 insert 不冪等，呼叫端必須傳「不重試」的 safeQuery（trigger_swap 傳 maxRetries=1）：
 * 重試若發生在「已寫入但回應遺失」就會寫出重複列。失敗一律回 {error}（fail-closed）。
 */
async function commitHold({ supabase, safeQuery, plan }) {
    if (plan.restoreRows.length === 0) return { error: null, restored: 0 };
    const { error } = await safeQuery(() => supabase.from('available_plates_staging').insert(plan.restoreRows));
    if (error) return { error, restored: 0 };
    return { error: null, restored: plan.restoreRows.length };
}

module.exports = {
    HOLD_MIN_PREV_ROWS,
    HOLD_RELEASE_MS,
    planEmptyGroupHold,
    fetchAllProdRows,
    planHoldFromDb,
    commitHold,
};
