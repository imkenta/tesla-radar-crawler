# 測速照相同步：本機 launchd 排程（正式資料源）

**`public.speed_cameras` 的正式同步跑在維護者 Mac 的 launchd 上（台灣 IP），不是 GitHub Actions。**
`.github/workflows/speed-camera-sync.yml` 只保留手動觸發，⛔ 不要用它寫正式庫（原因見下方「為什麼不用 GitHub Actions」）。

## 組成

| 項目 | 位置 | 說明 |
|---|---|---|
| launchd 排程（副本） | `scripts/launchd/com.evstudio.speed-camera-sync.plist` | 每週一 10:00 觸發。實際生效的是安裝在 `~/Library/LaunchAgents/` 的那份，repo 這份是備份＋版本紀錄 |
| 執行腳本 | `scripts/run-speed-camera-local.sh` | 從 `.env` 只抽 `VITE_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`，跑 `node speed-camera-sync.cjs --write`；失敗跳 macOS 通知 |
| 執行 log | `logs/speed-camera-local.log` | 每輪以 `===== <時間> speed-camera-sync 開始 =====` 開頭、`===== exit=<碼> =====` 結尾；超過 1MB 砍半。`logs/` 不進 git |
| 同步本體 | `speed-camera-sync.cjs` | 來源盤點與格式陷阱見 `docs/speed-camera-sources.md` |

plist 寫死了 `/Users/juishuchang/...` 的絕對路徑（launchd 不展開 `~`），換機器或換帳號要先改 plist 與腳本內的 `REPO`、`NODE` 路徑。

### 觸發時機（launchd 語意）

- `StartCalendarInterval`：Mac **睡眠**時錯過的排程，會在醒來後補跑；睡了好幾個週期也只補一次（`man launchd.plist`）。
- **關機**跨過排程時間則該輪不會補跑，等下週一。
- `launchctl print` 的 `runs` 只算本次開機以來的次數，`runs = 0` 不代表從沒跑過，要看 log。

## 安裝／重新安裝

```bash
cp scripts/launchd/com.evstudio.speed-camera-sync.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.evstudio.speed-camera-sync 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evstudio.speed-camera-sync.plist
launchctl print gui/$(id -u)/com.evstudio.speed-camera-sync | grep -E 'state|path'
```

改排程時間＝改 repo 這份 plist → 照上面重裝 → commit。兩份要保持一致：

```bash
cmp ~/Library/LaunchAgents/com.evstudio.speed-camera-sync.plist scripts/launchd/com.evstudio.speed-camera-sync.plist && echo 一致
```

停用：`launchctl bootout gui/$(id -u)/com.evstudio.speed-camera-sync`（plist 檔留著，之後 bootstrap 即可恢復）。

## 手動跑一輪（資料修正要立刻生效時）

```bash
node --env-file=.env speed-camera-sync.cjs --dry-run --out=/tmp/speed-camera-dry.json   # 先核對，不連 DB
zsh scripts/run-speed-camera-local.sh                                                  # 正式寫入，結果進 logs/speed-camera-local.log
```

寫入前先 dry-run；寫完用下方「anon 回讀」比對各來源筆數。

## 監看清單（唯讀，每週一排程後檢查）

以下全是唯讀檢查。任何寫入（重跑 `--write`、改方位表、改 plist）都要先問維護者。

1. **這週有沒有跑**：`grep '=====' logs/speed-camera-local.log | tail -4`。最近一筆「開始」應該是本週一 10:00 左右（或該週一之後 Mac 第一次醒來的時間）。沒有 → 先看 `launchctl print gui/$(id -u)/com.evstudio.speed-camera-sync` 是否還載入、Mac 是否整段關機。
2. **有沒有成功**：該輪結尾 `===== exit=0 =====`，且摘要行是 `摘要：成功 N／黃燈 0／失敗 0`（2026-09-28 為 `成功 10／黃燈 0／失敗 0`）。
3. **異常指紋**（在該輪區段內 grep）：

| 指紋 | 代表 | 處理 |
|---|---|---|
| `Cannot find module`（該輪沒有摘要行就結束） | `node_modules` 不見了（2026-09-07 實例：9/04 根目錄大掃除刪掉 node_modules，該輪整個沒跑） | 在 repo 跑 `npm ci` 後手動補跑一輪 |
| `exit=` 不是 0、或 `失敗` > 0 | 至少一個來源紅燈（下載失敗且庫存過期／無資料） | 看該來源的錯誤訊息；回報維護者 |
| `黃燈` > 0 | 某來源當輪抓不到，資料庫沿用舊資料 | 若是 `freeway-npa` 黃燈，檢查同輪 `national-npa 聯集去重` 的丟棄筆數：2026-07-05～09-28 正常輪觀測區間為 445–624 筆（9/28 為 533），明顯低於此區間＝可能多寫了重複國道桿（2026-09-26 事故，已於 `a836768` 修正，仍要盯） |
| `官方已換檔` | `freeway-npa` 官方發布新 ZIP | 資料照寫；需重跑 `tools/freeway-bearings/` 方位表並更新內建網址（見該目錄 README） |
| `不在方位表內`、或 `表上找不到 N 筆` 的 N > 0 | 國道新桿／改名／座標搬家 | 同上，重跑 `tools/freeway-bearings/` |
| `清除 stale N 筆` 的 N 突然很大 | 官方資料大量下架，或解析壞了 | 先 dry-run 比對筆數再判斷，勿直接重跑 `--write` |
| 某來源 `解析出` 筆數比上週驟降（例如掉一半以上） | 官方改格式或下載到錯誤頁 | 回報維護者 |

已知現況（不是新異常）：`tainan geocode 補值：…新查 100 筆（成功 0）` 在目前 log 保留的每一輪（2026-07-05 起共 14 輪有此行）都是 0 成功，台南多數點位仍無座標；要處理另開議題。

4. **anon 回讀**（走 App 實際用的 PostgREST＋anon key，只讀）：

```bash
U="$(sed -n 's/^VITE_SUPABASE_URL=//p' .env | tr -d '"')"; K="$(sed -n 's/^VITE_SUPABASE_ANON_KEY=//p' .env | tr -d '"')"
for s in taipei new-taipei new-taipei-section kaohsiung taoyuan tainan taichung taichung-mobile freeway-npa national-npa; do
  printf '%-20s ' "$s"; curl -sI "$U/rest/v1/speed_cameras?select=id&source=eq.$s" -H "apikey: $K" -H "Authorization: Bearer $K" -H 'Prefer: count=exact' | grep -i content-range
done
```

看 `content-range` 斜線後的總數。判斷基準是**和上一次回讀相比**的變化，不是和 log 的 upsert 數對齊（2026-10-01 實測 national-npa 回讀 1346，9/28 log 寫 upsert 1359，差 13 筆的原因尚未查證）。

## 為什麼不用 GitHub Actions

- 高雄市政府網域（data.kcg、openapi.kcg）對境外 IP 地理封鎖（2026-07-05 實測），美國 runner 永遠抓不到。
- 2026-09-26 手動觸發 workflow：TGOS 對 runner 回 403，`freeway-npa` 黃燈，`national-npa` 去重少了國道座標，多寫進 314 筆重複國道桿；本機重跑後才被當 stale 清掉。
- 兩邊同時排程會互相覆寫，所以 workflow 只留 `workflow_dispatch`、不設 schedule。
