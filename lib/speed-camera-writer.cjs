'use strict';

/**
 * 測速照相「真寫入模式」純函式邏輯——單一真理來源。
 *
 * 對應正式表 public.speed_cameras（direction not null default ''，
 * unique 鍵 = (source, address, direction)，見 D2 決議：正式版已移至
 * TeslaToolbox/supabase/migrations）。
 *
 * 這裡只放「不碰 supabase client」的純函式：payload 組裝、stale 判定。
 * 真正的 upsert/delete 由 speed-camera-sync.cjs 呼叫 supabase client 執行。
 */

/**
 * 把 parser 輸出的單筆正規化紀錄轉成可 upsert 的 DB payload。
 * - direction 為 null/undefined 時正規化成空字串（DB 欄位 not null default ''）。
 * - 一律加上 updated_at（本輪批次時間戳，用來判定 stale）。
 *
 * @param {object} record parser 輸出：{ city, address, road, direction, speed_limit, lat, lng, source, fetched_at }
 * @param {string} updatedAt ISO timestamp（本輪批次時間戳）
 * @returns {object} DB upsert payload
 */
function toUpsertPayload(record, updatedAt) {
  return {
    city: record.city,
    address: record.address,
    road: record.road ?? null,
    direction: record.direction ?? '',
    speed_limit: record.speed_limit ?? null,
    lat: record.lat ?? null,
    lng: record.lng ?? null,
    source: record.source,
    fetched_at: record.fetched_at,
    updated_at: updatedAt,
  };
}

/**
 * 批次轉換：records → upsert payload 陣列。
 * @param {object[]} records
 * @param {string} updatedAt
 * @returns {object[]}
 */
function toUpsertPayloads(records, updatedAt) {
  return records.map((r) => toUpsertPayload(r, updatedAt));
}

/**
 * 判斷某列是否為「本輪批次之前」寫入的 stale 資料（同一 source 底下，
 * fetched_at 早於本輪批次時間戳者，代表來源資料已移除該筆，須清除）。
 *
 * @param {string} rowFetchedAt 既有列的 fetched_at（ISO string）
 * @param {string} batchFetchedAt 本輪批次時間戳（ISO string）
 * @returns {boolean}
 */
function isStale(rowFetchedAt, batchFetchedAt) {
  if (!rowFetchedAt) return true;
  return new Date(rowFetchedAt).getTime() < new Date(batchFetchedAt).getTime();
}

/**
 * 組出 DB 既有座標查詢用的 key（同 upsert unique 鍵 (source, address, direction)）。
 * direction 正規化成空字串規則需與 toUpsertPayload 一致，否則對不上既有列。
 * @param {string} source
 * @param {string} address
 * @param {string|null|undefined} direction
 * @returns {string}
 */
function coordLookupKey(source, address, direction) {
  return `${source} ${address} ${direction ?? ''}`;
}

/**
 * 幫缺座標（lat/lng 皆 null）的紀錄補值：
 *   1. 先查 existingCoordsByKey（DB 既有同 (source,address,direction) 列的座標）——
 *      已有座標者直接沿用，絕不重複 geocode。
 *   2. 其餘缺座標紀錄才呼叫 geocodeFn（真實或 mock），最多處理 maxGeocodeCalls 筆
 *      （單輪上限，避免無節制打 Nominatim）。
 *   3. geocode 查無結果或失敗（geocodeFn 回傳 null）：該筆留 null，不視為錯誤，
 *      呼叫端(speed-camera-sync.cjs) 不會因此把整個 source 標記失敗。
 *   4. 超過 maxGeocodeCalls 的缺座標紀錄本輪不處理，留 null，下一輪批次再補
 *      （下一輪若 DB 已有其他來源/人工補值的同址座標，會在步驟 1 直接沿用）。
 *
 * @param {object[]} records parser 輸出的正規化紀錄（可能混雜已有座標與缺座標的）
 * @param {Map<string, {lat: number, lng: number}>} existingCoordsByKey coordLookupKey → 座標
 * @param {(address: string) => Promise<{lat: number, lng: number}|null>} geocodeFn
 * @param {number} maxGeocodeCalls 單輪最多呼叫 geocodeFn 次數
 * @returns {Promise<{ records: object[], geocodeAttempted: number, geocodeSucceeded: number, reusedFromDb: number, skippedOverCap: number }>}
 */
async function fillMissingCoords(records, existingCoordsByKey, geocodeFn, maxGeocodeCalls) {
  let geocodeAttempted = 0;
  let geocodeSucceeded = 0;
  let reusedFromDb = 0;
  let skippedOverCap = 0;

  const filled = [];
  for (const record of records) {
    if (record.lat != null && record.lng != null) {
      filled.push(record);
      continue;
    }

    const key = coordLookupKey(record.source, record.address, record.direction);
    const existing = existingCoordsByKey.get(key);
    if (existing && existing.lat != null && existing.lng != null) {
      reusedFromDb++;
      filled.push({ ...record, lat: existing.lat, lng: existing.lng });
      continue;
    }

    if (geocodeAttempted >= maxGeocodeCalls) {
      skippedOverCap++;
      filled.push(record);
      continue;
    }

    geocodeAttempted++;
    const result = await geocodeFn(record.address);
    if (result) {
      geocodeSucceeded++;
      filled.push({ ...record, lat: result.lat, lng: result.lng });
    } else {
      filled.push(record);
    }
  }

  return { records: filled, geocodeAttempted, geocodeSucceeded, reusedFromDb, skippedOverCap };
}

module.exports = {
  toUpsertPayload,
  toUpsertPayloads,
  isStale,
  coordLookupKey,
  fillMissingCoords,
};
