# 台灣固定式測速照相/科技執法開放資料盤點（R7 + R9 全國集）

盤點時間：2026-07-04（R7，六都）、2026-07-05（R9，全國集）。方法：WebSearch 找資料集頁面 → WebFetch 讀頁面描述 → 實際 `curl` 下載驗證格式/編碼/欄位（不採信 AI 摘要生成的欄位名，一律以實測 CSV 表頭為準）。

範圍：六都優先，另加桃園（六都之一，資料完整故一併記錄）；R9 另接警政署全國集補齊六都以外縣市（見下方「全國集」章節）。

## 總表

| 縣市 | 資料集 | 格式 | 座標 | 更新頻率 | 編碼 | 實測筆數 | 本輪是否實作解析器 |
|---|---|---|---|---|---|---|---|
| 台北市 | [固定測速照相地點表](https://data.taipei/dataset/detail?id=745b8808-061f-4f5b-9a62-da1590c049a9) | CSV | 有（緯度、經度） | 不定期 | **Big5**（需轉碼） | 144 筆 | ✅ |
| 新北市 | [固定式測速照相（全市總表）](https://data.ntpc.gov.tw/datasets/99f3ff6e-0352-4399-a726-775ab765a1dc) | CSV | 有（longitude/latitude） | 不定期 | UTF-8 (BOM) | 190 筆 | ✅ |
| 桃園市 | [桃園市固定式測速照相](https://data.gov.tw/dataset/25935) | CSV | 有（現行 schema 為座標緯度/座標經度） | 不定期 | **Big5**（需轉碼） | 118 筆（2026-07-28） | ✅（現行與舊 schema） |
| 高雄市 | [111年固定式違規照相設備及科技執法](https://data.gov.tw/dataset/148455) | CSV/JSON | 有（座標緯N度/座標經E度，非標準欄位命名） | 不定期 | UTF-8 (BOM) | 248 筆 | ✅ |
| 台中市 | [固定式科學儀器執法設備取締地點一覽表](https://www.police.taichung.gov.tw/traffic/home.jsp?id=55&parentpath=0,5,53) | PDF（文字型） | 有（座標緯度/座標經度） | 不定期 | UTF-8（PDF 文字層） | 229 筆 | ✅（R8，PDF spike 判定為文字型，已實作） |
| 台南市 | [智慧管理科技執法設備設置地點](https://data.tainan.gov.tw/Resource/1c7e82f0-d6b2-4b20-aeff-5c768100f82c) | CSV/JSON | 無（NPA逐筆借值；最後geocode） | 2026-10-01核對 | UTF-8 (BOM) | 191 筆 | 本地修復待合併；106筆借值 |

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
- 現行主下載連結（CSV，Big5 編碼）：`https://opendata.tycg.gov.tw/api/dataset/ecd45ee5-4489-436b-bd08-7d4e4111c4a4/resource/36e77f60-dabe-4fd0-8f69-a99f9acfd6f4/download`
- 舊資源 fallback：`https://opendata.tycg.gov.tw/api/dataset/ecd45ee5-4489-436b-bd08-7d4e4111c4a4/resource/6feee4ed-0221-40f2-bca1-980669e8d554/download`
- 現行欄位：`設備編號,型式,縣市,行政區,設置區域描述,設置地點_路口或路段,取締項目,座標緯度,座標經度,拍攝方向,速限,管轄單位,備註`。2026-07-28 實測 118 筆，118 筆座標皆有效。
- 現行 `型式` 與 `取締項目` 必須分開保留；逐筆分類得到 confirmed 113、rejected 5。6 筆區間平均速率明確投影為 `section_average`／`average_speed`，其餘不得從資料集名稱推測固定式或感測器。
- 舊 schema 仍由 fallback 支援：`設備類別,...,經度,緯度,...`。其欄名和值曾因設備類型互換，parser 僅對舊 schema 使用台灣經度大於緯度的數值範圍校正；現行 schema 直接依明確欄名解析。

### 台中市 —— 查無結構化開放資料，PDF spike（R8）判定文字型、已實作（source=`taichung`）
- 台中市政府資料開放平台（opendata.taichung.gov.tw）搜尋「科技執法」「固定式測速照相」查無對應資料集，確認仍只有 PDF。
- 資料集：`臺中市政府警察局「固定式科學儀器執法設備」取締地點一覽表`（目前版次 **115年7月24日**，224 筆）
- 官方來源頁面（表單下載）：
  `https://www.police.taichung.gov.tw/traffic/home.jsp?id=55&parentpath=0,5,53`
- 🔴 **2026-09-16 修正：下載連結不可寫死**（發現時資料已 51 天沒更新）
  - 檔名含上傳時戳（`downlod/<yyyymmddhhmmssN>.pdf`）。官方 **2026-07-28 重新上傳**（公告頁 `dataserno=202207040001`，標題日期 115-07-28）後，舊檔名 `202605151635480.pdf` 的 `filedownload` **不是回 404，而是回一個壞掉的 chunked body**——curl 報 `chunk hex-length char not a hex digit: 0xd`、Node undici 報 `terminated`，且 http1.1／http2／換 UA／加 Referer 全都一樣（~0.08s、size=0）⇒ 不是反爬也不是逾時。
  - 我們最後一次成功抓取是 7/27，官方 7/28 換檔 ⇒ 之後每週三次重試全敗、被黃燈容忍靜默放行 8 週。
  - ✅ 修法：每輪先從**公告頁**解析當前檔名（`resolveTaichungFixedPdfUrl`，`speed-camera-sync.cjs`）。挑選規則＝`filedisplay`（URL-decoded 中文檔名）同時含「固定式」與「一覽表」，排除「移動式」「區間」（同一頁還掛著公告、區間平均測速、科技執法、移動式等多份 PDF）。解析失敗才退回 SOURCES 內寫死的 URL（保底）。
- 下載連結（目前版次，2026-09-16 實測 885654 bytes、14 頁、224 筆）：
  `https://www.police.taichung.gov.tw/filedownload?file=downlod/202607281817151.pdf&filedisplay=...&flag=doc`
  （filedisplay 為 URL-encoded 中文檔名，見 `speed-camera-sync.cjs` SOURCES 內完整字串；下載連結非 session-based，可穩定重複下載。）
- **PDF spike 判定過程與證據**：
  1. `pdftotext -layout`（poppler）與 Node `pdf-parse`（`PDFParse.getText()`）兩種獨立工具分別抽取，皆取得**與視覺呈現一致的完整文字層**（非空白、非亂碼），確認為**文字型 PDF，非掃描影像**——若為掃描型，這兩種工具皆只能拿到空字串或需要 OCR。
  2. 全 14 頁、229 筆記錄逐筆比對：每筆的「編號」連續遞增 1~229（`sequential? True`）、每筆座標皆落在台中市地理範圍（緯度 23.5-24.6、經度 120.4-121.0，零筆超出）、`(行政區+設置地點, 拍攝方向)` 組合零重複，確認表格結構規律可靠，不是排版混亂的自由格式文字。
  3. 判定：**文字型且表格結構可靠 → 依規格實作 parser**（未使用 OCR）。
- **版面解析規則**（`parseTaichung`，`lib/speed-camera-parser.cjs`）：**兩種版面都要支援**，座標列格式兩版相同。
  - 舊版（115年3月10日）：
    ```
    <編號> <行政區> <設置地點>[ (備註，如往XX方向) ]
    <取締項目（可能再換行）> <座標緯度> <座標經度> <拍攝方向> <速限> <管轄單位>[ ※]
    ```
  - 新版（115年7月24日起）：**行政區變更時**，編號與行政區各自獨立成行；行政區未變的列則是「編號 行政區黏著設置地點」（區名與路名之間**沒有空白**）：
    ```
    1
    中區
    中區建國路與民權路口 闖紅燈、不依標誌、標線、
    號誌指示行駛 24.13584 120.68225 西往東 50 第一分局
    2 中區三民路三段與公園路口 闖紅燈、不依標誌、標線、
    號誌指示行駛、超速 24.14563 120.68389 北往南 50 第一分局
    ```
  - 起點判斷：先比舊版「數字＋空白＋X區＋空白」；再比「純數字行」（下一行為純行政區行）；最後比「數字＋空白＋其餘」。後兩者以**編號必須等於上一筆＋1** 守門，避免續行裡的數字被誤判成新紀錄。座標列尾端固定為「緯度 經度 方向 速限 XX分局」（容許尾端多印一個 `※`，無語意，忽略）。
- 🔴 **這條的真正教訓：只改 URL 會刪掉資料**。新版面丟給舊 parser 只解析得出 **4／224 筆**，而 `writeAll` 成功後會把同 source 其餘列當 stale 刪除 ⇒ 會靜默刪掉 ~225 支台中固定式測速桿，而且摘要仍顯示「成功」。因此同批加了兩道防護：
  - **筆數暴跌防護**（`ROW_COLLAPSE_MIN_RATIO`，預設 0.5）：本輪解析筆數 < DB 既有列數 × 0.5 ⇒ 該 source 直接判失敗，不 upsert、不清 stale。
  - **連續黃燈即紅燈**：黃燈（抓取失敗但庫存新鮮）會寫進 `sync_logs.error_summary` 的 `YELLOW <source>: <天數>天前` 行，下一輪讀回來；同一 source 連續第 2 次黃燈改判失敗（exit≠0、macOS 通知），不再連黃 8 週沒人知道。
- **新增依賴**：`pdf-parse@2.4.5`（已加入 `package.json`/`package-lock.json`）。其 2.x 版 API 為 `PDFParse` class + `getText()`（非 1.x 的函式呼叫），文字抽取為非同步 API，`parseTaichung` 因此為 `async function`（`speed-camera-sync.cjs` 呼叫端已改為 `await parse(...)`，其餘同步 parser 不受影響）。
- 座標已含在來源資料中（「座標緯度/座標經度」欄位），**不需要 geocode**。
- 「取締項目」欄位混合「闖紅燈」「不依標誌、標線、號誌指示行駛」「超速」等多種類型（同新北市/台南模式，保留原始資料不篩選）。
- 若未來 PDF 改版導致版面結構跑掉：`parseTaichung` 對抽不到座標的記錄只會印一行警告並略過該筆（見原始碼 `flush()` 內 `console.error`），不會拋例外中斷整個 source，但需留意此時筆數會明顯低於 229，屬於需要人工複核版面規則的訊號。

### 台南市 —— 新舊 schema 相容、逐筆 NPA 佐證及市界驗證（source=`tainan`）

- 官方混合設備資料集：[臺南市智慧管理科技執法設備設置地點](https://data.gov.tw/dataset/139129)、[臺南官方資源](https://data.tainan.gov.tw/Resource/1c7e82f0-d6b2-4b20-aeff-5c768100f82c)。UTF-8 BOM CSV：`https://data.tainan.gov.tw/File/DirectDownload/1c7e82f0-d6b2-4b20-aeff-5c768100f82c`。
- 2026-10-01 實際下載 191 筆，表頭為 `Seq,編號,轄區分局,行政區,設置位置,"拍攝\n行向",速限`。舊程式方向全空、行政區文字遺失；分類 confirmed 1／rejected 1／unknown 189，座標 0。log 從 8/24 起出現新版 191 筆；7/5 以來所有 geocode 補值摘要都成功 0。
- `parseTainan` 只在台南正規化表頭空白／換行，必要欄位缺失或欄名碰撞時報錯。行政區接受 37 區官方代碼或區名；位置仍保留舊版【取締項目】清理與原始證據。`南往北向` 等值保留原文，另換算行車方位，不更動共用方向 parser。舊 fixture 保留，新增今天完整官方 fixture。
- **分類仍 fail closed**：混合設備資料集名稱與速限值都不能證明測速。沒有逐筆取締文字或可核對的 NPA 同點證據就保留 unknown；明確非測速維持 rejected。confirmed 附 `classification_basis`、`taxonomy_basis`、`taxonomy_source_url`。NPA 證據只確認測速點，不推測感測器或固定設備型式。
- `lib/tainan-camera-enrichment.cjs` 只處理台南。使用同輪下載的[警政署測速執法設置點](https://data.gov.tw/dataset/7320)原始資料；最後 `national-npa` 重用同輪輸入，仍照原有30m聯集去重。要求 **台南行政區＋完整位置（含所有路名、里程和附註）＋相同方向＋相同速限**，僅接受唯一候選。只消除分隔符、台／臺與「公里處」差異；不補路名、不猜里程、不容許單向與雙向互借。東西／南北雙向也不等於無軸向的雙向。矛盾、歧義、複合區間全部拒絕。
- **佐證失效不覆寫**：NPA下載／解析失敗或0筆時中止台南整源，發生在geocode、upsert和stale清理之前；沿用DB既有列與原有黃燈／連續第二輪紅燈政策。取得佐證失敗不能用空陣列讓已confirmed資料降成unknown。
- **複合區間不補單點**：官方警局11506 PDF第8頁第123筆明確為區間平均速率。`data/tainan-enforcement-verified.json`保留PDF來源、雜湊和兩個完整里程範圍，僅地址／方向／速限完全相符才套 `section_average`／`average_speed`。所有區間／複合位置拒絕NPA單點、DB單點沿用、geocode，既有錯誤單點清null；未知範圍不推測point。可靠起訖座標取得前不把區間當成單一攝影桿。
- **方向驗證identity**：NPA嚴格命中後，`road`採官方NPA原文並加入trace，地方address、direction、取締原文保持不變；讓仁德臺1線342.7公里臺86線匝道正確命中既有方向驗證表，最終保留180°。共用方向驗證表與門檻不變。
- 每個座標必須通過官方台南**市界多邊形**，涵蓋 NPA 借值、DB 沿用和 geocode。`data/tainan-boundary.json` 從[國土測繪中心縣市界線](https://data.gov.tw/dataset/7442) `COUNTY_MOI_1140318.gml` 擷取臺南市，9,824 個頂點不簡化、不取 bbox；保留來源網址、SHA256 與 CRS。官方 TWD97 經緯度供 WGS84 點位作市界閘門，接近邊界的點可能被保守拒絕。
- 2026-10-01 安全 dry run：解析 **191**、方向非空 **191**、confirmed **107**／rejected **1**／unknown **83**、座標 **106**、App 可見 **106**。106 筆（55.5%）來自唯一 NPA 相符點，原有區間測速 confirmed 1 筆仍無座標。
- 剩餘 **85 筆**無座標：無完整位置與方向匹配 17；不可用位置／方向或複合區間 65；速限衝突 2（安南區公學路六段418號前、南區濱南路與喜樹路340巷口，台南60、NPA50）；明確非測速 1。寧留 null，不模糊比對。未匹配紀錄不因 geocode 成功而升級測速分類。
- 139 筆 NPA 台南原始資料全部在市界內。以原有30m去重移除 **106** 筆、保留 **33**，台南來源106＋NPA33仍覆蓋原來139筆，逐點缺漏 **0**。本次增加台南來源的可用列，沒有新增地理覆蓋；不能把106筆借值稱為106個新點。
- **台南 geocode 負快取及公平處理**：正式 `--write` 對非區間／非複合位置的剩餘缺值先沿用同key且在市界內的DB座標；其餘使用原有 Nominatim 1 req/s、自訂 User-Agent、台灣限定。單輪預設最多100次。查無結果、服務失敗或市外結果記錄在 `.cache/tainan-geocode-v1.json`（忽略於git），30天後可重試；先從未查過，再最久未查的地址，輸出順序不變。快取原子保存、移除已下架key；讀寫失敗有log。測試注入mock使用記憶體快取，絕不打真實Nominatim。191筆全失敗模擬第一輪100、下一輪91，到期仍按最久未查排序。
- **座標來源調查**：今天核對的台南智慧設備與[固定式交通違規設備資料集](https://data.tainan.gov.tw/Resource/14d5b56b-ae37-4566-a742-1744ff8bff46)皆未提供座標或完整取締類型，不能整批確認；已找到可用座標的官方來源是 NPA。[省道里程牌座標](https://data.gov.tw/dataset/7040)是里程牌位置，不能證明測速設備的精確位置或分類，這版不內插、不當成攝影桿座標。未申請TGOS門牌服務、帳戶、API key或接受條款。
- 歷史：2026-07-05 首次 geocode 17/72，其中15筆是中國誤配；7/6修台灣限定後剩2筆沿用、新查70成功0。新版資料8月起改地址／方向key後，正式台南座標降為0（2026-10-01 anon唯讀回讀確認）。本次未真geocode、未寫正式庫；完整驗收見 `docs/tainan-speed-camera-verification-20261001.md`。

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

台南重試成本已由專用負快取與公平排序處理，並先嘗試逐筆 NPA 官方座標佐證，見上方台南章節。其他來源與共用 geocoder 節流維持原有行為。

---

# 全國集接入（R9，2026-07-05）：警政署「測速執法設置點」補齊六都以外縣市

## 動機與資料集
既有六源（taipei/new-taipei/kaohsiung/taoyuan/tainan/taichung）只涵蓋六都，共 1053 筆，六都以外 15 縣市（基隆、新竹市、新竹縣、苗栗、彰化、南投、雲林、嘉義市、嘉義縣、屏東、宜蘭、花蓮、台東、澎湖、金門）完全零資料。

- **資料集**：`測速執法設置點`（data.gov.tw/dataset/7320），提供機關：內政部警政署，授權：政府資料開放授權條款第1版
- **實際下載連結**（2026-07-21 由 data.gov.tw 正式資料集頁面重新核對）：
  `https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/D737B2D5-B478-42C9-BE8C-94A5FBB7D907/download`
- **格式**：CSV，UTF-8 with BOM，HTTP 200，239,079 bytes
- **欄位**：`CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit`
- **⚠️ 雙層表頭陷阱（實測發現，非文件記載）**：第 1 行是英文欄位名（`CityName,...`），第 2 行是中文欄位說明（`設置縣市,設置市區鄉鎮,...`），**從第 3 行起才是真實資料**。`parseNationalNpa`（`lib/speed-camera-parser.cjs`）用「Longitude/Latitude 兩欄無法解析為有限數字」判斷並跳過該說明列，比寫死 row index 更穩健。
- **座標完整度**：實測全量抽驗零缺值
- **CityName 涵蓋**：實測共 31 種值，21 個為行政縣市（**缺連江縣**），另 10 種是「國道一號」「國道3甲」「台2已線」等國道／公路分類（169 筆）。這些都是有效測速點，parser 不做名稱或字尾資格判斷。
- **全量統計**（2026-07-21 直接下載現行正式資源）：1895 筆（不含表頭說明列）= 六都 895 筆 + 六都以外 15 縣市 831 筆 + 國道／公路 169 筆；其中 `國道五號` 20 筆。`parseNationalNpa` 只排除無有效座標的說明列或髒資料，所有有效點位完整輸出。

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

`speed-camera-sync.cjs` 的 `writeAll`/`syncAll` 在逐 source 迴圈中，對前六個自建 source（含台南 geocode 補值後）逐一收集座標到 `collectedPoints`；處理到 `national-npa`（陣列中排最後，標記 `dedupeAgainstOtherSources: true`）時，呼叫 `dedupeAgainstExisting(records, collectedPoints, 30)`：不讀取 CityName、道路名稱或方向字詞，只以座標 haversine ≤30 公尺判定跨來源重複點，其餘全部保留入庫。

優點：自建源優先（同一點位以自建源資料為準，不重複）、全國集補漏（六都獨有點位不再流失）、零維護（未來任一源增減點位，去重自動跟上，不需要人工維護黑名單/白名單）。

## 資料新鮮度策略

多數資料集（含全國集與既有六都源）都沒有 per-row 更新時間戳，無法逐筆比對「哪一邊比較新」。全國集頁面的「詮釋資料更新時間」是 data.gov.tw 平台的頁面渲染時間戳，不代表資料本體當日更新，資料集本身標示「不定期更新」。因此新鮮度採取**兩邊都跟隨排程同步、各自反映官方更新**的策略：既有六源與全國集同屬 `SOURCES` 陣列一起執行同一輪排程（本機 launchd 每週一，見 `docs/speed-camera-local-schedule.md`；⛔ 非 `.github/workflows`），各自下載當下最新版本，不做逐筆時間比較。若未來全國集新增可靠的逐筆「設置/更新日期」欄位，可再評估是否納入新鮮度判斷（本次實測 `CityName,RegionName,Address,DeptNm,BranchNm,Longitude,Latitude,direct,limit` 九個欄位中沒有日期欄位）。

## 已知缺口
**連江縣（馬祖）**：全國集查無資料（0 筆）。縣府有開放資料服務（`eip.matsu.gov.tw`）但未見測速照相專屬資料集。已知馬祖確實有固定測速點（第三方地圖站/PDF 提及），僅無結構化開放資料，需人工整理或向連江縣警察局索取，非本輪任務範圍。

## 實測入庫統計（2026-07-05，本機 `--write`）
DB 總筆數：1053 → 2193（+1140，全部來自 national-npa 執行期聯集去重後保留的筆數）。

各 source：taipei 143／new-taipei 190／kaohsiung 248／taoyuan 171／tainan 72／taichung 229／**national-npa 1140**（解析 1698 筆，去重丟棄 558 筆）。

national-npa 入庫後縣市分佈：臺南市 139、屏東縣 106、雲林縣 95、彰化縣 95、臺中市 80、基隆市 78、宜蘭縣 76、苗栗縣 68、新竹縣 59、新竹市 58、高雄市 47、南投縣 39、花蓮縣 37、金門縣 37、桃園市 35、澎湖縣 33、嘉義縣 26、臺東縣 16、嘉義市 11、臺北市 4、新北市 1。

---

# 測速 taxonomy 與國道專源（2026-07-28）

## 正交欄位與 fail-closed 規則

舊 `camera_type` 同時混合設備佈署、測量方式與感測器，無法誠實表達科技執法或區間測速。本輪新增三個正交欄位：

- `installation_class`: `traditional_fixed | integrated_technology | mobile | unknown`
- `speed_measurement_mode`: `point | section_average | unknown`
- `sensor_technology`: `radar | laser | vision | inductive_loop | average_speed | mixed | unknown`

逐筆保留 `equipment_type_raw`，並以 `taxonomy_basis`、`taxonomy_source_url`、`taxonomy_observed_at` 記錄依據。未命中明確逐筆文字、來源契約或窄範圍官方點位 override 時維持 `unknown`；「科技執法」只足以判斷 `integrated_technology`，不得推測雷達或雷射。相容欄位 `camera_type` 僅由 taxonomy 投影：區間為 `section`、移動式為 `mobile`、明確傳統固定且點測速為 `fixed`，其餘為 `unknown`。

測速資格先看逐筆 `enforcement_items_raw`：含超速／測速／平均速率才確認；明示闖紅燈、違停、安全距離等非測速項目則排除。只有逐筆欄位缺失時，才允許 `speed_only`、`mobile_speed`、`section_speed` 來源契約補足，避免來源名稱把混合資料中的非測速列誤收。

## `freeway-npa` 國道固定式專源

- 資料集：國道公路固定式測速照相地點（[data.gov.tw/dataset/13940](https://data.gov.tw/dataset/13940)）。
- 下載連結（2026-09-26 起）：每輪先打 `https://data.gov.tw/api/v2/rest/dataset/13940`，取 `distribution[].resourceDownloadUrl` 裡的 TGOS ZIP（`resolveFreewayNpaZipUrl`）。檔名含發布日（`1150720-…zip`），官方換新檔時舊檔可能照樣 200，寫死網址會靜默過期；解析失敗才退回 `SOURCES` 內建網址。同步 log 出現 `freeway-npa 解析到的當前檔案與內建網址不同（官方已換檔）` ＝官方換檔了：資料照新檔寫入，但**國道方位表要重跑**（新桿不在表內會印 `⚠️ … 不在方位表內`），並把內建網址更新成新檔。
- 格式：TGOS ZIP，內含一個資料 CSV 與 `manifest.csv`。parser 使用直接依賴 `yauzl` 在記憶體中讀取唯一非 manifest CSV，不把 ZIP entry 解壓到檔案系統。
- 欄位：`設備編號,型式,縣市,行政區,設置區域描述,設置地點,取締項目,座標緯度,座標經度,拍攝方向,速限,管轄單位,備註`。
- `SOURCES` 順序固定為 `taipei → new-taipei → new-taipei-section → kaohsiung → taoyuan → tainan → taichung → taichung-mobile → freeway-npa → national-npa`。國道專源先進入座標聯集，最後的全國集才做 30 公尺座標去重，因此同點優先保留 raw 欄位較完整的國道專源。
- 前置來源當輪抓取失敗（黃燈／紅燈都一樣，資料庫舊資料原樣保留）時，`writeAll` 改用該來源在資料庫的既有確認點位（`getExistingConfirmedPointsForSource`，分頁避開 1000 筆截斷）當 national-npa 去重基準；連資料庫都查不到就讓 national-npa 當輪不寫入（走黃燈）。2026-09-26 實例：freeway-npa 被擋後 national-npa 多寫 314 筆重複國道桿。
- 無效座標不導致整列消失：例如經度髒字串會保留該筆、該維度為 `null`，便於稽核與由其他來源補位。

雪山隧道只對官方逐點核對的 16 個國五點位套用窄 override：南向、北向各 8 個，里程集合固定為 `16.9, 18.3, 19.7, 21.1, 22.5, 23.9, 25.3, 26.7` 公里。設備佈署依據來自 dataset 100857，點測速與雷達依據來自 dataset 13940；其他國五、其他隧道或近似文字均不得泛化。

## 桃園現行資源

主資源更新為 `36e77f60-dabe-4fd0-8f69-a99f9acfd6f4`，舊 `6feee4ed-0221-40f2-bca1-980669e8d554` 保留為 fallback。現行 Big5 schema 分開提供 `型式`、`取締項目` 與明確 `座標緯度／座標經度`；parser 同時支援舊 schema 的經緯度錯置修復。現行混合資料的紅燈專用列會依逐筆取締項目排除，不會被資料集的測速來源契約翻盤。
