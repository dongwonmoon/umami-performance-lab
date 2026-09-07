# Performance report: optimization trade-offs

## Outcome — closed as an experiment, 2026-09-07

Umami v3.3.1, pinned `ca661c7057984aa98ed4f7083d84dae2f65bfcb0`.
This is a secondary case study in optimization judgment, not a deployed
performance improvement. Both alternatives were implemented and measured;
neither was adopted globally or submitted upstream. Summary-cache separation
is not selected; parallel-only remains a conditional candidate.

The report recomputes an all-metric percentile summary when selecting a new
metric. We compared summary reuse with a smaller alternative: execute chart
and summary queries concurrently without changing the client or API contract.

| Local synthetic condition | Legacy full | Parallel only | Interpretation |
|---|---:|---:|---|
| Uncapped sequential, all metrics median | 283.3ms | 195.7ms | ~31% lower latency |
| DB 2-CPU quota, sequential median | 383.7ms | 309.3ms | ~19% lower latency |
| DB 2-CPU quota, 4 concurrent requests; median 8-request block completion | 2.88s | 3.17s | ~10% longer completion |
| DB 2-CPU quota, light writes + spaced reports; pooled report median | 398.0ms | 345.8ms | Directional benefit; only 10 reads per strategy |

Cache separation was fastest on uncached metric transitions (88.8ms versus
195.7ms parallel-only in the three-way run), but adds requests, cache/error
coordination and possible summary/detail freshness skew. Parallel-only keeps
the existing API and cache, but does not reduce SQL work; constrained concurrent
blocks used about 10% more DB CPU/request. Under light 2-events/s writes,
all 180 measured events persisted without skipped slots or observed write
degradation. These observations do not establish production reliability,
average installation size or a stable improvement percentage.

**Decision:** avoid a universal default change without a target operating
environment. Retain the candidate patches and evidence, add no configuration,
and stop expanding this experiment. Revisit if an actual deployment or
upstream requirement establishes the relevant resource/concurrency conditions.

## Portfolio wording

> Umami 성능 보고서의 반복 집계를 분석하고 캐시 분리·쿼리 병렬화를
> 구현·비교했다. 로컬 합성 데이터에서 병렬화로 순차 조회 지연을 약 31%
> 줄였지만, DB 2 CPU·동시 요청 4개에서는 전체 완료 시간이 약 10% 늘어
> 일괄 적용을 보류하고 적용 조건을 정리했다.

Do not describe this as production speedup, a merged upstream fix, or proven
CPU savings. Lead the portfolio with the completed
[funnel case](funnel-start-bound.md); this is supporting evidence of judgment.

## Artifacts and reproduction limits

- [Public measurement samples](../evidence/2026-09-07/performance-report-comparison.json):
  filtered synthetic measurements with hashes of local originals; no raw events,
  database, authentication tokens or complete logs.
- [Parallel-only patch](../patches/performance-parallel-only.patch) and
  [summary-cache experiment patch](../patches/performance-summary-cache.patch)
  are **alternative** patches against the same pinned commit, not stacked patches.
  Apply each to a separate clean checkout with `git apply --check` first.
  Upstream attribution: [MIT license](../third_party/umami-LICENSE).
- [Fixture/probe](../scripts/performance-summary-probe.mjs),
  [comparison](../scripts/performance-summary-ab.mjs),
  [ingestion overlap](../scripts/performance-ingestion-overlap.mjs),
  [quota wrapper](../scripts/run-performance-overlap.sh).
- [Disposable DB stack](../compose/ingestion.yml) is reused;
  [comparison apps](../compose/performance-summary.yml) share that DB.
  These contain only public dummy credentials and bind HTTP to localhost.

The DB is not published. Scripts assume the lab's existing synthetic website,
31,493 performance rows, dates and fixed PostgreSQL schema. A fresh clone is
**not** a one-command recreation of these numbers. Reconstruct your own frozen
seed before adapting those explicit guards; do not remove equality checks merely
to obtain a passing run. Temporary build directories below are historical paths,
not guaranteed to persist. No new builds or full benchmarks were run for closure.

On the prepared local stack, `node scripts/performance-summary-ab.mjs --parallel`
compares all three strategies; `--parallel-only` excludes cache separation.
`bash scripts/run-performance-overlap.sh` runs the approved light-write overlap
with verified quota cleanup. Read the script's preconditions first; do not use
the older `docker update --cpus 0` restoration recipe. Offline checks use
`--check`; they do not establish runtime performance.

## Chronological evidence

Historical preparation/pending statements below are superseded by the closure
decision above; they are retained to explain corrections and rejected assumptions.

### Performance summary qualification — 2026-09-07

Main selected conditions and reviewed/ran the bounded probe; Luna implemented
[the measurement script](../scripts/performance-summary-probe.mjs). Existing
seed code has no performance events. The separate ingestion DB received 31,493
deterministic type-5 rows, one per existing SaaS pageview in
`2026-08-08T00:00:00+09:00`–`2026-09-07T00:00:00+09:00` (exclusive end).
Dates, session/visit relationships, paths and titles are inherited; performance
values are invented bounded numbers with INP null every seventh row. This is a
report-query fixture, not a benchmark of collection or actual Web Vitals.
The page-lifecycle model is supported by tracker send-once/10-second/hide/SPA
flush behavior (`src/tracker/index.ts:593-625`), not an assertion that every
production page supplies these metrics.

Two runs each made one warm pass and one measured pass over LCP/INP/CLS/FCP/TTFB.
All 20 API reads passed summary equality, 31,493-row count and independent
summary-SQL checks. Each response contained 30 chart points, 13 paths, 13
titles, three devices and six browsers.

| Observation | First run | Second run |
|---|---|---|
| Measured API ms, LCP/INP/CLS/FCP/TTFB | 283.4 / 260.4 / 302.7 / 321.2 / 270.6 | 257.0 / 251.8 / 256.9 / 260.2 / 329.0 |
| Standalone summary EXPLAIN execution ms | 175.7 / 173.2 / 178.0 | 210.6 / 189.9 / 186.5 |

The summary plans used the created-at index, accepted 31,493 rows and filtered
42,782 others; all reported zero shared read blocks. Child scan timings were
34–45ms, with further work in the aggregate. This is not enough to attribute
all remaining time to sorting or to promise a particular caching speedup.
EXPLAIN instrumentation, separate connections, and parallel work within the API
mean standalone SQL time is **not** an additive API fraction. Metric order was
fixed; per-metric sample size is only two measured requests, not a percentile
benchmark or measured UI rendering time.

**Decision:** unlike the recorder qualification, this is worth a bounded
before/after experiment. The same all-metric summary is repeatedly computed at
a non-negligible cost in this fixture. Investigate reusing it for identical
website/date/filter conditions during metric switching, while retaining correct
refresh behavior. Do not add persistent aggregate tables or claim production
impact yet; compare actual full responses, not only standalone SQL. At this
qualification stage, upstream changes had not been implemented or proposed publicly.

Re-run (local disposable target is hard-coded):
`node scripts/performance-summary-probe.mjs --prepare` prepares idempotently
and measures; omit `--prepare` to measure existing rows. `--check` checks SQL
template resolution/safety without DB/network calls. Stored raw results:
`.local/performance-summary-probe-2026-09-07T020515992Z.json` and
`.local/performance-summary-probe-2026-09-07T020556573Z.json`.
The original qualification DB remains at 263,306 events and zero type-5 rows.

### Bounded implementation/comparison plan

Reuse the existing browser QueryClient's one-minute freshness policy, not a
server/global cache or persistent aggregates. Keep the legacy full performance
response as the default. Add validated optional `section=summary|details` to
request only the needed portion; permission checks remain before either branch.
On the client, a performance-specific hook observes separate detail and summary
queries; only the returned UI data is combined, not the cached result. Summary
keys include website, parent-supplied dates, timezone/unit and all effective
filters, but exclude the selected metric. On metric changes, `fetchQuery`
revalidates the summary if stale, even when that metric's details are cached.
Both requests run in parallel on a cache miss. Normal reload starts a fresh
QueryClient; existing report invalidation covers both caches. No new freshness
setting. Main rejected caching the combined result: a summary reused at second
59 could otherwise become fresh inside that result for almost another minute.

Tasks: (1) Luna implements the scoped route/query/schema/client change with
focused red/green boundary tests; (2) main reviews, preserves an attributed
patch and prepares comparison commands; (3) compare cold first load and warm
metric transitions with full-response equality plus date/filter/stale-cache
checks. A split first load costs a second authenticated request and must be
measured, not hidden. User runs any lengthy production build/benchmark. Stop
before claiming a win until that comparison exists. Keep prior funnel edits
untouched; the performance-only patch must not contain them.

### Implementation prepared — runtime comparison pending

The scoped change is preserved in `patches/performance-summary-cache.patch`,
against Umami `ca661c7057984aa98ed4f7083d84dae2f65bfcb0`; upstream attribution
and license remain in `third_party/umami-LICENSE`. No funnel/Compose changes
are included. Main independently reran the four focused Vitest files: 57 tests
passed. Luna also reported a successful `tsc --noEmit --pretty false`.
Tests cover section validation, PostgreSQL/ClickHouse query branches, route
composition, caller dates, filter scope, summary reuse, expiry and errors.
ClickHouse coverage is mocked, not a live database measurement.

The patch applied cleanly to an archive of the pinned commit at
`/private/tmp/umami-performance-build.nUW38R`. This temporary build directory
excludes previous funnel edits. From the lab root, run in order:

```sh
docker build -t umami-performance:summary /private/tmp/umami-performance-build.nUW38R
docker compose -f compose/performance-summary.yml up -d --wait
node scripts/performance-summary-ab.mjs
```

The Compose app uses port 3005 and the existing disposable ingestion DB;
it does not run migrations. The script compares legacy full responses with
split requests on the same patched production build, alternating strategy order
and checking complete response equality. Cold requests and summary-reuse
transitions are recorded separately. Raw results stay under ignored `.local/`.
This measures HTTP request strategy, not actual browser rendering or production
traffic. Production build, runtime comparison and browser verification remain
pending; no speedup or completed optimization is claimed. No public PR was posted.

### First production-build comparison — 2026-09-07

User-run artifact: `.local/performance-summary-ab-1788748724169.json`, status
`complete`, image `sha256:daf4f1e2e20659016a846053188b11b592bc5ef6ae74560a5ad37ac03ccf67af`.
Main inspected the result and script assertions. Excluding round 0 warmup:

| HTTP + decode latency, median | Legacy full | Split | Reduction | Samples per strategy |
|---|---:|---:|---:|---:|
| First metric, no summary reuse | 294.0ms | 206.2ms | 29.9% | 5 |
| Subsequent four metrics, summary reused | 272.4ms | 99.0ms | 63.6% | 20 |

All 60 logical results including warmup matched their full-response references.
Seven-day (7,203 observations) and Chrome-filtered (18,597) recompositions also
matched. No request/assertion failure was recorded. Subsequent-metric sample
ranges were 252.7–326.8ms full versus 87.4–119.0ms split; separation is not
attributable to a single outlier in this run.

The cold label means absent summary reuse, not a cold server/DB cache. Cold
improvement is consistent with parallel summary/detail work, not skipped
summary computation. Split requests add an authenticated request on first load;
concurrent-load/CPU impact was not measured. Same-image legacy versus split
comparison isolates request strategy; it is not an untouched-image A/B.
Metric order is fixed and sample size small. The script simulates reuse rather
than exercising the React hook; previously visited fresh metric details can
already be cached in the original UI. Therefore this supports faster first
transitions to other metrics within the freshness window, not every click.

Decision: promising measured improvement on this synthetic fixture, not a
completed UX/production claim. Next bounded check is actual browser request
reuse and correct refresh on date/filter changes and expiry; no new optimization
or larger stress fixture is justified yet.

### Trade-off review

The benefit targets opening additional metric tabs for the same scope while
the summary is fresh. It does not eliminate breakdown/chart queries, benefit
an already-cached metric return, or prove a benefit for a user who only opens
one metric. First-load gains may come from parallel execution alone; this run
does not compare against a smaller full-response parallelization-only patch.

Code-level query accounting (excluding auth/filter-resolution queries): full
responses execute six report queries; split cold loads still execute six,
across two requests, while summary reuse executes five. Thus five distinct
metrics within freshness use 26 rather than 30 report queries, not 64% fewer
queries. The expensive summary disappears on four transitions, explaining why
latency savings can exceed query-count savings. CPU savings remain unmeasured.

Costs: two authenticated first-load requests and duplicated scope resolution;
two independently failing queries; additional client/API maintenance; more
concurrent first-load work instead of chart-then-summary sequencing. Under
incoming data, a reused summary can predate freshly fetched details within the
freshness window. The original full response was not a transactional snapshot
either, but splitting expands possible temporal skew. One-minute staleTime is
eligibility for refetch, not periodic refresh or a strict screen-age limit.
Historical fixed data cannot establish live-data consistency. Browser request
checks and concurrency/CPU measurements must not be conflated.

### Bounded browser check — 2026-09-07

Luna drove headed Chrome on localhost:3005; main inspected saved snapshots and
sanitized evidence `.local/performance-browser-verification.json`. Fixed range
Aug 8–Sep 6 rendered 31.5k samples, with summary + LCP details returning 200.
Switch to INP requested only details (200). Return to LCP requested both again.
Snapshot times were 08:38:36, 08:39:28 and 08:39:56 UTC respectively. Main
corrected the agent's initial expiry interpretation: summary age runs from its
fetch, not INP selection. The roughly 80-second interval is consistent with
expected expiry, not evidence of inconsistent caching. Exact response times
were not preserved, so this is not a controlled expiry-boundary test.

Applying `/pricing` changed displayed sample size to 6.41k and the path table
to `/pricing`; main confirmed the snapshot. Scoped POST bodies and a rapid
return to an already-cached metric were not captured. External favicon 404s
were reported, but no report/API error was observed. Browser startup/cache
permission issues made this check longer than intended; stopped instead of
expanding it. Existing automated tests cover more exact cache boundaries, but
the missing browser checks remain explicitly unverified.

### Upstream history check — performance report rationale

Primary-source search covered the pinned report implementation's introducing
commit, its release PR, later performance-report commits, and the v3.1.0/v3.3.0
release discussions. The introducing commit describes end-to-end Web Vitals
tracking—dedicated table, percentile aggregation, collection, report APIs and
dashboard—but gives no rationale for recomputing the all-metric summary when
the selected metric changes: [introducing commit
`ce9e241`](https://github.com/umami-software/umami/commit/ce9e2416fbf8080cdfdff36ca92d48b559c9460d).

The implementation was merged as part of the broad v3.1.0 release PR #4162
(API reports 500 commits, no feature-specific body or discussion found), so that PR does not
provide design evidence: [PR #4162](https://github.com/umami-software/umami/pull/4162).
The follow-up checkpoint is titled only “performance updates checkpoint” and
the code change runs `getPerformance` plus four breakdowns concurrently while
the internal chart/summary work remains sequential: [commit
`f6a6d2c`](https://github.com/umami-software/umami/commit/f6a6d2cc317f1876173bb6fc8105378f93d18f50).
No public comment found in the searched commit/PR surfaces explains a cache or
freshness policy.

The v3.1.0 release discussion confirms Web Vitals tracking and the redesigned
Performance page, but only lists user-facing features; it does not discuss
query reuse, freshness, or selected-metric behavior: [Discussion
#4167](https://github.com/umami-software/umami/discussions/4167). Older upstream
performance discussions establish that large self-hosted reports have raised
scalability concerns, while maintainers mention ClickHouse for large datasets;
they do not establish this report's summary as a known defect: [Issue
#1253](https://github.com/umami-software/umami/issues/1253), [Discussion
#1926](https://github.com/umami-software/umami/discussions/1926).

**Conclusion:** upstream history supports “feature assembled with existing
report-query patterns; intent behind repeated summary work is undocumented.”
Freshness/simplicity remains a testable local hypothesis, not an upstream
design claim. Searched scope does not include private maintainer discussion or
unindexed chat; those sources were not accessible or checked.

### Approved next comparison: parallel-only alternative

Keep the original full-response API and client cache unchanged. In a clean
archive of the pinned source, start chart and summary SQL together and await
both using Promise.all (PostgreSQL and ClickHouse). Preserve SQL, normalization
and rejection behavior. Luna owns this query-only change and one focused
concurrency/result check; main owns comparison script, Compose and final review.
No existing upstream checkout changes are overwritten. User runs the build.
Compare legacy-full and split on port 3005 with parallel-only on port 3006,
using the same DB, fixed scopes, rotated strategy order and response equality.
First compare latency; a short concurrency-4 full-vs-parallel block plus DB
cgroup CPU deltas checks for a gross contention/cost regression, not capacity.
No adoption decision before results. No new server cache or feature flags.

Prepared: `patches/performance-parallel-only.patch` applies to pinned `ca661c7`
(same Umami attribution/license as the other patches). Only getPerformance and
its focused test change; UI/schema/route stay original. Main inspected the patch,
reran its two backend tests successfully and checked reverse application against
the prepared archive. Luna observed red before green. SQL text and response
normalization are unchanged; failures still reject, but already-started peer
queries are not cancelled by Promise.all. No live ClickHouse verification.

User commands from the lab root:

```sh
docker build -t umami-performance:parallel /private/tmp/umami-performance-parallel.2DHd67
docker compose -f compose/performance-summary.yml --profile comparison up -d --wait
node scripts/performance-summary-ab.mjs --parallel
```

The existing two-way script remains available without the flag. Three-way mode
uses one warmup plus six balanced-order rounds, checks the same fixed-response
references and seven-day/Chrome scopes, then runs three paired full/parallel
blocks of eight requests at concurrency four. DB CPU counters bracket blocks,
not individual SQL calls; keep browsers/other DB clients idle. The small sample
cannot establish tail latency or maximum throughput, and split is not included
in the contention block. Two images may introduce build-related confounding;
recorded image IDs and pinned source narrow but do not eliminate it. Script
syntax/self-check and Compose validation passed; build/live results pending.

### Three-way result — 2026-09-07

Main inspected user artifact `.local/performance-three-way-1788774725790.json`
(`complete`). Summary image remains `daf4f1e2…`; parallel image is
`d1bf4fe2420a866e21c34b9e4c71e8f485ddfea99f1e153b68970d78843c2bd7`.
After excluding warmup, median HTTP+decode latency:

| Strategy | First LCP, n=6 | Subsequent metrics, n=24 |
|---|---:|---:|
| Legacy full | 286.5ms | 283.1ms |
| Parallel only | 192.9ms | 195.7ms |
| Split / summary reuse | 209.0ms | 88.8ms |

All 105 logical responses including warmup, 48 concurrent responses, and
seven-day/Chrome scope comparisons passed the script's full-response equality
assertions. No request/assertion failure was recorded. This is static-fixture
equivalence, not a live-data consistency guarantee.

Concurrency-four full versus parallel, three eight-request blocks per strategy:
median of block median latency 348.9→267.8ms (about 23% lower); median block DB
CPU per request 600.8→633.5 CPU-ms (about 5.5% higher). Paired block CPU increases
were 3.9%, 5.5%, 1.3%, while median request latency decreased in every pair.
DB cgroup deltas include all DB activity and measurement-boundary overhead;
short blocks and no idle subtraction limit precision. CPU time sums across
cores, so it can exceed wall latency. Split CPU was not measured here.

Interpretation: the smaller change delivers about 31–33% lower serial latency
without adding API requests or independent summary-cache freshness. Split still
delivers an additional roughly 107ms reduction on uncached metric transitions;
parallel-only does not reproduce that benefit. Parallelism reduces waiting,
not the amount of SQL work, and this run does not establish resource savings.
Recommendation, not adoption: prefer parallel-only as the lower-complexity
candidate given current evidence; retain split as an experiment rather than
declaring it incorrect. The extra summary reuse is worthwhile only if its
freshness/maintenance trade-off is accepted. No new code changes or integration
performed in response to this measurement.

### Public self-hosted operating reports (bounded sample)

These are user-reported operating observations, not a representative survey
or controlled benchmark. They provide useful conditions and failure shapes:

- [Discussion #1926](https://github.com/umami-software/umami/discussions/1926)
  includes a PostgreSQL self-host with **1–2M pageviews/month**: the reporter
  says 7-day overview worked, 30-day reports mostly failed, and 90-day crashed.
  In the same thread, a user reports **19M `website_event` rows** and an
  initial dashboard over **2 minutes**; adding
  `(website_id, event_type, created_at, session_id, visit_id)` reportedly made
  it load in **under 2 seconds**. Version/hardware and controlled before/after
  details are incomplete for those comments, so treat them as operational
  clues, not causal proof. A maintainer separately states Cloud uses ClickHouse
  and self-hosted PostgreSQL/MySQL has known large-dataset performance issues.
- [Issue #1253](https://github.com/umami-software/umami/issues/1253) reports
  Umami 1.33.1 with PostgreSQL on a **4-core Linode VM**, about **12.1M
  pageviews, 2.7M events, and 1.2M sessions**; 7-day reports worked, longer
  ranges increasingly failed, and all-time could OOM-kill the Umami container.
  The report identifies query load and in-memory processing as hypotheses, not
  a confirmed root cause.
- [Discussion #2715](https://github.com/umami-software/umami/discussions/2715)
  gives a low-volume baseline: PostgreSQL self-host, about **500 events/day**,
  Umami around **100MB**, with a **256MB** container memory limit. No latency or
  report measurements were provided.

These reports distinguish workload and backend where stated (PostgreSQL in all
three; ClickHouse appears only as the maintainer's Cloud comparison). They do
not establish a threshold for the current v3.3.1 performance report, nor do
they measure metric switching, summary recomputation, CPU attribution, or
freshness behavior. Hardware, schema/index state, query ranges, and versions
vary substantially; direct local qualification remains necessary.

Official [hosting guidance](https://docs.umami.is/docs/guides/hosting) explicitly
describes single-server app+PostgreSQL, separate app/database hosts, and hosted
app+managed database. These are supported deployment patterns, not evidence
of their relative popularity. The [DigitalOcean guide](https://docs.umami.is/docs/guides/running-on-digitalocean)
suggests a low-cost personal server but still references Ubuntu 20.04/MySQL;
its price and sizing should not be treated as current v3 capacity guidance.
No representative distribution of operator count, report frequency, hardware
or ingestion rates was established by this bounded search.

Main read-only runtime check on 2026-09-07: Docker reports 10 CPUs and
12,601,012,224 bytes memory (~11.7GiB); DB and parallel-app containers have
NanoCpus=0, Memory=0 and CpuQuota=0 (no per-container limits). This describes
the environment now, not independently captured historical limits. The local
Compose places both report reads and event writes on the same PostgreSQL DB;
the pinned send route uses saveEvent, whose relational branch writes via
prisma.client.websiteEvent.create. Our benchmark is not a small-VPS simulation.

Recommended next condition, not yet run: retain existing evidence as a
resource-rich local baseline, then bound DB CPU availability (e.g. 2 CPUs as an
explicit sensitivity-test choice, not the average Umami installation) with
unchanged data and one-at-a-time reports. Determine whether the parallel-only
benefit survives before introducing simultaneous ingestion as a second variable.
Do not infer that low dashboard user count implies an idle database, or that
old scalability reports prove a defect in the v3 Performance report.

### CPU-limited comparison prepared

`node scripts/performance-summary-ab.mjs --parallel-only` compares only full
and parallel responses (including the existing short concurrency-four blocks),
and records inspected DB CPU/memory limits in its result. It does not alter
limits itself. Syntax and offline self-check passed; runtime remains user-run.
Temporarily set only `umami-ingestion-db-1` to `--cpus 2`, save/restore its prior
NanoCpus value with an EXIT trap, and keep data, memory and app limits unchanged.
Preflight found NanoCpus/CpuQuota/CpuPeriod all zero; refuse a changed legacy
quota/period setup instead of guessing restoration. Interrupt/TERM should exit
through cleanup; SIGKILL, host loss or Docker failure cannot guarantee cleanup.
This is CPU-quota sensitivity, not a two-core VM or average-installation model.

### 2-CPU result and cleanup correction — 2026-09-07

Artifact `.local/performance-parallel-ab-1788776063975.json` completed with
DB NanoCpus=2,000,000,000, no memory cap, and unchanged image IDs. Excluding
warmup, 30 sequential requests per strategy had median 383.7ms full versus
309.3ms parallel (19.4% lower). All 70 serial results including warmup, 48
concurrent results and the two scoped comparisons passed response assertions.

At concurrency four, median of three block median latencies was
1,380.5→1,393.6ms (essentially no improvement). Median eight-request completion
time was 2,882.3→3,168.2ms (9.9% higher); paired completion increases were
2.9%, 15.5%, 10.3%. Median block CPU/request was 712.1→783.9 CPU-ms (10.1%
higher). Each parallel block's slowest response was 1.83–2.03s versus
1.55–1.62s full; these maxima are not reliable tail percentiles. Small samples,
shared DB CPU accounting and synthetic fixed workload remain limitations.

Conclusion: the serial latency benefit persists under this quota, but it does
not carry through to four concurrent report requests. No ingestion was running
as part of this test. This is evidence of a workload/resource-dependent tradeoff,
not proof that ordinary operators encounter it or that parallelism is always bad.
Do not adopt globally based only on the uncapped latency result.

Cleanup correction: the supplied shell trap's `docker update --cpus 0` returned
success but retained NanoCpus=2e9 and cpu.max=200000/100000. Main reproduced this;
do not reuse that restoration recipe. `--cpu-quota -1` removed the effective
quota but left NanoCpus metadata. To restore original configuration exactly,
main recreated only the disposable DB service from its unchanged Compose file,
with --no-deps --force-recreate --pull never, retaining named volume
`umami-ingestion_db-data`. No raw data or volume was deleted.

### Approved ingestion-overlap preparation

Question: under the same DB 2-CPU quota, does one-at-a-time performance-report
reading delay or lose modest event writes? Reuse existing ingestion/probe
patterns, no app changes/builds. Write at fixed scheduled 500ms intervals,
single-flight, recording latency and scheduling lateness (not silently lowering
arrival rate). 30 events per block; initial/final write-only baselines sandwich
full/parallel/parallel/full blocks. Each mixed block reads LCP five times with
2s completion-to-next-read gap. Fixed historical report scope, new uniquely
tagged synthetic pageviews outside that scope; all report JSON must match and
tagged DB rows/paths must equal accepted writes. This adds a small known dataset,
not user traffic. Initial baseline must have no errors, response p95 <250ms and
no response taking >=500ms; otherwise stop as unsuitable offered load. Thresholds
are experiment headroom choices, not product SLOs. About 90s user-run plus setup.
Luna owns the new scripts/performance-ingestion-overlap.mjs and offline timing
check; main reviews safety/comparison and provides CPU quota/restoration commands.

Prepared runner: `bash scripts/run-performance-overlap.sh` (no build). Main
corrected two initial implementation errors before handoff: baseline must be
write-only (not read-only), and normal timer jitter must not move every following
arrival time. Fixed-grid scheduling records raw write latencies/lateness and
skipped slots; `offered_load_maintained` distinguishes successful delivery from
actually sustaining the chosen rate. Initial baseline persistence is also checked.
The previous NanoCpus restoration recipe is not reused: the runner requires
unlimited effective CPU and NanoCpus=0, applies quota200000, then restores quota
-1 and verifies cpu.max=max/100000. Metadata quota -1 is semantically unlimited,
not the original unset 0. Ordinary EXIT/INT/TERM cleanup is covered; SIGKILL or
Docker loss cannot be guaranteed. No container recreation is needed.

Main ran the tiny --smoke: `.local/performance-ingestion-overlap-2026-09-07T103653331Z.json`
completed with 12/12 measured pageviews persisted, four report responses equal,
no skipped slots, and effective quota restored. One additional warmup pageview
is intentionally stored per run. This validates instrumentation, not workload
performance. Full run stores 180 measured synthetic events plus one warmup,
outside the report time range. Leave all other clients idle during measurement.

### Ingestion-overlap result — 2026-09-07

Main inspected `.local/performance-ingestion-overlap-2026-09-07T103845492Z.json`:
complete, non-smoke, offered_load_maintained=true, DB cpu.max=200000/100000.
All 180 measured writes persisted with matching unique paths, site, event type
and timestamp; all 20 report responses matched. No errors/skipped slots;
maximum scheduling lateness 1.6ms. Target was one send every 500ms; reported
2.07/s reflects 30 sends starting at t=0 and ending near t=14.5s, not extra load.
Effective DB CPU was independently checked after the run: max/100000 restored.

| Phase | Writer p50 / p95 ms | Report median ms |
|---|---:|---:|
| Write-only before | 20.4 / 25.3 | — |
| Full 1 | 19.7 / 27.2 | 391.7 |
| Parallel 1 | 20.9 / 34.8 | 416.4 |
| Parallel 2 | 18.3 / 23.2 | 325.3 |
| Full 2 | 18.0 / 37.4 | 411.8 |
| Write-only after | 18.2 / 62.2 | — |

Pooled 10-report medians: full398.0ms, parallel345.8ms (~13.1% lower), but the
parallel block medians vary substantially; no claim of a stable 13% improvement.
Each mixed block has only 30 writes/five reads. Baseline-final p95 was higher
than mixed p95s; do not attribute minor writer differences to report strategy.
Mixed DB CPU totals were 3.679/3.419 CPU-s full and 3.673/3.352 parallel, including
writer and all other DB activity; this does not establish CPU savings.

Decision: under this bounded light-write, spaced-report workload, no observed
write degradation/loss accompanies parallel-only reports. This does not negate
the earlier concurrency-four regression. The writer reuses a session cache,
uses synthetic pageviews outside the historical performance-report range, and
does not exercise new-session-heavy traffic or fresh performance events. This
is shared-DB interference evidence, not live-summary consistency or general
production reliability. Enough to record a conditional optimization candidate;
do not add configuration or increase workload solely to force a stronger answer.
