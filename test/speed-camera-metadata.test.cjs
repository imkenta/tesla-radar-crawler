'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySpeedStatus,
  classifyCameraType,
  classifySpeedTaxonomy,
  projectLegacyCameraType,
  isSnowMountainTunnelRadarPoint,
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
  assert.equal(classifySpeedStatus({
    sourceContract: 'mixed',
    text: '測速警告標誌旁',
  }).status, 'unknown', '地址或地名中的測速字樣不得替代官方逐筆取締證據');
  assert.equal(classifyCameraType({ explicitType: '固定式科技執法' }), 'fixed');
});

test('來源契約明確限定測速時可直接確認，移動式仍只代表可能執法地點', () => {
  assert.equal(classifySpeedStatus({ sourceContract: 'speed_only' }).status, 'confirmed');
  assert.equal(classifySpeedStatus({ sourceContract: 'mobile_speed' }).status, 'confirmed');
  assert.equal(classifyCameraType({ explicitType: '移動式測速地點' }), 'mobile');
  assert.equal(classifyCameraType({ explicitType: '區間平均速率' }), 'section');
});

test('明示非測速項目優先於 speed_only 來源契約，避免把闖紅燈列誤收', () => {
  assert.deepEqual(
    classifySpeedStatus({ explicitItems: '闖紅燈、未依號誌', sourceContract: 'speed_only' }),
    { status: 'rejected', basis: 'source_field:non_speed' }
  );
});

test('taxonomy 證據不足時 fail-closed，科技執法不推測 radar/laser', () => {
  assert.deepEqual(classifySpeedTaxonomy(), {
    installation_class: 'unknown',
    speed_measurement_mode: 'unknown',
    sensor_technology: 'unknown',
    taxonomy_basis: 'insufficient_evidence',
    taxonomy_source_url: null,
    taxonomy_observed_at: null,
    camera_type: 'unknown',
  });
  const technology = classifySpeedTaxonomy({ address: '某路口科技執法' });
  assert.equal(technology.installation_class, 'integrated_technology');
  assert.equal(technology.sensor_technology, 'unknown');
  assert.equal(technology.camera_type, 'unknown');
});

test('legacy camera_type 僅由正交 taxonomy 明確投影', () => {
  assert.equal(projectLegacyCameraType({
    installation_class: 'traditional_fixed',
    speed_measurement_mode: 'point',
  }), 'fixed');
  assert.equal(projectLegacyCameraType({
    installation_class: 'mobile',
    speed_measurement_mode: 'unknown',
  }), 'mobile');
  assert.equal(projectLegacyCameraType({
    installation_class: 'integrated_technology',
    speed_measurement_mode: 'section_average',
  }), 'section');
  assert.equal(projectLegacyCameraType({
    installation_class: 'integrated_technology',
    speed_measurement_mode: 'point',
  }), 'unknown');
});

test('雪山隧道 override 只接受南北向各八個精確里程', () => {
  const kms = ['16.9', '18.3', '19.7', '21.1', '22.5', '23.9', '25.3', '26.7'];
  for (const direction of ['南向', '北向']) {
    for (const km of kms) {
      assert.equal(isSnowMountainTunnelRadarPoint({
        source: 'freeway-npa',
        address: `國道五號${direction}${km}公里`,
      }), true);
    }
  }
  assert.equal(isSnowMountainTunnelRadarPoint({
    source: 'freeway-npa',
    address: '國道五號北向28.3公里',
  }), false);
  assert.equal(isSnowMountainTunnelRadarPoint({
    source: 'national-npa',
    city: '國道5號',
    address: '國道5號南向16.9公里（雪山隧道科技執法）',
  }), true);
});

test('雪山隧道 taxonomy 分開記錄 integrated 與 radar/point 官方依據', () => {
  const taxonomy = classifySpeedTaxonomy({
    source: 'freeway-npa',
    address: '國道五號南向16.9公里',
    enforcementItemsRaw: '超速',
    equipmentTypeRaw: '雷達',
  });
  assert.equal(taxonomy.installation_class, 'integrated_technology');
  assert.equal(taxonomy.speed_measurement_mode, 'point');
  assert.equal(taxonomy.sensor_technology, 'radar');
  assert.equal(taxonomy.camera_type, 'unknown');
  assert.match(taxonomy.taxonomy_basis, /dataset_100857/);
  assert.match(taxonomy.taxonomy_basis, /dataset_13940/);
  assert.equal(taxonomy.taxonomy_source_url, 'https://data.gov.tw/dataset/13940');
  assert.equal(taxonomy.taxonomy_observed_at, '2026-07-28T00:00:00.000+08:00');
});

test('道路類別只用可驗證文字判斷：國道、快速道路、一般道路分開', () => {
  assert.equal(inferRoadClass({ city: '國道五號', road: '雪山隧道', address: '' }), 'freeway');
  assert.equal(inferRoadClass({ city: '臺中市', road: '台74線12K', address: '' }), 'expressway');
  assert.equal(inferRoadClass({ city: '宜蘭縣', road: '中山路', address: '' }), 'ordinary');
  assert.equal(inferRoadLevel('雪山隧道南下'), 'tunnel');
  assert.equal(inferRoadLevel('國道五號南下'), 'unknown');
});

test('inferRoadClass：freeway-npa 縣市留白時仍能從 road 判斷國道（2026-08-03 雪隧對向測速誤放行事故回歸測試）', () => {
  // data.gov.tw/dataset/13940（freeway-npa）的「縣市」「行政區」欄位固定留白，路名只
  // 出現在「設置地點」（parser 對應到 road 欄，例：「國道五號北向16.9公里」）。
  // 2026-08-02 全量重建後這批國道五號記錄的 road_class 全掉成 unknown，
  // iOS 端對向測速排除的第一道閘門 roadClass=='freeway' 因此失效直接放行，
  // 8/3 雪山隧道實車整路收到對向測速重複通報。
  assert.equal(
    inferRoadClass({ city: '', road: '國道五號北向16.9公里', address: '國道五號北向16.9公里' }),
    'freeway'
  );
  assert.equal(
    inferRoadClass({ city: '', road: '國道一號南向2公里', address: '國道一號南向2公里' }),
    'freeway'
  );
  // 反向守門：省道與市區路名不得因縣市留白就被國道規則誤判
  assert.notEqual(
    inferRoadClass({ city: '', road: '台9線79k+550m環市東路與192甲線路口', address: '' }),
    'freeway'
  );
  assert.equal(
    inferRoadClass({ city: '宜蘭縣', road: '台9線78k中山路五段南下', address: '' }),
    'ordinary'
  );
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
    equipmentTypeRaw: '固定式測速',
  });

  assert.equal(record.speed_status, 'confirmed');
  assert.equal(record.camera_type, 'fixed');
  assert.equal(record.road_class, 'freeway');
  assert.equal(record.road_level, 'tunnel');
  assert.equal(record.direction_mode, 'single');
  assert.equal(record.direction_bearing, 180);
  assert.equal(isConfirmedSpeedRecord(record), true);
});
