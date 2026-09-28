'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyExpresswayDirectionVerification,
  logExpresswayDirectionResult,
  DEFAULT_TABLE_PATH,
} = require('../lib/expressway-direction-verification.cjs');

const table = require(DEFAULT_TABLE_PATH);
const angleDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };

const cam = (over = {}) => ({
  road: '太平區中彰快速道路27.5K(往大里方向)', lat: 24.136902, lng: 120.70988,
  road_class: 'expressway', direction_mode: 'single', direction: '北向南', direction_bearing: 180,
  ...over,
});

test('驗證過的快速道路桿保留方位；不改動傳入物件', () => {
  const input = [cam()];
  const r = applyExpresswayDirectionVerification(input);
  assert.equal(r.verified, 1);
  assert.equal(r.records[0].direction_bearing, 180);
  assert.deepEqual(r.cleared, []);
});

test('標籤寫反的桿（台65線 1.8K 往五股卻標北向南）不在白名單 ⇒ 清空方位', () => {
  const input = [cam({ road: '台65線快速公路1.8公里（往五股）', lat: 25.050781, lng: 121.44234, direction: '北向南', direction_bearing: 180 })];
  const r = applyExpresswayDirectionVerification(input);
  assert.equal(r.records[0].direction_bearing, null);
  assert.equal(input[0].direction_bearing, 180, '不得就地修改');
  assert.deepEqual(r.cleared, ['台65線快速公路1.8公里（往五股）']);
});

test('同名但座標搬家、或標籤方位改了 ⇒ 視為未驗證、清空', () => {
  assert.equal(applyExpresswayDirectionVerification([cam({ lat: 24.136902 + 0.001 })]).records[0].direction_bearing, null);
  assert.equal(applyExpresswayDirectionVerification([cam({ direction_bearing: 0 })]).records[0].direction_bearing, null);
});

test('國道、一般道路、雙向、沒有方位的紀錄完全不動', () => {
  const others = [
    cam({ road_class: 'freeway' }),
    cam({ road_class: 'ordinary' }),
    cam({ direction_mode: 'bidirectional' }),
    cam({ direction_bearing: null }),
  ];
  const r = applyExpresswayDirectionVerification(others);
  assert.deepEqual(r.records, others);
  assert.equal(r.verified, 0);
  assert.deepEqual(r.cleared, []);
});

test('白名單健全性：每筆標籤與最近單向車道同側（<60°）、(路名, 座標) 不重複', () => {
  const seen = new Set();
  for (const e of table.entries) {
    assert.ok(angleDiff(e.label_bearing, e.lane_bearing) < 60, `${e.road} 標籤 ${e.label_bearing}° 與車道 ${e.lane_bearing}°`);
    assert.ok(e.lane_distance_m <= 30, e.road);
    const k = `${e.road}|${e.lat}|${e.lng}`;
    assert.ok(!seen.has(k), `重複：${k}`);
    seen.add(k);
  }
  assert.ok(table.entries.length >= 40, `白名單筆數異常（${table.entries.length}）`);
});

// 2026-09-25／09-28 實車（中彰快速道路 national-npa 那兩筆）：必須在白名單內，App 才能擋對向。
test('實車 ground truth：中彰快速道路 25.9K／27.5K 在白名單，標籤與車頭一致', () => {
  const find = (road) => table.entries.find((e) => e.road === road);
  const n = find('太平區中彰快速道路25.9K(往潭子方向)');
  const s = find('太平區中彰快速道路27.5K(往大里方向)');
  assert.ok(n && s);
  assert.ok(angleDiff(n.label_bearing, 20) < 45, '9/28 北上車頭約 20°');
  assert.ok(angleDiff(s.label_bearing, 208) < 45, '9/25 南下車頭約 208°');
});

test('log 只在有處理時才印', () => {
  const lines = [];
  logExpresswayDirectionResult('x', { verified: 0, cleared: [] }, (l) => lines.push(l));
  assert.equal(lines.length, 0);
  logExpresswayDirectionResult('x', { verified: 2, cleared: ['a'] }, (l) => lines.push(l));
  assert.equal(lines.length, 1);
});
