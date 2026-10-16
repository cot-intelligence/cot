#!/bin/sh
# Time the collector's hot read endpoints, cold then warm, as the dashboard
# requests them (gzip accepted). Paste the output into PRs that touch db.py,
# session_read.py or the request path.
#
#   scripts/bench_api.sh                         # http://127.0.0.1:31337
#   scripts/bench_api.sh http://127.0.0.1:31481  # a scratch collector
#   RUNS=3 scripts/bench_api.sh
#
# Reads only, except that /v1/insights reconciles findings as a side effect
# (as the dashboard's own requests do).
set -eu

BASE="${1:-http://127.0.0.1:31337}"
RUNS="${RUNS:-2}"
TZ_NAME="${TZ_NAME:-UTC}"

curl -fsS -m 5 "$BASE/health" >/dev/null || { echo "no collector at $BASE" >&2; exit 1; }

# The largest session, for the detail endpoint.
BIG=$(curl -fsS -m 30 "$BASE/v1/sessions?limit=1&sort=events&order=desc" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("sessions", d) if isinstance(d, dict) else d; print(max(s, key=lambda r: r.get("event_count") or 0)["id"] if s else "")')

printf '%-44s %5s %9s %9s %10s\n' endpoint run total server bytes
for path in \
  "/v1/stats" \
  "/v1/sessions?limit=50" \
  "/v1/metrics?tz=$TZ_NAME" \
  "/v1/overview/window?days=30" \
  "/v1/connections" \
  "/v1/hooks/status" \
  "/v1/insights?days=30&status=all" \
  ${BIG:+"/v1/sessions/$BIG"}; do
  i=1
  while [ "$i" -le "$RUNS" ]; do
    curl -sS -o /dev/null -m 120 -H 'Accept-Encoding: gzip' -D /tmp/cot-bench-h.$$ \
      -w '%{time_total} %{size_download}\n' "$BASE$path" > /tmp/cot-bench-w.$$
    read -r total bytes < /tmp/cot-bench-w.$$
    server=$(tr -d '\r' < /tmp/cot-bench-h.$$ | awk -F': ' 'tolower($1)=="x-response-time"{print $2}')
    label=$(printf '%s' "$path" | cut -c1-44)
    printf '%-44s %5s %8.3fs %9s %10s\n' "$label" "$i" "$total" "${server:--}" "$bytes"
    i=$((i + 1))
  done
done
rm -f /tmp/cot-bench-h.$$ /tmp/cot-bench-w.$$
