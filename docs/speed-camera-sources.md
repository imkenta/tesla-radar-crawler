# 台灣固定式測速照相/科技執法開放資料盤點（R7）

盤點時間：2026-07-04。方法：WebSearch 找資料集頁面 → WebFetch 讀頁面描述 → 實際 `curl` 下載驗證格式/編碼/欄位（不採信 AI 摘要生成的欄位名，一律以實測 CSV 表頭為準）。

範圍：六都優先，另加桃園（六都之一，資料完整故一併記錄）。

## 總表

| 縣市 | 資料集 | 格式 | 座標 | 更新頻率 | 編碼 | 實測筆數 | 本輪是否實作解析器 |
|---|---|---|---|---|---|---|---|
| 台北市 | [固定測速照相地點表](https://data.taipei/dataset/detail?id=745b8808-061f-4f5b-9a62-da1590c049a9) | CSV | 有（緯度、經度） | 不定期 | **Big5**（需轉碼） | 144 筆 | ✅ |
| 新北市 | [固定式測速照相（全市總表）](https://data.ntpc.gov.tw/datasets/99f3ff6e-0352-4399-a726-775ab765a1dc) | CSV | 有（longitude/latitude） | 不定期 | UTF-8 (BOM) | 190 筆 | ✅ |
| 桃園市 | [桃園市固定式測速照相](https://data.gov.tw/dataset/25935) | CSV | 有（經度/緯度，⚠️部分列順序相反，見下） | 不定期 | **Big5**（需轉碼） | 171 筆 | ✅（R8） |
| 高雄市 | [111年固定式違規照相設備及科技執法](https://data.gov.tw/dataset/148455) | CSV/JSON | 有（座標緯N度/座標經E度，非標準欄位命名） | 不定期 | UTF-8 (BOM) | 248 筆 | ✅ |
| 台中市 | 見下方「台中市」章節（R8 PDF spike） | PDF | — | — | — | — | ❌ 掃描型 PDF，不實作（見證據） |
| 台南市 | [智慧管理科技執法設備設置地點](https://data.tainan.gov.tw/Resource/1c7e82f0-d6b2-4b20-aeff-5c768100f82c) | CSV/JSON | 無（geocode 補值） | 最後更新 2025-12-26 | UTF-8 (BOM) | 72 筆 | ✅（R8，geocode） |

## 逐縣市細節

### 台北市 —— 有座標
- 資料集：`臺北市固定測速照相地點表`
- 下載連結（CSV，Big5 編碼）：
  `https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=5012e8ba-5ace-4821-8482-ee07c147fd0a`
- 欄位（轉碼後表頭）：`編號,功能,設置路段,設置地點,緯度,經度,轄區,拍攝方向,速限-速度限制,縣市,縣市代碼`
- 陷阱：原始檔為 **Big5**，直接以 UTF-8 讀取會產生亂碼，必須先 `iconv -f BIG5 -t UTF-8`。
- 「速限」欄位偶爾為多行字串（例：`"50(往北)\n60(往南)"`）或非數字（`\`），解析器需容錯。

### 新北市 —— 有座標
- 資料集：`新北市固定式測速照相`（全市總表，非分區資料集；data.gov.tw 上另外拆成 27 個分區小資料集如八里區/泰山區，內容是同一份總表的子集）
- 下載連結（CSV，UTF-8 with BOM）：
  `https://data.ntpc.gov.tw/api/datasets/99f3ff6e-0352-4399-a726-775ab765a1dc/csv/file`
- 欄位：`cityname,regionname,address,deptnm,branchnm,violation types,longitude,latitude,direct,limit`
- **注意（更正舊有認知）**：本次實測確認新北市全市總表**已含經緯度**，190 筆全數有座標，UTF-8 BOM 編碼，直接可解析。若此前 memory 記載「新北市只有文字地址無經緯度、每年更新一次」，該記載已過時或指的是另一份舊版/分區資料集，建議更新相關記憶檔。
- 「取締項目」(violation types) 欄位含「超速」「闖紅燈」等多值以頓號分隔，本 R7 規格只做測速照相，解析器對非測速項目不強制過濾（保留原始 violation types 供上層篩選），仍輸出 speed_limit。

### 高雄市 —— 有座標（欄位命名不規則）
- 資料集：`高雄市111年「固定式違規照相設備及科技執法」設置地點第1次公告`
- 下載連結（CSV，UTF-8 with BOM）：
  `https://data.kcg.gov.tw/File/directDownload/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b`
  （JSON：`https://openapi.kcg.gov.tw/Api/Service/Get/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b`）
- 欄位：`Seq,編號,型式,測照地點,測照方向,速限,行政區,測照型式,座標緯N度,座標經E度`
- 陷阱：
  - 座標欄位名是「座標緯N度」「座標經E度」，非常規 lat/lng 命名，且**緯在前、經在後**（跟其他縣市 經,緯 順序相反），解析器必須用欄位名比對而非欄位順序。
  - 「速限」欄位對「違規左轉」等非測速類型會是文字（如 `違左`）而非數字。
  - `data.kcg.gov.tw` 直接 `curl` 若不帶 User-Agent 會回 404（疑似阻擋無 UA 請求）；透過 `data.gov.tw` 中央目錄頁面轉查得到的直鏈可正常下載。

### 桃園市 —— 有座標（R8 已實作，source=`taoyuan`）
- 資料集：`桃園市固定式測速照相`
- 下載連結（CSV，Big5 編碼）：
  `https://opendata.tycg.gov.tw/api/dataset/ecd45ee5-4489-436b-bd08-7d4e4111c4a4/resource/6feee4ed-0221-40f2-bca1-980669e8d554/download`
- 欄位：`設備類別,設置縣市代碼,設置行政區,設置行政區代碼,設置地址,管轄警局,管轄警局機關代碼,管轄分局,管轄分局機關代碼,經度,緯度,拍攝方向,速限`
- 陷阱1：Big5 編碼；地址是片段（如「成功路三段235號前」），不含行政區全名，組完整地址需拼接「設置行政區」欄位。
- 陷阱2（R8 實測發現，文件未記載）：表頭寫「經度,緯度」，但**只有「固定式測速照相設備」類型該兩欄順序與表頭一致**；「路口多功能測速照相設備」「區間平均速率測速照相設備」兩種類型（全檔 171 筆中 58 筆）該兩欄實際是「緯度,經度」（順序相反）。`parseTaoyuan`（`lib/speed-camera-parser.cjs`）改用數值大小判斷：台灣經度（~119-122）恆大於緯度（~21-27），取兩欄中較大者為經度，不依欄位名/順序假設。實測 171 筆全數落在台灣經緯度範圍內（lat 24.79-25.12、lng 121.01-121.41）。

### 台中市 —— 查無開放資料
- 台中市政府資料開放平台（opendata.taichung.gov.tw）搜尋「科技執法」「固定式測速照相」查無對應資料集。
- 台中市政府警察局交通警察大隊網站僅提供 **PDF** 版「科學儀器執法設備固定式及移動式取締地點一覽表」，非結構化開放資料，不適合程式化解析（PDF table 解析成本高且格式易變動，本輪不做）。
- 若未來要涵蓋台中，選項：(a) 定期人工下載 PDF 後用 pdf-parse 抽表格，準確度需人工複核；(b) 等待台中市政府釋出結構化資料。

### 台南市 —— 無座標，R8 已實作 geocode 補值流程（source=`tainan`）
- 資料集：`臺南市智慧管理科技執法設備設置地點`
- 下載連結（CSV，UTF-8 with BOM）：
  `https://data.tainan.gov.tw/File/DirectDownload/1c7e82f0-d6b2-4b20-aeff-5c768100f82c`
- 欄位：`轄區分局,行政區,設置位置,拍攝行向,速限`
- 「設置位置」是複合字串，例：`北門路段(火車站前圓環至青年路)自動辨識違規停車及不依標線行駛科技執法系統【違規停車、違規臨時停車...】`，混雜地點描述、系統類型敘述與取締項目【】列舉。`cleanTainanLocation()`（`lib/speed-camera-parser.cjs`）規則：開頭若為【標籤】先去掉標籤本身；其後若還有【...】（違規項目列舉）從該處截斷到底。71/72 筆清理後得到乾淨的路口/路段描述；1 筆（區間平均速率執法系統，市道182線雙路段複合敘述）清理後仍殘留里程/取締項目文字，geocode 準確度存疑但不影響其餘 71 筆，也不視為 parse 失敗。
- 「行政區」欄位是**行政區代碼**（如 `67000320`）非文字。已對照台南市政府資料開放平台官方代碼表
  `https://data.tainan.gov.tw/File/DirectDownload/5b389f60-dee6-425a-8a40-f5cb2f949cf1`（實測下載驗證，2026-07-05）
  建立 14 碼對照表（`TAINAN_DISTRICT_CODES`），涵蓋本資料集實際出現的全部代碼，無遺漏。
- **测速項目未特別篩選**：本資料集本身命名為「智慧管理科技執法設備」，混合測速、闖紅燈、違規停車、未依標線行駛等多種取締類型，且欄位未提供可靠的類型分類欄位可篩選「純測速」——解析器不篩選，全數 72 筆皆輸出（與新北市「取締項目」欄位處理原則一致：保留原始資料，篩選交由上層）。
- **geocode 補值流程**（`speed-camera-sync.cjs` `writeAll` + `lib/speed-camera-writer.cjs` `fillMissingCoords`）：
  1. 該 source 標記 `needsGeocode: true`。
  2. `--write` 執行時，先查 DB 既有同 `(source, address, direction)` 列已有座標者（`getExistingCoordsForSource`），直接沿用，絕不重複呼叫 Nominatim。
  3. 剩餘缺座標紀錄才呼叫 `lib/geocoder.cjs`（1 req/s 節流），單輪呼叫上限 `SPEEDCAM_GEOCODE_MAX_CALLS`（預設 100，72 筆一輪內可補完）。
  4. geocode 查無結果或失敗：該筆 lat/lng 留 null 入庫，**不計入 source 失敗**（`writeAll` 仍標記 `ok: true`）。
- **首次回填實測**（本機台灣 IP，2026-07-05，真實 Nominatim）：72 筆全數為新地址（DB 原無 tainan 座標資料），詳細成功率見任務回報。

## 全國無統一格式的具體證據
- 座標欄位命名：台北/新北/桃園用「經度/緯度」或 `longitude/latitude`；高雄用「座標緯N度/座標經E度」（順序相反）；台南完全沒有座標欄位。
- 編碼：台北、桃園為 Big5；新北、高雄、台南為 UTF-8 with BOM。
- 「測速限」欄位：多數是純數字字串，但會混入 `違左`、`\`、多行字串等非數字內容。
- 台中無結構化資料、僅 PDF。
- 各縣市對「測速照相」與「科技執法」（含闖紅燈、違停等）的收錄範圍不一致，欄位名也不統一表達這個分類（有的用「取締項目」、有的用「型式」、有的混在描述字串內）。

## Nominatim geocode 使用時機
台北/新北/高雄/桃園皆已有原生座標，**不需要 geocode**。台南（`source=tainan`）無座標，R8 已串接 `lib/geocoder.cjs`（節流 1 req/s、自訂 User-Agent）進 `--write` 流程，見上方「台南市」章節。測試（`test/geocoder.test.cjs`、`test/speed-camera-writer.test.cjs`、`test/speed-camera-sync.test.cjs`）全部 mock，不打真實 Nominatim；只有本機首次回填執行過一次真實呼叫（72 次，1 req/s，約 72 秒）。
