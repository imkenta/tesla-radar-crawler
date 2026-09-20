# 國道測速桿「實際道路走向」離線比對工具（C-64）

**狀態（2026-09-20）：已上線。** 這個目錄是**離線**工具，產出 `data/freeway-bearing-overrides.json`；同步流程（`speed-camera-sync.cjs`）只讀那張表（`lib/freeway-bearing-overrides.cjs`），本身不連 OSM。

同步 log 出現 `⚠️ … 有國道單向桿不在方位表內` ＝官方新增了桿、改了路名或座標搬家超過 30m：那幾支會退回羅盤值（修前行為），請重跑下面的步驟更新表，並跑 `npm test`（表的健全性測試會擋住明顯算錯的結果）。

## 為什麼

`speed_cameras.direction_bearing` 目前由官方文字換算成羅盤值（北向＝0°、南向＝180°…，見 `lib/speed-camera-metadata.cjs` 的 `parseDirection`）。
App 對國道單向桿用它判斷「同向就報、對向就排除」（TeslaToolbox `SpeedCameraMath.directionDecision`）。
但「北向／南向」是路線的名義方向，不是該處道路的實際走向：國一汐止—林口段實際是東西向，車頭剛好壓在 90°／270° 的判定分界上，
結果是對向桿誤報、真桿被排除到 109m 才報（2026-09-19 實車，TeslaToolbox `docs/post-launch-issues.md` C-64）。

## 做法

1. `1-dump-freeway-cameras.cjs`：用 anon key 走 PostgREST 把國道 confirmed 桿抓下來（唯讀）。
2. `2-fetch-osm.cjs`：向 Overpass 取每支桿 120m 內的 `highway=motorway|motorway_link|trunk` 幾何（單行道的數化方向＝行車方向）。
3. `3-compute-bearings.cjs`：
   - **正負號**由里程決定，不由羅盤決定：同一條國道 ±8→60km 內所有桿兩兩連線（里程差 ≥0.8km）取圓平均、剔除離群後再平均，
     得到「里程遞增方向」；南向／東向＝里程遞增、北向／西向＝遞減。座標明顯不在國道上的桿（離 motorway >150m）不拿來當鄰桿。
   - **精確值**取 OSM：候選道路中，切線方位與上面那個方向相差 <60° 的，motorway 優先、距離近者優先。
   - **高信心才改寫**：OSM 命中、離道路 ≤40m、鄰桿連線 ≥3 對、一致度 ≥0.7。其餘一律維持現行羅盤值（不會比現在差）。
4. `4-check-against-drive-logs.cjs`／`5-check-warn-time-margin.cjs`：拿實車 BLE log 的「已通過／觸發預警」事件與當下 GPS course 當 ground truth。

## 2026-09-20 結果

- 國道單向 confirmed 桿 188 支（另 1 支路名無里程，未處理）：**高信心 170、維持舊值 18**。
- 羅盤值與實際走向的差距：<30° 87 支、30–60° 57 支、**60–90° 31 支（判定岌岌可危）、≥90° 13 支（現在就是判反的）**。
- 實車驗證（9/18 早晚、9/19 林口來回）：預警當下車頭與新方位的夾角，真桿最大 35°、平均 13°；同一批用羅盤值是最大 90°、平均 60°。
  9/19 的 5 次對向誤報（北向 37K、五楊北向 38.8K、汐五南向 29.5K、南向 22.7K、汐五南向 16.1K）新方位夾角 160–170°，全部會被正確排除；
  被壓到 109m／389m／401m 才報的三支真桿新夾角 8–9°。

完整逐桿表：`comparison-2026-09-20.csv`；正式表：`data/freeway-bearing-overrides.json`（170 筆方位＋18 筆 `keep_compass`）。

## 重跑

```bash
node --env-file=.env tools/freeway-bearings/1-dump-freeway-cameras.cjs /tmp/fw.json
node tools/freeway-bearings/2-fetch-osm.cjs /tmp/fw.json /tmp/osm.json
# 第三支腳本吃兩份 OSM 快取（120m 與加寬 400m）；沒有加寬那份就把同一個檔傳兩次
node tools/freeway-bearings/3-compute-bearings.cjs /tmp/fw.json /tmp/osm.json /tmp/osm.json /tmp/bearings.json
```
