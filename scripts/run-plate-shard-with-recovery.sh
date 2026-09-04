#!/usr/bin/env bash

set -uo pipefail

readonly MVDIS_PREFLIGHT_EXIT_CODE=75
readonly SHARD="${1:-}"
readonly MODE="${2:-primary}"
readonly RESULT_PATH="${RESULT_PATH:-${RUNNER_TEMP:-/tmp}/plate-sync-result-${SHARD}.json}"
# 同 run 站點續爬記錄：同一 runner 上跨 crawler process 存活，換 runner 自然歸零。
readonly COMPLETED_STATIONS_FILE="${COMPLETED_STATIONS_FILE:-${RUNNER_TEMP:-/tmp}/plate-completed-stations-${SHARD}.json}"
readonly INITIAL_DELAY_SECONDS="${INITIAL_DELAY_SECONDS:-0}"
readonly RETRY_COOLDOWN_SECONDS="${RETRY_COOLDOWN_SECONDS:-15}"
readonly MAX_PREFLIGHT_ATTEMPTS="${MAX_PREFLIGHT_ATTEMPTS:-2}"
# spare 模式會在讀到 primary 的 result artifact 後以其 deadline 覆寫，故非 readonly。
DEADLINE_EPOCH="${DEADLINE_EPOCH:-0}"
# spare（熱備援）模式參數：輪詢間隔壓 API 用量（GITHUB_TOKEN 每 repo 每小時
# 1000 次上限，5 lane × 每 20 分一輪要省著用）；暖身重抽上限見 run_spare。
readonly SPARE_POLL_INTERVAL_SECONDS="${SPARE_POLL_INTERVAL_SECONDS:-20}"
readonly SPARE_MAX_WAIT_SECONDS="${SPARE_MAX_WAIT_SECONDS:-1080}"
readonly WARM_TICKET_MAX_TRIES="${WARM_TICKET_MAX_TRIES:-3}"
# 備援機獨立接手用：primary 開爬前死於 setup 時沒有 artifact 可讀 deadline，
# 改以備援機自身起跑時間＋lane 預算推算（兩者同輪同秒發車，誤差數秒）。
readonly SPARE_START_EPOCH="${SPARE_START_EPOCH:-0}"
readonly LANE_BUDGET_SECONDS="${LANE_BUDGET_SECONDS:-1140}"
# primary 原地重抽 WARP 身分的預算門檻：480s（recovery gate 下限）＋重抽與一次
# preflight 失敗的最壞耗時（~180s）＋餘裕（60s）。低於此值直接交棒，不賭。
readonly PRIMARY_REROLL_MIN_REMAINING_SECONDS="${PRIMARY_REROLL_MIN_REMAINING_SECONDS:-720}"

if [ -z "$SHARD" ]; then
  echo "::error::Missing shard argument."
  exit 2
fi

case "$MODE" in
  primary|fresh|spare) ;;
  *)
    echo "::error::Unknown recovery mode: $MODE"
    exit 2
    ;;
esac

for numeric_value in "$INITIAL_DELAY_SECONDS" "$RETRY_COOLDOWN_SECONDS" "$MAX_PREFLIGHT_ATTEMPTS" "$DEADLINE_EPOCH" "$PRIMARY_REROLL_MIN_REMAINING_SECONDS" "$SPARE_POLL_INTERVAL_SECONDS" "$SPARE_MAX_WAIT_SECONDS" "$WARM_TICKET_MAX_TRIES" "$SPARE_START_EPOCH" "$LANE_BUDGET_SECONDS"; do
  if ! [[ "$numeric_value" =~ ^[0-9]+$ ]]; then
    echo "::error::Recovery timing values must be non-negative integers."
    exit 2
  fi
done

if [ "$MAX_PREFLIGHT_ATTEMPTS" -lt 1 ] || [ "$MAX_PREFLIGHT_ATTEMPTS" -gt 8 ]; then
  echo "::error::MAX_PREFLIGHT_ATTEMPTS must be between 1 and 8."
  exit 2
fi

write_outcome() {
  local status="$1"

  mkdir -p "$(dirname "$RESULT_PATH")"
  # deadline_epoch 一併寫入：primary 的 result artifact 是熱備援 runner 取得
  # lane 共同預算的唯一管道（spare 與 primary 平行啟動，拿不到 needs outputs）。
  printf '{"shard":"%s","status":"%s","deadline_epoch":%s}\n' \
    "$SHARD" "$status" "${DEADLINE_EPOCH:-0}" > "$RESULT_PATH"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'status=%s\n' "$status" >> "$GITHUB_OUTPUT"
  fi
}

run_crawler() {
  local skip_jitter="${1:-0}"
  local exit_code
  local remaining_seconds

  if [ "$DEADLINE_EPOCH" -gt 0 ]; then
    remaining_seconds=$((DEADLINE_EPOCH - $(date +%s)))
    if [ "$remaining_seconds" -le 0 ]; then
      echo "::error::Shard $SHARD has exhausted its end-to-end lane budget before starting another crawler."
      return "$MVDIS_PREFLIGHT_EXIT_CODE"
    fi

    echo "Shard $SHARD has ${remaining_seconds}s remaining in its end-to-end lane budget."
    SKIP_SHARD_JITTER="$skip_jitter" COMPLETED_STATIONS_FILE="$COMPLETED_STATIONS_FILE" \
      timeout --signal=TERM --kill-after=15s \
      "${remaining_seconds}s" node gh-plate-sync.cjs "--shard=$SHARD"
    exit_code=$?
    if [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ] || [ "$exit_code" -eq 143 ]; then
      echo "::error::Shard $SHARD crawler reached the end-to-end lane deadline."
      return "$MVDIS_PREFLIGHT_EXIT_CODE"
    fi
  else
    SKIP_SHARD_JITTER="$skip_jitter" COMPLETED_STATIONS_FILE="$COMPLETED_STATIONS_FILE" \
      node gh-plate-sync.cjs "--shard=$SHARD"
    exit_code=$?
  fi

  return "$exit_code"
}

warp_cli() {
  sudo warp-cli "$@" 2>/dev/null || sudo warp-cli --accept-tos "$@" 2>/dev/null
}

wait_before_retry() {
  local seconds="$1"
  local reason="$2"
  local remaining_seconds

  if [ "$seconds" -gt 0 ]; then
    if [ "$DEADLINE_EPOCH" -gt 0 ]; then
      remaining_seconds=$((DEADLINE_EPOCH - $(date +%s)))
      if [ "$remaining_seconds" -le "$seconds" ]; then
        echo "::error::$reason, but only ${remaining_seconds}s remain in the lane budget."
        return 1
      fi
    fi
    echo "::warning::$reason; cooling down for ${seconds}s before the next isolated browser attempt."
    sleep "$seconds"
  fi

  return 0
}

# 2026-08-30：MVDIS 擋的是個別出口 IP，不是「非台灣 IP」（過去每天 70/72 輪從美國
# 出口成功）。單純 disconnect/connect 沿用同一 registration，常拿回同一顆出口 IP，
# 等於浪費一次重試；重註冊（registration delete → new）才是重抽出口 IP 的樂透票，
# 成本 ~40 秒，遠低於交棒 fresh runner 的 2-3 分鐘 setup。
reroll_warp_identity() {
  local warp_attempt
  local trace
  local host

  echo "Re-rolling WARP identity: new registration = new exit-IP lottery ticket."

  warp_cli disconnect || true
  warp_cli registration delete || true
  if ! warp_cli registration new; then
    echo "::warning::Unable to obtain a fresh WARP registration."
    return 1
  fi

  # registration 重置可能清掉 split-tunnel 名單；Gemini 若被捲回 WARP 隧道會變
  # unsupported-location 400 → HARD_FAILURE，所以重抽後一律重建排除清單。
  # 重複加入既有排除項在部分 warp-cli 版本會報錯，因此失敗僅告警，
  # 由下方的 split-tunnel 實測（ipify 直連 IP ≠ WARP 出口 IP）做最終裁決。
  for host in generativelanguage.googleapis.com api.ipify.org; do
    warp_cli tunnel host add "$host" || \
      echo "::warning::Could not re-add $host to the WARP exclusion list (may already be excluded)."
  done
  if [ -n "${VITE_SUPABASE_URL:-}" ]; then
    local supabase_host
    local supabase_ip
    supabase_host=$(sed -E 's#https?://([^/]+).*#\1#' <<< "$VITE_SUPABASE_URL")
    supabase_ip=$(getent ahostsv4 "$supabase_host" 2>/dev/null | awk 'NR == 1 { print $1 }')
    if [ -n "$supabase_ip" ]; then
      warp_cli add-excluded-route "${supabase_ip}/32" || true
    fi
  fi

  if ! warp_cli connect; then
    echo "::warning::Unable to reconnect WARP after re-registration."
    return 1
  fi

  for warp_attempt in 1 2 3 4 5 6; do
    trace=$(curl -4 -fsS --max-time 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || true)
    if grep -q '^warp=on$' <<< "$trace"; then
      echo "WARP identity re-rolled and verified on attempt $warp_attempt/6."

      # split-tunnel 實測：ipify 在排除清單內應走 runner 直連 IP，與 WARP 出口
      # IP 相同代表排除清單失效（Gemini 也會被捲進隧道）。
      local warp_ip
      local direct_ip
      warp_ip=$(awk -F= '$1 == "ip" { print $2 }' <<< "$trace")
      direct_ip=$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
      if [ -n "$warp_ip" ] && [ -n "$direct_ip" ] && [ "$warp_ip" = "$direct_ip" ]; then
        echo "::warning::Split-tunnel exclusion appears broken after re-registration (direct IP == WARP exit IP)."
        return 1
      fi
      return 0
    fi
    sleep 5
  done

  echo "::warning::Cloudflare trace did not confirm warp=on after re-registration."
  return 1
}

run_primary() {
  local first_exit
  local second_exit
  local remaining_seconds

  run_crawler 0
  first_exit=$?

  case "$first_exit" in
    0)
      write_outcome SUCCESS
      return 0
      ;;
    "$MVDIS_PREFLIGHT_EXIT_CODE")
      # WARP 出口樂透沒中：交棒 fresh runner 要再花 2-3 分鐘 setup；原地重抽
      # registration 只要 ~40 秒。預算仍足（重抽＋一次 preflight 失敗後，交棒時
      # recovery gate 的 600 秒門檻必須仍過）才原地重抽一張，否則維持立即交棒。
      # DEADLINE_EPOCH 未設（無預算資訊）時不賭，直接交棒。
      if [ "$DEADLINE_EPOCH" -gt 0 ]; then
        remaining_seconds=$((DEADLINE_EPOCH - $(date +%s)))
        if [ "$remaining_seconds" -ge "$PRIMARY_REROLL_MIN_REMAINING_SECONDS" ] && reroll_warp_identity; then
          echo "Shard $SHARD retrying once on the primary runner with a fresh WARP identity."
          run_crawler 1
          second_exit=$?
          case "$second_exit" in
            0)
              write_outcome SUCCESS
              return 0
              ;;
            "$MVDIS_PREFLIGHT_EXIT_CODE")
              ;;
            *)
              echo "::error::Shard $SHARD failed with non-retryable exit code $second_exit."
              write_outcome HARD_FAILURE
              return 0
              ;;
          esac
        fi
      fi
      echo "::warning::Shard $SHARD is leaving the primary runner for isolated fresh-runner recovery."
      write_outcome RETRY
      return 0
      ;;
    *)
      echo "::error::Shard $SHARD failed with non-retryable exit code $first_exit."
      write_outcome HARD_FAILURE
      return 0
      ;;
  esac

}

run_fresh() {
  local attempt
  local exit_code

  if ! wait_before_retry "$INITIAL_DELAY_SECONDS" "Shard $SHARD is waiting for its dedicated fresh-runner MVDIS slot"; then
    write_outcome RETRY
    return "$MVDIS_PREFLIGHT_EXIT_CODE"
  fi

  for ((attempt = 1; attempt <= MAX_PREFLIGHT_ATTEMPTS; attempt++)); do
    echo "Fresh-runner attempt $attempt/$MAX_PREFLIGHT_ATTEMPTS for shard $SHARD."
    run_crawler 1
    exit_code=$?

    case "$exit_code" in
      0)
        write_outcome SUCCESS
        return 0
        ;;
      "$MVDIS_PREFLIGHT_EXIT_CODE")
        if [ "$attempt" -eq "$MAX_PREFLIGHT_ATTEMPTS" ]; then
          echo "::error::Shard $SHARD exhausted $MAX_PREFLIGHT_ATTEMPTS isolated MVDIS attempts on the fresh runner."
          write_outcome RETRY
          return "$MVDIS_PREFLIGHT_EXIT_CODE"
        fi
        ;;
      *)
        echo "::error::Shard $SHARD failed with non-retryable exit code $exit_code on fresh-runner attempt $attempt."
        write_outcome HARD_FAILURE
        return "$exit_code"
        ;;
    esac

    if ! wait_before_retry "$RETRY_COOLDOWN_SECONDS" "Shard $SHARD received another transient MVDIS failure"; then
      write_outcome RETRY
      return "$MVDIS_PREFLIGHT_EXIT_CODE"
    fi
    if ! reroll_warp_identity; then
      echo "::error::Unable to re-roll the WARP identity between fresh-runner attempts for shard $SHARD."
      write_outcome RETRY
      return "$MVDIS_PREFLIGHT_EXIT_CODE"
    fi
  done
}

# 熱備援（2026-09-01）：與 primary 平行啟動，setup 完先暖身驗票，等 primary
# 的 result artifact 出現後接棒——省掉舊 recovery 路徑上 2.5 分鐘的 setup
# 關鍵路徑（昨天多場敗局差距正是 2-3 分鐘）。swap 全有全無語義完全不動。
run_spare() {
  local warm_try
  local waited=0
  local artifact_id=""
  local primary_conclusion=""
  local result_json=""
  local primary_status=""
  local primary_deadline=""

  # 1) 暖身：先確保手上是一張經 Chromium 驗證的好票（等待期先把樂透抽完）。
  for ((warm_try = 1; warm_try <= WARM_TICKET_MAX_TRIES; warm_try++)); do
    if SKIP_SHARD_JITTER=1 COMPLETED_STATIONS_FILE="$COMPLETED_STATIONS_FILE" \
      node gh-plate-sync.cjs "--shard=$SHARD" --preflight-only; then
      echo "Spare holds a verified MVDIS ticket (warm attempt $warm_try/$WARM_TICKET_MAX_TRIES)."
      break
    fi
    if [ "$warm_try" -lt "$WARM_TICKET_MAX_TRIES" ]; then
      reroll_warp_identity || true
    else
      echo "::warning::Spare could not verify a ticket after $WARM_TICKET_MAX_TRIES rolls; standing by anyway (crawl path re-rolls on its own)."
    fi
  done

  # 2) 等 primary 的 result artifact（或 primary 沒留下 artifact 就終局）。
  while [ "$waited" -lt "$SPARE_MAX_WAIT_SECONDS" ]; do
    artifact_id=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts" \
      --jq '[.artifacts[] | select(.name == "plate-sync-result-'"$SHARD"'")][0].id // ""' 2>/dev/null || true)
    if [ -n "$artifact_id" ]; then
      break
    fi
    primary_conclusion=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100" \
      --jq '[.jobs[] | select(.name | endswith("primary-attempt ('"$SHARD"')"))][0].conclusion // ""' 2>/dev/null || true)
    if [ -n "$primary_conclusion" ]; then
      # 2026-09-04：SUCCESS/RETRY/HARD_FAILURE 都會留 artifact；「失敗且無 artifact」＝
      # primary 在開爬前就死於 setup（apt 慢/逾時，SHARD5 10:03/10:23 實例）。此時
      # 健康的備援機不該收工，而是以自身起跑時間推算 lane 預算、整個 shard 接手。
      if [ "$primary_conclusion" != "success" ] && [ "$SPARE_START_EPOCH" -gt 0 ]; then
        DEADLINE_EPOCH=$((SPARE_START_EPOCH + LANE_BUDGET_SECONDS))
        echo "Primary died before crawling ($primary_conclusion, no artifact); spare taking the whole shard $SHARD."
        spare_take_over
        return $?
      fi
      echo "Primary finished ($primary_conclusion) without publishing a result artifact; spare standing down."
      write_outcome SPARE_IDLE
      return 0
    fi
    sleep "$SPARE_POLL_INTERVAL_SECONDS"
    waited=$((waited + SPARE_POLL_INTERVAL_SECONDS))
  done

  if [ -z "$artifact_id" ]; then
    echo "::warning::Spare wait timed out without seeing a primary result; standing down."
    write_outcome SPARE_IDLE
    return 0
  fi

  # 3) 讀 primary outcome（artifact 是 zip；unzip -p 直接吐 JSON）。
  local artifact_zip="${RUNNER_TEMP:-/tmp}/plate-sync-result-${SHARD}.zip"
  if ! gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip" > "$artifact_zip"; then
    echo "::error::Spare failed to download the primary result artifact."
    write_outcome SPARE_IDLE
    return 0
  fi
  result_json=$(unzip -p "$artifact_zip" 2>/dev/null || true)
  primary_status=$(sed -nE 's/.*"status":"([A-Z_]+)".*/\1/p' <<< "$result_json")
  primary_deadline=$(sed -nE 's/.*"deadline_epoch":([0-9]+).*/\1/p' <<< "$result_json")

  case "$primary_status" in
    SUCCESS)
      echo "Primary completed $SHARD on its own; spare standing down."
      write_outcome SPARE_IDLE
      return 0
      ;;
    HARD_FAILURE)
      echo "Primary hit a non-retryable failure; spare must not mask it. Standing down."
      write_outcome SPARE_IDLE
      return 0
      ;;
    RETRY)
      ;;
    *)
      echo "::warning::Unrecognized primary status '${primary_status:-EMPTY}'; spare standing down."
      write_outcome SPARE_IDLE
      return 0
      ;;
  esac

  # 4) 接棒：以 primary 的 lane 預算為準，沿用既有 fresh 重試迴圈（含重抽）。
  if [ -n "$primary_deadline" ] && [ "$primary_deadline" -gt 0 ]; then
    DEADLINE_EPOCH="$primary_deadline"
  fi
  spare_take_over
  return $?
}

# 備援機接手爬行（兩條路徑共用）：預算門檻 240s（已暖機、零 setup 成本）。
spare_take_over() {
  if [ "$DEADLINE_EPOCH" -gt 0 ]; then
    local remaining_seconds=$((DEADLINE_EPOCH - $(date +%s)))
    if [ "$remaining_seconds" -lt 240 ]; then
      echo "::error::Only ${remaining_seconds}s remain when the spare takes over; refusing a hopeless crawl."
      write_outcome RETRY
      return "$MVDIS_PREFLIGHT_EXIT_CODE"
    fi
    echo "Spare taking over shard $SHARD with ${remaining_seconds}s remaining in the lane budget."
  fi
  run_fresh
  return $?
}

if [ "$MODE" = "fresh" ]; then
  run_fresh
  exit $?
fi

if [ "$MODE" = "spare" ]; then
  run_spare
  exit $?
fi

run_primary
exit $?
