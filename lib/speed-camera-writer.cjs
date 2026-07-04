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

module.exports = {
  toUpsertPayload,
  toUpsertPayloads,
  isStale,
};
