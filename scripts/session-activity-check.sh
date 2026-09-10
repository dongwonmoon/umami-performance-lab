#!/usr/bin/env bash
set -euo pipefail

upstream_root=${1:?usage: $0 UPSTREAM_ROOT [BASELINE_SOURCE]}
source_file="$upstream_root/src/queries/sql/sessions/getSessionActivity.ts"
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
patch_file="$repo_root/patches/session-activity-exists.patch"
docker_container=${PSQL_DOCKER_CONTAINER:-umami-walkthrough-db-1}
docker_user=${PSQL_DOCKER_USER:-walkthrough}
docker_database=${PSQL_DOCKER_DATABASE:-umami_walkthrough}

[[ -f "$source_file" && -f "$patch_file" ]] || {
  echo "missing source or patch: $source_file / $patch_file" >&2
  exit 2
}

baseline_dir=''
if [[ $# -gt 1 ]]; then
  baseline_file=$2
  [[ -f "$baseline_file" ]] || { echo "missing baseline: $baseline_file" >&2; exit 2; }
else
  baseline_dir=$(mktemp -d)
  baseline_file="$baseline_dir/src/queries/sql/sessions/getSessionActivity.ts"
  mkdir -p "$(dirname "$baseline_file")"
  cp "$source_file" "$baseline_file"
  git -C "$baseline_dir" init -q
  git -C "$baseline_dir" apply --reverse --whitespace=nowarn "$patch_file"
fi

extract_sql() {
  awk '
    /return rawQuery\(/ { capture=1; next }
    capture && /^[[:space:]]*`,/ { exit }
    capture && /^[[:space:]]*`$/ { next }
    capture { sub(/^[[:space:]]{4}/, ""); print }
  ' "$1"
}

render_sql() {
  sed \
    -e "s/{{websiteId::uuid}}/'00000000-0000-0000-0000-000000000001'::uuid/g" \
    -e "s/{{startDate}}/'2026-09-01 00:00:00+00'/g" \
    -e "s/{{endDate}}/'2026-09-02 00:00:00+00'/g" \
    -e "s/{{sessionIds}}::uuid\[\]/ARRAY['00000000-0000-0000-0000-000000000011'::uuid,'00000000-0000-0000-0000-000000000012'::uuid]/g" \
    -e 's/\${EVENT_TYPE\.performance}/5/g'
}

original_sql=$(extract_sql "$baseline_file" | render_sql)
candidate_sql=$(extract_sql "$source_file" | render_sql)
fixture=$(mktemp)
trap 'rm -f "$fixture"; [[ -n "$baseline_dir" ]] && rm -rf "$baseline_dir"' EXIT
cat >"$fixture" <<SQL
\set ON_ERROR_STOP on
\pset pager off
BEGIN;
CREATE TEMP TABLE website_event (LIKE public.website_event INCLUDING ALL);
CREATE TEMP TABLE event_data (LIKE public.event_data INCLUDING ALL);
INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type)
VALUES
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000201','2026-09-01 00:00:00+00','/start',1),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000202','2026-09-01 12:00:00+00','/multiple',1),
 ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000203','2026-09-02 00:00:00+00','/end',1),
 ('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000204',NULL,'/null-date',1),
 ('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000205','2026-08-31 23:59:59+00','/before',1),
 ('00000000-0000-0000-0000-000000000106','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000206','2026-09-02 00:00:01+00','/after',1),
 ('00000000-0000-0000-0000-000000000107','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000207','2026-09-01 08:00:00+00','/performance',5),
 ('00000000-0000-0000-0000-000000000108','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000208','2026-09-01 09:00:00+00','/other-site',1),
 ('00000000-0000-0000-0000-000000000109','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000209','2026-09-01 10:00:00+00','/second-session',1);
INSERT INTO event_data (event_data_id, website_id, website_event_id, data_key, data_type, created_at)
VALUES
 ('00000000-0000-0000-0000-000000001001','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','a',1,'2026-09-01 12:00:00+00'),
 ('00000000-0000-0000-0000-000000001002','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','b',1,'2026-09-01 12:00:00+00'),
 ('00000000-0000-0000-0000-000000001003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000103','end',1,'2026-09-02 00:00:00+00'),
 ('00000000-0000-0000-0000-000000001004','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','wrong-site',1,'2026-09-01 00:00:00+00'),
 ('00000000-0000-0000-0000-000000001005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000104','null-date',1,NULL),
 ('00000000-0000-0000-0000-000000001006','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000105','outside',1,'2026-08-31 23:59:59+00'),
 ('00000000-0000-0000-0000-000000001007','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000106','outside',1,'2026-09-02 00:00:01+00'),
 ('00000000-0000-0000-0000-000000001008','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000107','performance-data',1,'2026-09-01 08:00:00+00'),
 ('00000000-0000-0000-0000-000000001010','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','outside-before',1,'2026-08-31 23:59:59+00'),
 ('00000000-0000-0000-0000-000000001011','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','outside-after',1,'2026-09-02 00:00:01+00'),
 ('00000000-0000-0000-0000-000000001012','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','null-date',1,NULL),
 ('00000000-0000-0000-0000-000000001013','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000109','lower-bound',1,'2026-09-01 00:00:00+00');
CREATE TEMP TABLE original AS
$original_sql
;
CREATE TEMP TABLE candidate AS
$candidate_sql
;
DO \$check\$
BEGIN
 CREATE TEMP TABLE expected_activity ("eventId" uuid, "hasData" boolean);
 INSERT INTO expected_activity VALUES
  ('00000000-0000-0000-0000-000000000101',false),
  ('00000000-0000-0000-0000-000000000102',true),
  ('00000000-0000-0000-0000-000000000103',true),
  ('00000000-0000-0000-0000-000000000109',true);
 IF (SELECT count(*) FROM original) <> 4 OR (SELECT count(*) FROM candidate) <> 4 THEN
   RAISE EXCEPTION 'expected four in-range non-performance events';
 END IF;
 IF EXISTS ((SELECT "eventId", "hasData" FROM original) EXCEPT ALL (SELECT * FROM expected_activity))
    OR EXISTS ((SELECT * FROM expected_activity) EXCEPT ALL (SELECT "eventId", "hasData" FROM original))
    OR EXISTS ((SELECT "eventId", "hasData" FROM candidate) EXCEPT ALL (SELECT * FROM expected_activity))
    OR EXISTS ((SELECT * FROM expected_activity) EXCEPT ALL (SELECT "eventId", "hasData" FROM candidate)) THEN
   RAISE EXCEPTION 'unexpected event IDs or hasData values';
 END IF;
 IF EXISTS ((SELECT * FROM original) EXCEPT ALL (SELECT * FROM candidate))
    OR EXISTS ((SELECT * FROM candidate) EXCEPT ALL (SELECT * FROM original)) THEN
   RAISE EXCEPTION 'full original and candidate rows differ';
 END IF;
 RAISE NOTICE 'PASS: source-derived original and correlated EXISTS SQL agree on full rows and expected bounds, NULL, site, sessions, properties, and performance exclusion';
END
\$check\$;
ROLLBACK;
SQL

if [[ "$(docker inspect -f '{{.State.Running}}' "$docker_container" 2>/dev/null)" == true ]]; then
  docker exec -i "$docker_container" psql -U "$docker_user" -d "$docker_database" -X -f - <"$fixture"
else
  echo "a running $docker_container container is required" >&2
  exit 2
fi
