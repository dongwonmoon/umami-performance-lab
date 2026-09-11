# Next bounded experiment candidates

Historical investigation log (2026-09-07–09), not the current task queue.
Dated selections below record decisions at that time; later results supersede them.
The completed tracker case is recorded in [tracker-navigation.md](tracker-navigation.md).

These are hypotheses from pinned upstream `/private/tmp/umami-qualification` at
`ca661c7` (v3.3.1), not asserted bugs.

## 1. Dashboard filter-value dropdown under cardinality

**User scenario.** An operator opens a website report, chooses a date range, then types a prefix into a hostname/referrer/page filter.

**Code facts.** The values route validates the date/type/search query, checks
permissions, obtains filters, calls `getValues`, then filters nulls and sorts
the returned rows: [`src/app/api/websites/[websiteId]/values/route.ts:13-57`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/app/api/websites/%5BwebsiteId%5D/values/route.ts#L13-L57).
For PostgreSQL, event values scan the selected date range, group by the chosen
column, order by count, and limit to 10; session columns use the same shape on
`session`: [`src/queries/sql/getValues.ts:53-84`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/queries/sql/getValues.ts#L53-L84).
Search is `ILIKE`; comma-separated search is capped at five alternatives
before grouping: [`src/queries/sql/getValues.ts:35-50`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/queries/sql/getValues.ts#L35-L50).

**Unproven hypothesis.** On a high-cardinality field and long date range, the
dropdown's “only 10” response may still require a large group/sort, so typing
search can consume measurable DB CPU even though the UI result is small. This
may be normal top-10 aggregation behavior, and indexes may already make it
cheap.

**Smallest measurement.** With fixed synthetic DB and one website, replay the
same authenticated GETs using valid UI types `path` and `browser` across
7-day/whole-history ranges and empty/prefix/five-value searches. Record request
latency, PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` separately, and response
equality; do not change schema first.

Issue [#4141](https://github.com/umami-software/umami/issues/4141) reported a
~15s dropdown in v3.0.3 and is closed as fixed-in-dev; it motivates measuring
the current path, not claiming an existing regression.

**Local qualification (2026-09-07).** Against localhost:3000 Demo SaaS, the
authenticated UI types `path` and `browser` returned 200 consistently in three
repeats for each saved range (7d/all): path rows were 10/10 and p50 was
15.1/32.1ms; browser rows were 6/6 and p50 10.3/28.2ms (Luna's 12-request probe;
qualification only, not a preserved benchmark). Main independently counted
262,196 SaaS events but only 13 distinct paths. This low-cardinality fixture
does not generalize or reject the candidate; no urgency was observed here.

## 2. Event collection: single requests versus the existing batch endpoint
**User scenario.** A server-side integration sends pageviews/custom events in a
busy burst or backfills them through `/api/batch`.

**Code facts.** `/api/send` parses an unauthenticated payload, optionally
validates the website, computes session/visit IDs, creates a session when the
cache is absent, and awaits `saveEvent`: [`src/app/api/send/route.ts:74-177`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/app/api/send/route.ts#L74-L177), [`src/app/api/send/route.ts:253-307`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/app/api/send/route.ts#L253-L307).
The batch schema allows 500 objects and invokes `send.POST` in a serial loop;
it retains per-item non-OK responses and returns processed/error counts:
[`src/app/api/batch/route.ts:7-57`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/app/api/batch/route.ts#L7-L57).
Relational event persistence is one awaited Prisma create per event:
[`src/queries/sql/events/saveEvent.ts:66-71`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/queries/sql/events/saveEvent.ts#L66-L71),
[`src/queries/sql/events/saveEvent.ts:106-109`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/queries/sql/events/saveEvent.ts#L106-L109).

**Unproven hypothesis.** Batch latency may scale nearly linearly with item
count, while concurrent single requests may expose DB connection contention;
the batch's partial-error behavior may be useful rather than problematic.
Issue [#4494](https://github.com/umami-software/umami/issues/4494) reports
v3.3.1 Vercel/Supabase `EMAXCONNSESSION` during rapid navigation/dashboard
activity; it is external reported context, not reproduced here, and local
single-process results will not represent serverless pool behavior.
The official [server-side events guide](https://docs.umami.is/docs/guides/send-server-side-events)
documents batching and recommends limited concurrency, making this a bounded
behavior check rather than an assumed defect.

**Smallest measurement.** Against disposable data, send identical valid pageview
payloads as 1/10/100-item batches and as 1/4/8 concurrent singles, first with
one cache token and then cold sessions. Record HTTP latency, accepted/error
counts, DB CPU, and inserted-row counts; stop below saturation and preserve
failed responses.

## Selection — 2026-09-07

Main recommends **candidate 2 first**, initially comparing equal event totals
sent singly versus in small batches. The code's sequential loop is not itself
a bug: ordering, DB load, session semantics and partial errors may justify it.
Measure end-to-end time, per-event cost and actual saved events before choosing
an optimization. Use a disposable DB copy; preserve the completed funnel DB.
Only if needed, a follow-up can combine event collection with dashboard reads
to test resource contention. The shared Prisma client is visible at
[`src/lib/prisma.ts:861-915`](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/lib/prisma.ts#L861-L915);
this is a hypothesis, not a reproduction of serverless issue #4494.

Filter queries are a reserve candidate, not a preselected defect. Defer a
memory-leak hunt: [#4498](https://github.com/umami-software/umami/issues/4498)
reports 268MB usage without a growth series or reproduction, which is not
sufficient evidence of a leak. No upstream changes, collection writes or long
measurements were made during this candidate search. No improvement is promised.

Candidate 2 was approved; preparation and subsequent observations belong in
[the ingestion experiment](ingestion-batch.md). This note remains the search-time evidence.

## Broader application/data-flow inspection — 2026-09-07

Main inspected the pinned checkout directly, without subagents or changes to
Umami. The ingestion overlap check is closed without observed read degradation;
see its owning experiment. Filter-input debounce is deferred: different defaults
are not evidence of a meaningful performance problem. The filter editor actually
uses a six-month candidate window, and `ILIKE` searches substrings, not only
prefixes; the earlier scenario above should not imply otherwise.

### First follow-up: the opt-in session recorder

Two distinct hypotheses share a realistic workflow: record a short visit to an
owned synthetic page, then play it back. Establish actual payload sizes first;
do not manufacture large recordings to force a slowdown.

- **Browser repeated serialization.** `src/recorder/index.js:437-478` checks
  each emitted event, the growing buffer plus that event, and usually the buffer
  again after insertion. Size checks call `JSON.stringify` and `Blob.size`
  (`:54-76`). Flushing runs another growing-chunk size-check loop (`:191-250`).
  Existing limits are 100 events, a two-second flush timer, and a 500,000-byte
  payload target; full snapshots follow a separate path. Repeated traversal is
  code evidence, not a measured browser slowdown. Size checks protect delivery:
  removing them is not an acceptable optimization. Reusing serialized sizes is
  only a hypothesis and must preserve UTF-8 bytes, JSON escaping, envelope size,
  event order, fragmentation, and replay correctness.
- **Server synchronous compression/decompression.** PostgreSQL recording uses
  `gzipSync(JSON.stringify(...))` in
  `src/queries/sql/replays/saveRecording.ts:36`. Playback loads matching visit
  chunks and synchronously decompresses/parses each in
  `src/queries/sql/replays/getReplayChunks.ts:81-84`, then merges/restores events
  and returns the complete result through the replay route. Normal
  `ReplayPlayback` supplies no cutoff options. This can occupy the serving JS
  thread; user-visible interference has not been measured. Async zlib may reduce
  blocking but does not remove JSON CPU work or total compression cost, and
  introduces thread-pool/memory trade-offs. Streaming/pagination would be a
  larger playback-design change, not the first fix.

Recorder defaults limit the hypothesis: disabled unless enabled, 15% sampling,
five-minute duration, and the above chunk limits. The record API also checks a
1,000,000-byte request bound. These are reasons not to assume a large impact.
The [Node zlib documentation](https://nodejs.org/api/zlib.html#threadpool-usage-and-performance-considerations)
describes async zlib thread-pool use and its resource trade-offs.

Smallest next observation: one ordinary synthetic visit with recording enabled;
measure recorder CPU/serialization work, actual chunk sizes and playback cost.
Only if material, isolate browser repetition or server blocking as separate
before/after questions. No recording was collected in this inspection.

### Reserve: performance-report work independent of the selected metric

`Performance.tsx:71-76` includes the selected LCP/INP/etc. metric in the report
query. The API always runs chart + all-metric summary + four breakdowns
(`src/app/api/reports/performance/route.ts:24-38`): six aggregate queries on the
PostgreSQL path. The all-metric summary in `getPerformance.ts:64-123` does not
depend on the selected metric, yet is recomputed for each such request. Chart
and summary also execute sequentially inside `getPerformance`; independent
breakdowns already execute concurrently. Hidden-tab breakdowns are prefetched,
which can intentionally make tab switching immediate.

Hypothesis: separating/reusing the summary for a fixed website/date/filter
selection avoids work during metric exploration. It may instead cost extra
requests or show differently aged panels. Measure the summary's fraction of
cost before splitting endpoints or introducing caching. No latency claim yet.

### Deferred: pre-aggregation and incremental realtime

Realtime polls every ten seconds and recomputes the recent 30-minute series;
activity is already limited to 100 rows. Incremental buckets or shared results
are conceivable, but late events, expiring buckets and distinct visitors add
correctness work. ClickHouse already has an hourly aggregate path (for example,
`getWebsiteSessions.ts` uses `website_event_stats_hourly` when applicable).
Do not describe Umami as having no pre-aggregation or transplant it wholesale
into PostgreSQL. Percentiles and distinct counts also cannot generally be
combined by summing/averaging daily answers. No demonstrated cost currently
justifies persistent derived tables here.

Runtime qualification: read-only SQL against the original disposable DB found
195,077 pageviews, 68,229 custom events, zero performance events and zero replay
chunks. Thus previous fixtures cannot establish either new candidate's value.
No collection writes, load tests, builds, upstream edits, or commits were made.

### Recorder qualification result — 2026-09-07

Subsequent approved observation used the existing **separate ingestion stack**
on port 3003, not the original funnel DB. Created one synthetic website
`fccac52f-445d-43c0-b373-b1d663c3418d`, enabled recording at 100% for this single
visit (heatmaps off, 60-second limit). A local 30-book catalog was served on
port 3004: eight add-to-selection clicks 600ms apart, one list reversal and a
scroll. This is a small synthetic interaction, not a production traffic model.
Headless Chromium's initial bot-classified visit did not establish a session;
the successful visit used an explicit ordinary Chrome HTTP User-Agent, leaving
the application's bot policy unchanged. The unmodified served recorder script
was injected after tracker session establishment.

- Successful page observation lasted 23.6 seconds; 67 recorder events were sent
  in six successful HTTP requests. DB independently contained six chunks and
  67 events, totaling 4,362 compressed bytes.
- Narrow browser instrumentation wrapped `JSON.stringify` for record payloads:
  332 calls, 2,121 cumulative event-array entries traversed, **4.6ms total**,
  **0.3ms largest call**. This measures stringify duration, not total recorder
  CPU: it excludes Blob byte-size work, rrweb capture, other serialization,
  and instrumentation overhead outside the timed call. No >=50ms long task
  was reported during the successful observed page visit.
- Three sequential authenticated playback API reads returned HTTP 200 and the
  same event/chunk counts: 20.3 / 15.2 / 12.4ms including response parsing.
  A separate local Node probe decompressed and parsed the actual six buffers:
  ten post-warmup samples were 0.279–1.024ms (median about 0.296ms). This is not
  server profiling or a concurrent-request interference measurement.
- Actual Umami playback UI loaded the recorded catalog. At 8x playback, the
  iframe reached selection count `8` and first item `book 30`, matching the
  performed changes. One console error was the unrelated external favicon
  request for `localhost.ico` returning 404, not a replay failure.

**Decision:** repeated work exists, but this small workflow did not demonstrate
a meaningful performance problem. Do not implement caching, async compression,
or larger artificial inputs on this evidence. A representative richer page
could revisit the candidate; larger recordings/concurrency remain untested.

Local-only probe and aggregates: `.local/recorder-qualification.mjs`,
`.local/recorder-qualification-result.json` (SHA-256
`6e4b18491d031e9f85417af71de5dbd685356f168351914728e860deae0d2cff`),
`.local/recorder-playback-result.json` (SHA-256
`eb31d4054eea96a4e8fd437dabcb0e1c85a9f66a13df4740f435e85a4a7ab586`).
These are qualification evidence, not a published reproducible benchmark.
Browser logs/session artifacts are ignored via `.playwright-cli/`; raw replay
content stays in the disposable DB. No Umami code or original DB was changed.

### Performance-report case moved

Qualification, comparisons and closure are now owned by
[performance-report.md](performance-report.md). Both alternatives remain
experimental; no global adoption or upstream PR. Continue future candidate
selection here without reopening this case merely to force an optimization.

## Journey case moved

The investigation, tie semantics, measured results and closure are owned by
[journey-distinct.md](journey-distinct.md). Continue future candidate selection
here; do not reopen the completed measurement solely to chase larger gains.

## Visitor count case moved

Closed evidence and limitations are in [visitor-count-order.md](visitor-count-order.md).

## Next selection after first upstream PR — 2026-09-08

User deferred additional PRs; continue independent candidate discovery, without
posting or manufacturing a defect. Current inspection uses dev
`9fb7bacee62c34d6d05312d063a37c20d581de23`, not the historical runtime image.

**Preferred: Attribution's repeated conversion/touchpoint work.** The UI
`Attribution.tsx` requests a report only after a target step is selected and
renders referrer, paid-ad and five UTM tables together. The report route calls
`getAttribution`; its PostgreSQL implementation executes eight sequential
`rawQuery` calls. Seven repeat the same `events` and `model` CTE definitions
to find converting sessions and their first/last touchpoint; the eighth computes
totals. Source: `src/queries/sql/reports/getAttribution.ts:53-227`, route
`src/app/api/reports/attribution/route.ts`, existing query tests explicitly
assert eight calls. This establishes repeated SQL structure, not measured cost.

Hypothesis: sharing conversion/touchpoint computation within one report could
reduce total DB work, unlike simply overlapping the same queries. Separate
queries are straightforward and let PostgreSQL specialize each dimension; a
combined query may increase intermediate memory, complicate SQL or lose useful
plans. Persisted caching/pre-aggregation is not proposed. Preserve first/last
click semantics, distinct-session counts, equal-timestamp matches, filters,
blank values and each dimension's independent top-20 selection.

Smallest next observation: first verify that a disposable dataset contains
nonempty conversion events and referrer/UTM values; do not interpret an empty
report as representative. On one fixed snapshot, observe first/last-click
reports for a short and longer supported UI period, recording complete output,
per-query timings and the cost of repeated CTE work. Only then decide whether
a small shared-computation comparison is worthwhile. No patch, dataset change,
API benchmark or performance claim was made during candidate selection.

Alternatives checked, not selected:
- Realtime already caps activity to 100 rows; minute series must stay fresh.
  Repeated polling alone does not justify cache/incremental-state complexity.
- Export materializes CSVs, ZIP and base64, but its seven metric queries default
  to 500 rows each. Large raw-export assumptions would be misleading; lower
  priority without observed memory pressure.
- Website reset/delete uses two event-data cleanup passes, with an explicit
  legacy-row correctness rationale and tests. Do not remove the second pass
  as redundant or run deletion against preserved experiment data.

### Attribution case moved

Closed local candidate: [Attribution shared computation](attribution-shared.md).
Qualification, comparisons, source verification and limitations now live there.
PR submission and push are deferred by the user.

## Needs-first search — 2026-09-09

User explicitly rejected choosing a performance/operations category first and
inventing work to fit it. This pass only inspected existing records, public
reports and source; no reproduction, app changes, new probes or PRs.
Local reference remains dev `9fb7bace`; selected live source paths were also
checked at dev `16acac55300ee656ecf31835cd1012b94fc71b45` using GitHub API.

- **Metric sample counts:** [PR #4478](https://github.com/umami-software/umami/pull/4478)
  is open/unmerged at inspection. Author reports sparse metric values while
  summary counts every row. Current [getPerformance source](https://github.com/umami-software/umami/blob/16acac55300ee656ecf31835cd1012b94fc71b45/src/queries/sql/reports/getPerformance.ts)
  still uses an all-row count. Concrete correctness concern, but an existing
  proposed fix already owns it; no competing patch or independent reproduction.
- **Saved/per-row board filters:** [feature request #4468](https://github.com/umami-software/umami/issues/4468)
  describes comparing user regions and losing filters on reload. Author says
  they are implementing per-row support. Related [PR #4303](https://github.com/umami-software/umami/pull/4303)
  (open/unmerged) covers browser-local board filter persistence, not per-row
  definitions. Real stated need, but broader product scope and overlapping work;
  not relabeled as an operations defect or selected for implementation.
- **Bot-skewed analytics:** [discussion #4074](https://github.com/umami-software/umami/discussions/4074)
  reports a small Ghost blog's suspected bot visits. Geography alone is not
  bot proof. The reply discusses missing *dashboard* controls; do not generalize
  that into no built-in filtering. Current [send route](https://github.com/umami-software/umami/blob/16acac55300ee656ecf31835cd1012b94fc71b45/src/app/api/send/route.ts#L141-L148)
  already applies `isbot(userAgent)` unless disabled and `hasBlockedIp(ip)`.
  Without offending request characteristics/configuration, an artificial bot
  test would not reproduce the report. Defer new filtering infrastructure.

Main also traced overview download → export route → metric functions. Default
page metric limit is 500 in the local source; the [release description](https://github.com/umami-software/umami/discussions/3529)
describes current-page stats export, not a complete raw backup. Do not claim
data loss merely from a cap. Likewise heartbeat's unconditional `{ok:true}`
does not by itself prove defective readiness: endpoint purpose matters.

Decision: **no new implementation selected in this pass**. This is not proof
that Umami has no worthwhile problems. Reopen these only with a distinct unmet
need or reproducible gap, not merely because they fit a portfolio category.
No user hands-on session is required yet; next discovery can inspect ordinary
end-to-end usage, but no costly stress/chaos scenario is justified here.

### Ordinary browser walkthrough — 2026-09-09

Main used the existing production build in `umami-visitor-pr-check.dOV9fg`
(dev9fb7bace with the earlier visitor patch), at localhost:3000 against the
preserved synthetic DB. Set read-only PGOPTIONS with 15s statement timeout;
no migrations, seed, stress traffic or persistent application edits.

Observed login → Demo SaaS → Last 30 days → `/pricing` link filter → Pages
More dialog → CSV download. Filter chip and URL remained consistent. Expanded
table showed 6,099 visitors/visits/views; downloaded `path.csv` contained
`/pricing,6099,6099,6099,0,0` under
`name,pageviews,visitors,visits,bounces,totaltime`. This confirms those counts
and download completion, not every exported metric's semantics or latency.
The current overview UI did not expose the whole-overview export button;
the actual path exercised was the expanded table's client-side CSV download,
not the server ZIP export route inspected earlier.

Important environment exclusion: annotations requests returned 500/P2021
because `public.annotation` does not exist in the preserved historical DB.
No upstream bug claim: the new app build and old DB schema are not aligned.
Pre-login auth verification returned 401 and synthetic-domain favicons returned
404; neither establishes a product defect. Empty-period title attributes also
contained NaN while displayed values were zero; not investigated or promoted
to an optimization candidate.

Ignored local evidence: `.playwright-cli/page-2026-09-09T04-39-28-754Z.yml`,
`page-2026-09-09T04-39-42-014Z.yml`,
`page-2026-09-09T04-40-02-760Z.yml` in the same directory,
`.playwright-cli/console-2026-09-09T04-37-54-643Z.log`, and
`.local/needs-first-path.csv`. Browser startup required local automation-cache
permissions; that is a tool setup issue, not app behavior.

Decision: no compelling new product change established by this small flow.
Before expanding into notes/boards/write flows, use a separate schema-aligned
disposable environment; do not migrate the preserved benchmark DB in place.
App process and this browser session stopped after observation; the pre-existing
DB container remains running. No commit, push or PR.

### Schema-aligned disposable environment — 2026-09-09

User approved environment preparation, not a product fix. Created Compose
project `umami-walkthrough` using ignored `.local/walkthrough-compose.yml`:
PostgreSQL15 at localhost:5434, database `umami_walkthrough`, dedicated volume
`umami-walkthrough_walkthrough-data`. Inspect confirmed that the preserved
benchmark uses a different volume `umami-qualification_umami-db-data` at5433.
No migrations or seeds were run against that preserved DB.

Used the existing `umami-visitor-pr-check.dOV9fg` source/build (dev9fb7bace plus
visitor-count patch). Its `prisma migrate deploy` applied all27 migrations
to the fresh DB; SQL verified27 completed entries and the annotation table.
Existing `tsx scripts/seed-data.ts --days 1` generated995 sessions and2,706
events across two demo sites. The generator includes both endpoints, so the
actual dates were September8–9, not one calendar date. These random inputs
are for functional exploration, not comparable to historical benchmarks.

App started at http://127.0.0.1:3000 against5434 with a distinct local secret.
Authenticated login, websites list and the previously failing annotations GET
all returned200. API checks only; a new full UI walkthrough was not performed
in this preparation step. App uses existing `next start`; Next emitted its
standalone-output advisory, but startup and tested routes succeeded. No build.

Runtime left available for follow-up: app exec session67036, new DB container
`umami-walkthrough-db-1`. Demo SaaS id `c17cf711-0e4a-443f-b75a-9919a521bf95`.
To restart DB: `docker compose -f .local/walkthrough-compose.yml up -d db`.
App launch requires DATABASE_URL from that isolated Compose configuration,
APP_SECRET for this disposable environment, and `next start -H127.0.0.1 -p3000`
in the existing build directory (separate flag arguments when running).
No product source changes, commit, push or PR. Compose/credentials remain ignored.

### Notes create/edit/reload walkthrough — 2026-09-09

On the isolated walkthrough DB, main used the real browser: login → Demo SaaS
Overview → Notes → Add note → Save → edit text → Save → full reload → Notes.
Created only synthetic note `237eb6b9-abc0-404f-bd03-296c0ddd9f04`; initial text
`Walkthrough: pricing copy updated`, revised with ` — reviewed` appended.
Both database inspection and reloaded UI showed the revised value. UI date
September9 matched stored `2026-09-08T15:00:00Z`, `all_day=true` (Korea time).

Luna separately traced AnnotationEditForm and useTimezone: this UI normalizes
browser-local calendar dates to midnight and stores UTC, always allDay=true;
API also supports timed annotations. No multi-timezone behavior was tested.
Prior missing-table 500 did not recur; console only contained pre-login401
and synthetic favicon404s. This is a normal one-note persistence check, not
permission, concurrent edit, load, all date-range or timezone qualification.

Evidence: ignored `.playwright-cli/page-2026-09-09T04-46-01-086Z.yml` (edit),
`page-2026-09-09T04-46-52-094Z.yml` (after reload), and
`console-2026-09-09T04-44-09-132Z.log` in that directory; direct read-only SQL
on `umami-walkthrough-db-1` confirmed the stored row. Test note retained in
disposable DB; original benchmark DB untouched. Browser closed, app/DB remain
available. Decision: no change justified by this flow. No patch/commit/PR.

### Board create/configure/reopen walkthrough — 2026-09-09

Luna ran the browser flow on the isolated walkthrough app: created Mixed board
`Walkthrough board`, added Metrics bar for Demo SaaS, saved the component then
the board, reloaded and reopened from Boards. Board id:
`82616a59-c6d6-4d02-b009-4738f946cbe4`. Main independently verified persisted
parameters contain one row/column, `WebsiteMetricsBar`, title `Metrics bar`,
entityType `website`, and entityId `c17cf711-0e4a-443f-b75a-9919a521bf95`.
Reopened screen displayed those labels plus505 visitors/visits and1,050 views.

Primary retained UI evidence: ignored
`.playwright-cli/page-2026-09-09T04-52-33-855Z.yml` (reopened board).
The agent's immediate-reload snapshot `page-2026-09-09T04-52-03-096Z.yml`
contains only a loading alert, so that file alone is not proof of restoration;
the later reopened view and direct DB read establish persistence.
Main inspected console log `console-2026-09-09T04-48-25-041Z.log` in the same
directory: pre-login401 and synthetic favicon404, no demonstrated save error.

Decision: basic board persistence works in this bounded case; no change
justified. Did not test shares, permissions, multiple editors, row filters or
large boards. Browser closed; one synthetic board remains in disposable DB.
No original DB changes, source edits, new test framework, commit or PR.

### Runtime cleanup — 2026-09-09

At user request, stopped the walkthrough Next app (exec67036) and both
`umami-walkthrough-db-1` and `umami-qualification-db-1`. Docker volumes/data
were preserved. Playwright CLI reported no open browsers; local TCP3000–3010
had no listeners after shutdown. This supersedes earlier runtime-left-running
notes. Other unrelated application processes were not stopped.

### Tracker navigation case

The complete collection-path investigation, rejected immediate-navigation variant,
dispatch-only candidate and verification record moved to [tracker-navigation.md](tracker-navigation.md).

### Website reset/delete screening — 2026-09-09

Read-only source inspection against dev `9fb7bace` (the existing verification
archive; visitor-count patch is unrelated). No app or DB was started, no website
was reset/deleted, and no browser UI execution or deletion benchmark was performed.

UI source `WebsiteData.tsx`, `WebsiteResetForm.tsx`, and `WebsiteDeleteForm.tsx`
offers full reset and website deletion, guarded by typed RESET/DELETE confirmation.
The corresponding POST reset/DELETE routes check update/delete permissions and await
the operation. This is UI-code evidence, not a live walkthrough. A date-range purge
was not found in these settings/routes. Official [API documentation](https://docs.umami.is/docs/api/websites)
describes reset/delete; [FAQ](https://docs.umami.is/docs/faq) says self-hosted data
is retained indefinitely unless manually deleted. Building retention scheduling
would be new functionality, not a proven fix.

`src/queries/prisma/website.ts:20-74,207-283` deletes dependents before events and
sessions in a single interactive transaction, timeout 30s. Reset preserves the
website/configuration and updates resetAt; deletion also removes reports, segments,
annotations and shares, then the website (soft deletion in cloud mode). Redis
updates happen after the transaction in cloud mode. `prisma/schema.prisma:7-10`
uses relationMode=prisma: do not assume database FK cascades provide cleanup.

The two-pass event-data deletion is intentional defensive cleanup for mismatched
denormalized website IDs. Existing [issue #4435](https://github.com/umami-software/umami/issues/4435)
is closed/fixed-in-dev; do not rediscover that failure as new or remove its safety
pass as redundant work. A large transaction/30s timeout is not evidence of an
observed timeout, lock incident or poor throughput.

Fresh focused check in `/private/tmp/umami-visitor-pr-check.dOV9fg`:
`node_modules/.bin/vitest run src/queries/prisma/website.test.ts src/permissions/website.test.ts`
passed 51 tests in 1.19s. Tests mock DB transactions; they verify call order and
permission behavior, not real rollback, concurrent ingestion or deletion speed.

More concrete follow-up hypothesis: an already-open tracked page can continue
using its cache token after an administrator resets the website. The reset deletes
session rows. `src/app/api/send/route.ts:109-179` skips website lookup when a cache
websiteId exists and skips session creation when a cached sessionId matches the
recomputed ID. `saveEvent.ts:108` then creates the event; visitor-list SQL joins
events to session rows (`getWebsiteSessions.ts:60`). This could leave post-reset
events without the expected session context. It is a source-supported hypothesis,
not an observed orphan/event loss or an established production-frequency claim.
The narrow duplicate search did not establish novelty.

Next qualification, if continued: a new disposable website/session, one normal
send to obtain its token, reset, then one cached send and a fresh-token control.
Inspect HTTP outcomes and persisted event/session linkage. No race injection,
large dataset, retention job, retry queue, or existing benchmark data required.
Do not select a fix until actual API/DB behavior is observed.

### Filter/request-scope screening — 2026-09-09

**Superseded by the browser check below: session-summary pagination candidate
rejected. The hook exists but its component is not mounted by the current page.**

Pinned dev9fb7bace source, no service startup or upstream edits. Overview country
filters, chart unit, dimension tabs and comparison periods change corresponding
query semantics; no unnecessary recomputation established for those interactions.
Stats excludes chart unit already. Do not revive the previous debounce or
Attribution/Performance-summary cases under a new name.

A narrower candidate is visitor-list pagination. DataGrid updates URL page;
`useWebsiteSessionStatsQuery` spreads `useFilterParameters()` (default includes
page/pageSize) into both its query key and request. The sessions/stats route and
`getWebsiteSessionStats` aggregate the date/filter population, not one list page.
The event-summary hook already uses `includePagination: false`.

Offline probe `.local/session-pagination-probe.cjs` transpiles the actual hooks
and filter helper, uses the installed TanStack QueryClient with the app's 60s
staleTime, and substitutes navigation/date/HTTP boundaries. Fixed country/date,
pages 1→2→3→1: session summary has 3 distinct keys/3 mocked requests; event
summary has 1 key/1 request. Assertions passed. This is not an actual React render,
browser trace, API response-equivalence check or DB performance measurement.

Next qualification: normal visitor page 1→2→3 on a fixed synthetic website;
observe actual summary requests, response equality and their server cost before
judging significance. Excluding pagination may retain summary data until existing
cache refresh rather than refreshing on every new page; assess that freshness
trade-off, and keep genuine country/date/search semantics separate. No patch
selected, no production-impact or novelty claim. Per user preference, intermediate
investigation remains uncommitted until the case is concluded.

### Session pagination browser check — candidate rejected, 2026-09-09

Reused existing dev9fb7bace build (unrelated visitor-count patch) and isolated
walkthrough DB; no rebuild, seeding, schema change or analytical-data writes.
Actual Sessions Activity page exposed 983 records across pages for fixed range
startAt=1788796800000, endAt=1788969599999. Clicked next twice (1→2→3).
Captured HTTP responses: only list requests, all200, pages1/2/3 and count983.
Browser request durations were56.038/43.548/29.340ms; these are one warm run's
list timings, NOT summary costs, SQL CPU timings or optimization evidence.
No sessions/stats request occurred. Console errors were image/favicon404s,
not failed summary requests.

Root correction: `SessionsPage.tsx` renders SessionsDataTable/SessionProperties
and SessionModal, not SessionsMetricsBar. Repository search found no mounting
caller for SessionsMetricsBar; that unused component was the only hook caller.
The API remains exposed, but existence is not proof the UI invokes it. The prior
offline harness manually invoked an unused hook and therefore did not model the
current user's path. This was a call-chain qualification error, not an Umami bug.

Probe `.local/session-pagination-browser.js` returns request URLs/status/timings
without auth headers or private analytics. The first run used console.log without
returning samples; only the subsequent returned run supports the timings above.
Browser snapshot `.playwright-cli/page-2026-09-09T11-07-52-923Z.yml` and console
log from the same timestamp remain ignored. No patch, cache change, dead-code
cleanup or follow-on stress test is justified by this candidate.

### Overview expanded paths walkthrough — 2026-09-09

Real browser on the same dev9fb7bace walkthrough build/DB, fixed date range
1788796800000–1788969599999. Opened Overview → Pages/Path → More, then searched
`docs` and cleared it. No new data or load generation. Browser Resource Timing
showed one metrics/expanded request on opening (52.3ms,1534 transfer bytes), one
search=docs request (35.9ms,791 bytes), with 13 initial paths and 5 matching rows.
No overview stats/chart/other metric requests were observed during search.
Clearing search restored13 rows with a24.4ms request; more than the configured
60s stale window had elapsed since initial loading, so this is not evidence of
failed cache reuse. An active-user poll was also observed (24.3ms), not attributed
to search. These are individual warm local observations, not benchmark medians,
SQL execution times or full interaction-to-paint timings.

Clicked Views header: no API request or sort state appeared. Actual
MetricsExpandedTable.tsx uses plain DataColumns without sorting configuration;
do not claim a sorting flow was exercised. Search is local component state,
passed only to its expanded-metrics query, with an existing300ms delay.
No debounce or caching patch justified. Snapshot:
`.playwright-cli/page-2026-09-09T11-12-17-539Z.yml` (ignored).

Decision: no compelling cost or request-fanout problem in this small fixture.
Thirteen distinct paths cannot qualify high-cardinality behavior, but do not
manufacture large data merely to make this candidate look slow. No source
change, benchmark expansion, commit or push; temporary app/browser/DB stopped
after observation, data preserved.

### Public-report qualification — 2026-09-10

No new runtime test, source patch, service, commit or push in this screening.
Reports below are other users' observations, not this lab's measurements.

- **First candidate: session activity / event-data membership.** Open
  [#4526](https://github.com/umami-software/umami/issues/4526) reports runtime
  v3.2.0, PostgreSQL16.14, 4vCPU/15GiB, approximately6.88M event_data rows and
  443k website_event rows. Ordinary Events→session-avatar navigation requested
  about20days despite the underlying list showing24hours. Reporter observed
  minute-long queries and reproduced15s timeouts with4MB work_mem; an existing
  index-backed correlated EXISTS was faster in their samples. This is a
  planner/data-distribution problem, not evidence that every IN query is slow.
  Live dev source at1d7874b7d946e9d8e9b257a051fa0789ddd32728 still has the
  site/date-wide IN subquery in getSessionActivity.ts. Searches for PRs using
  `session activity` and `hasData EXISTS` found no matching fix; this is a bounded
  search, not proof none exists. Reporter already supplied diagnosis and proposed
  SQL: any lab work must credit it as independent reproduction/validation, not
  claim an original discovery. Next: verify current mounted UI/API path and
  schema semantics, then design a bounded synthetic plan comparison; no benchmark
  or patch yet approved by this screening.
- **Reserve: connection-cap failure presentation.** Open
  [#4494](https://github.com/umami-software/umami/issues/4494) reports v3.3.1,
  Vercel+Supabase session-mode pool cap15, rapid dashboard navigation and a
  server-component error screen. Actual pasted Prisma code is P2039 (the prose
  also mentions P2010). Pool configuration versus application error isolation
  remains unresolved; retry/backoff suggestions are not adopted. A local
  single-process reproduction would not establish serverless prevalence.
- **Not selected:** [#4498](https://github.com/umami-software/umami/issues/4498)
  reports268MB RAM on Caprover with only version3 specified, without growth
  history or a leak reproduction. Insufficient evidence of excessive usage.
  [#4353](https://github.com/umami-software/umami/issues/4353) concerns stale
  planner statistics after upgrade on approximately11M events; closed with a
  collaborator pointing to added upgrade guidance, not a fresh fix candidate.
  Luna also located older upgrade/pool#3417 and Docker shared-memory discussion
  #2490; these do not establish a current code defect and are not prioritized.

Decision: investigate#4526 first if continuing. It has concrete user-flow,
environment and plan evidence, while still requiring our own verification.
No production/general-frequency claims or commitment to an upstream PR.

### Session activity qualification preparation — 2026-09-10

Read-only Luna call-chain audit plus main review used the existing dev9fb7bace
archive (unrelated visitor-count patch). SessionProfile mounts SessionActivity
with firstAt/lastAt; its hook calls the activity route, the only runtime caller
of getSessionActivity. Additionally, the route expands linked session IDs and,
when multiple IDs and link dates exist, widens the dates to month boundaries.
This is code evidence, not a newly observed browser trace or proof of a bug in
date semantics. Do not shrink the requested history to hide SQL cost.

EventData.websiteEventId is required; initial migration confirms UUID NOT NULL
and an existing index. Preserve website and date filters in correlated EXISTS.
The usual IN-versus-EXISTS NULL distinction therefore does not apply to these
ID columns under the declared schema ([PostgreSQL semantics](https://www.postgresql.org/docs/16/functions-subquery.html)).
Sibling getWebsiteEvents already uses paged_events/paged_event_data joins with
DISTINCT; that is a possible pattern, not automatically simpler than EXISTS.
No alternative is selected before measurements justify the extra query structure.

Prepared scripts/session-activity-probe.sql: temp tables copy the installed
public table definitions/indexes, never public data. Fixed synthetic timestamps,
500 target events, half with no properties, 20 properties per remaining event.
Small check events=1000 creates15000 properties; both complete 500-row projections
matched. Raw plans and PASS are in ignored .local/session-activity-smoke.log.
This was SQL-only PostgreSQL15.19/aarch64, not reporter16.14/x86 or API validation.
Temp tables use local buffers and cannot establish production I/O/parallelism.

Default30000 events produces595000 properties, still below the reported scale.
User runs this qualification; setup statements capped60s and each variant's
EXPLAIN ANALYZE+result capture capped15s. Timeout yields INCONCLUSIVE equality,
not failure-free equivalence or an exact speedup. Each variant runs once for a
plan and once for results, candidate first: not an alternating benchmark.
No forced planner switches, indexes, app patch, or production memory tuning.
Schema-dependent view rewriting fails closed if PostgreSQL formatting changes.
Small smoke completed; larger run not yet executed. Temporary DB stopped again;
volume preserved. No commit/push.

### Session activity larger qualification — user run inspected 2026-09-10

`.local/session-activity-probe.log`: PostgreSQL15.19/aarch64, work_mem4MB,
hash_mem_multiplier2, 30000 synthetic events/595000 properties, temp tables.
Completed EXPLAIN ANALYZE: candidate2.803ms; original14118.519ms, both500 output
rows. These are single SQL plan executions, not API latency or benchmark medians.
Original materialized595000 property IDs once, then visited that materialization
500 times (298746 rows per loop, rounded plan average);472433 temp blocks read.
Candidate used existing website_event_id index500 times. Outer plans also differ:
original scans backward by created_at and filters29500 other-session events;
candidate takes a bitmap/sort path. JIT accounts for186.430ms in original.
Thus repeated membership work is strongly supported, but the entire time delta
must not be attributed solely to that node or to physical disk/CPU saturation.
Temp-block counters are not measurements of physical disk traffic.

Harness limitation caught during review: each run_probe call shares one15s
timeout across EXPLAIN ANALYZE and a second execution for result capture.
Original's plan DID finish at14.119s; its subsequent result capture timed out.
The notice 'no completed timing/equality claim' is too broad: the completed plan
timing above is valid, full-result equality for this larger fixture is unknown.
Final INCONCLUSIVE correctly withholds equality. Small-fixture equality remains
the only completed equality evidence. Next separate plan/result time budgets
before further validation; do not call the incident or proposed fix fully proven.
No upstream patch, commit or push made.

Probe follow-up: split explain_probe and capture_probe into separate top-level
SELECT statements, each with its own15s timeout. Notices now distinguish plan
timeout from result-capture timeout. events=1000 smoke exited0 and matched all
500 projected rows (.local/session-activity-smoke-v2.log). DB stopped again.
Large rerun pending; retain the original log instead of overwriting it.

Large v2 rerun inspected: .local/session-activity-probe-v2.log reports candidate
EXPLAIN ANALYZE3.497ms; original plan execution hit its15s timeout (no completed
timing for that execution). Both separate result captures completed, and the
full500-row JSON projections matched after sorting by eventId. Thus large-fixture
equality is now confirmed, not just small-fixture equality. This does not verify
tie ordering or other tenants/date boundaries/linked sessions; fixture times are
unique and captures are sequential with no concurrent writes. EXPLAIN execution
and result capture are separate executions with different instrumentation/cache
conditions; a timeout in one and completion in the other are not contradictory.
Together with v1's completed14.119s original plan, the runs support an unstable,
expensive materialized membership path versus indexed EXISTS on this fixture,
not a precise speedup factor or a production latency guarantee. No running
containers remained at inspection. No commit/push.

### Minimal source patch and semantic regression — 2026-09-10

Luna implemented patches/session-activity-exists.patch against the existing
dev9fb7bace source archive. Main reviewed the baseline/source diff: only the
relational hasData expression and outer table alias change; website/date filters,
session array, performance exclusion, projection/order/LIMIT500 and ClickHouse
remain unchanged. Diagnosis/EXISTS approach credited to issue4526. No new index,
dependency, memory setting, cache, or API/date-policy change.

scripts/session-activity-check.sh extracts relational SQL from the actual patched
source; default baseline is reconstructed by reversing the saved patch in a temp
directory (optional explicit baseline path also supported). It executes both on
TEMP tables copied from installed schema inside a rolled-back transaction.
Final fixture:9 events/12 property rows;4 independently expected eventId/hasData
pairs and full-row multiset equality. Covers multiple properties, no qualifying
properties, other-site properties, inclusive lower/upper bounds, out-of-range
and NULL property dates on a retained event, excluded outer dates/site/performance
events, and two selected sessions. It does not test tie order or the500-row cap.
Reviewer corrected the first fixture: properties attached only to excluded events
did not exercise inner date filters; a lower-bound property initially also had a
qualifying middle-date property. These masking cases were removed before final run.

Main reran successfully:
`bash scripts/session-activity-check.sh /private/tmp/umami-visitor-pr-check.dOV9fg`
and `bash -n scripts/session-activity-check.sh`. Reverse git apply --check passed
on the patched archive; agent also reported forward applicability on baseline.
Actual baseline/source diff confirms ClickHouse unchanged. Existing Vitest activity
route and saveSessionData tests:2 files/3 tests passed after patch (2.21s).
Those tests mock SQL and are not a substitute for the real DB fixture.

Test-first qualification is the previously observed performance failure, not a
new semantic bug: correctness tests should pass on the baseline too. An agent's
initial missing-EXISTS source-text assertion was discarded during review; do not
present it as a behavioral red/green regression. No large patched-source API
benchmark, browser build, full API suite or production verification performed.
Prior large timings used the probe's equivalent SQL shape, not this source-linked
harness. No additional performance claim. Temporary DB stopped; original data
and unrelated source changes preserved. No commit/push/upstream submission.

### Session activity reproduction and handoff

Repository packaging: summary in `evidence/2026-09-10/session-activity-summary.json`
is transcribed from the two ignored local logs; it is not raw measurement output.
Original diagnosis and EXISTS proposal belong to issue4526. The public lab keeps
only synthetic aggregate evidence, scripts and the attributed minimal patch.
Historical "no commit/push" entries above describe those stages, not packaging.

Prerequisites: a disposable PostgreSQL database with Umami's migrated
`public.website_event` and `public.event_data` schema. No source data is required.
Existing local instance uses container `umami-walkthrough-db-1`, role `walkthrough`,
database `umami_walkthrough`; its Compose file and volume are intentionally local.
For another installation substitute its container/role/database in the probe
command and set `PSQL_DOCKER_CONTAINER`, `PSQL_DOCKER_USER`, `PSQL_DOCKER_DATABASE`
for the regression script. Run only on disposable infrastructure you own.

From the lab root, with that DB running:

```bash
docker exec -i umami-walkthrough-db-1 \
  psql -X -U walkthrough -d umami_walkthrough \
  < scripts/session-activity-probe.sql
```

Default30000 events; add `-v events=1000` to psql for the smoke fixture.
All generated tables are temporary. Setup statements have60s limits; plan/result
calls each have15s limits. Read the final PASS/INCONCLUSIVE, not just exit status:
timeouts are intentionally captured. Full logs should remain under ignored.local.

For source correctness, use an external checkout at
`9fb7bacee62c34d6d05312d063a37c20d581de23`, check then apply the patch using
`git apply --check` and `git apply` there. Do not reapply to an already patched
checkout. Then from this lab:

```bash
bash scripts/session-activity-check.sh /absolute/path/to/patched/umami
```

The script reverses the supplied patch only in a temporary copy to reconstruct
baseline SQL. It executes both queries against9 synthetic events/12 properties
and rolls back. It does not rebuild or start the app. Stop the disposable DB
after checks; preserve any existing volumes. Next external action is a draft
verification comment on issue4526, not an automatic PR. Full build/lint and
current-dev compatibility remain submission work, not completed validations.

External follow-up: with user approval, posted the independent reproduction
[comment](https://github.com/umami-software/umami/issues/4526#issuecomment-5611336850)
on2026-09-10, linking immutable lab commitc3ecd02. No PR submitted.
At that check dev1d7874b7d946e9d8e9b257a051fa0789ddd32728 still contains the
same relational IN expression. PR searches for `session activity`, `4526`, and
`getSessionActivity` found no matching fix; this bounded search is not proof of
absence. Current-dev build/lint and submission packaging remain pending.

Comment was subsequently edited with user approval to explain the checks inline
and omit the repository-root link; the same comment URL remains valid.

PR preparation: fetched pinned current dev1d7874b7 into a separate non-promisor
checkout at `/private/tmp/umami-session-pr-check.2I1SLd`. No other case's patches
are included. Patch applies cleanly; git diff shows one SQL file,6 additions and
5 deletions; diff --check passes. Source-derived DB regression passed on this
checkout using the existing disposable PG15 schema (not a fresh migration of
current dev). DB stopped. Dependency install/build/lint and existing unit tests
on this fresh checkout remain user-run work. Dockerfile pins pnpm11.21.0.
Use SKIP_DB_CHECK=1 and a dummy localhost URL for build verification to avoid
database checks/migrations; this does not establish migration/runtime health.
No PR or remote branch submitted, and no new lab commit/push at this stage.

User-run verification inspected2026-09-10: build log reaches postbuild successfully;
following targeted Vitest run reports2 files/3 tests passed. Full lint exits1.
Main compared `biome lint . --max-diagnostics=100` on patched checkout and pristine
archive of the SAME dev1d7874b7 using the same installed dependencies: diagnostics
match byte-for-byte except the elapsed-ms summary. Both have6 errors,13 warnings,
11 infos. Raw comparison logs are ignored.local/session-lint-{baseline,patched}.log.
Single changed SQL file lint passes. Earlier visitor checkout had14 warnings,
so do not claim identical totals across historical revisions. No unrelated lint
fixes warranted. Build/install also changed only the executable mode of
packages/mcp/bin/umami-mcp.js (100644→100755); exclude that artifact from the PR.
No full-lint success claim, no PR submission or new commit/push.

Submission2026-09-10: user approved the reviewed draft.
[PR#4528](https://github.com/umami-software/umami/pull/4528) opened against `dev`,
head `dongwonmoon:codex/session-activity-exists`, commit1faf55d. Verified remote
diff contains only getSessionActivity.ts (6 additions/5 deletions), excluding
the build-generated executable-mode change. Fresh targeted unit tests3/3 and
changed-file lint passed immediately before commit. PR credits issue4526 and
links immutable direct test/summary files. OPEN is submission, not acceptance
or merge; no maintainer response or CI success is claimed here.

### Fresh candidate screening — 2026-09-10

Read-only source inspection at dev `1d7874b7d946e9d8e9b257a051fa0789ddd32728`
(existing checkout has the unrelated session-activity patch). Live dev SHA was
checked; no application, database, browser, benchmark or upstream change ran.

**Preferred next observation: heatmap detail repeats the page-list aggregate.**
`HeatmapsPage.tsx` mounts `Heatmap.tsx:61-103`, which separately requests the page
list and, when a path is selected, its detail through `useResultQuery`.
The displayed list comes only from `pagesData.pages`; detail consumes points,
scroll and snapshot, not `detailData.pages`. Yet relational `getHeatmap.ts:118-143`
always aggregates all matching pages before branching on `urlPath`; selected-page
requests repeat that aggregate. ClickHouse has the same broad response structure.
This is a mounted UI/code fact, not an observed browser trace or measured bottleneck.

The list is capped at 100 pages and click detail at 5,000 grouped points. React
Query caching may avoid repeat requests for a revisited path; this does not merge
list and detail keys. Full API responses may intentionally serve other consumers:
`tests/api/reports.spec.ts:401-442` explicitly requires a selected-page request to
include the page list. Do not simply remove it or call it unused globally.

Smallest next check: on disposable, recording-enabled synthetic input, open the
heatmap list and select two pages; capture actual requests and measure the page
aggregate separately from detail. If its cost is negligible, stop. If material,
evaluate a narrow opt-in detail-only path that preserves existing API defaults;
no cache, endpoint split or implementation is selected yet. Account for collection
setup cost: existing recording qualification had heatmaps disabled, so its data
does not establish this candidate's value. A bounded GitHub heatmap PR search
found no clearly matching fix; this is not a comprehensive novelty claim.

Other screening outcomes: retention's repeated client-side array searches are
bounded by a calendar-month UI (`RetentionPage.tsx:8-21`); no reason to enlarge
the fixture to force a cost. Revenue repeats session qualification but resembles
the existing attribution investigation and was not prioritized. Luna traced
mounted board realtime components: header-only/chart-only widgets fetch the full
payload, but shared query keys mitigate duplication, and activity is capped at
100 SQL rows (up to 200 UI rows including synthetic session entries). Those
entries serve visitor/activity semantics; neither a new defect nor a worthwhile
endpoint split was established. Keep these as lower-priority observations.

### Heatmap ordinary-flow qualification — 2026-09-10

Reused the built dev1d7874b7 + unrelated session-activity patch with isolated
walkthrough DB5434. Initial heatmap table was empty. Created one synthetic site
`3c1fd4cd-668e-4769-a3f3-7499f33f9a59`, heatmap-only sampling100%, and served two
simple local pages. Real Chromium clicks through the unmodified tracker/recorder
produced three click rows: /first2 (button and navigation link), /second1.
Used an ordinary Chrome User-Agent header; bot policy was not disabled. Automatic
scroll observations also exist, including iframe visits; only click mode was tested.

Actual heatmap UI reload → /first → /second returned three HTTP200 responses.
Each included both page names; point counts were0/2/1. A single retained browser
observation returned76.6/16.1/21.9ms and545/936/828 transferred bytes, respectively.
These are Resource Timing samples, not repeated medians or SQL times. Browser
parameters: start2026-09-09T02:00Z, end2026-09-10T02:59:59.999Z, Asia/Seoul,
no filters. Snapshot `.playwright-cli/page-2026-09-10T02-34-23-872Z.yml` and local
CLI observations support the flow. Initial cross-call Node-global response capture
did not persist; only the final single-call returned responses establish payloads.

Source-linked `.local/heatmap-qualification.ts` calls getHeatmap for list/first/
second three times; asserts two pages,1/2/2 raw SQL calls and nonempty detail.
It records each raw-query duration and a separate EXPLAIN ANALYZE execution in
`.local/heatmap-qualification.json`. Local PG15, read-only/5s statement options,
same three click rows; query dates were the Korean calendar day, not the browser's
rolling range. Repeated page SQL executions took0.046–0.143ms. Warm raw-query
calls took0.589–2.140ms; first call126.233ms includes client-side startup/connection
overhead and is not a126ms SQL claim. Interleaved EXPLAIN warms caches: no speedup
or representative latency claim. The helper does not measure snapshot lookup or
total HTTP time. No data amplification, comparative patch or load test ran.

Decision: duplicated work confirmed, material cost not established in this tiny
fixture. Pause implementation, not a claim of scalability. Revisit with justified
traffic/recording-volume evidence, not arbitrary rows designed to force slowness.
Existing API page-list contract remains unchanged. Dedicated browser, app, synthetic
page server and walkthrough DB stopped; volumes/synthetic rows preserved. Only
the owning record changes in Git; local probe/output remain ignored. No commit,
push or upstream posting.

### Reported replay/identity screening — 2026-09-10

- [Issue #4497](https://github.com/umami-software/umami/issues/4497) reports v3.3.1
  (`ca661c7`), PostgreSQL, a playable 4:07 replay listed as 0:01 and hidden by
  `minDuration=5`; the reporter also saw player overshoot to 5:23. A comment
  measured 247.014s wall span versus 1.961s summed chunk spans (37 chunks/70 events).
- Current `dev` is `1d7874b7`; its replay query still sums chunk spans for both
  `duration` and the minimum-duration `HAVING` in PostgreSQL and ClickHouse
  (`src/queries/sql/replays/getSessionReplays.ts:51-70,116-135`).
- [PR #4503](https://github.com/umami-software/umami/pull/4503) proposes the
  endpoint-span expression in both stores and is OPEN/unmerged. The player
  overshoot remains a separate, unverified defect. **Priority: one smallest
  check**—apply/read-test the PR expression against a gapped multi-chunk fixture;
  do not duplicate implementation in this lab.
- [Issue #4512](https://github.com/umami-software/umami/issues/4512) reports v3.3.1
  identity collision under shared IP + identical UA/hostname/site: `identify()`
  updates session primary identity while per-event IDs remain correct. Current
  mounted flow writes `session_link` and calls `updateSession` on every new link
  (`src/app/api/send/route.ts:315-343`); current GET stitches from the primary
  only once it exists (`.../sessions/[sessionId]/route.ts:33-49`).
- [PR #4518](https://github.com/umami-software/umami/pull/4518) keeps all linked IDs
  visible/stitchable while retaining last-wins primary semantics; it is OPEN/unmerged.
  Its review notes the additive `distinctIds` field is absent from the generated
  public API contract. **Policy choice:** hold implementation; if accepted, the
  smallest check is two colliding identities through session GET plus contract
  coverage. No independent candidate established.

Main reviewed issue4497's reproduction/comment and PR4503's scope (4 additions/
4 deletions, existing proposal). Prefer independent validation of that proposal,
not another implementation or a claim of original diagnosis. The reporter used
a downstream masking patch; an unmodified local recorder would separate that
environment difference. No runtime reproduction has been performed in this pass.

Operational reports screened but not selected: [4491](https://github.com/umami-software/umami/issues/4491)
requests a configurable ClickHouse pool without measured saturation; [4475](https://github.com/umami-software/umami/issues/4475)
omits the original migration failure log, which a collaborator requested;
[4458](https://github.com/umami-software/umami/issues/4458) lacks a precise failing
request/source path for the alleged startup failure; [4459](https://github.com/umami-software/umami/issues/4459)
mixes authentication and unconfigured2FA symptoms without confirming one cause.
Do not infer a new fix, request private databases, or execute suggested destructive
recovery commands. No services, patch, commit, push or external comment in this pass.

### Upgrade/recovery documentation and startup check — 2026-09-10

Question: what can an operator safely determine when an update fails? This is
read-only qualification, not reproduction of issue4475 or a recovery runbook.

- [Official updates](https://docs.umami.is/docs/updates) describes pull/build/restart
  and post-upgrade ANALYZE, but that page does not give failed-migration diagnosis
  or rollback steps. The [CapRover guide](https://docs.umami.is/docs/guides/running-on-caprover)
  explicitly recommends a database backup; it also contains legacy MySQL/image-prefix
  advice, so it is not a verified v3.3.1 deployment procedure. Do not claim that all
  official documentation lacks backup guidance.
- Read the release-specific [v3.3.1 package scripts](https://github.com/umami-software/umami/blob/v3.3.1/package.json)
  and [check-db.js](https://github.com/umami-software/umami/blob/v3.3.1/scripts/check-db.js):
  Docker startup runs check-db before tracker update/server; check-db executes
  `prisma migrate deploy` unless explicitly skipped and exits1 on a caught failure.
  Source-build checks and Docker runtime checks are distinct paths. Pinned dev
  1d7874b7 instead uses a set-e startup shell with the same ordering. Local checkout
  1faf55d contains the unrelated submitted session-activity patch; it was not edited.
- [Migration22](https://github.com/umami-software/umami/blob/v3.3.1/prisma/migrations/22_add_2fa/migration.sql)
  adds columns/tables/indexes; no reverse SQL is performed by the inspected startup
  path. Switching app images is not itself a database restore. Whether a specific
  older app remains compatible needs checking, not a blanket incompatibility claim.
- [Issue4475](https://github.com/umami-software/umami/issues/4475) shows P3009 and
  historical app-only rollback, not the initial migration error. The collaborator
  requests `_prisma_migrations` error details. No causal link between the rollback
  and original failure has been established.
- [Prisma failed-migration guidance](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing#failed-migration)
  identifies the migration `logs` column and distinguishes history resolution from
  actually repairing partially applied steps. Marking a migration rolled back is
  not automatic reversal of its SQL. Do not blindly retry, mark applied, reset the
  database, or bypass migration checks as a proposed fix.

Decision: an operator-guidance question is supported; an application defect is not.
Next bounded runtime question, if pursued: establish a normal version-pinned upgrade
on disposable synthetic data and its migration logs before choosing a failure
scenario. Do not manufacture schema damage to claim reproduction of4475. If the
normal path is clear, do not force a new automation/chaos framework or upstream PR.
No runtime upgrade, failure injection, restore, service start, commit or push ran.

Preparation (user-run first boot pending): ignored `.local/upgrade-compose.yml`
defines project `umami-upgrade-check`, a new `upgrade-data` volume and localhost
port3011; PostgreSQL has no host port. Both services disable automatic restart so
startup failures remain inspectable. Credentials are deliberately public dummy
values for local synthetic data, not production configuration. No existing volume
with that project name or listener on3011 was found at preparation time.

Registry manifest inspection verified linux/arm64 and linux/amd64 for both images:
3.1.0 index `sha256:e3f80c0625aad7179b49da27d475357cabb1068b8cacd9a792cfd6966888b123`;
3.3.1 index `sha256:fa32d116cf20cad52cbc3fad9a63b46e7fa02299d8f967168eb453d49c476b4a`.
Compose defaults to the former; PostgreSQL15-alpine is pinned to existing local
RepoDigest `sha256:fe0737ba566a2c5b2a28f34433c0a423261900ec17b9bf7ad115e1aae7e57f1b`.
`docker compose -f .local/upgrade-compose.yml config --quiet` passed. No image
layers were downloaded and no services started by the agent.

Sequence: user boots3.1.0; establish login/site/synthetic event baseline; stop only
the app to freeze writes, take a checked pg_dump backup and record migration state;
then switch only the app image to pinned3.3.1 without recreating/upgrading the DB;
check login, preserved data, new collection and migration history. Stop on error
and retain logs; do not reset volumes or mark migrations resolved automatically.
Heartbeat alone is not success. Backup creation is not proof of restoration.
The initial handoff intentionally stops before fixture creation or upgrade.

3.1.0 baseline captured after user first boot (2026-09-10): image healthy,
19 migrations completed; login and website creation succeeded. API-generated
synthetic fixture has3 pageviews (`/upgrade-a`, `/upgrade-b`, `/upgrade-c`) and
one named `synthetic_signup` event. API stats report3 pageviews/1 visitor/1 visit;
DB snapshot contains1 website,1 session,4 events and4 event-data rows. Fixed stats
window1789014850000–1789014870000ms and row snapshot are retained in ignored
`.local/upgrade-baseline.json` and `.local/upgrade-baseline-db.json` (no login token).
Main independently checked persisted event-type counts (3 pageviews/1 named event).

App was deliberately stopped (exit143); the isolated DB remains healthy and running.
Custom pg_dump `.local/upgrade-before-v3.1.0-20260910T043416Z.dump` is49,881 bytes,
SHA256 `41ec2b97da7e00999ae76ad157003f4be98a522464a98a14453bc62b4fd2e942`.
Main verified the hash and successfully read its archive listing using the DB
container's pg_restore. This is archive-readability evidence, NOT a tested restore.
Target override `.local/upgrade-target.yml` pins3.3.1; configuration validation
passes. Use both Compose files after upgrade (base alone selects3.1.0).
Next handoff pulls/recreates only app with `--no-deps`, retaining DB/container/volume.
Upgrade and after-state validation are still pending; no success claim or PR.

3.3.1 outcome — 2026-09-10: user ran the app-only update. Actual image digest
matched the pinned target; DB container creation predates the update and its
`umami-upgrade-check_upgrade-data` mount remains. Startup applied migrations20–24;
SQL inspection confirms24 completed, none unfinished/rolled back. Login succeeds.
The fixed-window stats JSON is semantically identical (3 pageviews/1 visitor/1 visit).
Main independently compared baseline fields against actual DB rows: original
website, session,4 events and4 event-data rows match. Website `replay_enabled`
is compared to `recorder_enabled`, the explicit migration20 rename; this is not
byte-identical whole-schema preservation. The fixture had recording disabled.

One new `/upgrade-after` pageview was accepted and persisted. Wider-window stats
now report4 pageviews/1 visitor/1 visit. Local summaries are
`.local/upgrade-after.json` and `.local/upgrade-after-db.json`; the latter contains
only new-event/count evidence, not a full before-send row snapshot. Main checked
prior rows directly after that insertion. Stored stats hashes differ in formatting;
parsed JSON deep equality, not hash equality, establishes the fixed-window match.

Decision: normal upgrade passes this small synthetic smoke check. It does not
reproduce4475, validate partial-migration recovery, establish large-data migration
performance, exercise enabled recording/2FA or duplicate session-data migration,
or prove backup restoration. No new defect or code fix established; do not force
failure injection merely to produce a case. Isolated app and DB stopped after checks;
volume and backup retained. No other services changed, no commit/push/PR.

### Separate-copy restore closure — 2026-09-10

User approved restoring the pre-upgrade archive, not overwriting the upgraded DB.
Used `-p umami-restore-check` with the base Compose file and ignored
`.local/upgrade-restore.yml`: separate project network/volume
`umami-restore-check_upgrade-data`, pinned3.1.0 app on localhost3012.
Target had zero public tables before restore. Verified the archive SHA above,
then `pg_restore --exit-on-error -U upgrade -d upgrade` completed with exit0.
Only after restore was the app started; images were already local (`--pull never`).

Main independently checked actual restored DB against baseline fields:1 website,
1 session,4 events,4 event-data rows and19 migration records match, with matching
row counts. Fresh API login and parsed fixed-window stats also match baseline.
There are no `/upgrade-after` events in the restored copy. This is the expected
backup-time cutoff, not an unexpected restore defect: choosing this restored copy
as the service DB would omit that later event. The original upgraded volume is
retained untouched, so no original event was actually deleted in this exercise.

Local evidence: `.local/upgrade-restore-result.json`, `upgrade-restore-db.json`
and `upgrade-restore-commands.md`. Both restore containers stopped after validation;
both original and restored volumes and archive retained. No commit/push/PR.

Minimal tested operator sequence (local synthetic setup, not a generic runbook):
1. Record app image, DB image, configuration and fixed-data/API baseline; stop app
   writes before taking this small fixture's custom pg_dump archive.
2. Preserve the current DB; create a separate empty target with the same PostgreSQL
   image/role. Check project-scoped volume identity and DB readiness before restoring.
3. Check archive checksum; restore with `pg_restore --exit-on-error`. Stop on error;
   do not reset an existing database or mark migrations resolved to bypass failures.
4. Start the matching old app against ONLY the restored DB. Check login, baseline
   row values/counts, migrations and fixed-window API stats, not just heartbeat.
5. Account for writes after the backup before any production cutover; this exercise
   made no cutover. Stop disposable services, retain evidence until cleanup is approved.

Decision: close the normal upgrade plus backup-restore smoke check. A real restore
is now verified for this fixture; no application defect or reliability improvement
was demonstrated. This was same-host, small-data, default-admin testing with no
enabled2FA/recording or alternate-role coverage. It establishes no production RTO,
general recovery guarantee, point-in-time recovery or fix for issue4475. No further
failure injection or automation is justified by this result alone.

Portfolio disposition (user discussion): do not promote this upgrade/restore check
as a standalone featured portfolio case. The operational checks succeeded, but
the intended search for a meaningful defect/improvement produced neither a fix
nor measured operational benefit. Retain it as supporting practice and a closed
investigation, not an optimization, outage response, or issue4475 resolution.

### Next bounded candidate after restore — 2026-09-10

Re-read [4494](https://github.com/umami-software/umami/issues/4494): Vercel/Supabase
report includes EMAXCONNSESSION pool_size15, Website.findUnique and PrismaP2039
(the prose saysP2010). The reported navigation/dashboard failure is real external
evidence, not our reproduction; serverless connection behavior is not established
by a single local process. No comments or PR matching4494 found in the narrow search.

Pinned dev remains1d7874b7. Source path: website route layout awaits getWebsite →
website.findUnique; Providers already wraps children in a global ErrorBoundary.
Its OK button calls resetErrorBoundary, and no route error.tsx was found. Therefore
"there is no error handling" is false. Candidate question: after a transient DB
read failure has cleared, does this existing action actually recover the website
view, or repeat the same server-render failure? This needs browser observation;
do not claim it broken from source alone. Separate connection-capacity/configuration
diagnosis from UI recovery, and do not add automatic retries to an overloaded DB
without evidence. Any local fault test would validate only recovery semantics,
not reproduce Supabase's pool limit or establish occurrence frequency.

Luna screened filter issues4500/4489 and existing open PRs4501/4496. Do not duplicate
those fixes. Local notes `.local/filter-issue-screen.md` retain exact examples.
No runtime fault, new patch, service start, external comment or commit in this pass.

### DB read-failure recovery observation — 2026-09-10

User approved a bounded local failure/recovery check, not implementation. Reused
only isolated `umami-upgrade-check` with pinned3.3.1/PG15 and synthetic site.
Luna observed one cycle and main independently repeated: healthy site → site list →
stop only DB → click the existing site link. App logs show Website.findUnique
PrismaP1001/DatabaseNotReachable; browser displays Something went wrong, React441,
and OK. This is NOT EMAXCONNSESSION/P2039 or a reproduction of Supabase pool limits.

Restarted the same DB before attempting recovery. Main independently logged in and
read the website via API (both HTTP200) while the original browser remained failed.
Attached a Playwright request listener immediately before clicking the observed OK
button: zero requests during click plus1s observation; the same error UI remained.
Full page reload then recovered: Overview visible and error heading absent after
render completion. Initial reload snapshot was still loading and is not the success
evidence; the subsequent visibility check establishes recovery.

Source explanation: v3.3.1 ErrorBoundary passes only resetErrorBoundary to OK with
no onReset callback/server refresh; Providers wraps children in this boundary.
The inspected current-dev dependency reset implementation resets local caught-error
state; it does not fetch a new server result itself. Reusing the failed Server
Component result explains the observation, but no patched comparison has been run.
React's [441 explanation](https://react.dev/errors/441) identifies a server-render
error whose details are hidden in production; exposing database errors is not a fix.

Evidence: `.local/db-recovery-observation.md`, failure snapshot
`.playwright-cli/page-2026-09-10T05-11-04-078Z.yml`, and main tool outputs for
independent API200, zero-request OK click, and successful post-reload visibility.
Existing snapshots from Luna are indexed in that local note. Screenshot references
were subsequently removed because the files were not retained. Two local
cycles, no claim about production frequency or connection-capacity improvement.

Decision: a concrete recovery-button gap survives observation; full reload is a
working workaround. Next work, if approved, is choosing/testing a minimal recovery
action and checking effects on other errors, NOT automatic DB retries or pool tuning.
No product code changed, no commit/push/upstream post. Test browser and isolated
project stopped after final checks; DB volumes retained.

Recovery candidate preparation: retain OK's local reset semantics and add a separate
translated Refresh action using existing labels.refresh and window.location.reload.
No automatic retry, error-code classification or DB configuration change. Full
reload discards unsaved client state and reissues normal page requests, so it is
explicit/user-triggered; it does not restore service while the DB remains unavailable.

Luna implemented only ErrorBoundary.tsx and its adjacent test in the existing dev
verification checkout; unrelated session-query commit and MCP executable-mode change
are not included in this candidate. New refresh test failed before implementation;
after implementation main reran2 tests successfully: explicit reload (no auto reload)
and preserved OK recovery for transient client rendering failure. Changed-file lint
passes. Navigation is mocked in jsdom; these tests do not establish RSC recovery.
Product patch `patches/error-boundary-refresh.patch` changes1 line/adds1 line;
test patch is separate `patches/error-boundary-refresh-test.patch`.

Browser validation pending user build: `.local/build-recovery.sh` downloads immutable
v3.3.1 source ca661c7 and applies only the product patch, then builds local image
`umami-recovery:3.3.1-refresh`. No current-dev/session patch is copied into that
image. `.local/recovery-candidate.yml` selects it for the synthetic project. Shell
syntax and Compose config checks pass; build has NOT run. Build output will be in
`.local/recovery-build.log`; source remains in a unique /private/tmp directory.
Next: repeat the recorded DB-failure/recovery flow with the new Refresh button and
verify recovery without an extra manual reload. Do not claim complete fix yet.
No commit, push or upstream submission.

Candidate runtime validation — 2026-09-10: user build completed successfully;
actual running image ID is
`sha256:52f83177a7788bd8bf83fce1006de09962eb9fb8e775dba7e5e15708a64ac681`.
Source retained at `/private/tmp/umami-recovery-build.26cYBd/source` identifies3.3.1
and reverse-apply check confirms the product patch. Unit tests remain on the dev
verification checkout; they are not presented as a full3.3.1 test-suite run.

One candidate browser cycle reproduced the same DB-down error. DB was restarted
and independently readable before UI recovery. OK still left the error; the added
Refresh action requested fresh auth/site/stats/metrics and returned to Overview,
without an intervening manual reload. Main verified actual image and recovered
browser (Overview visible, error heading absent) and reran2 unit tests/changed-file
lint successfully. Candidate evidence is `.local/db-recovery-after.md` and snapshots
`page-2026-09-10T05-47-16-296Z.yml`, `page-2026-09-10T05-47-42-890Z.yml`,
`page-2026-09-10T05-47-56-089Z.yml` under ignored `.playwright-cli/`.
Agent's nonexistent screenshot reference was removed; it is not evidence. A stale
element click failed before a new snapshot/valid Refresh click; this was a tooling
retry, not an app recovery. Request indices skip static requests in CLI output;
do not infer a precise request count from index gaps.

Decision: the explicit reload escape hatch works for the observed local server-error
case. This adds a recovery option; it does not make OK recover server errors, reduce
DB failures, fix Supabase pool exhaustion or establish reliability under all errors.
Known trade-off: full reload discards unsaved UI state and requests the page again.
The previous lightweight OK recovery remains. No automatic retry loop is added.
Runtime coverage is one candidate Chromium cycle against two baseline cycles;
persistent DB failure, other browsers and enabled2FA were not exercised. Scoped
implementation validation is complete, not a claim of upstream acceptance.
Candidate browser/project stopped after validation; images/volumes retained.
No commit, push or PR submitted.

### Error recovery UX closure — 2026-09-10

Final decision, superseding the two-button candidate above: use **Refresh only**.
The user inspected the candidate UI and approved replacing OK, not adding retry
policies. The final patch replaces local boundary reset with the same explicit
`window.location.reload()` already exercised in the candidate. It reuses the
existing translated `labels.refresh`; no dependency or server change is needed.

Reason: OK neither describes its action nor recovered the observed server-render
failure. Keeping two subtly different recovery actions requires users to understand
an implementation distinction. Local reset can recover a synthetic transient client
render failure (the earlier test demonstrated this), but the inspected application
did not establish a real flow requiring that cheaper recovery path. This is a UX
trade-off, not proof that reset is always useless: Refresh always repeats document
requests and clears in-memory client state, even when local reset might suffice.
The global fallback already unmounts its child subtree; preserving an unsaved form
with the former OK action was not established. Persistent faults can still recur.

Classification: **error-recovery UX improvement**, discovered through a local
reliability experiment. Not DB availability, connection-capacity or incident-response
improvement; not a featured DevOps achievement by itself. The two-button image and
its observations above remain historical evidence, not validation of the final UI.
The owning patches are [product](../patches/error-boundary-refresh.patch) and
[focused test](../patches/error-boundary-refresh-test.patch). Product base is v3.3.1
`ca661c7057984aa98ed4f7083d84dae2f65bfcb0`; test harness is the inspected dev
`1d7874b7d946e9d8e9b257a051fa0789ddd32728` checkout. Apply with `git apply --check`
first. The unrelated session-query patch is not included.

Final verification: the revised test failed against two buttons, then passed with
one. Main reran the focused Vitest test (1 passed) and changed-file Biome check
(2 files, no fixes). Both product/test patches pass reverse-apply checks against
their respective modified source files; a malformed product hunk count discovered
during review was corrected before publishing. No full test-suite claim.

Rebuilt the existing v3.3.1 source with Docker cache (exit0), applying only the final
product change. Running image ID:
`sha256:1f59f5c25db54a90be0e4232c4e98b7e118624c71bfbbc74cc2a99618c09c2db`.
Build skips application type validation per upstream build settings; successful
build is not presented as a full type-check. In the in-app browser, main repeated
one cycle: website list → stop isolated DB → click Upgrade fixture → React441 with
only Refresh → restart DB and confirm pg_isready → click Refresh → website heading,
Pages and synthetic stats visible (1 visitor, 1 visit, 4 views). No intervening manual
reload. This is a final single-button runtime check, separate from the historical
two-button cycle. Tool-returned DOM snapshots establish the observation; no saved
screenshot or public raw-log artifact is claimed.

User authorized closure in the personal lab repository only: preserve this record
and both patches, with a small portfolio-index entry. No upstream PR/comment or
production deployment. Local DB backups, raw logs and Compose files stay ignored.
After the check, stopped only the isolated app/DB and closed the test tab; retained
images, volumes and backups. No unrelated service or source checkout was removed.

### Deployment acceptance boundary — 2026-09-10

Question: does our existing deployment success check establish that analytics can
be collected and read? Read the pinned v3.3.1 source, not live upstream HEAD.
`src/app/api/heartbeat/route.ts` unconditionally returns `{ok:true}`; neither DB nor
collection is exercised. Official Compose calls that route; our isolated Compose
uses `curl --fail` on it. Startup `scripts/start-docker.sh` runs check-db/migrations
before starting the server, but that one-time check is not continuing verification.
This separation can be appropriate for liveness; do not label it a product bug.

Direct local observation using the final recovery-UX image above and the existing
synthetic fixture: authenticated `/api/websites` and heartbeat both returned200.
After stopping only DB, heartbeat still returned200/`{ok:true}`, while the same
authenticated websites request returned500. A finally block restarted DB;
pg_isready confirmed accepting connections. Then stopped the scoped project again.
No events were inserted, migrations changed, or public endpoints faulted. This
demonstrates a read-availability gap in using heartbeat as acceptance, NOT a
collection-only failure, failed-release reproduction, or production frequency.

Luna inspected existing checks; main confirmed CI and Playwright configuration.
Pinned `.github/workflows/ci.yml` runs install, Vitest and build with SKIP_DB_CHECK=1;
it does not run Playwright. `playwright.config.ts` selects tests/e2e and defaults to
pnpm dev, with optional external server configuration. Send unit tests mock saveEvent;
these checks do not prove persistence in a deployed image. Do not generalize this
to all Umami installations or undisclosed upstream checks.

Our earlier upgrade fixture already verified send → stats plus persisted DB rows
manually. Reuse that contract rather than create a new framework. Next bounded
improvement: a manually invoked deployment acceptance check on a dedicated synthetic
site, sending one uniquely identifiable event and requiring its queried count,
with bounded timeout and failure exit status. Keep it separate from liveness and
normal customer data. Direct API coverage would not prove browser tracker loading,
CSP/CORS behavior or the full UI; those must remain explicit limitations.
No new script, CI, scheduled monitoring, rollback automation, commit or push in
this qualification step. Reusing the known DB-stop fault established the check's
scope only; it is not a second portfolio incident.

Manual checker implementation (approved scope): use Node's existing fetch/assert
facilities, not a new monitoring stack. The checker owns one send, scoped by a fresh
UUID URL. Require a zero-count baseline and exactly one pageview on the same filtered
stats query after sending. A 200/no-op send is not success. Stop within30 seconds;
do not retry writes or silently delete their evidence. Use a dedicated synthetic
site with domain `deployment-smoke.invalid`, and initially accept only loopback HTTP
origins with redirects disabled. Credentials come from environment and are not logged.
This deliberately remains a local deployment-acceptance rehearsal, not a remote
production deployment tool. Implementation/test files are `scripts/deployment-smoke.mjs`
and `scripts/deployment-smoke.test.mjs`; main checks real deployed-image behavior
after Luna's bounded implementation. No commit/push authorized for this step.

Run on the disposable local deployment (Node22+; existing synthetic admin only):

```sh
UMAMI_BASE_URL=http://127.0.0.1:3011 \
UMAMI_WEBSITE_ID=2eb11d63-cef9-4bd6-a619-281392517a78 \
UMAMI_USERNAME=admin UMAMI_PASSWORD=umami \
node scripts/deployment-smoke.mjs

node --test scripts/deployment-smoke.test.mjs
```

The UUID belongs only to this retained local fixture, not a portable seeded account.
On another disposable instance first create a website with domain
`deployment-smoke.invalid`, then supply its ID and that instance's credentials.
The example password is the local synthetic default, never a production suggestion.
Do not put real credentials in shell history; this initial tool is loopback-only.
The app must already be running; the checker does not build, deploy, create sites,
or manipulate Docker. A run leaves one pageview if sending succeeded, including when
later verification fails. Re-running uses a fresh UUID, not a write retry.

Verification — 2026-09-10: main reviewed the first implementation and found its
query end time preceded the send, excluding the newly created event. The original
test fixture ignored time/path filtering and missed this bug. Revised fixture
filters both, and the checker uses one shared30s deadline across login, validation,
send and polling (each request at most10s and capped by remaining time). No guarantee
is made across host/server clock skew; this is a same-host local check.

Main reran `node --test scripts/deployment-smoke.test.mjs`:5 passed. Tests cover
one scoped send/read, HTTP200 without storage failing, unsafe target rejection before
network use, CLI success output, and CLI failure without credential disclosure. A
simulated HTTP server establishes checker behavior, not an actual Umami outage.

Real deployed-image results, on the same final v3.3.1 recovery-UX image retained above:
- Healthy: exit0; marker `/deployment-smoke/99d3a940-9af1-4ef7-8566-ca8274284f56`,
  pageviews1.
- DB stopped: heartbeat200, checker exit1, empty stdout, `stage=login status=500`.
  This fails before send; it is not evidence of a real collection-only outage.
- DB restored: exit0; marker `/deployment-smoke/7f192258-4054-4e43-af3a-69385ac0cdc4`,
  pageviews1. Independent SQL confirmed2 total rows/2 unique marker paths in the
  dedicated site. Both are synthetic pageviews retained as evidence.

The test proves API collection/read acceptance for this fixture, not tracker/CORS,
UI rendering, remote infrastructure, all application features or deployment rollback.
No upstream product change or heartbeat replacement. The manual checker is ready
for subsequent local deployments; no CI/scheduler integration was added. Scoped
app/DB stopped, volumes retained. `git diff --check` passes. Changes remain uncommitted.

Deployment rehearsal — 2026-09-10: used two already-local3.3.1 images, not a new
schema version or a remote release. First booted the pinned official image
`sha256:fa32d116cf20cad52cbc3fad9a63b46e7fa02299d8f967168eb453d49c476b4a`
with upgrade-target.yml and --pull never. Verified actual image, then checker exit0
with marker `945c9998-9307-4d71-b7b4-c06caae7c394`, pageviews1.

Then replaced ONLY app using the following command; waited for exit0, verified
actual running image matched the recorded candidate digest, and ran the checker
with the synthetic environment documented above. Do not mark acceptance on Compose
health alone. Stop on any failed step; no automatic rollback is implied.

```sh
docker compose -f .local/upgrade-compose.yml -f .local/recovery-candidate.yml \
  up -d --no-deps --pull never --wait --wait-timeout 60 app
docker inspect umami-upgrade-check-app-1 --format '{{.Image}}'
# Compare to the expected immutable image ID before running deployment-smoke.mjs.
```

Actual candidate image was `sha256:1f59f5c25db54a90be0e4232c4e98b7e118624c71bfbbc74cc2a99618c09c2db`;
checker exit0 with marker `95b41b90-3f8d-4ccd-ae73-e78b12baf01b`, pageviews1.
DB container ID `f88b53f8eb4f79244b9bbee1a5c833c71f9f7646f8479a0d1c853f5561b242a0`,
creation time and volume `umami-upgrade-check_upgrade-data` remained identical.
Before/after migration count24, unfinished0. Dedicated site now has4 rows/4 unique
paths (two prior checks plus these two); no whole-database equivalence claim.

Outcome: the manual acceptance procedure worked after an actual image replacement.
No deployment defect, rollback, measured reduction in operator errors, zero-downtime
guarantee or production benefit was established. Existing commands plus one checker
suffice for now; no deployment wrapper, CI or monitoring was justified by this run.
Stopped only test app/DB afterward; images, volumes and synthetic records retained.
No additional code, commit, push or upstream action in this rehearsal.

Closure — 2026-09-11: user reported `docker system prune -a --volumes` and reboot.
The Docker socket is currently unavailable; image/container/volume survival is
unknown, not confirmed deletion or retention. The older pre-upgrade dump still
matches SHA256 `41ec2b97da7e00999ae76ad157003f4be98a522464a98a14453bc62b4fd2e942`;
it predates the deployment-smoke site and cannot restore that fixture. Recheck
runtime resources before reusing the historical IDs/commands above. No rebuild or
restore was needed for closure. Fresh Docker-independent tests:5 passed, diff check
clean. User requested resuming personal-repository commit/push cleanup; only the
checker, its tests, README link and this record are included, no raw data or backup.
