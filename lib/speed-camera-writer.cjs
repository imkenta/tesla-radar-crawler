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
    // 台南地址（如「北區 公園路和北安路口」）缺市級上下文，同名路名（中正路、中山路口
    // 等全台皆有）容易被 Nominatim 誤配到其他縣市甚至國外。僅台南來源補「臺南市」前綴
    // 消歧義；其餘 source 的地址本身格式各異，不在此處統一加前綴（會誤傷其他來源）。
    const geocodeQuery = record.source === 'tainan' ? `臺南市${record.address}` : record.address;
    const result = await geocodeFn(geocodeQuery);
    if (result) {
      geocodeSucceeded++;
      filled.push({ ...record, lat: result.lat, lng: result.lng });
    } else {
      filled.push(record);
    }
  }

  return { records: filled, geocodeAttempted, geocodeSucceeded, reusedFromDb, skippedOverCap };
}

const EARTH_RADIUS_M = 6371000;

/**
 * 兩座標點的 haversine 距離（公尺）。
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(a));
}

/**
 * 全國集（national-npa）跨 source 執行期聯集去重：與「既有點位」（本輪其他六個自建源
 * 的解析輸出，含台南 geocode 補值後的座標）座標距離 ≤ thresholdMeters 者視為同一支，
 * 予以丟棄；其餘（全國集獨有點位）保留。
 *
 * 設計取捨（見 docs/speed-camera-sources.md「全國集接入」章節）：
 * - 只比對座標，不比對 direction/拍攝方向——各 source 的方向欄位語意與格式完全不統一
 *   （如台北「南北雙向」vs 高雄「北向南」vs 桃園「往桃園市區方向」），沒有共通詞彙可
 *   語意比對，勉強比對反而容易把同一支測速但描述用詞不同的點誤判為「不同支」而漏丟
 *   重複點；純距離判斷更保守也更不會漏丟真正的重複。
 * - existingPoints 沒有座標（lat/lng 為 null）的既有紀錄，一律視為「無法比對」，不會
 *   與任何全國集點位匹配到，全國集該筆保留（寧可保留疑似重複也不錯殺獨有點位）。
 * - 缺座標（lat/lng 為 null）的全國集紀錄本身也保留原樣（不太可能發生，parser 已過濾
 *   掉座標欄位無法解析的列，但仍防禦處理）。
 *
 * @param {object[]} nationalRecords 全國集 parser 輸出（正規化紀錄，含 lat/lng）
 * @param {Array<{lat: number, lng: number}>} existingPoints 本輪其他六個自建源已解析（含 geocode 補值後）的座標點位
 * @param {number} thresholdMeters 判定同一支的距離門檻（公尺）
 * @returns {{ kept: object[], droppedCount: number }}
 */
function dedupeAgainstExisting(nationalRecords, existingPoints, thresholdMeters) {
  const comparablePoints = existingPoints.filter((p) => p.lat != null && p.lng != null);

  const kept = [];
  let droppedCount = 0;
  for (const record of nationalRecords) {
    if (record.lat == null || record.lng == null) {
      kept.push(record);
      continue;
    }
    const isDuplicate = comparablePoints.some(
      (p) => haversineMeters(record.lat, record.lng, p.lat, p.lng) <= thresholdMeters
    );
    if (isDuplicate) {
      droppedCount++;
    } else {
      kept.push(record);
    }
  }
  return { kept, droppedCount };
}

module.exports = {
  toUpsertPayload,
  toUpsertPayloads,
  isStale,
  coordLookupKey,
  fillMissingCoords,
  haversineMeters,
  dedupeAgainstExisting,
};
