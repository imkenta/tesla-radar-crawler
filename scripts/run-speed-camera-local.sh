#!/bin/zsh
# 測速照相同步——本機（台灣 IP）排程執行版
# 由 launchd 每週觸發（~/Library/LaunchAgents/com.evstudio.speed-camera-sync.plist）。
# 為什麼在本機跑：高雄市政府網域對境外 IP 地理封鎖（data.kcg + openapi.kcg 雙主機實測全擋，
# 2026-07-05），GitHub 美國 runner 永遠抓不到；台灣 IP 全源可達。
# ⚠️ .env 含帶空白的值，不能整檔 source——只精準抽取需要的兩個變數。

set -u
REPO="/Users/juishuchang/Projects/Tesla/tesla-radar-crawler"
LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/speed-camera-local.log"
NODE="/opt/homebrew/bin/node"

mkdir -p "$LOG_DIR"
cd "$REPO" || exit 1

export VITE_SUPABASE_URL="$(sed -n 's/^VITE_SUPABASE_URL=//p' .env | tr -d '"' | head -1)"
export SUPABASE_SERVICE_ROLE_KEY="$(sed -n 's/^SUPABASE_SERVICE_ROLE_KEY=//p' .env | tr -d '"' | head -1)"

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') speed-camera-sync 開始 ====="
  "$NODE" speed-camera-sync.cjs --write
  RC=$?
  echo "===== exit=$RC ====="
} >> "$LOG" 2>&1

# 失敗時跳 macOS 桌面通知（本機管線是唯一資料源，死了要看得見）
if [ "${RC:-1}" -ne 0 ]; then
  /usr/bin/osascript -e 'display notification "測速照相同步失敗，詳見 logs/speed-camera-local.log" with title "speed-camera-sync"' 2>/dev/null
fi

# log 超過 1MB 就砍半（保留後半）
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 1048576 ]; then
  tail -c 524288 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
