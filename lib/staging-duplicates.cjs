// staging 重複鍵檢查（2026-10-14）：同一張牌被兩個 writer（primary＋誤接手的備援機）
// 各寫一次時，筆數只會「上升」，trigger_swap 的下降閘擋不到，10/13 因此把每張牌
// 兩筆的資料 swap 上線。swap 前以 (station_id, region_id, plate_type, plate_no) 檢查。
const STAGING_KEY_COLUMNS = 'station_id, region_id, plate_type, plate_no';
// PostgREST max-rows=1000 會靜默截斷，一律用 range 分頁讀完。
const PAGE_SIZE = 1000;

function stagingRowKey(row) {
    return [row.station_id, row.region_id, row.plate_type, row.plate_no].join('|');
}

function findDuplicateKeys(rows) {
    const counts = new Map();
    for (const row of rows) {
        const k = stagingRowKey(row);
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts].filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, count: n }));
}

async function fetchAllStagingKeys(supabase, safeQuery) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await safeQuery(() => supabase
            .from('available_plates_staging')
            .select(STAGING_KEY_COLUMNS)
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1));
        if (error) return { rows: null, error };
        rows.push(...data);
        if (data.length < PAGE_SIZE) return { rows, error: null };
    }
}

module.exports = { findDuplicateKeys, fetchAllStagingKeys, stagingRowKey };
