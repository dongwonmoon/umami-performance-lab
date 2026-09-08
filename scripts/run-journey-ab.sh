#!/usr/bin/env bash
# User-run build and bounded measurement. No source checkout or DB replacement.
set -euo pipefail
cd "$(dirname "$0")/.."
oracle=${1:?Pass the completed --oracle JSON path}
test -f "$oracle"
node - "$oracle" <<'NODE'
const assert = require('node:assert/strict');
const data = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.oracle, true);
assert.equal(data.website_id, '18573f23-3e24-44ef-b580-154cf371e7fe');
NODE
upstream=/private/tmp/umami-qualification
commit=ca661c7057984aa98ed4f7083d84dae2f65bfcb0
test "$(git -C "$upstream" rev-parse HEAD)" = "$commit"
test "$(docker inspect -f '{{.State.Running}}' umami-qualification-db-1)" = true
node scripts/journey-api-ab.mjs --check
export JOURNEY_BUILD_ROOT
JOURNEY_BUILD_ROOT=$(mktemp -d /private/tmp/umami-journey-build.XXXXXX)
mkdir "$JOURNEY_BUILD_ROOT/baseline" "$JOURNEY_BUILD_ROOT/candidate"
git -C "$upstream" archive "$commit" | tar -x -C "$JOURNEY_BUILD_ROOT/baseline"
git -C "$upstream" archive "$commit" | tar -x -C "$JOURNEY_BUILD_ROOT/candidate"
git -C "$JOURNEY_BUILD_ROOT/candidate" apply --check "$PWD/patches/journey-distinct.patch"
git -C "$JOURNEY_BUILD_ROOT/candidate" apply "$PWD/patches/journey-distinct.patch"
printf 'Build sources retained at %s\n' "$JOURNEY_BUILD_ROOT"
# Sequential builds reuse the same dependency layers; no original app is rebuilt.
docker compose -f compose/journey.yml build baseline
docker compose -f compose/journey.yml build candidate
docker compose -f compose/journey.yml up -d --no-build --wait --wait-timeout 180
node scripts/journey-api-ab.mjs --smoke "$oracle"
node scripts/journey-api-ab.mjs "$oracle"
