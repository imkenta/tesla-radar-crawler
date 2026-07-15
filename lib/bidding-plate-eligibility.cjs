'use strict';

const EV_BIDDING_PLATE_TYPES = Object.freeze([
  '電動自小客',
  '電動租賃車'
]);

const EV_BIDDING_PLATE_TYPE_SET = new Set(EV_BIDDING_PLATE_TYPES);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlateNo(value) {
  return normalizeText(value).toUpperCase();
}

function isPlateNoWithinRange(plateNo, startPlate, endPlate) {
  const plate = normalizePlateNo(plateNo);
  const start = normalizePlateNo(startPlate);
  const end = normalizePlateNo(endPlate);

  if (!plate || !start || !end) return false;
  return plate >= start && plate <= end;
}

function groupActiveEvAnnouncements(rows) {
  const stations = new Map();

  for (const row of rows || []) {
    const sectionCode = normalizeText(row.section_code);
    const stationCode = normalizeText(row.station_code);
    const plateType = normalizeText(row.plate_type);
    const startPlate = normalizePlateNo(row.start_plate);
    const endPlate = normalizePlateNo(row.end_plate);

    if (!sectionCode || !stationCode || !startPlate || !endPlate) continue;
    if (!EV_BIDDING_PLATE_TYPE_SET.has(plateType)) continue;

    const key = `${sectionCode}-${stationCode}`;
    if (!stations.has(key)) {
      stations.set(key, {
        sectionCode,
        stationCode,
        announcements: []
      });
    }

    stations.get(key).announcements.push({
      plateType,
      startPlate,
      endPlate,
      startTime: row.start_time || null,
      endTime: row.end_time || null
    });
  }

  return [...stations.values()];
}

function isEligibleElectricBiddingPlate(plate, announcements) {
  const plateNo = normalizePlateNo(plate?.plateNo);
  const plateType = normalizeText(plate?.plateType);

  if (!plateNo || !EV_BIDDING_PLATE_TYPE_SET.has(plateType)) return false;

  return (announcements || []).some((announcement) =>
    normalizeText(announcement.plateType) === plateType &&
    isPlateNoWithinRange(plateNo, announcement.startPlate, announcement.endPlate)
  );
}

function partitionEligibleBiddingPlates(plates, announcements) {
  const eligible = [];
  const rejected = [];

  for (const plate of plates || []) {
    if (isEligibleElectricBiddingPlate(plate, announcements)) {
      eligible.push(plate);
    } else {
      rejected.push(plate);
    }
  }

  return { eligible, rejected };
}

module.exports = {
  EV_BIDDING_PLATE_TYPES,
  groupActiveEvAnnouncements,
  isPlateNoWithinRange,
  isEligibleElectricBiddingPlate,
  partitionEligibleBiddingPlates
};
