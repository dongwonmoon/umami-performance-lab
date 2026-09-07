#!/usr/bin/env bash
# Disposable DB only. Restore effective unlimited CPU even on ordinary interruption.
set -euo pipefail
cd "$(dirname "$0")/.."
db=umami-ingestion-db-1
test "$(docker inspect "$db" --format '{{.HostConfig.NanoCpus}}')" = 0
test "$(docker exec "$db" cat /sys/fs/cgroup/cpu.max)" = 'max 100000'

restore() {
  local result=$?
  trap - EXIT
  if docker update --cpu-quota -1 "$db" >/dev/null &&
     test "$(docker exec "$db" cat /sys/fs/cgroup/cpu.max)" = 'max 100000'; then
    echo 'DB CPU restored: unlimited'
  else
    echo 'ERROR: DB CPU restoration failed; inspect manually.' >&2
    result=1
  fi
  exit "$result"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker update --cpu-quota 200000 "$db" >/dev/null
test "$(docker exec "$db" cat /sys/fs/cgroup/cpu.max)" = '200000 100000'
node scripts/performance-ingestion-overlap.mjs "$@"
