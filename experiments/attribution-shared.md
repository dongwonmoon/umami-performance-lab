# Attribution: share conversion and touchpoint computation

## Closure — 2026-09-09

Validated local candidate; further experiments paused at the user's request.
PR submission, push and deployment are explicitly deferred. This is a local
synthetic-data case study, not production evidence. The chronological notes
below retain each stage's historical decision; this closure is current status.

The PostgreSQL attribution report repeated its conversion/touchpoint CTEs
across seven dimension queries, plus a separate totals query. The candidate
shares those CTEs in one statement while preserving each dimension's grouping
and limits. No persistent cache or application-level parallelism was added.

30d shared-SQL prototype medians improved from 228.4 to 96.6ms (first-click)
and 217.4 to 90.2ms (last-click). Later source-port verification established
14 equal serialized reports and 9 passing focused tests, not new API timings.
The trade-off is SQL-side JSON assembly and shared CTE materialization;
production cardinality, peak memory, full build and browser behavior remain
unverified. Raw internal BigInt/Number differences are documented below.

## Reusing the patch

Base: Umami dev `9fb7bacee62c34d6d05312d063a37c20d581de23`.
On a disposable checkout with that revision's dependencies installed:

```sh
git apply --check /Users/dongwon/workspace/umami-performance-lab/patches/attribution-shared-dev.patch
git apply /Users/dongwon/workspace/umami-performance-lab/patches/attribution-shared-dev.patch
pnpm exec vitest run src/queries/sql/reports/getAttribution.test.ts
pnpm exec biome lint src/queries/sql/reports/getAttribution.ts src/queries/sql/reports/getAttribution.test.ts
```

Original DB and full local probe outputs remain ignored, not public artifacts.
These instructions reproduce the focused unit check, not historical benchmark
numbers. Revisit full build/API coverage and current upstream rules before
proposing a PR. Upstream patch licensing: [MIT attribution](../third_party/umami-LICENSE).

## Chronological evidence

### Attribution read-only qualification — 2026-09-08

The app/DB containers had been removed, but the preserved qualification volume
remained. Started only `db` using the existing PG15 Compose service and volume;
did not start the app or migrations. No other project's container was started.
Database reads used read-only transactions and timeouts. The report probe
asserted `default_transaction_read_only=on` and `statement_timeout=15s`.

Synthetic site `18573f23-3e24-44ef-b580-154cf371e7fe` still contains 262,196
events / 91,225 linked sessions, through 2026-09-06 14:57:45Z. `/signup`
has 27,294 pageviews over the full dataset; referrer/source/medium/campaign/
content are populated, while UTM term is empty. Thus the result is not an
empty-report benchmark, but does not represent all dimension cardinalities.

Called the real unmodified Attribution function from dev `9fb7bace`, using
fresh dev dependencies and the preserved DB. The scratch checkout also has the
visitor-count patch, which this function does not call. `getAttribution.ts`
differs from pinned `ca661c7` only by an explicit return type. No HTTP/API
latency or browser UX was measured. Parameters: path `/signup`, UTC, fixed
end 2026-09-06 15:00Z, 7/30 days, first/last-click, no filters. Each condition
had one warmup and three sequential timed calls, then separate EXPLAIN ANALYZE
for its eight queries. Full report outputs matched within each condition.

| Range/model | Timed function calls (ms) | Median (ms) |
|---|---|---:|
| 7d first-click | 69.4, 65.0, 60.6 | 65.0 |
| 7d last-click | 63.6, 65.0, 65.2 | 65.0 |
| 30d first-click | 239.3, 243.2, 242.7 | 242.7 |
| 30d last-click | 237.0, 238.4, 237.1 | 237.1 |

Six of seven dimension tables were nonempty in every condition. Target-page
totals were 1,022 for 7d and 4,515 for 30d; pageviews/visitors/visits coincide
for this fixture, so repeated conversions per session are not qualified here.

The 30d first-click UTM source EXPLAIN took 32.530ms overall. Its inclusive
model aggregate subtree took 25.116ms, outputting 4,515 sessions after joining
21,375 matching event rows; last-click equivalents were 31.613/24.174ms.
Do not add parent/child times or multiply them into an expected speedup.
Empty UTM term sometimes avoids work (7d first-click EXPLAIN 1.607ms), while
30d first-click still took 32.080ms: specialized plans matter.

Decision: repeated conversion/touchpoint computation has measurable cost in
this bounded input. A same-output shared-computation comparison on the 30d
case is worth proposing next; no optimization is implemented or adopted yet.
Preserve special filtering, blank values, tied timestamps and per-table limits;
do not make persistent caches or simply parallelize eight queries. One dataset,
three timed samples, no load overlap, restarted DB and sequential condition
order limit generalization. The function times are not end-user latency.

Local-only probe: `.local/attribution-observe.ts`; results, query timings and
plans: `.local/attribution-observation-1788850817547.json`. Both are ignored;
no raw event export, commit, push or new upstream PR was made. DB remains
running for a follow-up; original data was not modified by the probe.

### Shared-computation prototype — 2026-09-09

User approved a small comparison, not a production patch or another PR.
Prototype `.local/attribution-shared-ab.ts` replays the saved parameterized SQL
from the observation. Baseline runs eight statements sequentially; candidate
factors the identical events/model prefix into one statement, retaining the
seven original dimension bodies and the separate totals computation. JSON
assembly happens in PostgreSQL for the candidate. Thus the comparison changes
round trips and result assembly as well as shared computation, not solely CTE
evaluation. No persistent cache, application parallelism or DB writes.

Only 30d `/signup`, UTC, first/last-click, no filters were tested. PG15.19,
existing fixed synthetic DB, read-only and 15s statement timeout asserted.
Each condition: baseline qualification against historical full output, candidate
qualification, warmups for both, separate EXPLAIN runs, then three AB/BA/AB
pairs. Timings include SQL round trips, decoding/assembly and equality checks,
not HTTP or browser work. EXPLAINs ran before timed pairs and warmed caches.

| Model | Baseline samples ms | Candidate samples ms | Median before → after |
|---|---|---|---|
| first-click | 228.4, 237.4, 225.0 | 101.4, 94.3, 96.6 | 228.4 → 96.6 (~57.7% lower) |
| last-click | 214.8, 217.4, 242.8 | 90.9, 90.2, 90.1 | 217.4 → 90.2 (~58.5% lower) |

All 12 timed reports matched the respective baseline exactly, including array
order; no tie-only difference occurred. This fixture does not exercise a tied
top-20 cutoff in high-cardinality dimensions. Guard code separately checks
descending order and rejects membership/count differences; accepting sorted
arrays alone would not establish tie-only equivalence.

Candidate plans explicitly contain `CTE model`, executed once with 4,515 rows,
and seven CTE scans. First/last model aggregate inclusive times were
25.006/22.709ms; candidate statement execution was 106.881/95.739ms. Root
temporary read/write blocks were zero. This does not establish peak memory,
overall server CPU savings or behavior under concurrent load. Do not add
overlapping plan-node times.

An initial prototype run failed output validation: `json_agg(value)` resolved
to the numeric `value` column rather than the intended whole row. Fixed the
prototype to use an unambiguous alias and `row_to_json(item)` before measuring.
Failure evidence remains `.local/attribution-shared-ab-1788927061716.json`;
it was a prototype defect, not an upstream defect. Main also corrected the
qualification timing boundary and preserved full EXPLAIN trees before final run.

Successful evidence: `.local/attribution-shared-ab-1788927088862.json`, including
qualification outputs, candidate SQL, timed samples and complete plans.
Decision: worth further correctness/implementation review; not yet adopted.
Open limits include filters, empty reports, multiple conversions, equal-time
events/top-20 boundaries, larger/smaller ranges, memory and concurrent load.
A single statement also uses one statement snapshot rather than eight snapshots;
fixed read-only data does not measure concurrent-write behavior. Preserve this
result and stop here rather than turning a positive prototype into an immediate PR.

### Additional correctness/resource checks — 2026-09-09

The user approved further checks. These results validate the shared-SQL
prototype, not automatically an application-source port or browser behavior.

Read-only CTE-shadow fixtures exercised empty input, repeated conversions,
same-time events, inclusive date boundaries, null/blank labels, another website,
hostname filtering and 25 equal-count labels at the top-20 cutoff. Both models
passed all eight cases against baseline **and an independent JS oracle**.
The oracle checks counts, descending order and valid cutoff membership rather
than merely sorting away differences. Exact baseline/candidate equality also
held in all eight cases. The hostname condition was injected at SQL level;
this does not cover the application's complete filter parser.
Evidence: `.local/attribution-edge-check.ts` and
`.local/attribution-edge-1788927695623.json`.

Read-only resource probe used the same fixed DB, explicit `work_mem=4MB`,
warmups, three AB/BA/AB pairs per condition and separate full EXPLAINs.
30d runs issued four reports concurrently; 181d runs issued one at a time.
Wall times below are whole-burst medians, not per-request p95 or HTTP latency.

| Range / model | Concurrent reports | Wall ms before → after | DB CPU ms/report before → after |
|---|---:|---:|---:|
| 30d first-click | 4 | 299.5 → 139.9 | 290.9 → 140.6 |
| 30d last-click | 4 | 304.6 → 127.5 | 288.7 → 128.6 |
| 181d first-click | 1 | 1294.1 → 747.4 | 2589.0 → 970.3 |
| 181d last-click | 1 | 1091.9 → 620.3 | 2201.2 → 803.3 |

All timed outputs matched exactly. CPU is the DB container cgroup usage delta,
including measurement overhead; CPU can exceed wall time through parallel DB
work. Candidate EXPLAIN roots had zero temporary read/write blocks in all four
conditions. This is not a peak-memory measurement or proof against spills at
larger cardinalities. Three samples and one synthetic dataset do not establish
production concurrency limits. No concurrent ingestion was tested.
Evidence: `.local/attribution-resource-check.ts` and
`.local/attribution-resource-1788927755272.json`.

Decision: these checks strengthen the candidate; no observed resource trade-off
reversed the gain in tested conditions. Source maintainability and actual port
verification remain distinct from this SQL evidence. No cache, new setting,
commit, push or upstream submission is warranted by this check alone.

### Actual source port / review — 2026-09-09

User approved completing the remaining source verification. Luna implemented
the isolated dev `9fb7bacee62c34d6d05312d063a37c20d581de23` port in
`/private/tmp/umami-attribution-port`; main reviewed the full patch and ran the
independent real-function comparison. Preserved patch:
[`attribution-shared-dev.patch`](../patches/attribution-shared-dev.patch).
It changes one source file (56 insertions, 97 deletions) and its existing unit
test. ClickHouse is unchanged. Existing UTM query builder is reused; a fixed
seven-dimension list generates local CTEs and JSON fields. No SQL-text parsing,
new shared abstraction, dependency, cache, configuration or parallel execution.

Main compared the original and patched `getAttribution` functions through the
real Prisma filter parser and the route's `json` response serializer, on the
fixed read-only DB. Seven cases × first/last-click = **14 exact JSON matches**:
path, hostname, session-country, custom event, cohort, absent event property,
and absent conversion path. Verified eight DB calls before / one after for
each case. Path/hostname totals were 4,515; country/cohort 350; custom event
1,359; absent property/path zero. Hostname is not selective in this dataset;
country/cohort are. This is function/serializer coverage, not an HTTP auth or
browser end-to-end test. A populated property-filter case was not exercised.

Internal count values change from BigInt to Number because PostgreSQL returns
JSON. The sole non-test caller is the attribution API route, which immediately
serializes the result; existing `lib/db.ts` already converts BigInt to Number
for JSON. Thus tested API-shaped values are equal, but **raw JS return types
are not identical**. This change does not add a new public precision guarantee.
All user values still pass through existing parameter binding. Errors still
reject the report; no partial-success fallback or persistent state was added.
The single statement uses one snapshot rather than eight: no concurrent-write
test was run, and historical fixed-data equivalence does not prove equality
between requests made while data is changing.

Fresh main verification: attribution Vitest **9/9**, focused Biome lint clean,
and patch apply-check against clean dev archive passed. Original mock assertions
for eight calls and eight result rows were adapted to one result payload;
mock tests alone are not SQL correctness evidence. Read-only function check:
`.local/attribution-port-check.ts`, result
`.local/attribution-port-check-1788928078949.json`. No full build/typecheck or
new performance benchmark was run in this step; prior timing claims remain
shared-SQL prototype measurements, not timings of a deployed patch.

Review decision: no blocking correctness or maintainability issue found in
the tested scope. JSON assembly adds a small SQL responsibility but removes
seven repeated executions and reduces source length; the measured gain makes
that trade-off reasonable here. Keep the patch as a validated local candidate,
not an upstream-approved or production-proven change. Peak memory, production
cardinality and unspecified tie order remain limitations, not reasons to add
settings or caching. No commit, push, deployment or PR in this step.
