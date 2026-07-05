'use strict';

/**
 * 站點配載表（lib/shard-config.cjs）完整性測試。
 *
 * 2026-07-05：3→5 分片重構。驗證新配載表本身正確——不驗證 production DB
 * 的 system_configs.mvdis_stations（那份需另外套用 supabase/migrations-draft/
 * shard_5way_mvdis_stations.sql，本測試只保證 repo 內版控參考表無誤）。
 *
 * 全 mock：不打真實 Supabase、不觸發 workflow、不實爬。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SHARD_NAMES, STATION_CONFIG } = require('../lib/shard-config.cjs');

function flattenStations(config) {
    const out = [];
    for (const dept of config) {
        for (const s of dept.stations) {
            out.push({ ...s, deptId: dept.id });
        }
    }
    return out;
}

test('SHARD_NAMES：5 個分片，NORTH/CENTRAL/SOUTH 舊名延續 + SHARD4/SHARD5 新增', () => {
    assert.deepEqual(SHARD_NAMES, ['NORTH', 'CENTRAL', 'SOUTH', 'SHARD4', 'SHARD5']);
});

test('配載表完整性：5 shard 聯集＝30 站原始全集，無重複、無遺漏', () => {
    // 原始 3-shard 全集（2026-07-05 從 production system_configs.mvdis_stations 讀出）
    const ORIGINAL_STATION_IDS = [
        '20', '21', '25', '26', '28', '30', '33', '40', '43', '44',
        '50', '51', '52', '53', '54', '60', '63', '64', '65', '70',
        '72', '73', '74', '75', '76', '80', '81', '82', '83', '84',
    ].sort();

    const stations = flattenStations(STATION_CONFIG);
    const ids = stations.map((s) => s.id);
    const uniqueIds = new Set(ids);

    assert.equal(ids.length, 30, '應為 30 站');
    assert.equal(uniqueIds.size, ids.length, '不得有重複站點 ID');
    assert.deepEqual([...uniqueIds].sort(), ORIGINAL_STATION_IDS, '新配載聯集必須等於原 30 站全集');
});

test('配載表完整性：每個 shard 都非空（5 shard 皆有實際站點）', () => {
    const stations = flattenStations(STATION_CONFIG);
    for (const shardName of SHARD_NAMES) {
        const count = stations.filter((s) => s.shard === shardName).length;
        assert.ok(count > 0, `${shardName} 不得為空 shard`);
    }
});

test('配載表完整性：每站的 shard 欄位必須是 SHARD_NAMES 之一（不得打錯字或留舊名以外的值）', () => {
    const stations = flattenStations(STATION_CONFIG);
    for (const s of stations) {
        assert.ok(SHARD_NAMES.includes(s.shard), `站點 ${s.id}(${s.name}) 的 shard="${s.shard}" 不在 SHARD_NAMES 內`);
    }
});

test('配載耗時估算：以原 shard 站均耗時加權，5 shard 皆 ≤13 分（目標上限）', () => {
    // 原 3-shard 實測（2026-07-05）：NORTH 13 分/6 站、CENTRAL 16 分/12 站、SOUTH 21 分/12 站
    const ORIGIN_AVG_MIN_PER_STATION = { NORTH: 13 / 6, CENTRAL: 16 / 12, SOUTH: 21 / 12 };
    // 新 shard 的估算 = 站點原屬 shard 的站均耗時之和（保留原站的體感速度基準）
    const ORIGIN_SHARD_OF = {
        '20': 'NORTH', '21': 'NORTH', '25': 'NORTH', '40': 'NORTH', '43': 'NORTH', '44': 'NORTH',
        '26': 'CENTRAL', '28': 'CENTRAL', '50': 'CENTRAL', '51': 'CENTRAL', '52': 'CENTRAL',
        '53': 'CENTRAL', '54': 'CENTRAL', '60': 'CENTRAL', '63': 'CENTRAL', '64': 'CENTRAL',
        '65': 'CENTRAL', '84': 'CENTRAL',
        '30': 'SOUTH', '33': 'SOUTH', '70': 'SOUTH', '72': 'SOUTH', '73': 'SOUTH', '74': 'SOUTH',
        '75': 'SOUTH', '76': 'SOUTH', '80': 'SOUTH', '81': 'SOUTH', '82': 'SOUTH', '83': 'SOUTH',
    };

    const stations = flattenStations(STATION_CONFIG);
    const estimatedMinutes = {};
    const stationCounts = {};
    for (const s of stations) {
        const perStationMin = ORIGIN_AVG_MIN_PER_STATION[ORIGIN_SHARD_OF[s.id]];
        estimatedMinutes[s.shard] = (estimatedMinutes[s.shard] || 0) + perStationMin;
        stationCounts[s.shard] = (stationCounts[s.shard] || 0) + 1;
    }

    for (const shardName of SHARD_NAMES) {
        assert.ok(
            estimatedMinutes[shardName] <= 13,
            `${shardName} 估計耗時 ${estimatedMinutes[shardName].toFixed(2)} 分超過 13 分目標上限`
        );
    }

    // 總工作量守恆：重新分配不應無中生有或憑空消失站點耗時
    const total = Object.values(estimatedMinutes).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 50) < 0.01, `總工作量應守恆為 50 分（原 13+16+21），實際 ${total}`);

    // 附帶輸出每 shard 站數（供人工檢查，non-assertion）
    for (const shardName of SHARD_NAMES) {
        assert.ok(stationCounts[shardName] >= 1);
    }
});

test('SQL migration draft 與 lib/shard-config.cjs 完全一致（防止兩份配載表互相漂移）', () => {
    const fs = require('fs');
    const path = require('path');
    const sqlPath = path.join(__dirname, '..', 'supabase', 'migrations-draft', 'shard_5way_mvdis_stations.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const match = sql.match(/value = '(\[[\s\S]*?\])'::jsonb/);
    assert.ok(match, 'SQL 檔應含可解析的 jsonb value 區塊');
    const sqlConfig = JSON.parse(match[1]);

    function flatten(config) {
        const map = {};
        for (const dept of config) {
            for (const s of dept.stations) {
                map[s.id] = JSON.stringify({ name: s.name, shard: s.shard, no_rental: !!s.no_rental });
            }
        }
        return map;
    }

    const cjsMap = flatten(STATION_CONFIG);
    const sqlMap = flatten(sqlConfig);

    assert.deepEqual(Object.keys(cjsMap).sort(), Object.keys(sqlMap).sort(), 'SQL 與 cjs 站點集合須一致');
    for (const id of Object.keys(cjsMap)) {
        assert.equal(sqlMap[id], cjsMap[id], `站點 ${id} 的 SQL 與 cjs 配載內容須一致`);
    }
});
