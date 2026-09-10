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
