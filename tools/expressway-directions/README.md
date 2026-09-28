# 快速道路單向測速桿「方向標籤驗證」離線工具（B-14 候選①）

**狀態（2026-09-28）：已上線。** 產出 `data/expressway-direction-verified.json`（白名單）；同步流程只讀那張表（`lib/expressway-direction-verification.cjs`），本身不連 OSM。

## 為什麼

App 自 2026-09-28（TeslaToolbox B-14 候選①）起對「快速道路＋單向＋有方位」的桿做「行進方向與桿方位夾角 >150° 就當對向排除」。
但快速道路的 `direction_bearing` 只是官方羅盤標籤：實查 79 支中有 7 支與實際車道差 >150°（例：台65線 1.8K「往五股」卻標「北向南」＝標籤寫反），照標籤排除就會漏報真桿。
⇒ 只有逐支驗證過的桿保留方位，其餘清空（App 拿不到方位就不做方向排除＝照報）。

## 通過條件（`3-verify.cjs`）

1. 30m 內有單向（oneway）的 motorway／trunk／primary 主線；
2. 標籤方位與「離桿最近的單向車道」行車方向差 < 60°；
3. 最近的反向單向車道不存在，或至少遠 3m（座標落在中央分隔島上、分不出哪一側的一律不通過）。

## 重跑

```bash
node --env-file=.env tools/expressway-directions/1-dump-expressway-cameras.cjs /tmp/ex.json
node tools/expressway-directions/2-fetch-osm.cjs /tmp/ex.json /tmp/ex_osm.json
node tools/expressway-directions/3-verify.cjs /tmp/ex.json /tmp/ex_osm.json data/expressway-direction-verified.json
npm test
```

標籤由 `3-verify.cjs` 以官方方向文字（`direction`）經 `parseDirection` 重算，不依賴資料庫裡的 `direction_bearing`（同步後未通過的桿已被清空），所以隨時可重跑。

## 2026-09-28 結果

79 支：通過 53、不通過 26（標籤與車道差 ≥60° 16 支，其中 >150° 7 支；30m 內沒有單向主線 7 支；座標落在兩側車道之間 2 支；區間測速 2 支亦在其中）。
