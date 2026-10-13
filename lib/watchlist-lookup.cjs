'use strict';

// 收藏清單批次查詢：一次把指定 source 的 watchlist 全撈回來，再在記憶體依 plate_no 分組。
// 取代「每張牌各查一次 watchlist」的 N+1 寫法——那會每天打 3.8 萬次 PostgREST，
// 佔了 Supabase 每日 API 閘道日誌的三分之二（2026-10-13 Log Ingestion 超過免費額度 135%）。
// watchlist 是使用者收藏，量級遠小於車牌數；分頁以避開 max-rows=1000 截斷。

const PAGE_SIZE = 1000;

async function fetchWatchesByPlate(supabase, source, plateNos) {
  const wanted = new Set((plateNos || []).filter(Boolean));
  const byPlate = new Map();
  if (wanted.size === 0) return byPlate;

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('watchlist')
      .select('*')
      .eq('source', source)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`watchlist fetch failed: ${error.message}`);

    for (const watch of data || []) {
      if (!wanted.has(watch.plate_no)) continue;
      if (!byPlate.has(watch.plate_no)) byPlate.set(watch.plate_no, []);
      byPlate.get(watch.plate_no).push(watch);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return byPlate;
}

module.exports = { fetchWatchesByPlate, PAGE_SIZE };
