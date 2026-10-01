# 臺南測速資料修復驗收（2026-10-01）

本地修復完成，正式資料未變更。worktree：`/Users/juishuchang/Documents/Codex/2026-10-01/task-6/tainan-worktree`；分支：`fix/tainan-speed-camera-schema`；基底：`6a169bf755bc75aeea0613a2f7570a7867cd5e81`。未push、未merge、未部署、未執行正式 `--write`、未觸發GitHub workflow；主目錄仍是乾淨main。

## 已核實重現及排程

完整讀取附件6271 bytes後，自行下載官方資料重現。官方CSV新表頭有 `"拍攝\n行向"`；行政區改為區名；設置位置多數缺逐筆取締說明。舊parser靜默遺失全部方向及行政區。方向值 `南往北向` 也不能直接由共用方向函式換算。

`node` 呼叫原parser並斷言第一筆方向非空，實際輸出解析191／方向0／座標0／confirmed1／rejected1／unknown189，`AssertionError: 新 schema 第一筆方向不得遺失`。回歸測試先跑紅2項，修後綠2項，舊fixture保持原樣。

已安裝plist與 `launchctl print gui/$(id -u)/com.evstudio.speed-camera-sync` 確認每週一10:00，執行 `/Users/juishuchang/Projects/Tesla/tesla-radar-crawler/scripts/run-speed-camera-local.sh`；下輪2026-10-05。排程仍指向主目錄。9/28 log：台南191筆、確認1／排除1／待確認189，新查100成功0、91筆未處理。從7/5起每個保留geocode摘要成功數均0。

## 安全dry run及完整回歸

在worktree正常載入既有 `.env`，以本地guard僅允許官方主機GET/HEAD；禁止DB主機與Nominatim。guard位於忽略的 `evidence/no-side-effects.cjs`，未加入正式程式。

```sh
npm test
node --env-file=.env --require ./evidence/no-side-effects.cjs /Users/juishuchang/Projects/Tesla/tesla-radar-crawler/speed-camera-sync.cjs --dry-run --out=evidence/dry-run-before.json
node --env-file=.env --require ./evidence/no-side-effects.cjs speed-camera-sync.cjs --dry-run --out=evidence/dry-run-after.json
node evidence/analyze.cjs
```

`npm test`：tests290／pass290／fail0。測試全mock下載、DB與geocode，未真打Nominatim。新增新舊schema、區名／代碼、方向、必要欄位、NPA嚴格配對、區間拒絕、外市座標、負快取跨程序、191筆公平輪詢與整合去重測試。

| 台南指標 | 修前 | 修後（安全dry run） |
|---|---:|---:|
| 解析筆數 | 191 | 191 |
| direction非空 | 0 | 191 |
| confirmed | 1 | 107 |
| excluded（程式值rejected） | 1 | 1 |
| unknown | 189 | 83 |
| 有座標 | 0 | 106 |
| App可見confirmed＋座標 | 0 | 106 |

兩次十來源dry run全部下載解析成功。去除批次時間後，台北、新北、新北區間、高雄、桃園、台中、台中移動式、國道專源八來源輸出逐欄完全相同；共用parser、writer、geocoder與NPA30m聯集去重函式未改。

正式庫另以既有anon client純SELECT回讀（2026-10-01T09:40:38Z）：台南191／方向0／座標0／confirmed1／rejected1／unknown189／App可見0；NPA台南139／座標139／confirmed139／App可見139。沒有service role查詢或DB寫入。此結果與附件一致，但本次係獨立查證。

## 座標與測速分類證據

優先調查[台南智慧設備官方資源](https://data.tainan.gov.tw/Resource/1c7e82f0-d6b2-4b20-aeff-5c768100f82c)及[台南固定式交通違規資料](https://data.tainan.gov.tw/Resource/14d5b56b-ae37-4566-a742-1744ff8bff46)，所列欄位皆無座標，也未提供所有設備測速的來源契約。調查範圍內未找到更完整的台南市原生座標資料，不能據此斷言其他資料絕不存在。

採用[警政署官方測速執法設置點](https://data.gov.tw/dataset/7320)（今天全國1892筆、台南139筆），唯一行政區＋完整位置＋方向＋速限相符才借座標並confirmed。保留所有里程、路名、附註，不做模糊路名／最近鄰／里程內插；重複候選、相反方向、速限衝突、區間或非測速一律拒絕。每筆把命中地址、方向與匹配key寫入 `taxonomy_basis`，`taxonomy_source_url` 指向dataset7320。

每個NPA／DB／geocode座標都通過[官方市界多邊形](https://data.gov.tw/dataset/7442)，非僅台灣或台南bbox；高雄阿蓮與嘉義水上等bbox內外市點也有拒絕測試。國土測繪中心GML擷取臺南市不簡化，9824頂點；原始CRS EPSG:3824，與WGS84點位作市界閘門，接近邊界者可能保守拒絕。來源及雜湊存於資料檔。

[官方省道里程牌座標](https://data.gov.tw/dataset/7040)定位里程牌，不能證明攝影桿的精確位置、取締項目或方向；本版未把牌位當桿位。Nominatim只保留原有最後補值角色，加台南市界、負快取與公平處理，這次驗收沒有真呼叫。未申請TGOS帳戶、金鑰、持續存取或同意條款。

## 十筆逐點核對

以下是從106筆匹配中分散選出的十筆，台南位置文字／方向與官方NPA逐筆比對。NPA地址與台南地址相同，方向只轉換等價羅盤表述。距離比較使用完整dry run輸出及獨立NPA快照；**因座標直接借自NPA，0m代表與官方來源一致，不是獨立實地測量精度。**

| # | 台南位置＝NPA位置 | 台南方向 → NPA方向 | 緯度,經度 | 距離m | 市界內 |
|---|---|---|---|---:|---|
| 1 | 新營區 臺1線290.3公里與東山路口 | 南往北向 → 北向 | 23.308907, 120.325730 | 0.000 | 是 |
| 2 | 鹽水區 歡雅里臺19線105.6公里 | 南往北向 → 北向 | 23.292790, 120.241684 | 0.000 | 是 |
| 3 | 後壁區 臺1線279.9公里與南91線路口 | 南往北向 → 北向 | 23.388468, 120.375340 | 0.000 | 是 |
| 4 | 麻豆區 臺19甲17.2公里與新生南路路口 | 南往北向 → 北向 | 23.176693, 120.254030 | 0.000 | 是 |
| 5 | 六甲區 臺1線297.3公里與174線路口 | 北往南向 → 南向 | 23.253683, 120.312450 | 0.000 | 是 |
| 6 | 佳里區 佳青路一段（近北頭洋公車站附近） | 雙向 → 雙向 | 23.172243, 120.162590 | 0.000 | 是 |
| 7 | 新化區 臺19甲線33.5公里 | 雙向 → 雙向 | 23.055922, 120.298650 | 0.000 | 是 |
| 8 | 南化區 臺3線378.4公里 | 雙向 → 雙向 | 23.086584, 120.486984 | 0.000 | 是 |
| 9 | 安南區 安吉路-安中路口 | 南往北向 → 北向 | 23.045890, 120.188400 | 0.000 | 是 |
| 10 | 南區 金華路-永華路口 | 南往北向 → 北向 | 22.987970, 120.192085 | 0.000 | 是 |

## 30m聯集去重與剩餘缺口

139筆NPA台南全部在官方市界內。原有去重函式移除106筆、保留33筆；台南可見106＋NPA33＝139。對原有139筆逐點檢查，30m內有保留點的139筆，缺漏0。所有借值皆已有NPA點位，所以地理覆蓋沒有新增，也沒有降低；沒有把106筆借值計為新攝影桿。完整快照回歸測試鎖住此結果。

剩餘85筆無座標：

| 原因 | 筆數 |
|---|---:|
| 完整位置／方向沒有唯一NPA匹配 | 17 |
| 無可靠方向或位置、複合區間等不適用單點匹配 | 65 |
| 速限衝突 | 2 |
| 明確非測速 | 1 |

速限衝突為安南區公學路六段418號前、南區濱南路與喜樹路340巷口：台南60、NPA50，保留unknown及null。現有confirmed區間測速1筆沒有可靠起訖座標，仍null。其餘未知設備需要逐筆取締證據及可信座標，不能靠 geocode 或資料集名稱升級。

負快取 `.cache/tainan-geocode-v1.json` 忽略於git，30天TTL；查詢先從未查過，再最久未查，輸出順序不變。全191筆無結果mock：第一輪100次、略過上限91；下一週91次、負快取略過100；到期依最久未查排序。未改Nominatim1req/s及User-Agent限制。

## 交接與可重現證據

本地 `evidence/` 已忽略於git，包含前後JSON／log、production-statistics.json、verification.json、matches.json、完整npm-test.txt及red/green輸出。106筆完整trace在 `evidence/matches.json`；來源快照則納入測試fixture。

- `test/fixtures/speed-camera-tainan-20261001.csv` SHA256 `2275c9d13024d72686d12f7875772ef3be8753b12b361ac15d01a4b87352d36f`
- `test/fixtures/speed-camera-npa-tainan-20261001.csv` SHA256 `20d3e8092e33a249a29e79cfc853cc7b79b1c0f74a8d34e51d63d22bdceb534d`
- `data/tainan-boundary.json` SHA256 `0be779bc196c4f52573291adee5f8867bc2184575441bb87f458a0e8563b7775`

需維護者決定：核准這份diff後是否push與合併；正式資料何時更新由維護者選擇，這次不執行。85筆缺口沒有可信逐筆證據時維持null／unknown，暫無必須申請TGOS的決策。main尚未合併，10/5排程會繼續執行既有main。
