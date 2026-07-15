'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  groupActiveEvAnnouncements,
  partitionEligibleBiddingPlates
} = require('../lib/bidding-plate-eligibility.cjs');

test('groups active EV announcements by station without losing plate type or range', () => {
  const stations = groupActiveEvAnnouncements([
    {
      section_code: '40',
      station_code: '44',
      plate_type: '電動自小客',
      start_plate: 'EBQ-7001',
      end_plate: 'EBQ-9999',
      start_time: '2026-07-13T05:00:00Z',
      end_time: '2026-07-15T05:00:00Z'
    },
    {
      section_code: '40',
      station_code: '44',
      plate_type: '電動租賃車',
      start_plate: 'REE-7001',
      end_plate: 'REE-7999',
      start_time: '2026-07-13T05:00:00Z',
      end_time: '2026-07-15T05:00:00Z'
    },
    {
      section_code: '40',
      station_code: '44',
      plate_type: '自用小客貨車',
      start_plate: 'CFA-1001',
      end_plate: 'CFA-9999'
    }
  ]);

  assert.equal(stations.length, 1);
  assert.equal(stations[0].stationCode, '44');
  assert.deepEqual(
    stations[0].announcements.map(({ plateType, startPlate, endPlate }) => ({ plateType, startPlate, endPlate })),
    [
      { plateType: '電動自小客', startPlate: 'EBQ-7001', endPlate: 'EBQ-9999' },
      { plateType: '電動租賃車', startPlate: 'REE-7001', endPlate: 'REE-7999' }
    ]
  );
});

test('rejects non-EV and out-of-range plates from a mixed station result', () => {
  const announcements = [
    { plateType: '電動自小客', startPlate: 'EBQ-7001', endPlate: 'EBQ-9999' },
    { plateType: '電動租賃車', startPlate: 'REE-7001', endPlate: 'REE-7999' }
  ];
  const parsed = [
    { plateNo: 'EBQ-7001', plateType: '電動自小客' },
    { plateNo: 'EBQ-8123', plateType: '電動自小客' },
    { plateNo: 'REE-7087', plateType: '電動租賃車' },
    { plateNo: 'EBQ-6999', plateType: '電動自小客' },
    { plateNo: 'CFA-1225', plateType: '自用小客貨車' },
    { plateNo: 'REE-8123', plateType: '電動租賃車' }
  ];

  const { eligible, rejected } = partitionEligibleBiddingPlates(parsed, announcements);

  assert.deepEqual(eligible.map((plate) => plate.plateNo), ['EBQ-7001', 'EBQ-8123', 'REE-7087']);
  assert.deepEqual(rejected.map((plate) => plate.plateNo), ['EBQ-6999', 'CFA-1225', 'REE-8123']);
});

test('production crawler wires the EV eligibility partition before database upsert', () => {
  const crawlerSource = fs.readFileSync(path.join(__dirname, '..', 'bidding-plates-sync.cjs'), 'utf8');

  assert.match(crawlerSource, /groupActiveEvAnnouncements/);
  assert.match(crawlerSource, /partitionEligibleBiddingPlates\(parsed, station\.announcements\)/);
});
