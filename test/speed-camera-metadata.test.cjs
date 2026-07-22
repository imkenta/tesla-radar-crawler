'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySpeedStatus,
  classifyCameraType,
  inferRoadClass,
  inferRoadLevel,
  parseDirection,
  withCameraMetadata,
  isConfirmedSpeedRecord,
} = require('../lib/speed-camera-metadata.cjs');

test('測速確認狀態與設備型態分離：固定設備不等於一定取締超速', () => {
  assert.deepEqual(
    classifySpeedStatus({ explicitItems: '闖紅燈、違規左轉', sourceContract: 'mixed' }),
    { status: 'rejected', basis: 'source_field:non_speed' }
  );
  assert.deepEqual(
    classifySpeedStatus({ explicitItems: '闖紅燈、超速', sourceContract: 'mixed' }),
    { status: 'confirmed', basis: 'source_field:speed' }
  );
  assert.equal(classifySpeedStatus({ sourceContract: 'mixed', text: '某路口' }).status, 'unknown');
  assert.equal(classifySpeedStatus({
    explicitItems: '闖紅燈',
    sourceContract: 'mixed',
    text: '測速警告標誌旁',
  }).status, 'rejected', '官方取締項目存在時，不得被地址中的「測速」字樣翻盤');
  assert.equal(classifyCameraType({ explicitType: '固定式科技執法' }), 'fixed');
});

test('來源契約明確限定測速時可直接確認，移動式仍只代表可能執法地點', () => {
  assert.equal(classifySpeedStatus({ sourceContract: 'speed_only' }).status, 'confirmed');
  assert.equal(classifySpeedStatus({ sourceContract: 'mobile_speed' }).status, 'confirmed');
  assert.equal(classifyCameraType({ explicitType: '移動式測速地點' }), 'mobile');
  assert.equal(classifyCameraType({ explicitType: '區間平均速率' }), 'section');
});

test('道路類別只用可驗證文字判斷：國道、快速道路、一般道路分開', () => {
  assert.equal(inferRoadClass({ city: '國道五號', road: '雪山隧道', address: '' }), 'freeway');
  assert.equal(inferRoadClass({ city: '臺中市', road: '台74線12K', address: '' }), 'expressway');
  assert.equal(inferRoadClass({ city: '宜蘭縣', road: '中山路', address: '' }), 'ordinary');
  assert.equal(inferRoadLevel('雪山隧道南下'), 'tunnel');
  assert.equal(inferRoadLevel('國道五號南下'), 'unknown');
});

test('方向標準化保留單向、雙向與無法換算方位的地標方向', () => {
  assert.deepEqual(parseDirection('南下'), { mode: 'single', bearing: 180 });
  assert.deepEqual(parseDirection('南向北(超速)'), { mode: 'single', bearing: 0 });
  assert.deepEqual(parseDirection('南北雙向'), { mode: 'bidirectional', bearing: null });
  assert.deepEqual(parseDirection('往雪山隧道'), { mode: 'landmark', bearing: null });
});

test('withCameraMetadata 產生 App 通報所需完整語意欄位', () => {
  const record = withCameraMetadata({
    city: '國道五號',
    address: '雪山隧道南下',
    road: '國道五號',
    direction: '南下',
  }, {
    sourceContract: 'speed_only',
    explicitType: '固定式測速',
  });

  assert.equal(record.speed_status, 'confirmed');
  assert.equal(record.camera_type, 'fixed');
  assert.equal(record.road_class, 'freeway');
  assert.equal(record.road_level, 'tunnel');
  assert.equal(record.direction_mode, 'single');
  assert.equal(record.direction_bearing, 180);
  assert.equal(isConfirmedSpeedRecord(record), true);
});
