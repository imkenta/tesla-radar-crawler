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

for numeric_value in "$INITIAL_DELAY_SECONDS" "$RETRY_COOLDOWN_SECONDS" "$MAX_PREFLIGHT_ATTEMPTS" "$DEADLINE_EPOCH"; do
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

refresh_warp_session() {
  local warp_attempt
  local trace

  echo "Refreshing the current WARP tunnel without recycling its registration."

  warp_cli disconnect || true
  if ! warp_cli connect; then
    echo "::warning::Unable to reconnect WARP."
    return 1
  fi

  for warp_attempt in 1 2 3 4 5 6; do
    trace=$(curl -4 -fsS --max-time 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || true)
    if grep -q '^warp=on$' <<< "$trace"; then
      echo "WARP tunnel refreshed and verified on attempt $warp_attempt/6."
      return 0
    fi
    sleep 5
  done

  echo "::warning::Cloudflare trace did not confirm warp=on after refreshing the tunnel."
  return 1
}

run_primary() {
  local first_exit

  run_crawler 0
  first_exit=$?

  case "$first_exit" in
    0)
      write_outcome SUCCESS
      return 0
      ;;
    "$MVDIS_PREFLIGHT_EXIT_CODE")
      echo "::warning::Shard $SHARD is leaving the primary runner immediately for isolated fresh-runner recovery."
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
    if ! refresh_warp_session; then
      echo "::error::Unable to refresh WARP between fresh-runner attempts for shard $SHARD."
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
