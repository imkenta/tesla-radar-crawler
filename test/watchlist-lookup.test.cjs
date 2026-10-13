'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchWatchesByPlate, PAGE_SIZE } = require('../lib/watchlist-lookup.cjs');

function fakeSupabase(rows, calls) {
  return {
    from(table) {
      const q = { table, filters: {}, range: null };
      const builder = {
        select() { return builder; },
        eq(col, val) { q.filters[col] = val; return builder; },
        order() { return builder; },
        range(from, to) {
          q.range = [from, to];
          calls.push(q);
          const matched = rows.filter((r) => Object.entries(q.filters).every(([k, v]) => r[k] === v));
          return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
        },
      };
      return builder;
    },
  };
}

test('groups watches by plate with one request instead of one per plate', async () => {
  const calls = [];
  const rows = [
    { id: 1, plate_no: 'EAA-0001', source: 'available', email: 'a@x' },
    { id: 2, plate_no: 'EAA-0001', source: 'available', email: 'b@x' },
    { id: 3, plate_no: 'EAA-0002', source: 'bidding', email: 'c@x' },
    { id: 4, plate_no: 'EAA-0003', source: 'available', email: 'd@x' },
  ];
  const plates = Array.from({ length: 5000 }, (_, i) => `EZZ-${i}`).concat(['EAA-0001', 'EAA-0002']);
  const map = await fetchWatchesByPlate(fakeSupabase(rows, calls), 'available', plates);

  assert.equal(calls.length, 1);
  assert.deepEqual(map.get('EAA-0001').map((w) => w.id), [1, 2]);
  assert.equal(map.has('EAA-0002'), false, 'other source excluded');
  assert.equal(map.has('EAA-0003'), false, 'unrequested plate excluded');
});

test('paginates past max-rows', async () => {
  const calls = [];
  const rows = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({ id: i, plate_no: `P-${i}`, source: 'bidding' }));
  const map = await fetchWatchesByPlate(fakeSupabase(rows, calls), 'bidding', [`P-${PAGE_SIZE + 3}`, 'P-0']);
  assert.equal(calls.length, 2);
  assert.equal(map.size, 2);
});

test('empty plate list makes no request', async () => {
  const calls = [];
  const map = await fetchWatchesByPlate(fakeSupabase([], calls), 'available', []);
  assert.equal(calls.length, 0);
  assert.equal(map.size, 0);
});

test('throws on query error', async () => {
  const supabase = { from: () => ({ select() { return this; }, eq() { return this; }, order() { return this; }, range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) };
  await assert.rejects(fetchWatchesByPlate(supabase, 'available', ['X']), /boom/);
});
