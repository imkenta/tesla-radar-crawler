#!/usr/bin/env bash
# Cloudflare WARP 的 apt 安裝函式——單一來源（WARP 審查 M6）。
#
# 這個檔不會在 runner 上被載入。三支正式流程（bidding-plates-sync.yml、bid-announce-sync.yml、
# actions/setup-plate-runner/action.yml）的 YAML 裡各有一份由本檔產生的副本，夾在
# 「# >>> warp-apt-lib: <函式名>」與「# <<< warp-apt-lib: <函式名>」之間。
#   改這裡 → 跑 `npm run sync:warp-lib` → 一起提交。`npm test` 會檢查副本與本檔逐字相同。
# ⛔ 不要改成在 runner 上 source 這個檔：actions/cache 的還原可以寫到工作區任何位置（M1c），
#    快取驗證邏輯必須留在還原步驟碰不到的地方（workflow／action 的 inline script）。
#
# 行為測試：test/bidding-workflows.test.cjs、test/setup-action-warp-cache.test.cjs（執行 YAML 內的副本；同步檢查保證與本檔相同）。

# 逐檔比對快取 .deb 的 SHA256，相符才放進 apt archives。
# 依賴呼叫端（install_warp_bounded／install_warp_verified）的區域變數 APT_OPTS 與 ARCHIVES（bash 動態作用域）。
adopt_verified_cached_debs() {
  local CACHE_DIR="$HOME/.warp-apt-cache" URIS NAME SIZE HASH ALG HEX VER WANT ACTUAL TMP OK=0 BAD=0 UNV=0 MISS=0
  local SPECS=() MD5_TO_SHA="" ERR_FILE
  ERR_FILE=$(mktemp)
  URIS=$(sudo timeout --signal=TERM --kill-after=10s 20s \
           env DEBIAN_FRONTEND=noninteractive \
           apt-get "${APT_OPTS[@]}" install -y --print-uris cloudflare-warp 2>"$ERR_FILE" | grep "^'" || true)
  if [ -z "$URIS" ]; then
    echo "::warning::could not list the packages apt expects; cached .deb files are not used."
    tail -n 5 "$ERR_FILE" || true
    rm -f "$ERR_FILE"
    return 0
  fi
  rm -f "$ERR_FILE"
  # apt 的 --print-uris 只印 MD5（實測 Ubuntu 26.04 的 apt 仍是 MD5Sum:），不拿它當驗證依據：
  # 用「套件=版本」向 apt-cache 取同一筆索引紀錄的 SHA256（以 MD5 只當作對應紀錄的鍵），再比對檔案的 SHA256。
  while read -r _ NAME SIZE HASH; do
    case "$NAME" in ''|*/*|.*) continue ;; esac
    [ -f "$CACHE_DIR/$NAME" ] || continue
    VER="${NAME#*_}"; VER="${VER%%_*}"; VER="${VER//%3a/:}"; VER="${VER//%3A/:}"
    SPECS+=("${NAME%%_*}=${VER}")
  done <<< "$URIS"
  if [ "${#SPECS[@]}" -gt 0 ]; then
    # 每行「md5 sha256」；不用關聯陣列（測試也在 bash 3.2 上跑）
    MD5_TO_SHA=$(timeout --signal=TERM --kill-after=10s 20s apt-cache show "${SPECS[@]}" 2>/dev/null | awk '
      /^MD5sum: /  { md = $2 }
      /^SHA256: /  { sha = $2 }
      /^$/         { if (md != "" && sha != "") print md, sha; md = ""; sha = "" }
      END          { if (md != "" && sha != "") print md, sha }' || true)
  fi
  while read -r _ NAME SIZE HASH; do
    case "$NAME" in ''|*/*|.*) continue ;; esac
    if [ ! -e "$CACHE_DIR/$NAME" ] && [ ! -L "$CACHE_DIR/$NAME" ]; then MISS=$((MISS + 1)); continue; fi
    # 只收一般檔：symlink、目錄一律不用
    if [ -L "$CACHE_DIR/$NAME" ] || [ ! -f "$CACHE_DIR/$NAME" ]; then
      echo "::warning::cached $NAME is not a regular file; ignored."
      UNV=$((UNV + 1)); continue
    fi
    ALG="${HASH%%:*}"; HEX="${HASH#*:}"; WANT=""
    case "$ALG" in
      SHA256) WANT="$HEX" ;;
      MD5Sum) if [ -n "$HEX" ]; then WANT=$(awk -v m="$HEX" '$1 == m { print $2; exit }' <<< "$MD5_TO_SHA"); fi ;;
    esac
    if [ "${#WANT}" -ne 64 ]; then
      # 索引裡查不到可用的 SHA256（apt-cache 逾時、或 apt 改印別種雜湊）：不採用，但這不是「內容被換掉」
      echo "::warning::no SHA256 available for cached $NAME (apt printed ${ALG:-nothing}); it will be downloaded instead."
      UNV=$((UNV + 1)); continue
    fi
    # 大小先對不上的直接拒絕（不必把一個超大的假檔整個複製進系統碟再算雜湊）
    if [ "$(wc -c < "$CACHE_DIR/$NAME" | tr -d ' ')" != "$SIZE" ]; then BAD=$((BAD + 1)); continue; fi
    # 先複製到 root 擁有的 archives 內，再對「複本」算雜湊，相符才改名成正式檔名：
    # 快取目錄是 runner 使用者可寫的，直接對原檔算雜湊再複製會有「算完才被換掉」的空窗。
    TMP="$ARCHIVES/$NAME.adopting"
    if ! sudo cp "$CACHE_DIR/$NAME" "$TMP"; then
      sudo rm -f "$TMP"; UNV=$((UNV + 1)); continue
    fi
    ACTUAL=$(sudo sha256sum "$TMP" | cut -d' ' -f1)
    if [ "$ACTUAL" = "$WANT" ] && sudo mv -f "$TMP" "$ARCHIVES/$NAME"; then
      OK=$((OK + 1))
    else
      sudo rm -f "$TMP"
      BAD=$((BAD + 1))
    fi
  done <<< "$URIS"
  echo "cached .deb: $OK verified (SHA256) and reused, $BAD rejected (hash mismatch), $UNV unverifiable, $MISS not in cache (will be downloaded)."
  if [ "$BAD" -gt 0 ]; then echo "::warning::$BAD cached .deb file(s) failed SHA256 verification and were ignored."; fi
  return 0
}

# 競標兩支 workflow：兩段式（下載→解包）＋整體時間預算。設計說明見 bidding-plates-sync.yml 的註解。
install_warp_bounded() {
  local DEADLINE=$((SECONDS + ${WARP_APT_BUDGET:-330}))
  local UNPACK_RESERVE=60
  local TRY CAP REM RC DOWNLOADED=false
  local APT_OPTS=(-o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=20 -o Dpkg::Use-Pty=0)

  # Ubuntu 鏡像（azure.archive.ubuntu.com）卡住時改用 archive.ubuntu.com（與 setup-plate-runner 相同的替換）。
  # runner 的來源是 mirror+file:/etc/apt/apt-mirrors.txt，只改清單檔內容，不動來源 URI，既有套件清單仍可用。可重複呼叫。
  # 11/11 晚間換鏡像後 archive.ubuntu.com 同樣每個檔案卡滿逾時（本機測兩個鏡像 IPv4／IPv6 皆正常），
  # 所以退路再加：之後的 apt 一律走 IPv4，並各用 5 秒量一次兩個位址族的連線，下次失敗時 log 就看得出卡在哪。
  local NET_OPTS=()
  use_fallback_ubuntu_mirror() {
    NET_OPTS=(-o Acquire::ForceIPv4=true)
    local MIRRORS="${WARP_APT_MIRRORS_FILE:-/etc/apt/apt-mirrors.txt}"
    if [ -f "$MIRRORS" ] && grep -q 'azure\.archive\.ubuntu\.com' "$MIRRORS"; then
      local FAM
      for FAM in 4 6; do
        echo "probe IPv${FAM}: azure=$(curl -"$FAM" -s -o /dev/null -m 5 -w '%{http_code}/%{time_total}s' http://azure.archive.ubuntu.com/ubuntu/dists/ 2>/dev/null || true) archive=$(curl -"$FAM" -s -o /dev/null -m 5 -w '%{http_code}/%{time_total}s' https://archive.ubuntu.com/ubuntu/dists/ 2>/dev/null || true)"
      done
      # 只改 mirror 清單檔的內容，不動 sources.list／ubuntu.sources 的來源 URI：URI 一變，套件清單的檔名跟著變，
      # 沒有重新 update 就找不到 Ubuntu 套件清單（WARP 審查 L2 評估後維持原狀）。
      sudo sed -i -E 's#https?://azure\.archive\.ubuntu\.com/ubuntu/?#https://archive.ubuntu.com/ubuntu/#g' "$MIRRORS" || true
      echo "::warning::Ubuntu apt mirror switched to archive.ubuntu.com (IPv4 only) for this run."
    fi
  }

  # update：第 1 輪用原鏡像（正常 3–17 秒）；卡住就換鏡像再完整更新一次；仍失敗則只更新 Cloudflare 來源、
  # Ubuntu 套件清單沿用 runner 映像內既有的（11/11 實測這樣仍能解出相依；清單過期時下載階段會明確失敗）。
  # 2026-11-15（WARP 審查 M1）：快取的 .deb 會以 root 安裝，而 main 上任何 job 都寫得進這份快取；
  # apt 對 archives 內現成的檔案只比對大小。所以不再整批複製：update 之後用 --print-uris 取得 apt
  # （已驗簽的索引）預期的檔名、再向 apt-cache 取 SHA256，逐檔比對相符才放進 archives；不符、查不到雜湊或不在清單內的
  # 一律不用，由 apt 自行下載。來自別的映像版本的快取（M2）也因此只會被略過，不會被誤用。
  local ARCHIVES="${WARP_APT_ARCHIVES:-/var/cache/apt/archives}"

  # 2026-11-15（WARP 審查 H1）：只更新 Cloudflare 來源的那一輪原本只跑 1 次、上限 20 秒＝Acquire::https::Timeout，
  # apt 自己的重試來不及生效；11/13 那次失敗就是索引 0.6 秒抓完後卡 19.4 秒被砍。改成：
  #   上限 30 秒（大於 https Timeout，讓 apt 內建重試有機會跑）；有快取時失敗再試 2 輪（各 ≤40 秒、
  #   每輪重新建立連線、加 apt 的 https 除錯輸出）。沒有快取時前面已經用掉兩輪完整 update，Cloudflare-only 維持 1 輪。
  for TRY in 1 2 3 4 5; do
    # 已有快取的 .deb：跳過會碰 Ubuntu 鏡像的前兩輪，直接只更新 Cloudflare 來源
    if [ "${WARP_DEB_CACHE:-0}" = "1" ] && [ "$TRY" -lt 3 ]; then continue; fi
    REM=$((DEADLINE - SECONDS - UNPACK_RESERVE)); CAP=30
    local SCOPE=()
    if [ "$TRY" -eq 2 ]; then CAP=45; fi
    if [ "$TRY" -ge 3 ]; then
      SCOPE=(-o Dir::Etc::sourcelist=sources.list.d/cloudflare-client.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0)
      if [ "$TRY" -gt 3 ]; then CAP=40; SCOPE=(-o Debug::Acquire::https=true "${SCOPE[@]}"); fi
      if [ "${WARP_DEB_CACHE:-0}" != "1" ]; then
        echo "::warning::falling back to Cloudflare-only apt index (Ubuntu lists from the runner image are reused)."
      fi
    fi
    if [ "$CAP" -gt "$REM" ]; then CAP=$REM; fi
    if [ "$CAP" -lt 10 ]; then echo "::warning::WARP install time budget (${WARP_APT_BUDGET:-330}s, ${UNPACK_RESERVE}s of it reserved for unpacking) leaves ${REM}s for apt-get update; giving up."; return 1; fi
    echo "apt-get update attempt $TRY (cap ${CAP}s)..."
    if sudo timeout --signal=TERM --kill-after=10s "${CAP}s" \
         apt-get "${APT_OPTS[@]}" "${NET_OPTS[@]}" "${SCOPE[@]}" update; then
      break
    fi
    echo "::warning::apt-get update attempt $TRY failed or timed out."
    if [ "$TRY" -ge 5 ]; then return 1; fi
    if [ "$TRY" -ge 3 ]; then
      # Cloudflare-only 的重試只給快取模式
      if [ "${WARP_DEB_CACHE:-0}" != "1" ]; then return 1; fi
    else
      use_fallback_ubuntu_mirror
    fi
    sleep 3
  done

  # 比對快取的兩個查詢各有 20 秒上限（另加複製與算雜湊，正常共 5–8 秒）；剩餘預算不夠就不比對，直接下載
  if [ "${WARP_DEB_CACHE:-0}" = "1" ]; then
    REM=$((DEADLINE - SECONDS - UNPACK_RESERVE))
    if [ "$REM" -ge 50 ]; then adopt_verified_cached_debs
    else echo "::warning::only ${REM}s left before the unpack reserve; cached .deb files are not verified or used."; fi
  fi

  local FULL_UPDATED=false
  for TRY in 1 2 3; do
    REM=$((DEADLINE - SECONDS - UNPACK_RESERVE)); CAP=100
    if [ "$CAP" -gt "$REM" ]; then CAP=$REM; fi
    if [ "$CAP" -lt 10 ]; then echo "::warning::WARP install time budget (${WARP_APT_BUDGET:-330}s, ${UNPACK_RESERVE}s of it reserved for unpacking) leaves ${REM}s for another download attempt; stopping downloads."; break; fi
    echo "apt-get install --download-only attempt $TRY/3 (cap ${CAP}s)..."
    RC=0
    sudo timeout --signal=TERM --kill-after=10s "${CAP}s" \
         env DEBIAN_FRONTEND=noninteractive \
         apt-get "${APT_OPTS[@]}" "${NET_OPTS[@]}" install -y --download-only cloudflare-warp || RC=$?
    if [ "$RC" -eq 0 ]; then
      DOWNLOADED=true
      break
    fi
    echo "::warning::download attempt $TRY failed or timed out (partial files are kept and resumed)."
    use_fallback_ubuntu_mirror
    # 2026-11-15（WARP 審查 M2）：快取模式只更新過 Cloudflare 來源，Ubuntu 清單是 runner 映像內的舊資料；
    # 下載失敗可能是清單過期（檔案已不在鏡像上）。補一次有上限的完整 update（只做一次、失敗不擋），成功後重新比對快取。
    # 只在 apt 自己回報錯誤時才做；被 timeout 砍掉（124／137＝連線卡住）時不做，把時間留給下載重試。
    if [ "${WARP_DEB_CACHE:-0}" = "1" ] && [ "$FULL_UPDATED" != "true" ] && [ "$RC" -ne 124 ] && [ "$RC" -ne 137 ]; then
      FULL_UPDATED=true
      REM=$((DEADLINE - SECONDS - UNPACK_RESERVE)); CAP=45
      if [ "$CAP" -gt "$REM" ]; then CAP=$REM; fi
      if [ "$CAP" -ge 10 ]; then
        echo "full apt-get update after a failed download in cache mode (cap ${CAP}s)..."
        if sudo timeout --signal=TERM --kill-after=10s "${CAP}s" \
             apt-get "${APT_OPTS[@]}" "${NET_OPTS[@]}" update; then
          REM=$((DEADLINE - SECONDS - UNPACK_RESERVE))
          if [ "$REM" -ge 50 ]; then adopt_verified_cached_debs
          else echo "::warning::only ${REM}s left before the unpack reserve; cached .deb files are not re-verified."; fi
        else
          echo "::warning::full apt-get update failed or timed out; continuing with existing package lists."
        fi
      fi
    fi
    sleep 2
  done
  if [ "$DOWNLOADED" != "true" ]; then return 1; fi

  for TRY in 1 2; do
    REM=$((DEADLINE - SECONDS)); CAP=120
    if [ "$CAP" -gt "$REM" ]; then CAP=$REM; fi
    if [ "$CAP" -lt 10 ]; then echo "::warning::WARP install time budget (${WARP_APT_BUDGET:-330}s) leaves ${REM}s for unpacking; giving up."; return 1; fi
    echo "apt-get install (unpack from local .deb) attempt $TRY/2 (cap ${CAP}s)..."
    if sudo timeout --signal=TERM --kill-after=10s "${CAP}s" \
         env DEBIAN_FRONTEND=noninteractive \
         apt-get "${APT_OPTS[@]}" "${NET_OPTS[@]}" install -y --no-download cloudflare-warp; then
      return 0
    fi
    echo "::warning::unpack attempt $TRY failed or timed out; finishing any half-configured packages."
    # 最後一輪失敗後不必收尾（函式即將回傳失敗），省下最多 65 秒、不逼近步驟上限
    if [ "$TRY" -lt 2 ]; then sudo timeout --signal=TERM --kill-after=5s 60s dpkg --configure -a || true; fi
  done
  return 1
}

# 車牌同步 setup action：只更新 Cloudflare 索引 → 比對快取 → 按名稱安裝；之後重建快取目錄並算出另存的鍵（WARP_CACHE_KEY）。
install_warp_verified() {
  local APT_OPTS=(-o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=20 -o Dpkg::Use-Pty=0)
  local ARCHIVES="${WARP_APT_ARCHIVES:-/var/cache/apt/archives}"
  local CACHE_DIR="$HOME/.warp-apt-cache" HAVE_CACHE=false INSTALLED=false REJECTED=false TRY CAP BASE_KEY PRE_LIST="" POST_LIST
  local ADOPT_LOG="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/warp-adopt.$$.log"

  cloudflare_only_update() {
    for TRY in 1 2 3; do
      CAP=30
      local DEBUG_OPTS=()
      if [ "$TRY" -gt 1 ]; then CAP=40; DEBUG_OPTS=(-o Debug::Acquire::https=true); fi
      echo "apt-get update (Cloudflare repo only) attempt $TRY/3 (cap ${CAP}s)..."
      if sudo timeout --signal=TERM --kill-after=10s "${CAP}s" \
        apt-get "${APT_OPTS[@]}" "${DEBUG_OPTS[@]}" \
          -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/cloudflare-client.list \
          -o Dir::Etc::sourceparts=- \
          -o APT::Get::List-Cleanup=0 \
          update; then
        return 0
      fi
      echo "::warning::apt-get update (Cloudflare repo only) attempt $TRY failed or timed out."
      if [ "$TRY" -lt 3 ]; then sleep 3; fi
    done
    return 1
  }

  refresh_all_indexes() {
    for TRY in 1 2; do
      echo "apt-get update (all sources, fallback) attempt $TRY/2..."
      if sudo timeout --signal=TERM --kill-after=15s 90s \
        apt-get "${APT_OPTS[@]}" update; then
        return 0
      fi
      echo "::warning::Full apt-get update attempt $TRY failed or timed out."
      if [ "$TRY" -lt 2 ]; then sleep 5; fi
    done
    return 1
  }

  install_warp() {
    sudo timeout --signal=TERM --kill-after=15s 240s \
      env DEBIAN_FRONTEND=noninteractive \
      apt-get "${APT_OPTS[@]}" install -y cloudflare-warp
  }

  if ls "$CACHE_DIR"/*.deb > /dev/null 2>&1; then HAVE_CACHE=true; fi
  if [ -d "$CACHE_DIR" ]; then PRE_LIST=$(ls -A "$CACHE_DIR" | LC_ALL=C sort | sha256sum | cut -c1-32); fi

  if cloudflare_only_update; then
    if [ "$HAVE_CACHE" = "true" ]; then adopt_verified_cached_debs | tee -a "$ADOPT_LOG"; fi
    if install_warp; then
      INSTALLED=true
    else
      echo "::warning::Cloudflare WARP installation failed; refreshing all apt indexes and retrying."
    fi
  else
    echo "::warning::Cloudflare-only apt index update failed; refreshing all apt indexes and retrying."
  fi

  if [ "$INSTALLED" != "true" ]; then
    if ! refresh_all_indexes; then
      echo "::error::Unable to refresh apt indexes after bounded retries."
      return 1
    fi
    if [ "$HAVE_CACHE" = "true" ]; then adopt_verified_cached_debs | tee -a "$ADOPT_LOG"; fi
    if ! install_warp; then
      echo "::error::Cloudflare WARP package installation failed or timed out."
      return 1
    fi
  fi

  # 快取目錄整個重建，只放這一輪 apt archives 內的一般檔（全部經 apt 或上面的比對驗過）：
  # 還原進來但沒通過比對、已不在清單內、或根本不是 .deb 的東西（目錄、symlink、雜檔）都不再存回去。
  rm -rf -- "$HOME/.warp-apt-cache"
  mkdir -p "$CACHE_DIR"
  local DEB
  for DEB in "$ARCHIVES"/*.deb; do
    if [ -f "$DEB" ] && [ ! -L "$DEB" ]; then sudo cp "$DEB" "$CACHE_DIR/" || true; fi
  done
  sudo chown -R "$(id -u):$(id -g)" "$CACHE_DIR"
  # 另存的鍵（空字串＝不存）。鍵一律帶 run 編號：restore-keys 取的是同前綴下「最新」的一份，
  # 用固定鍵的話，只要那個鍵早就存在就存不進去，壞掉的那份會一直是最新的。
  #   不存：還原命中的鍵屬於同一組檔名，而且還原進來的目錄內容（檔名清單）與重建後完全相同。
  #   要存：其餘情況；以及有快取檔雜湊不符（檔名相同、內容被換掉或損毀）或不是一般檔。
  #         查不到雜湊（unverifiable）不算：那不是內容被換掉，每輪另存只會洗掉快取額度。
  WARP_CACHE_KEY=""
  POST_LIST=$(ls -A "$CACHE_DIR" | LC_ALL=C sort | sha256sum | cut -c1-32)
  # 雜湊不符，或所需檔名被目錄／symlink 佔住（檔名清單看不出差別）→ 都要另存一份乾淨的
  if grep -Eq 'failed SHA256 verification|is not a regular file' "$ADOPT_LOG" 2>/dev/null; then REJECTED=true; fi
  rm -f "$ADOPT_LOG"
  if ls "$CACHE_DIR"/*.deb > /dev/null 2>&1; then
    BASE_KEY="warp-apt-${RUNNER_OS:-Linux}-${ImageVersion:-unknown}-debs-${POST_LIST}"
    if [ "$REJECTED" = "true" ] || [ "$PRE_LIST" != "$POST_LIST" ] || [[ "${WARP_CACHE_MATCHED_KEY:-}" != "$BASE_KEY"* ]]; then
      WARP_CACHE_KEY="${BASE_KEY}-r${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}"
    fi
  fi
  return 0
}
