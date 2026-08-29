#!/usr/bin/env bash

set -uo pipefail

readonly MVDIS_PREFLIGHT_EXIT_CODE=75
readonly SHARD="${1:-}"
readonly RESULT_PATH="${RESULT_PATH:-${RUNNER_TEMP:-/tmp}/plate-sync-result-${SHARD}.json}"

if [ -z "$SHARD" ]; then
  echo "::error::Missing shard argument."
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

reset_warp_session() {
  echo "::warning::MVDIS preflight was transiently unreachable; rebuilding the WARP session before one local retry."

  warp_cli disconnect || true
  if ! warp_cli registration delete; then
    echo "::warning::Unable to delete the existing WARP registration."
    return 1
  fi
  if ! warp_cli registration new; then
    echo "::warning::Unable to create a new WARP registration."
    return 1
  fi

  for host in generativelanguage.googleapis.com api.ipify.org; do
    if ! warp_cli tunnel host add "$host"; then
      echo "::warning::Unable to restore the WARP split-tunnel exclusion for $host."
      return 1
    fi
  done

  if [ -n "${VITE_SUPABASE_URL:-}" ]; then
    local supabase_host
    local supabase_ip
    supabase_host="${VITE_SUPABASE_URL#*://}"
    supabase_host="${supabase_host%%/*}"
    supabase_ip=$(getent ahostsv4 "$supabase_host" 2>/dev/null | awk 'NR == 1 { print $1 }')
    if [ -n "$supabase_ip" ]; then
      warp_cli add-excluded-route "$supabase_ip/32" || true
    fi
  fi

  if ! warp_cli connect; then
    echo "::warning::Unable to reconnect WARP."
    return 1
  fi

  for attempt in 1 2 3 4 5 6; do
    local trace
    trace=$(curl -4 -fsS --max-time 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || true)
    if grep -q '^warp=on$' <<< "$trace"; then
      echo "WARP session rebuilt and verified on attempt $attempt/6."
      return 0
    fi
    sleep 5
  done

  echo "::warning::Cloudflare trace did not confirm warp=on after rebuilding the session."
  return 1
}

run_crawler 0
first_exit=$?

case "$first_exit" in
  0)
    write_outcome SUCCESS
    exit 0
    ;;
  "$MVDIS_PREFLIGHT_EXIT_CODE")
    ;;
  *)
    echo "::error::Shard $SHARD failed with non-retryable exit code $first_exit."
    write_outcome HARD_FAILURE
    exit 0
    ;;
esac

if ! reset_warp_session; then
  echo "::warning::Deferring shard $SHARD to a fresh GitHub runner because local WARP recovery failed."
  write_outcome RETRY
  exit 0
fi

run_crawler 1
second_exit=$?

case "$second_exit" in
  0)
    write_outcome SUCCESS
    ;;
  "$MVDIS_PREFLIGHT_EXIT_CODE")
    echo "::warning::Shard $SHARD still has a transient MVDIS failure after local recovery; requesting a fresh runner."
    write_outcome RETRY
    ;;
  *)
    echo "::error::Shard $SHARD failed with non-retryable exit code $second_exit after local recovery."
    write_outcome HARD_FAILURE
    ;;
esac

exit 0
