'use strict';

/**
 * 測速照相「真寫入模式」純函式邏輯測試。
 *
 * 只測 lib/speed-camera-writer.cjs 的純函式（payload 組裝、stale 判定），
 * 不碰 supabase client——client 呼叫在 speed-camera-sync.cjs 的 mock 測試另外驗證。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toUpsertPayload, toUpsertPayloads, isStale } = require('../lib/speed-camera-writer.cjs');

test('toUpsertPayload：direction 為 null 正規化成空字串', () => {
  const record = {
    city: '臺南市',
    address: '北門路段',
    road: null,
    direction: null,
    speed_limit: null,
    lat: null,
    lng: null,
    source: 'tainan',
    fetched_at: '2026-07-04T00:00:00.000Z',
  };
  const payload = toUpsertPayload(record, '2026-07-05T00:00:00.000Z');

  assert.equal(payload.direction, '');
  assert.equal(payload.road, null);
  assert.equal(payload.updated_at, '2026-07-05T00:00:00.000Z');
});

test('toUpsertPayload：direction 為 undefined 也正規化成空字串', () => {
  const record = {
    city: '臺南市',
    address: '北門路段',
    source: 'tainan',
    fetched_at: '2026-07-04T00:00:00.000Z',
  };
  const payload = toUpsertPayload(record, '2026-07-05T00:00:00.000Z');
  assert.equal(payload.direction, '');
});

test('toUpsertPayload：有值的 direction 原樣保留', () => {
  const record = {
    city: '臺北市',
    address: '承德路3段 敦煌路口',
    road: '承德路3段',
    direction: '南北雙向',
    speed_limit: 50,
    lat: 25.07450558,
    lng: 121.5199333,
    source: 'taipei',
    fetched_at: '2026-07-04T00:00:00.000Z',
  };
  const payload = toUpsertPayload(record, '2026-07-05T00:00:00.000Z');
  assert.equal(payload.direction, '南北雙向');
  assert.equal(payload.speed_limit, 50);
  assert.equal(payload.updated_at, '2026-07-05T00:00:00.000Z');
});

test('toUpsertPayload：所有筆都帶上同一個本輪批次 updated_at', () => {
  const records = [
    { city: 'A', address: 'a', source: 's', fetched_at: 't1' },
    { city: 'B', address: 'b', source: 's', fetched_at: 't2' },
  ];
  const payloads = toUpsertPayloads(records, '2026-07-05T00:00:00.000Z');
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every((p) => p.updated_at === '2026-07-05T00:00:00.000Z'));
});

test('isStale：既有列 fetched_at 早於本輪批次 → true（該清除）', () => {
  assert.equal(isStale('2026-07-04T00:00:00.000Z', '2026-07-05T00:00:00.000Z'), true);
});

test('isStale：既有列 fetched_at 等於本輪批次 → false（本輪剛寫入，不清）', () => {
  assert.equal(isStale('2026-07-05T00:00:00.000Z', '2026-07-05T00:00:00.000Z'), false);
});

test('isStale：既有列 fetched_at 晚於本輪批次 → false（不應發生，但不誤刪）', () => {
  assert.equal(isStale('2026-07-06T00:00:00.000Z', '2026-07-05T00:00:00.000Z'), false);
});

test('isStale：既有列 fetched_at 缺失（null/undefined）→ true（視為 stale，保守清除）', () => {
  assert.equal(isStale(null, '2026-07-05T00:00:00.000Z'), true);
  assert.equal(isStale(undefined, '2026-07-05T00:00:00.000Z'), true);
});
