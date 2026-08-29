#!/usr/bin/env bash

set -uo pipefail

readonly MVDIS_PREFLIGHT_EXIT_CODE=75
readonly SHARD="${1:-}"
readonly MODE="${2:-primary}"
readonly RESULT_PATH="${RESULT_PATH:-${RUNNER_TEMP:-/tmp}/plate-sync-result-${SHARD}.json}"
readonly INITIAL_DELAY_SECONDS="${INITIAL_DELAY_SECONDS:-0}"
readonly RETRY_COOLDOWN_SECONDS="${RETRY_COOLDOWN_SECONDS:-90}"
readonly MAX_PREFLIGHT_ATTEMPTS="${MAX_PREFLIGHT_ATTEMPTS:-3}"

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

for numeric_value in "$INITIAL_DELAY_SECONDS" "$RETRY_COOLDOWN_SECONDS" "$MAX_PREFLIGHT_ATTEMPTS"; do
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
  SKIP_SHARD_JITTER="$skip_jitter" node gh-plate-sync.cjs "--shard=$SHARD"
  local exit_code=$?
  return "$exit_code"
}

warp_cli() {
  sudo warp-cli "$@" 2>/dev/null || sudo warp-cli --accept-tos "$@" 2>/dev/null
}

wait_before_retry() {
  local seconds="$1"
  local reason="$2"

  if [ "$seconds" -gt 0 ]; then
    echo "::warning::$reason; cooling down for ${seconds}s before the next isolated browser attempt."
    sleep "$seconds"
  fi
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
  local second_exit

  run_crawler 0
  first_exit=$?

  case "$first_exit" in
    0)
      write_outcome SUCCESS
      return 0
      ;;
    "$MVDIS_PREFLIGHT_EXIT_CODE") ;;
    *)
      echo "::error::Shard $SHARD failed with non-retryable exit code $first_exit."
      write_outcome HARD_FAILURE
      return 0
      ;;
  esac

  wait_before_retry "$RETRY_COOLDOWN_SECONDS" "MVDIS preflight was transiently unreachable"
  if ! refresh_warp_session; then
    echo "::warning::Deferring shard $SHARD to a fresh GitHub runner because local WARP refresh failed."
    write_outcome RETRY
    return 0
  fi

  run_crawler 1
  second_exit=$?

  case "$second_exit" in
    0)
      write_outcome SUCCESS
      ;;
    "$MVDIS_PREFLIGHT_EXIT_CODE")
      echo "::warning::Shard $SHARD still has a transient MVDIS failure after local cooldown; requesting a fresh runner."
      write_outcome RETRY
      ;;
    *)
      echo "::error::Shard $SHARD failed with non-retryable exit code $second_exit after local recovery."
      write_outcome HARD_FAILURE
      ;;
  esac

  return 0
}

run_fresh() {
  local attempt
  local exit_code

  wait_before_retry "$INITIAL_DELAY_SECONDS" "Shard $SHARD is waiting for its dedicated fresh-runner MVDIS slot"

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

    wait_before_retry "$RETRY_COOLDOWN_SECONDS" "Shard $SHARD received another transient MVDIS failure"
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
