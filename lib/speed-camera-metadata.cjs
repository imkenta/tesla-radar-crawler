'use strict';

const CAMERA_TYPES = new Set(['fixed', 'mobile', 'section', 'unknown']);
const ROAD_LEVELS = new Set(['elevated', 'ground', 'tunnel', 'unknown']);
const ROAD_CLASSES = new Set(['freeway', 'expressway', 'ordinary', 'unknown']);
const SPEED_STATUSES = new Set(['confirmed', 'rejected', 'unknown']);

const SPEED_ENFORCEMENT_RE = /(超速|測速|平均速率|速度限制)/;
const NON_SPEED_RE = /(闖紅燈|紅燈右轉|紅燈越線|違規左轉|違左|違規停車|違停|不依標誌|不依標線|未依標誌|未依標線|號誌指示|未禮讓|未停讓行人|不停讓行人|行人穿越道|未保持路口淨空|大型車(?:行駛|違規)|禁行|跨越槽化線|壓線|逆向行駛|機車行駛行穿道)/;

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
 * - speed_only / mobile_speed / section_speed：官方資料集本身即限定超速執法。
 * - mixed：必須從官方取締項目欄位確認；純闖紅燈、違停等標成 rejected。
 */
function classifySpeedStatus({ explicitItems = '', sourceContract = 'mixed', text = '' } = {}) {
  if (['speed_only', 'mobile_speed', 'section_speed'].includes(sourceContract)) {
    return { status: 'confirmed', basis: `source_contract:${sourceContract}` };
  }

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

  const fallbackText = String(text || '').trim();
  if (SPEED_ENFORCEMENT_RE.test(fallbackText)) {
    return { status: 'confirmed', basis: 'text:speed' };
  }
  if (NON_SPEED_RE.test(fallbackText)) {
    return { status: 'rejected', basis: 'text:non_speed' };
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
    text,
  });
  const cameraType = classifyCameraType({
    explicitType: options.explicitType,
    text,
    fallbackType: options.fallbackType,
  });
  const roadLevel = options.roadLevel || inferRoadLevel(text);
  const roadClass = options.roadClass || inferRoadClass(record);
  const direction = parseDirection(record.direction);

  return {
    ...record,
    speed_status: SPEED_STATUSES.has(speed.status) ? speed.status : 'unknown',
    enforcement_items_raw: String(options.enforcementItemsRaw || '').trim() || null,
    classification_basis: speed.basis,
    camera_type: CAMERA_TYPES.has(cameraType) ? cameraType : 'unknown',
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
  inferRoadLevel,
  inferRoadClass,
  parseDirection,
  withCameraMetadata,
  isConfirmedSpeedRecord,
};
