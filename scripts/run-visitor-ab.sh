#!/usr/bin/env bash
# User-run builds, compatibility check and bounded comparison; no DB replacement.
set -euo pipefail
cd "$(dirname "$0")/.."
test "$#" -eq 0 || { echo 'usage: scripts/run-visitor-ab.sh' >&2; exit 2; }
upstream=/private/tmp/umami-qualification
commit=ca661c7057984aa98ed4f7083d84dae2f65bfcb0
test "$(git -C "$upstream" rev-parse HEAD)" = "$commit"
test "$(docker inspect -f '{{.State.Running}}' umami-qualification-db-1)" = true
node scripts/visitor-api-ab.mjs --check
export VISITOR_BUILD_ROOT
VISITOR_BUILD_ROOT=$(mktemp -d /private/tmp/umami-visitor-build.XXXXXX)
mkdir "$VISITOR_BUILD_ROOT/baseline" "$VISITOR_BUILD_ROOT/candidate"
git -C "$upstream" archive "$commit" | tar -x -C "$VISITOR_BUILD_ROOT/baseline"
git -C "$upstream" archive "$commit" | tar -x -C "$VISITOR_BUILD_ROOT/candidate"
git -C "$VISITOR_BUILD_ROOT/candidate" apply --check "$PWD/patches/visitor-count-order.patch"
git -C "$VISITOR_BUILD_ROOT/candidate" apply "$PWD/patches/visitor-count-order.patch"
docker compose -f compose/visitor.yml config >/dev/null
printf 'Build sources retained at %s\n' "$VISITOR_BUILD_ROOT"
docker compose -f compose/visitor.yml build baseline
docker compose -f compose/visitor.yml build candidate
docker compose -f compose/visitor.yml up -d --no-build --wait --wait-timeout 180
node scripts/visitor-api-ab.mjs --smoke
node scripts/visitor-api-ab.mjs
