#!/usr/bin/env bash

set -uo pipefail

readonly MVDIS_PREFLIGHT_EXIT_CODE=75
readonly SHARD="${1:-}"
readonly MODE="${2:-primary}"
readonly RESULT_PATH="${RESULT_PATH:-${RUNNER_TEMP:-/tmp}/plate-sync-result-${SHARD}.json}"
readonly INITIAL_DELAY_SECONDS="${INITIAL_DELAY_SECONDS:-0}"
readonly RETRY_COOLDOWN_SECONDS="${RETRY_COOLDOWN_SECONDS:-15}"
readonly MAX_PREFLIGHT_ATTEMPTS="${MAX_PREFLIGHT_ATTEMPTS:-2}"
readonly DEADLINE_EPOCH="${DEADLINE_EPOCH:-0}"
# primary 原地重抽 WARP 身分的預算門檻：480s（recovery gate 下限）＋重抽與一次
# preflight 失敗的最壞耗時（~180s）＋餘裕（60s）。低於此值直接交棒，不賭。
readonly PRIMARY_REROLL_MIN_REMAINING_SECONDS="${PRIMARY_REROLL_MIN_REMAINING_SECONDS:-720}"

if [ -z "$SHARD" ]; then
  echo "::error::Missing shard argument."
  exit 2
fi

case "$MODE" in
  primary|fresh) ;;
  *)
    echo "::error::Unknown recovery mode: $MODE"
    exit 2
    ;;
esac

for numeric_value in "$INITIAL_DELAY_SECONDS" "$RETRY_COOLDOWN_SECONDS" "$MAX_PREFLIGHT_ATTEMPTS" "$DEADLINE_EPOCH" "$PRIMARY_REROLL_MIN_REMAINING_SECONDS"; do
  if ! [[ "$numeric_value" =~ ^[0-9]+$ ]]; then
    echo "::error::Recovery timing values must be non-negative integers."
    exit 2
  fi
done

if [ "$MAX_PREFLIGHT_ATTEMPTS" -lt 1 ] || [ "$MAX_PREFLIGHT_ATTEMPTS" -gt 5 ]; then
  echo "::error::MAX_PREFLIGHT_ATTEMPTS must be between 1 and 5."
  exit 2
fi

write_outcome() {
  local status="$1"

  mkdir -p "$(dirname "$RESULT_PATH")"
  printf '{"shard":"%s","status":"%s"}\n' "$SHARD" "$status" > "$RESULT_PATH"
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
    SKIP_SHARD_JITTER="$skip_jitter" timeout --signal=TERM --kill-after=15s \
      "${remaining_seconds}s" node gh-plate-sync.cjs "--shard=$SHARD"
    exit_code=$?
    if [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ] || [ "$exit_code" -eq 143 ]; then
      echo "::error::Shard $SHARD crawler reached the end-to-end lane deadline."
      return "$MVDIS_PREFLIGHT_EXIT_CODE"
    fi
  else
    SKIP_SHARD_JITTER="$skip_jitter" node gh-plate-sync.cjs "--shard=$SHARD"
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

if [ "$MODE" = "fresh" ]; then
  run_fresh
  exit $?
fi

run_primary
exit $?
