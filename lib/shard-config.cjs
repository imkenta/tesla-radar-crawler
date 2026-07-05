'use strict';

/**
 * 站點 → shard 配載表（版本控制單一真理來源）。
 *
 * 2026-07-05：3→5 分片重構。實測負載觸發：cron 20 分觸發 < 單 shard 實跑
 * 15~21 分（NORTH 13 / CENTRAL 16 / SOUTH 21），shard concurrency 排隊把帳面拉到
 * 28~30 分。SOUTH（12 站，21 分）最重，拆給新 SHARD4/SHARD5，NORTH/CENTRAL
 * 名稱與既有 key/secret/sync_metadata key 延續。
 *
 * 權重法：因無逐站遙測，採「原 shard 站均耗時」估算（NORTH 13/6=2.17 分/站、
 * CENTRAL 16/12=1.33 分/站、SOUTH 21/12=1.75 分/站），依行政區聚類重新分配，
 * 目標每 shard ≤13 分。
 *
 * 各 shard 站數與估計耗時（估算基準見上）：
 *   NORTH   6 站（20,21,25,40,43,44）           ≈13.0 分（原班不動）
 *   CENTRAL 5 站（50,51,52,53,54）              ≈ 6.7 分（原 12 站分出 60/63/64/65→SHARD5、26/28/84→SHARD5）
 *   SOUTH   6 站（70,72,73,74,75,76）           ≈10.5 分（原 12 站分出 30/33/80/81/82/83→SHARD4）
 *   SHARD4  6 站（30,33,80,81,82,83）           ≈10.5 分（高雄市區/高雄區+台東屏東恆春 cluster）
 *   SHARD5  7 站（26,28,60,63,64,65,84）        ≈ 9.3 分（金馬澎離島 + 台中彰化南投 cluster）
 *   合計 30 站，50.0 分工作量（原三 shard 總和 13+16+21=50，重分配後總量不變，只重切邊界）
 *
 * ⚠️ 此表是本 repo 的版控參考／測試單一真理；正式生效仍需將本表內容寫回 Supabase
 * `system_configs` 表 key='mvdis_stations' 的 value（gh-plate-sync.cjs／
 * bid-announce-sync.cjs 執行時直接讀 DB，不讀本檔）。修改本表後，push 前置條件
 * 包含：把這裡的配置同步寫回該 DB row（見 scratchpad/shard-5way.md）。
 */

const SHARD_NAMES = Object.freeze(['NORTH', 'CENTRAL', 'SOUTH', 'SHARD4', 'SHARD5']);

const STATION_CONFIG = Object.freeze([
    { id: '2', label_en: 'Taipei City', label_zh: '臺北市', stations: [
        { id: '20', name: '臺北市區監理所', shard: 'NORTH' },
        { id: '21', name: '士林監理站', shard: 'NORTH' },
        { id: '25', name: '基隆監理站', shard: 'NORTH' },
        { id: '26', name: '金門監理站', shard: 'SHARD5' },
        { id: '28', name: '連江監理站', shard: 'SHARD5' },
    ]},
    { id: '3', label_en: 'Kaohsiung City', label_zh: '高雄市', stations: [
        { id: '30', name: '高雄市區監理所', shard: 'SHARD4' },
        { id: '33', name: '旗山監理站', shard: 'SHARD4' },
    ]},
    { id: '4', label_en: 'Taipei Area', label_zh: '臺北區', stations: [
        { id: '40', name: '臺北區監理所', shard: 'NORTH' },
        { id: '43', name: '宜蘭監理站', shard: 'NORTH' },
        { id: '44', name: '花蓮監理站', shard: 'NORTH' },
    ]},
    { id: '5', label_en: 'Hsinchu Area', label_zh: '新竹區', stations: [
        { id: '50', name: '新竹區監理所', shard: 'CENTRAL' },
        { id: '51', name: '新竹市監理站', shard: 'CENTRAL' },
        { id: '52', name: '桃園監理站', shard: 'CENTRAL' },
        { id: '53', name: '中壢監理站', shard: 'CENTRAL' },
        { id: '54', name: '苗栗監理站', shard: 'CENTRAL' },
    ]},
    { id: '6', label_en: 'Taichung Area', label_zh: '臺中區', stations: [
        { id: '60', name: '臺中區監理所', shard: 'SHARD5' },
        { id: '63', name: '豐原監理站', shard: 'SHARD5' },
        { id: '64', name: '彰化監理站', shard: 'SHARD5' },
        { id: '65', name: '南投監理站', shard: 'SHARD5' },
    ]},
    { id: '7', label_en: 'Chiayi Area', label_zh: '嘉義區', stations: [
        { id: '70', name: '嘉義區監理所', shard: 'SOUTH' },
        { id: '72', name: '雲林監理站', shard: 'SOUTH' },
        { id: '73', name: '新營監理站', shard: 'SOUTH', no_rental: true },
        { id: '74', name: '臺南監理站', shard: 'SOUTH' },
        { id: '75', name: '麻豆監理站', shard: 'SOUTH' },
        { id: '76', name: '嘉義市監理站', shard: 'SOUTH' },
    ]},
    { id: '8', label_en: 'Kaohsiung Area', label_zh: '高雄區', stations: [
        { id: '80', name: '高雄區監理所', shard: 'SHARD4' },
        { id: '81', name: '臺東監理站', shard: 'SHARD4' },
        { id: '82', name: '屏東監理站', shard: 'SHARD4' },
        { id: '83', name: '恆春監理分站', shard: 'SHARD4', no_rental: true },
        { id: '84', name: '澎湖監理站', shard: 'SHARD5' },
    ]},
]);

module.exports = { SHARD_NAMES, STATION_CONFIG };
