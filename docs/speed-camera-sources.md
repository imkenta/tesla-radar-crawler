# 台灣固定式測速照相/科技執法開放資料盤點（R7 + R9 全國集）

盤點時間：2026-07-04（R7，六都）、2026-07-05（R9，全國集）。方法：WebSearch 找資料集頁面 → WebFetch 讀頁面描述 → 實際 `curl` 下載驗證格式/編碼/欄位（不採信 AI 摘要生成的欄位名，一律以實測 CSV 表頭為準）。

範圍：六都優先，另加桃園（六都之一，資料完整故一併記錄）；R9 另接警政署全國集補齊六都以外縣市（見下方「全國集」章節）。

## 總表

| 縣市 | 資料集 | 格式 | 座標 | 更新頻率 | 編碼 | 實測筆數 | 本輪是否實作解析器 |
|---|---|---|---|---|---|---|---|
| 台北市 | [固定測速照相地點表](https://data.taipei/dataset/detail?id=745b8808-061f-4f5b-9a62-da1590c049a9) | CSV | 有（緯度、經度） | 不定期 | **Big5**（需轉碼） | 144 筆 | ✅ |
| 新北市 | [固定式測速照相（全市總表）](https://data.ntpc.gov.tw/datasets/99f3ff6e-0352-4399-a726-775ab765a1dc) | CSV | 有（longitude/latitude） | 不定期 | UTF-8 (BOM) | 190 筆 | ✅ |
| 桃園市 | [桃園市固定式測速照相](https://data.gov.tw/dataset/25935) | CSV | 有（經度/緯度，⚠️部分列順序相反，見下） | 不定期 | **Big5**（需轉碼） | 171 筆 | ✅（R8） |
| 高雄市 | [111年固定式違規照相設備及科技執法](https://data.gov.tw/dataset/148455) | CSV/JSON | 有（座標緯N度/座標經E度，非標準欄位命名） | 不定期 | UTF-8 (BOM) | 248 筆 | ✅ |
| 台中市 | [固定式科學儀器執法設備取締地點一覽表](https://www.police.taichung.gov.tw/traffic/home.jsp?id=55&parentpath=0,5,53) | PDF（文字型） | 有（座標緯度/座標經度） | 不定期 | UTF-8（PDF 文字層） | 229 筆 | ✅（R8，PDF spike 判定為文字型，已實作） |
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

### 台中市 —— 查無結構化開放資料，PDF spike（R8）判定文字型、已實作（source=`taichung`）
- 台中市政府資料開放平台（opendata.taichung.gov.tw）搜尋「科技執法」「固定式測速照相」查無對應資料集，確認仍只有 PDF。
- 資料集：`臺中市政府警察局「固定式科學儀器執法設備」取締地點一覽表(115年3月10日)`
- 官方來源頁面（表單下載）：
  `https://www.police.taichung.gov.tw/traffic/home.jsp?id=55&parentpath=0,5,53`
- 下載連結（PDF，2026-07-05 實測下載驗證，845835 bytes，14 頁）：
  `https://www.police.taichung.gov.tw/filedownload?file=downlod/202605151635480.pdf&filedisplay=...&flag=doc`
  （filedisplay 為 URL-encoded 中文檔名，見 `speed-camera-sync.cjs` SOURCES 內完整字串；下載連結非 session-based，重複下載 md5 一致，可穩定排程抓取。）
- **PDF spike 判定過程與證據**：
  1. `pdftotext -layout`（poppler）與 Node `pdf-parse`（`PDFParse.getText()`）兩種獨立工具分別抽取，皆取得**與視覺呈現一致的完整文字層**（非空白、非亂碼），確認為**文字型 PDF，非掃描影像**——若為掃描型，這兩種工具皆只能拿到空字串或需要 OCR。
  2. 全 14 頁、229 筆記錄逐筆比對：每筆的「編號」連續遞增 1~229（`sequential? True`）、每筆座標皆落在台中市地理範圍（緯度 23.5-24.6、經度 120.4-121.0，零筆超出）、`(行政區+設置地點, 拍攝方向)` 組合零重複，確認表格結構規律可靠，不是排版混亂的自由格式文字。
  3. 判定：**文字型且表格結構可靠 → 依規格實作 parser**（未使用 OCR）。
- **版面解析規則**（`parseTaichung`，`lib/speed-camera-parser.cjs`）：每筆紀錄的欄位跨 2 行（少數因備註/取締項目換行變 3-4 行）：
  ```
  <編號> <行政區> <設置地點>[ (備註，如往XX方向) ]
  <取締項目（可能再換行）> <座標緯度> <座標經度> <拍攝方向> <速限> <管轄單位>[ ※]
  ```
  以「行首為『數字 + 空白 + X區 + 空白』」判斷新紀錄起點；座標列尾端固定為「緯度 經度 方向 速限 XX分局」正則比對（容許尾端多印一個 `※` 註記符號，無額外語意，忽略）。
- **新增依賴**：`pdf-parse@2.4.5`（已加入 `package.json`/`package-lock.json`）。其 2.x 版 API 為 `PDFParse` class + `getText()`（非 1.x 的函式呼叫），文字抽取為非同步 API，`parseTaichung` 因此為 `async function`（`speed-camera-sync.cjs` 呼叫端已改為 `await parse(...)`，其餘同步 parser 不受影響）。
- 座標已含在來源資料中（「座標緯度/座標經度」欄位），**不需要 geocode**。
- 「取締項目」欄位混合「闖紅燈」「不依標誌、標線、號誌指示行駛」「超速」等多種類型（同新北市/台南模式，保留原始資料不篩選）。
- 若未來 PDF 改版導致版面結構跑掉：`parseTaichung` 對抽不到座標的記錄只會印一行警告並略過該筆（見原始碼 `flush()` 內 `console.error`），不會拋例外中斷整個 source，但需留意此時筆數會明顯低於 229，屬於需要人工複核版面規則的訊號。

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
- **首次回填實測**（本機台灣 IP，2026-07-05，真實 Nominatim，`node speed-camera-sync.cjs --write`）：72 筆全數為新地址（DB 原無 tainan 座標資料）；geocode 成功 **17/72（23.6%）**，其餘 55 筆留 null 入庫（不算失敗，符合設計）。
  - ⚠️ **勘誤（2026-07-06）**：上述 17 筆中 **15 筆是跨國誤配的假陽性**（座標落在中國，見下方「Nominatim geocode 使用時機」章節修復記錄），真實成功只有 **2/72（2.8%）**。
- **修復後重回填實測**（本機台灣 IP，2026-07-06，geocoder 已加 `countrycodes=tw`+viewbox/bounded+台灣 bbox 驗證、查詢字串補「臺南市」前綴）：沿用 DB 2 筆（先前僅存的真成功座標）、新查 70 筆**成功 0**。誠實結論：台南地址是「X路與Y路口」路口交叉格式，Nominatim/OSM 對台灣路口交叉點的解析能力在台灣界內趨近 **0%**——先前較高的「成功率」全靠跨國撞名假陽性撐起來。寧可 null 不可錯：台南市轄區的座標覆蓋實質由 `national-npa` 全國集的 **139 個台南點位**承擔（有原生座標），自建 tainan 源保留供未來補值。未來選項：TGOS 全國門牌地址定位服務（政府圖資，可解路口交叉格式），需另評估申請與 ToS。

## 全國無統一格式的具體證據
- 座標欄位命名：台北/新北/桃園用「經度/緯度」或 `longitude/latitude`；高雄用「座標緯N度/座標經E度」（順序相反）；台南完全沒有座標欄位。
- 編碼：台北、桃園為 Big5；新北、高雄、台南為 UTF-8 with BOM。
- 「測速限」欄位：多數是純數字字串，但會混入 `違左`、`\`、多行字串等非數字內容。
- 台中無結構化資料、僅 PDF。
- 各縣市對「測速照相」與「科技執法」（含闖紅燈、違停等）的收錄範圍不一致，欄位名也不統一表達這個分類（有的用「取締項目」、有的用「型式」、有的混在描述字串內）。

## Nominatim geocode 使用時機
台北/新北/高雄/桃園皆已有原生座標，**不需要 geocode**。台南（`source=tainan`）無座標，R8 已串接 `lib/geocoder.cjs`（節流 1 req/s、自訂 User-Agent）進 `--write` 流程，見上方「台南市」章節。測試（`test/geocoder.test.cjs`、`test/speed-camera-writer.test.cjs`、`test/speed-camera-sync.test.cjs`）全部 mock，不打真實 Nominatim；只有本機首次回填執行過一次真實呼叫（72 次，1 req/s，約 72 秒）。

✅ **跨國誤配問題已修復（2026-07-05 發現、2026-07-06 修復）**：DB 曾有 15 筆 `tainan` 座標被 Nominatim 誤配到中國大陸境內（如「新化區 中正路與中山路口」被配到河南省），肇因於清理後的地址字串缺乏台灣上下文。修復內容：
- `lib/geocoder.cjs` 模組預設加台灣邊界——請求帶 `countrycodes=tw` + `viewbox`/`bounded=1`，且回傳座標不在台灣 bbox（lat 20–27, lng 117–123）一律視為失敗回 null（縱深防禦，任何呼叫端都不會再踩）。
- `lib/speed-camera-writer.cjs` `fillMissingCoords` 僅對 `source==='tainan'` 的 geocode 查詢字串補「臺南市」前綴消歧義。
- production 15 筆髒座標已清為 null，清污＋重回填後全表出界列 = 0（驗證 SQL：`lat not between 20 and 27 or lng not between 117 and 123`）。
- 互動確認：台南列將來若取得正確座標，下輪 `national-npa` 的台南重疊點會被既有 30m 聯集去重自動丟棄，無害。

⚠️ **已知成本（可容忍，暫不處理）**：tainan 有 70 筆地址 geocode 恆失敗（路口格式，見上方台南章節），每輪 `--write` 都會重試這 70 筆（1 req/s 節流，約 70 秒/輪、每週一輪，本機成本可容忍）。未來優化選項：對「已知查無結果」的地址做負面快取（記錄失敗地址跳過重查），視執行頻率需求再投入。

---

# 全國集接入（R9，2026-07-05）：警政署「測速執法設置點」補齊六都以外縣市

## 動機與資料集
既有六源（taipei/new-taipei/kaohsiung/taoyuan/tainan/taichung）只涵蓋六都，共 1053 筆，六都以外 15 縣市（基隆、新竹市、新竹縣、苗栗、彰化、南投、雲林、嘉義市、嘉義縣、屏東、宜蘭、花蓮、台東、澎湖、金門）完全零資料。

- **資料集**：`測速執法設置點`（data.gov.tw/dataset/7320），提供機關：內政部警政署，授權：政府資料開放授權條款第1版
- **實際下載連結**（2026-07-05 實測驗證）：
  `https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/8B41C4A6-FDC4-4971-98BA-7FFCFE1C294C/download`
- **格式**：CSV，UTF-8 with BOM，HTTP 200，235,630 bytes
- **欄位**：`CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit`
- **⚠️ 雙層表頭陷阱（實測發現，非文件記載）**：第 1 行是英文欄位名（`CityName,...`），第 2 行是中文欄位說明（`設置縣市,設置市區鄉鎮,...`），**從第 3 行起才是真實資料**。`parseNationalNpa`（`lib/speed-camera-parser.cjs`）用「Longitude/Latitude 兩欄無法解析為有限數字」判斷並跳過該說明列，比寫死 row index 更穩健。
- **座標完整度**：實測全量抽驗零缺值
- **縣市涵蓋**：CityName 欄位實測共 31 種值，21 個為合法縣市（**缺連江縣**），另 10 種是「國道一號」「國道3甲」「台2已線」等國道/公路路段分類（非縣市，共 169 筆），`isEligibleNationalNpaCity`（判斷是否以「市」或「縣」結尾）過濾掉這類值。
- **全量統計**：1867 筆（不含表頭說明列）= 六都 864 筆 + 六都以外 15 縣市 834 筆 + 國道等非縣市 169 筆。`parseNationalNpa` 只排除國道等 169 筆，輸出 1698 筆（21 縣市，含六都）。

## 決策依據：為何不用「排除六都」黑名單，改用執行期聯集去重

最初方案曾打算在 parser 層直接排除六都（理由：自建源總筆數 1053 > 全國集六都子集 864），但**逐都 haversine ≤30m 重疊分析**（比對全國集六都子集 vs 既有六都自建源解析輸出）發現，總量比較無法反映逐點覆蓋率——各都的「全國集獨有點位」（自建源沒有、全國集有的座標點）並不少：

| 都 | 自建源(source) | 自建源筆數 | 全國集筆數 | 重疊(≤30m) | **全國集獨有** |
|---|---|---|---|---|---|
| 臺北市 | taipei | 143 | 98 | 94 | 4 |
| 新北市 | new-taipei | 190 | 189 | 188 | 1 |
| 桃園市 | taoyuan | 171 | 163 | 128 | **35** |
| 臺中市 | taichung | 229 | 150 | 70 | **80** |
| 臺南市 | tainan | 72（**原生座標 0**，需 geocode） | 139 | 0 | **139（全部）** |
| 高雄市 | kaohsiung | 248 | 125 | 78 | **47** |

臺中市重疊率只有 70/150（獨有 80 筆）、臺南市自建源完全沒有原生座標（geocode 補值率長期偏低，見上方章節），全國集反而是臺南唯一有原生座標的來源。若靜態排除六都，會漏收這 306 筆（4+1+35+80+139+47）獨有點位，等同於系統性地讓車機在這些真實存在的測速點位置不示警。

**方向欄位不納入重疊比對**：各 source 的方向描述語意/格式完全不統一（台北「南北雙向」vs 高雄「北向南」vs 桃園「往桃園市區方向」），沒有共通詞彙可比對，勉強比對反而容易把「同一支測速但描述用詞不同」的點誤判為不同支而漏丟真正的重複，故 `dedupeAgainstExisting`（`lib/speed-camera-writer.cjs`）只比對座標距離。

## 實作：執行期聯集去重（非靜態黑名單）

`speed-camera-sync.cjs` 的 `writeAll`/`syncAll` 在逐 source 迴圈中，對前六個自建 source（含台南 geocode 補值後）逐一收集座標到 `collectedPoints`；處理到 `national-npa`（陣列中排最後，標記 `dedupeAgainstOtherSources: true`）時，呼叫 `dedupeAgainstExisting(records, collectedPoints, 30)`：座標 haversine ≤30 公尺視為同一支予以丟棄，其餘（六都的獨有點位 + 15 縣市全部）保留入庫。

優點：自建源優先（同一點位以自建源資料為準，不重複）、全國集補漏（六都獨有點位不再流失）、零維護（未來任一源增減點位，去重自動跟上，不需要人工維護黑名單/白名單）。

## 資料新鮮度策略

多數資料集（含全國集與既有六都源）都沒有 per-row 更新時間戳，無法逐筆比對「哪一邊比較新」。全國集頁面的「詮釋資料更新時間」是 data.gov.tw 平台的頁面渲染時間戳，不代表資料本體當日更新，資料集本身標示「不定期更新」。因此新鮮度採取**兩邊都跟隨排程同步、各自反映官方更新**的策略：既有六源与全國集同屬 `SOURCES` 陣列一起執行同一輪排程（見 `.github/workflows`），各自下載當下最新版本，不做逐筆時間比較。若未來全國集新增可靠的逐筆「設置/更新日期」欄位，可再評估是否納入新鮮度判斷（本次實測 `CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit` 九個欄位中沒有日期欄位）。

## 已知缺口
**連江縣（馬祖）**：全國集查無資料（0 筆）。縣府有開放資料服務（`eip.matsu.gov.tw`）但未見測速照相專屬資料集。已知馬祖確實有固定測速點（第三方地圖站/PDF 提及），僅無結構化開放資料，需人工整理或向連江縣警察局索取，非本輪任務範圍。

## 實測入庫統計（2026-07-05，本機 `--write`）
DB 總筆數：1053 → 2193（+1140，全部來自 national-npa 執行期聯集去重後保留的筆數）。

各 source：taipei 143／new-taipei 190／kaohsiung 248／taoyuan 171／tainan 72／taichung 229／**national-npa 1140**（解析 1698 筆，去重丟棄 558 筆）。

national-npa 入庫後縣市分佈：臺南市 139、屏東縣 106、雲林縣 95、彰化縣 95、臺中市 80、基隆市 78、宜蘭縣 76、苗栗縣 68、新竹縣 59、新竹市 58、高雄市 47、南投縣 39、花蓮縣 37、金門縣 37、桃園市 35、澎湖縣 33、嘉義縣 26、臺東縣 16、嘉義市 11、臺北市 4、新北市 1。
