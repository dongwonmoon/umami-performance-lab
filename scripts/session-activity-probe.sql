\set ON_ERROR_STOP on
\pset pager off
\if :{?events}
\else
\set events 30000
\endif
-- SQL mechanism probe, NOT an API benchmark or production-shaped reproduction.
-- Attribution: umami-software/umami#4526; SQL shape from dev9fb7bace.
-- Only connection-local temp objects; public tables provide schema, never data.
SET statement_timeout = '60s';
SET work_mem = '4MB';
SET hash_mem_multiplier = 2;
SELECT version(), current_setting('work_mem'), current_setting('hash_mem_multiplier');
CREATE TEMP TABLE probe_config AS SELECT :events::integer AS events;
DO $$ BEGIN
  IF (SELECT events < 500 OR events > 50000 FROM probe_config) THEN
    RAISE EXCEPTION 'events must be between 500 and 50000';
  END IF;
END $$;
CREATE TEMP TABLE probe_events (LIKE public.website_event INCLUDING ALL);
CREATE TEMP TABLE probe_data (LIKE public.event_data INCLUDING ALL);
INSERT INTO probe_events (event_id, website_id, session_id, visit_id, created_at, url_path)
SELECT md5('event-' || i)::uuid, md5('site')::uuid,
       md5(CASE WHEN i <= 500 THEN 'target' ELSE 'other-' || i END)::uuid,
       md5('visit-' || i)::uuid,
       timestamptz '2026-08-01 UTC' + i * interval '1 minute', '/synthetic'
FROM generate_series(1, :events) AS s(i);
-- Twenty properties/event, except half the target's events have no properties.
-- Deliberately stated distribution: not claimed to match the reporter's data.
INSERT INTO probe_data (event_data_id, website_id, website_event_id, data_key,
                       string_value, data_type, created_at)
SELECT md5(e.event_id::text || '-' || k)::uuid, e.website_id, e.event_id,
       'property-' || k, 'synthetic-value', 1, e.created_at
FROM probe_events e CROSS JOIN generate_series(1,20) AS keys(k)
WHERE e.session_id <> md5('target')::uuid
   OR mod(extract(epoch FROM e.created_at)::bigint / 60, 2) = 0;
ANALYZE probe_events;
ANALYZE probe_data;
SELECT (SELECT count(*) FROM probe_events) AS events,
       (SELECT count(*) FROM probe_data) AS properties;

CREATE TEMP VIEW probe_original AS
SELECT e.created_at AS "createdAt", e.url_path AS "urlPath",
       e.url_query AS "urlQuery", e.referrer_domain AS "referrerDomain",
       e.event_id AS "eventId", e.event_type AS "eventType",
       e.event_name AS "eventName", e.visit_id AS "visitId", e.hostname,
       e.event_id IN (
         SELECT d.website_event_id FROM probe_data d
         WHERE d.website_id = md5('site')::uuid
           AND d.created_at BETWEEN '2026-08-01 UTC' AND '2026-09-30 UTC'
       ) AS "hasData"
FROM probe_events e
WHERE e.website_id = md5('site')::uuid
  AND e.session_id = ANY(ARRAY[md5('target')::uuid])
  AND e.event_type <> 5
  AND e.created_at BETWEEN '2026-08-01 UTC' AND '2026-09-30 UTC'
ORDER BY e.created_at DESC LIMIT 500;

-- Derive B from A: keep projection, predicates, ordering and limit identical.
DO $$ DECLARE q text; needle text; BEGIN
  SELECT pg_get_viewdef('probe_original'::regclass, true) INTO q;
  needle := 'e.event_id IN ( SELECT d.website_event_id';
  IF strpos(q, needle) = 0 THEN
    RAISE EXCEPTION 'Unexpected view formatting; inspect before adapting';
  END IF;
  q := replace(q, needle, 'EXISTS ( SELECT 1');
  q := replace(q, 'WHERE d.website_id', 'WHERE d.website_event_id = e.event_id AND d.website_id');
  EXECUTE 'CREATE TEMP VIEW probe_candidate AS ' || q;
END $$;

SET statement_timeout = '15s';
CREATE TEMP TABLE probe_results (variant text, result jsonb);
-- Plan first so a timeout still leaves useful plan evidence.
EXPLAIN (FORMAT JSON) SELECT * FROM probe_original;
EXPLAIN (FORMAT JSON) SELECT * FROM probe_candidate;
-- Separate SQL statements give plan and result capture independent 15s budgets.
-- Candidate first, original benefits from warmed data.
-- This is a qualification, not a speedup estimate or repeated A/B benchmark.
CREATE FUNCTION pg_temp.explain_probe(v text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE plan json; BEGIN
    BEGIN
      EXECUTE format('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM probe_%I',v) INTO plan;
      RAISE NOTICE '% plan: %', v, plan;
    EXCEPTION WHEN query_canceled THEN
      RAISE NOTICE '% plan timed out; no completed plan timing',v;
    END;
END $$;
CREATE FUNCTION pg_temp.capture_probe(v text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE answer jsonb; BEGIN
    BEGIN
      EXECUTE format('SELECT jsonb_agg(to_jsonb(t) ORDER BY t."eventId") FROM probe_%I t',v) INTO answer;
      INSERT INTO probe_results VALUES (v,answer);
    EXCEPTION WHEN query_canceled THEN
      RAISE NOTICE '% result capture timed out; equality remains inconclusive',v;
    END;
END $$;
SELECT pg_temp.explain_probe('candidate');
SELECT pg_temp.explain_probe('original');
SELECT pg_temp.capture_probe('candidate');
SELECT pg_temp.capture_probe('original');
DO $$ BEGIN
  IF (SELECT count(*) FROM probe_results) = 2 THEN
    IF (SELECT count(DISTINCT result) FROM probe_results) <> 1 THEN
      RAISE EXCEPTION 'Result mismatch';
    END IF;
    IF EXISTS (SELECT 1 FROM probe_results WHERE jsonb_array_length(result) <> 500) THEN
      RAISE EXCEPTION 'Expected 500 rows';
    END IF;
    RAISE NOTICE 'PASS: full 500-row projection matches on this fixture';
  ELSE
    RAISE NOTICE 'INCONCLUSIVE equality: at least one variant did not finish';
  END IF;
END $$;
-- Disconnect drops every probe object, including indexes and synthetic rows.
