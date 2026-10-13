const test = require('node:test');
const assert = require('node:assert/strict');
const { findDuplicateKeys, fetchAllStagingKeys } = require('../lib/staging-duplicates.cjs');

const row = (plate_no, extra = {}) => ({ station_id: '40', region_id: '4', plate_type: 'g', plate_no, ...extra });

test('no duplicates for distinct keys', () => {
    assert.deepEqual(findDuplicateKeys([row('A'), row('B'), row('A', { plate_type: 'h' }), row('A', { station_id: '41' })]), []);
});

test('flags a plate written twice (primary + spare double-write)', () => {
    const dups = findDuplicateKeys([row('A'), row('B'), row('A')]);
    assert.deepEqual(dups, [{ key: '40|4|g|A', count: 2 }]);
});

test('fetchAllStagingKeys pages past the 1000-row cap', async () => {
    const all = Array.from({ length: 2300 }, (_, i) => row(`P${i}`));
    const calls = [];
    const supabase = {
        from: () => ({
            select: () => ({
                order: () => ({
                    range: (from, to) => { calls.push([from, to]); return Promise.resolve({ data: all.slice(from, to + 1), error: null }); },
                }),
            }),
        }),
    };
    const { rows, error } = await fetchAllStagingKeys(supabase, (op) => op());
    assert.equal(error, null);
    assert.equal(rows.length, 2300);
    assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('fetchAllStagingKeys surfaces query errors', async () => {
    const supabase = { from: () => ({ select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) };
    const { rows, error } = await fetchAllStagingKeys(supabase, (op) => op());
    assert.equal(rows, null);
    assert.equal(error.message, 'boom');
});
