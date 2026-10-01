'use strict';

const evidence = require('../data/tainan-enforcement-verified.json');
const { projectLegacyCameraType } = require('./speed-camera-metadata.cjs');
const compact = raw => String(raw || '').replace(/\s+/g, '');

// 區間／多位置無法由一個 lat/lng 代表；所有借值、DB 沿用與 geocode 均使用此閘門。
function hasNonPointLocation(record) {
  return record.speed_measurement_mode === 'section_average' || record.sensor_technology === 'average_speed' ||
    /區間|平均速率|一、|二、|公里(?:處)?\s*[至到]\s*\d/.test([record.address, record.road, record.enforcement_items_raw].join('|'));
}

function applyTainanOfficialTaxonomy(record) {
  if (record.source !== 'tainan') return record;
  const entry = evidence.entries.find(e => compact(e.address) === compact(record.address) &&
    e.direction === record.direction && e.speed_limit === record.speed_limit);
  if (entry) {
    const taxonomy = { ...record, equipment_type_raw: entry.equipment_type_raw,
      speed_measurement_mode: entry.speed_measurement_mode, sensor_technology: entry.sensor_technology,
      taxonomy_basis: `speed_measurement_mode:official_record_override:tainan_pdf:${entry.official_number}:page${entry.page};sensor_technology:official_equipment:區間平均速率執法系統;source_sha256:${evidence.source_sha256}`,
      taxonomy_source_url: evidence.source_url, taxonomy_observed_at: evidence.observed_at,
    };
    return { ...taxonomy, camera_type: projectLegacyCameraType(taxonomy) };
  }
  // 未核對的複合區間即使含「超速」，也不能被共用文字分類器誤判為單點。
  if (hasNonPointLocation(record) && record.speed_measurement_mode === 'point') {
    const taxonomy = { ...record, speed_measurement_mode: 'unknown', sensor_technology: 'unknown',
      taxonomy_basis: 'speed_measurement_mode:ambiguous_non_point_location' };
    return { ...taxonomy, camera_type: projectLegacyCameraType(taxonomy) };
  }
  return record;
}

module.exports = { hasNonPointLocation, applyTainanOfficialTaxonomy };
