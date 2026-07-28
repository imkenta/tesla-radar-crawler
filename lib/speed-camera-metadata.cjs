'use strict';

const CAMERA_TYPES = new Set(['fixed', 'mobile', 'section', 'unknown']);
const ROAD_LEVELS = new Set(['elevated', 'ground', 'tunnel', 'unknown']);
const ROAD_CLASSES = new Set(['freeway', 'expressway', 'ordinary', 'unknown']);
const SPEED_STATUSES = new Set(['confirmed', 'rejected', 'unknown']);
const INSTALLATION_CLASSES = new Set(['traditional_fixed', 'integrated_technology', 'mobile', 'unknown']);
const SPEED_MEASUREMENT_MODES = new Set(['point', 'section_average', 'unknown']);
const SENSOR_TECHNOLOGIES = new Set(['radar', 'laser', 'vision', 'inductive_loop', 'average_speed', 'mixed', 'unknown']);

const SPEED_ENFORCEMENT_RE = /(超速|測速|平均速率|速度限制)/;
const NON_SPEED_RE = /(未保持安全距離|安全距離|車距|慢速|龜速|闖紅燈|紅燈右轉|紅燈越線|違規左轉|違左|違規停車|違規臨時停車|違停|不依標誌|不依標線|未依標誌|未依標線|號誌指示|未禮讓|未停讓行人|不停讓行人|行人穿越道|未保持路口淨空|大型車(?:行駛|違規)|禁行|跨越槽化線|壓線|逆向行駛|機車行駛行穿道)/;
const SNOW_MOUNTAIN_TUNNEL_KM = new Set(['16.9', '18.3', '19.7', '21.1', '22.5', '23.9', '25.3', '26.7']);
const SNOW_MOUNTAIN_RADAR_SOURCE_URL = 'https://data.gov.tw/dataset/13940';
const SNOW_MOUNTAIN_INSTALLATION_SOURCE_URL = 'https://data.gov.tw/dataset/100857';
const SNOW_MOUNTAIN_TAXONOMY_OBSERVED_AT = '2026-07-28T00:00:00.000+08:00';

const EXPRESSWAY_ROUTE_RE = /(?:台|臺)\s*(?:61|62甲|62|64|65|66|68甲|68|72|74甲|74|76|78|82|84|86|88)\s*(?:線)?(?!\d)/;

const COMPASS_BEARINGS = new Map([
  ['北', 0], ['東北', 45], ['北東', 45],
  ['東', 90], ['東南', 135], ['南東', 135],
  ['南', 180], ['西南', 225], ['南西', 225],
  ['西', 270], ['西北', 315], ['北西', 315],
]);
const COMPASS_TOKEN = '(?:東北|北東|東南|南東|西南|南西|西北|北西|北|東|南|西)';
const FLOW_RE = new RegExp(`^(${COMPASS_TOKEN})[向往](${COMPASS_TOKEN})$`);
const SINGLE_SUFFIX_RE = new RegExp(`^(${COMPASS_TOKEN})向$`);
const SINGLE_PREFIX_RE = new RegExp(`^往(${COMPASS_TOKEN})$`);

function compactText(values) {
  return values.filter((value) => value != null && String(value).trim()).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 「設備型態」和「是否真的取締超速」是兩個不同維度。這裡只判斷後者。
 * sourceContract:
 * - speed_only / mobile_speed / section_speed：逐筆取締欄位缺失時，由官方資料集契約補足。
 * - mixed：必須從官方取締項目欄位確認；純闖紅燈、違停等標成 rejected。
 */
function classifySpeedStatus({ explicitItems = '', sourceContract = 'mixed' } = {}) {
  const explicit = String(explicitItems || '').trim();
  if (explicit) {
    if (SPEED_ENFORCEMENT_RE.test(explicit)) {
      return { status: 'confirmed', basis: 'source_field:speed' };
    }
    if (NON_SPEED_RE.test(explicit)) {
      return { status: 'rejected', basis: 'source_field:non_speed' };
    }
    return { status: 'unknown', basis: 'source_field:insufficient_evidence' };
  }

  if (['speed_only', 'mobile_speed', 'section_speed'].includes(sourceContract)) {
    return { status: 'confirmed', basis: `source_contract:${sourceContract}` };
  }

  return { status: 'unknown', basis: 'insufficient_evidence' };
}

function classifyCameraType({ explicitType = '', text = '', fallbackType = 'unknown' } = {}) {
  const combined = compactText([explicitType, text]);
  if (/(區間|平均速率)/.test(combined)) return 'section';
  if (/(移動式|機動測速|移動測速)/.test(combined)) return 'mobile';
  if (/(固定式|固定測速|固定桿)/.test(combined)) return 'fixed';
  return CAMERA_TYPES.has(fallbackType) ? fallbackType : 'unknown';
}

function normalizeTaxonomyText(raw) {
  if (raw == null) return '';
  return String(raw)
    .trim()
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '');
}

function isSnowMountainTunnelRadarPoint({ source = null, city = null, address = null } = {}) {
  const normalizedAddress = normalizeTaxonomyText(address);
  let match = null;
  if (source === 'national-npa' && /^國道(?:五|5)號$/.test(normalizeTaxonomyText(city))) {
    match = /^國道(?:五|5)號(北向|南向)(\d{1,3}(?:\.\d+)?)公里\(雪山隧道科技執法\)$/.exec(normalizedAddress);
  } else if (source === 'freeway-npa') {
    match = /^國道(?:五|5)號(北向|南向)(\d{1,3}(?:\.\d+)?)公里$/.exec(normalizedAddress);
  }
  return Boolean(match && SNOW_MOUNTAIN_TUNNEL_KM.has(match[2]));
}

function projectLegacyCameraType({
  installation_class: installationClass = 'unknown',
  speed_measurement_mode: speedMeasurementMode = 'unknown',
} = {}) {
  if (speedMeasurementMode === 'section_average') return 'section';
  if (installationClass === 'mobile') return 'mobile';
  if (installationClass === 'traditional_fixed' && speedMeasurementMode === 'point') return 'fixed';
  return 'unknown';
}

function classifySpeedTaxonomy({
  source = null,
  city = null,
  address = null,
  road = null,
  direction = null,
  enforcementItemsRaw = null,
  equipmentTypeRaw = null,
  taxonomyContract = null,
  taxonomySourceUrl: suppliedTaxonomySourceUrl = null,
  taxonomyObservedAt: suppliedTaxonomyObservedAt = null,
} = {}) {
  let installationClass = 'unknown';
  let speedMeasurementMode = 'unknown';
  let sensorTechnology = 'unknown';
  let taxonomySourceUrl = suppliedTaxonomySourceUrl;
  let taxonomyObservedAt = suppliedTaxonomyObservedAt;
  let installationBasis = null;
  let speedMeasurementBasis = null;
  let sensorBasis = null;

  const explicitText = [address, road, direction, enforcementItemsRaw, equipmentTypeRaw]
    .map(normalizeTaxonomyText)
    .filter(Boolean)
    .join('|');
  const equipmentText = normalizeTaxonomyText(equipmentTypeRaw);

  if (taxonomyContract === 'mobile_speed') {
    installationClass = 'mobile';
    installationBasis = 'installation:source_contract:mobile_speed';
  } else if (explicitText.includes('科技執法')) {
    installationClass = 'integrated_technology';
    installationBasis = 'installation:explicit_token:科技執法';
  } else if (equipmentText.includes('固定式')) {
    installationClass = 'traditional_fixed';
    installationBasis = 'installation:explicit_equipment_token:固定式';
  }

  const sectionToken = ['區間平均速率', '區間測速', '平均速率']
    .find((token) => explicitText.includes(token));
  if (sectionToken) {
    speedMeasurementMode = 'section_average';
    sensorTechnology = 'average_speed';
    speedMeasurementBasis = `speed_measurement_mode:explicit_token:${sectionToken}`;
    sensorBasis = `sensor_technology:explicit_section_measurement:${sectionToken}`;
  } else {
    const pointToken = ['超速', '測速'].find((token) => explicitText.includes(token));
    if (pointToken) {
      speedMeasurementMode = 'point';
      speedMeasurementBasis = `speed_measurement_mode:explicit_token:${pointToken}`;
    }
  }

  const explicitSensors = [];
  if (equipmentText.includes('雷達')) explicitSensors.push('radar');
  if (equipmentText.includes('雷射')) explicitSensors.push('laser');
  if (equipmentText.includes('影像') || equipmentText.includes('視覺')) explicitSensors.push('vision');
  if (equipmentText.includes('線圈') && !equipmentText.includes('非線圈')) explicitSensors.push('inductive_loop');
  if (explicitSensors.length > 1) {
    sensorTechnology = 'mixed';
    sensorBasis = `sensor_technology:explicit_equipment:${explicitSensors.join('+')}`;
  } else if (explicitSensors.length === 1) {
    [sensorTechnology] = explicitSensors;
    sensorBasis = `sensor_technology:explicit_equipment:${sensorTechnology}`;
  }

  if (isSnowMountainTunnelRadarPoint({ source, city, address })) {
    installationClass = 'integrated_technology';
    speedMeasurementMode = 'point';
    sensorTechnology = 'radar';
    installationBasis = `installation:official_point_override:dataset_100857:${SNOW_MOUNTAIN_INSTALLATION_SOURCE_URL}`;
    speedMeasurementBasis = 'speed_measurement_mode:official_point_override:dataset_13940';
    sensorBasis = 'sensor_technology:official_equipment_override:dataset_13940:雷達';
    taxonomySourceUrl = SNOW_MOUNTAIN_RADAR_SOURCE_URL;
    taxonomyObservedAt = SNOW_MOUNTAIN_TAXONOMY_OBSERVED_AT;
  }

  const taxonomy = {
    installation_class: INSTALLATION_CLASSES.has(installationClass) ? installationClass : 'unknown',
    speed_measurement_mode: SPEED_MEASUREMENT_MODES.has(speedMeasurementMode) ? speedMeasurementMode : 'unknown',
    sensor_technology: SENSOR_TECHNOLOGIES.has(sensorTechnology) ? sensorTechnology : 'unknown',
    taxonomy_basis: [installationBasis, speedMeasurementBasis, sensorBasis].filter(Boolean).join(';') || 'insufficient_evidence',
    taxonomy_source_url: taxonomySourceUrl || null,
    taxonomy_observed_at: taxonomyObservedAt || null,
  };
  return { ...taxonomy, camera_type: projectLegacyCameraType(taxonomy) };
}

function inferRoadLevel(text = '') {
  const value = String(text || '');
  if (/(高架下|橋下|平面道路|平面段|地面道路)/.test(value)) return 'ground';
  if (/(高架道路|高架橋|高架段|橋上|橋面)/.test(value)) return 'elevated';
  if (/(隧道|地下道)/.test(value)) return 'tunnel';
  return 'unknown';
}

function inferRoadClass(record) {
  const city = String(record.city || '').trim();
  const text = compactText([city, record.road, record.address]);
  if (/^國道/.test(city)) return 'freeway';
  if (EXPRESSWAY_ROUTE_RE.test(text)) return 'expressway';
  if (/(市|縣)$/.test(city)) return 'ordinary';
  return 'unknown';
}

function parseDirection(raw) {
  if (raw == null || !String(raw).trim()) {
    return { mode: 'unknown', bearing: null };
  }

  let text = String(raw)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[、，,]/g, '')
    .trim();
  if (!text) return { mode: 'unknown', bearing: null };

  if (/雙向|多向/.test(text) || /^(南北|東西)(向)?$/.test(text)) {
    return { mode: 'bidirectional', bearing: null };
  }

  text = text.replace(/方向$/, '').trim();
  const flow = FLOW_RE.exec(text);
  if (flow) return { mode: 'single', bearing: COMPASS_BEARINGS.get(flow[2]) };

  const suffix = SINGLE_SUFFIX_RE.exec(text);
  if (suffix) return { mode: 'single', bearing: COMPASS_BEARINGS.get(suffix[1]) };

  const prefix = SINGLE_PREFIX_RE.exec(text);
  if (prefix) return { mode: 'single', bearing: COMPASS_BEARINGS.get(prefix[1]) };

  const trafficWord = /^(北上|南下|東行|西行)$/.exec(text);
  if (trafficWord) {
    return {
      mode: 'single',
      bearing: { 北上: 0, 東行: 90, 南下: 180, 西行: 270 }[trafficWord[1]],
    };
  }

  return { mode: 'landmark', bearing: null };
}

function withCameraMetadata(record, options = {}) {
  const text = compactText([
    record.city,
    record.address,
    record.road,
    record.direction,
    options.extraText,
  ]);
  const speed = classifySpeedStatus({
    explicitItems: options.enforcementItemsRaw,
    sourceContract: options.sourceContract,
  });
  const equipmentTypeRaw = options.equipmentTypeRaw;
  const taxonomy = classifySpeedTaxonomy({
    ...record,
    enforcementItemsRaw: options.enforcementItemsRaw,
    equipmentTypeRaw,
    taxonomyContract: options.taxonomyContract,
    taxonomySourceUrl: options.taxonomySourceUrl,
    taxonomyObservedAt: options.taxonomyObservedAt,
  });
  const roadLevel = options.roadLevel || inferRoadLevel(text);
  const roadClass = options.roadClass || inferRoadClass(record);
  const direction = parseDirection(record.direction);

  return {
    ...record,
    speed_status: SPEED_STATUSES.has(speed.status) ? speed.status : 'unknown',
    enforcement_items_raw: String(options.enforcementItemsRaw || '').trim() || null,
    equipment_type_raw: String(equipmentTypeRaw || '').trim() || null,
    classification_basis: speed.basis,
    ...taxonomy,
    camera_type: CAMERA_TYPES.has(taxonomy.camera_type) ? taxonomy.camera_type : 'unknown',
    road_class: ROAD_CLASSES.has(roadClass) ? roadClass : 'unknown',
    road_level: ROAD_LEVELS.has(roadLevel) ? roadLevel : 'unknown',
    direction_mode: direction.mode,
    direction_bearing: direction.bearing,
    camera_elevation_m: options.cameraElevationM ?? null,
    section_start_lat: options.sectionStartLat ?? null,
    section_start_lng: options.sectionStartLng ?? null,
    section_end_lat: options.sectionEndLat ?? null,
    section_end_lng: options.sectionEndLng ?? null,
    section_length_m: options.sectionLengthM ?? null,
  };
}

function isConfirmedSpeedRecord(record) {
  return record && record.speed_status === 'confirmed';
}

module.exports = {
  classifySpeedStatus,
  classifyCameraType,
  classifySpeedTaxonomy,
  projectLegacyCameraType,
  isSnowMountainTunnelRadarPoint,
  inferRoadLevel,
  inferRoadClass,
  parseDirection,
  withCameraMetadata,
  isConfirmedSpeedRecord,
};
