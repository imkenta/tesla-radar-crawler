-- ⚠️ 草稿／審查用 SQL，不由本 repo 自動套用。正式套用由主對話走閘門手動執行
-- （Supabase SQL editor 或 execute_sql，對象：TeslaStudio project okuiwdhbufcefoopfoov）。
--
-- 目的：system_configs.mvdis_stations（key='mvdis_stations'）3 shard → 5 shard 重配載。
-- 對應版控參考：lib/shard-config.cjs（STATION_CONFIG，測試單一真理），本檔 value 與其一致。
--
-- 動機：實測觸發頻率 20 分 < 單 shard 實跑 15~21 分（NORTH 13/CENTRAL 16/SOUTH 21）
-- ＝系統飽和，shard concurrency 排隊把帳面拉到 28~30 分。5 分片讓單 shard 降到 ~10~12 分，
-- 同時多兩個 GCP 專案配額池（+40%）。
--
-- 權重法：無逐站遙測，採「原 shard 站均耗時」估算
-- （NORTH 13/6=2.17 分/站、CENTRAL 16/12=1.33 分/站、SOUTH 21/12=1.75 分/站），
-- 依行政區聚類重新分配，目標每 shard ≤13 分。NORTH 單站天生較肥（現有 6 站已卡在
-- 13 分上限）故整組原封不動；CENTRAL、SOUTH 各拆一部分給新 SHARD4/SHARD5。
--
-- 各 shard 站數與估計耗時（估算基準見上，30 站合計仍是 50.0 分工作量、只重切邊界）：
--   NORTH   6 站（20,21,25,40,43,44）      ≈13.0 分（原班不動，key/secret/sync_metadata 延續）
--   CENTRAL 5 站（50,51,52,53,54）         ≈ 6.7 分（新竹桃園苗栗 cluster；原 26/28/60/63/64/65/84 分出）
--   SOUTH   6 站（70,72,73,74,75,76）      ≈10.5 分（嘉義雲林台南 cluster；原 30/33/80/81/82/83 分出）
--   SHARD4  6 站（30,33,80,81,82,83）      ≈10.5 分（高雄市區/高雄區+台東屏東恆春 cluster，新拆）
--   SHARD5  7 站（26,28,60,63,64,65,84）   ≈ 9.3 分（金馬澎離島 + 台中彰化南投 cluster，新拆）
--
-- 部署順序（零停機）：
--   1. 先 push 程式碼（workflow matrix 5 值 + SHARD4/SHARD5 key 接線）。
--      此時本 SQL 尚未套用，DB 仍是舊 3-shard 配載 → SHARD4/SHARD5 對照到 0 站，
--      loadStationData() totalStations=0，空跑無害（不會因為 0 站而報錯或誤刪資料）。
--   2. 待 GEMINI_API_KEY_SHARD4 / GEMINI_API_KEY_SHARD5 secrets 就位，
--      在 Supabase 執行本 SQL，DB 切成新 5-shard 配載。
--   3. 下一輪 workflow 觸發即依新配載生效，全程零停機、無需暫停 cron。

update public.system_configs
set value = '[
  {"id":"2","label_en":"Taipei City","label_zh":"臺北市","stations":[
    {"id":"20","name":"臺北市區監理所","shard":"NORTH"},
    {"id":"21","name":"士林監理站","shard":"NORTH"},
    {"id":"25","name":"基隆監理站","shard":"NORTH"},
    {"id":"26","name":"金門監理站","shard":"SHARD5"},
    {"id":"28","name":"連江監理站","shard":"SHARD5"}
  ]},
  {"id":"3","label_en":"Kaohsiung City","label_zh":"高雄市","stations":[
    {"id":"30","name":"高雄市區監理所","shard":"SHARD4"},
    {"id":"33","name":"旗山監理站","shard":"SHARD4"}
  ]},
  {"id":"4","label_en":"Taipei Area","label_zh":"臺北區","stations":[
    {"id":"40","name":"臺北區監理所","shard":"NORTH"},
    {"id":"43","name":"宜蘭監理站","shard":"NORTH"},
    {"id":"44","name":"花蓮監理站","shard":"NORTH"}
  ]},
  {"id":"5","label_en":"Hsinchu Area","label_zh":"新竹區","stations":[
    {"id":"50","name":"新竹區監理所","shard":"CENTRAL"},
    {"id":"51","name":"新竹市監理站","shard":"CENTRAL"},
    {"id":"52","name":"桃園監理站","shard":"CENTRAL"},
    {"id":"53","name":"中壢監理站","shard":"CENTRAL"},
    {"id":"54","name":"苗栗監理站","shard":"CENTRAL"}
  ]},
  {"id":"6","label_en":"Taichung Area","label_zh":"臺中區","stations":[
    {"id":"60","name":"臺中區監理所","shard":"SHARD5"},
    {"id":"63","name":"豐原監理站","shard":"SHARD5"},
    {"id":"64","name":"彰化監理站","shard":"SHARD5"},
    {"id":"65","name":"南投監理站","shard":"SHARD5"}
  ]},
  {"id":"7","label_en":"Chiayi Area","label_zh":"嘉義區","stations":[
    {"id":"70","name":"嘉義區監理所","shard":"SOUTH"},
    {"id":"72","name":"雲林監理站","shard":"SOUTH"},
    {"id":"73","name":"新營監理站","shard":"SOUTH","no_rental":true},
    {"id":"74","name":"臺南監理站","shard":"SOUTH"},
    {"id":"75","name":"麻豆監理站","shard":"SOUTH"},
    {"id":"76","name":"嘉義市監理站","shard":"SOUTH"}
  ]},
  {"id":"8","label_en":"Kaohsiung Area","label_zh":"高雄區","stations":[
    {"id":"80","name":"高雄區監理所","shard":"SHARD4"},
    {"id":"81","name":"臺東監理站","shard":"SHARD4"},
    {"id":"82","name":"屏東監理站","shard":"SHARD4"},
    {"id":"83","name":"恆春監理分站","shard":"SHARD4","no_rental":true},
    {"id":"84","name":"澎湖監理站","shard":"SHARD5"}
  ]}
]'::jsonb
where key = 'mvdis_stations';
