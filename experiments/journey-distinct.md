# Journey: removing redundant PostgreSQL deduplication

## Outcome and scope

An independent local performance case study against Umami v3.3.1
(`ca661c7057984aa98ed4f7083d84dae2f65bfcb0`). One PostgreSQL SQL word,
`DISTINCT`, was removed; no algorithm, index, cache, concurrency setting,
ClickHouse query or product ordering policy was changed.

On the fixed synthetic DB, 181-day Journey API latency fell from 391.8 to
286.6ms and DB CPU/request from 387.3 to 274.6ms (medians of paired-block
statistics). Four concurrent requests also improved in the observed blocks.
This is measured local optimization, **not production deployment or upstream
acceptance**. The explicit compatibility limit is changed selection/order of
equal-count paths; do not claim all JSON responses stayed identical.

- [Experimental one-word patch](../patches/journey-distinct.patch)
- [Public measurement evidence](../evidence/2026-09-08/journey-comparison.json)
- [Query/fixture/oracle checker](../scripts/journey-distinct-check.ts)
- [API measurement and validator](../scripts/journey-api-ab.mjs)
- [User-run build wrapper](../scripts/run-journey-ab.sh), [Compose](../compose/journey.yml)

## Why the work was unnecessary

Journey turns a visit's chronological events into a path, counts matching
paths, then returns the top 100. The events CTE projects both `visit_id`
and `row_number() OVER (PARTITION BY visit_id ORDER BY created_at)`.
Within one visit the row numbers are unique; across visits the visit ID
differs. Therefore the projected pair already distinguishes every row,
even if page names or timestamps repeat. This reasoning concerns the outer
events DISTINCT only: cohort subqueries have their own meaningful deduplication.

The application requested DISTINCT. PostgreSQL chose the physical plan for
implementing it; sorting is not mandatory for every DISTINCT query. In the
observed long-range plan the Unique node consumed and returned 194,070 rows.
It removed none, yet sorting and temporary disk writes occurred. The alternative
plan avoided that work. Physical-plan side effects do not establish an
application-level ordering guarantee.

The developer's motivation is **unknown**. A defensive coding habit, an
oversight or an abandoned intermediate design are hypotheses only. The public
bootstrap commit already contained DISTINCT plus ROW_NUMBER and did not explain
why. Do not present a developer mistake or intent as established fact.

## What changed visibly, and what did not

Complete aggregate paths/counts matched in the exercised cases. However, only
`ORDER BY count DESC LIMIT 100` specifies selection. At the observed cutoff,
97 paths exceeded four occurrences and 13 paths tied at four occurrences for
the remaining three slots. Both variants returned valid top-100 selections,
but chose different tied paths. UI node counts/layout can therefore change.

Two different ties must not be conflated:

1. **Path count ties:** which equally frequent paths enter the top 100.
2. **Event timestamp ties:** which same-time event comes first within a visit.

The small fixture showed timestamp ambiguity already in the baseline when
physical input order was reversed; each same-input baseline/candidate pair
matched. That does not prove invariance for every possible planner/data state.
No deterministic tie-breaking rule was added merely to make exact JSON checks
pass. A stable-display requirement would be a separate product decision.

## Portfolio / possible future PR framing

A defensible summary: “Found a redundant deduplication step in an existing
analytics report, confirmed zero rows removed in the execution plan, and
validated reduced HTTP latency and DB CPU on controlled synthetic data.
Investigated and disclosed existing unspecified tie-selection behavior.”

Avoid “zero regressions,” “production traffic improved,” “all results exactly
unchanged,” “the author intended X,” or “upstream accepted this.” Short-range
savings were only 4–8ms, despite larger relative percentages. Keep this
distinction from the approximately 105ms long-range saving.

If proposing upstream later, recheck current code, contribution rules, existing
issues/PRs and the relevant test suite. Explain both tie behaviors explicitly;
offer deterministic ordering only as a separate, approved change. No submission
is authorized by this case-study closure.

## Closure and existing tests — 2026-09-08

Closed as a locally validated PostgreSQL optimization case, with the documented
tie-selection trade-off accepted for this case study. Preserve the one-word
experimental patch and evidence; do not replace the original application, post
upstream, add deterministic sorting, or extend into another benchmark implicitly.

Existing upstream tests were run on the clean **candidate archive**, using
installed dependencies from the external qualification checkout via a temporary
node_modules symlink. Three files, eight tests passed in 4.02 seconds:

```sh
cd /private/tmp/umami-journey-build.ICAYsU/candidate
/private/tmp/umami-qualification/node_modules/.bin/vitest run \
  'src/app/(main)/websites/[websiteId]/(reports)/journeys/JourneysPage.test.tsx' \
  src/components/input/WebsiteValueComboBox.test.tsx \
  src/permissions/report.test.ts
```

These cover UI request/selection behavior, value selection and report permission
mapping. They do **not** execute Journey SQL or establish performance. The full
upstream test suite was not run. SQL evidence comes from the actual query/fixture
checks and the production-build API experiment. Initial test startup without
the symlink failed resolving vitest/config (zero tests collected); after supplying
the existing dependencies the unchanged tests passed. The temporary symlink was
removed afterward; neither test source nor runtime settings were changed.

The public evidence file preserves original measurement blocks and sample
latencies/CPU, image/limit metadata, input hashes and qualification flags, but
not login tokens, DB contents or raw request logs. Full local outputs remain
ignored. Main independently checked the public blocks against the original
JSON and recomputed reported medians; the sanitized file is not a substitute
for the unavailable original synthetic DB. Fresh clones must create and freeze
their own synthetic input; historical commands depend on the noted local paths.

## Investigation timeline

## New qualification: redundant Journey deduplication — 2026-09-07

**Decision: investigate next, not adopt yet.** Main traced Journey UI → report
API → SQL. The UI offers all/views/events and a step count; this is an existing
visitor-path report, not a manufactured workload. In pinned
`src/queries/sql/reports/getJourney.ts:118-129`, PostgreSQL assigns
`row_number()` within each `visit_id`, then applies `DISTINCT` to a projection
that includes both visit ID and row number. Those two fields already distinguish
rows. This is a stronger redundancy hypothesis than merely observing a slow query.

Short read-only qualification used the original disposable qualification DB,
website `18573f23-3e24-44ef-b580-154cf371e7fe`, three steps, pageviews only,
no other filters, inclusive UTC bounds 2026-03-09 15:00 through 2026-09-06 15:00.
An inline Node/psql probe reproduced the query shape (events CTE, three CASE/MAX
step columns per visit, sequence counts, descending count, limit 100); the only
alternative was removing DISTINCT. It did not invoke the API or modify Umami.

Initial EXPLAIN ANALYZE showed 194,070 pageviews and 91,225 visit groups.
Original Unique consumed and returned 194,070 rows: no deduplication occurred.
The original plan wrote 1,688 temporary blocks including external merge sorts;
the alternative wrote zero. This first ordered pair was 633.378/307.178ms and
is not a reliable effect estimate because cache/order differed.

Six subsequent alternating-order pairs, PostgreSQL EXPLAIN execution time in ms:

- Original: 429.832, 402.368, 419.820, 422.484, 411.427, 428.719.
- Without DISTINCT: 278.326, 275.398, 283.705, 274.578, 271.097, 295.119.
- Medians: 421.152 → 276.862ms (about 34% lower); SQL qualification, not API UX.
- Both queries returned 13 identical row objects after ignoring tie ordering.
  The pageview fixture had zero duplicate `(visit_id, created_at)` groups.
- A one-pair seven-day probe was 18.729/9.920ms; insufficient repetitions for
  a short-range performance claim.

**Limitations / next check.** Query reconstructed from source rather than captured
from Prisma; no session/cohort filters, other step counts, all/custom-event mode,
timestamp ties, top-100 count ties, concurrency, or ClickHouse validation yet.
Changing plan can expose existing unspecified tie ordering. Preserve the full
response contract, including parseResult's adjacent-duplicate handling. Check
actual API queries and existing historical rationale before preparing a patch.
GitHub file history inspected this turn contains filter/cohort additions and SQL
syntax fixes; the reason for DISTINCT has not been established. Keyword issue
search is not exhaustive and does not establish absence of an existing fix.
No benchmark script, production patch, build, commit, or runtime reconfiguration
was made in this qualification.

**Reserve, not a second simultaneous experiment.** Luna traced visitor list and
detail flows. Main checked `getWebsiteSessions.ts:36-81` and
`src/lib/prisma.ts:784-817`: list count and page data run sequentially through
the shared paging helper, using the aggregate query. Count is capped at 10,000
and detail activity at 500 rows. This may repeat work, but planner pruning and
the required count semantics must be measured before calling it waste. Journey
has stronger evidence now, so defer this reserve. Export aggregates are already
capped; Journey browser processing has at most 100 returned sequences. Neither
code shape alone warrants another optimization.

### Actual query-boundary validation — 2026-09-08

Used [journey-distinct-check.ts](../scripts/journey-distinct-check.ts) to call the
unmodified pinned `getJourney`, actual `prisma.parseFilters`, original SQL
executor and original `parseResult`. Only the first DISTINCT immediately inside
`WITH events AS` was removed at the rawQuery boundary. Main independently checked
all ten captured pairs: parameter objects identical, no other SQL changes.
The baseline 7d/views/3 response also exactly matched HTTP 200 from the running
official app on port 3000 (JSON wire representation, including undefined→null).
This is not a patched HTTP/build comparison or a new performance benchmark.

Results on the unchanged synthetic DB:

| Conditions | Exact parsed response | Row multiset |
|---|---|---|
| 7d views, 3 and 7 steps | equal | equal |
| 7d events, 3 and 7 steps | ordering differs | equal |
| 7d all, 3 steps | ordering differs | equal |
| 7d all, 7 steps | differs | differs at top-100 boundary |
| 30d all, 3 steps | ordering differs | equal |
| 181d views, 3 steps | equal | equal |
| 7d views, Chrome session filter, 3 steps | equal | equal |
| 7d views, start `/`, end `/pricing`, 3 steps | equal (1 row) | equal |

**Do not describe this as ten passing equivalence tests.** Five exact comparisons
passed, nine multiset comparisons passed; the full diagnostic deliberately exits
1 and records the top-100 mismatch. All cases were nonempty. No SQL errors.

Main isolated the mismatch using the captured SQL and parameters. Removing only
the final `limit 100` from both variants returned 193 identical raw rows as a
multiset. There were 97 paths with count > 4 and 13 paths with count = 4. The
remaining three top-100 slots picked different count-4 paths. Adding the same
secondary `e1,e2,e3,e4,e5,e6,e7` ordering to both limited queries made their entire
raw responses equal. This diagnoses unspecified **count-tie selection**, not
changed counts or missing aggregate paths. It does not prove ordering of events
with identical timestamps: the fixture has zero `(visit_id, created_at)` ties.

**Decision:** redundancy remains supported, but do not claim exact compatibility
or ship a DISTINCT-only patch yet. A deterministic count-tie rule is a separate
observable behavior decision; if adopted, establish that baseline first and then
compare DISTINCT removal independently. Do not silently normalize away a changed
top-100 selection. Cohort filters, timestamp ties, ClickHouse, and patched API
performance remain unverified. No production source, DB contents, container
configuration, commit, or PR was changed.

History: Luna traced the original
[76cab03 bootstrap commit](https://github.com/umami-software/umami/commit/76cab03bb231632cfde4290ed578ab937326de45)
to 2024-05-17; main verified its patch contains DISTINCT and ROW_NUMBER together.
[PR #2758](https://github.com/umami-software/umami/pull/2758) is a 32-commit,
187-file merge with no body. No rationale for that combination was established;
absence of explanation is not proof of a mistake or proof of no existing fix.

Local output: `.local/journey-distinct-check-2026-09-08T022753017Z.json`.
It preserves SQL/params and both parsed results, stays Git-ignored, and has no
auth token. Earlier full run stopped at the mismatch; the final runner saves it
and continues the remaining cases before returning failure. Re-run locally:

```sh
DATABASE_URL=postgres://umami:umami@127.0.0.1:5433/umami \
  /private/tmp/umami-qualification/node_modules/.bin/tsx \
  --tsconfig /private/tmp/umami-qualification/tsconfig.json \
  scripts/journey-distinct-check.ts
```

These are disposable local credentials. `--smoke` runs just the first pair;
`--check` checks the rewrite/canonicalization without connecting to PostgreSQL.
The full run was short locally; no user-run build is needed at this stage.

### Tie behavior and UI consequences — 2026-09-08

The next approved question was whether tie handling must expand the optimization.
Added `--ties` to the existing checker, not to Umami. It shadows `website_event`
with a statement-local MATERIALIZED VALUES CTE: nine rows across three visits,
including different paths at the same timestamp, identical repeated paths,
and a null path. Crossed unique/tied timestamps, forward/reversed physical input,
and 3/7 steps: eight pairs. Every pair had exactly equal baseline/candidate parsed
results and retained all three visits. Reversing input preserved both unique-time
results; it changed both tied-time baseline results. Thus this fixture reproduces
the original unspecified timestamp ordering, not a DISTINCT-removal regression.
It is a small semantic check, not proof across all plans, data or ClickHouse.
No stored rows, tables or container settings were changed.

Final local artifact: `.local/journey-distinct-check-2026-09-08T023625503Z.json`.
Run the command above with `--ties`; exit 0 means the fixture checks passed, not
that the historical top-100 incompatibility disappeared.

UI facts checked by Luna and main in `Journey.tsx:59-149`: nodes are assembled
from returned paths, with totals and edges calculated from those paths. The
sort uses `firstBy('total', -1)` but nodes contain `totalCount`, not `total`.
Main checked the installed comparator with two such objects: it retained input
order. This is an adjacent potential defect, not changed here. No explicit stable
tie-order contract was found in the inspected caller/tests; absence of a contract
does not make visual differences irrelevant.

Main executed the actual extracted column-building callback (TypeScript
transpilation plus installed `thenby`, matching `objectToArray`) against the saved
responses. This is UI data-model execution, **not a browser visual test**:

- 7d events/3: despite differing response order, displayed node order and counts
  matched in this sample.
- 7d all/7: the three alternative count-4 paths changed several node counts,
  column 4 order, and column totals: 4th 944→940, 5th 460→456, 6th 197→193.
  These are totals over the selected paths, not evidence of lost stored events.

**Revised decision:** do not require a new sorting rule merely to make an exact
JSON assertion pass. Continue with DISTINCT-only as the next PostgreSQL A/B
candidate, not a shipped fix. The next check must separate deterministic cases
(exact equality) from tied cases (full aggregate equality and a valid count-ranked
top-100 selection). Keep visible tied-path differences explicit. Timestamp order,
deterministic count tie-breaking and the UI sort field are separate behaviors,
not bundled optimizations. If stable displayed paths are required for adoption,
revisit that requirement explicitly. No claim of universally identical output,
new API performance result, production source edit, commit or PR this turn.

### Prepared production-build comparison — 2026-09-08

This is preparation, **not an API performance result**. The experimental
[patch](../patches/journey-distinct.patch) removes only PostgreSQL's outer
DISTINCT. ClickHouse and both tie-order rules stay unchanged. Existing source
checkout edits are excluded: the build runner archives the pinned commit twice
and patches one archive. Main checked the two prepared trees differ only in
`getJourney.ts`; the patch applies cleanly. Original running apps stay intact.

[Compose](../compose/journey.yml) adds baseline/candidate apps on loopback
3007/3008 using the existing original qualification DB, equal environment and
startup without migrations. No new DB, quota change or replacement of the
previous performance-report containers. Both images use the same upstream
Dockerfile/dependency lock; actual image IDs and DB limits must be recorded at
measurement time. Docker dependency/base tags are not a permanent reproducibility
guarantee; this is a same-host paired build.

Preparation checks passed: Compose config, shell/Node syntax, clean patch
application, validator self-checks including cutoff/duplicate rejection, and
validation of all 20 previously captured responses against their complete
aggregates. A deliberately lower-ranked replacement was rejected. The runner
records the oracle SHA-256 and validates image labels/IDs before measurement.
No new-image HTTP smoke or Docker build has run yet.

The diagnostic's `--oracle` mode removes the final limit from **both** query
variants. All ten complete parsed row multisets matched in
`.local/journey-distinct-check-2026-09-08T024612210Z.json`. This is the fixed local
input for the API runner, not a portable production oracle. Current timestamp
ties are absent. Changed underlying data requires regenerating and reviewing it.

The API validator must preserve multiset multiplicity, accept only descending
top-100 counts from this full aggregate, and separately report exact equality.
It must not accept arbitrary lower-ranked replacements just because counts sum
to the same total. Cases without ties should retain exact responses; known
count ties can select different valid paths. This is not browser UX validation.

After qualification/warmup, measurement uses six alternating paired rounds,
five sequential requests per variant/case (7d views/3, 181d views/3, 7d all/7),
then three alternating paired blocks of four concurrent workers × two requests
for 181d views/3. Each block records DB CPU delta and each HTTP+decode latency.
Concurrent block completion time excludes the following CPU-counter command.
These short closed-loop blocks are not a capacity or production-traffic claim.

User-run build and measurement (keep other DB clients/dashboard tabs idle):

```sh
cd /Users/dongwon/workspace/umami-performance-lab
bash scripts/run-journey-ab.sh \
  .local/journey-distinct-check-2026-09-08T024612210Z.json
```

The runner retains fresh build directories under `/private/tmp` and both test
apps for inspection; it does not delete them or commit/push anything. Do not
run a second measurement concurrently. Long builds and measurements are left
to the user; the next result to inspect is `.local/journey-api-ab-*.json`.

### Production-build API result — 2026-09-08

User executed the wrapper. Main inspected both outputs, runner logic, oracle
hash, complete block counts/order and initial responses independently. No rerun
or runtime modification was needed for this interpretation.

- Smoke: `journey-api-ab-2026-09-08T025704702Z.json`, complete, 2 report responses.
- Full: `journey-api-ab-2026-09-08T025706457Z.json`, complete, SHA-256
  `d7b32aacc5c6f4a2e27389aadb14933527895ffd6697cd890d0124b2810887e8`.
- Oracle SHA-256 independently matched:
  `2497dff65bc90f6ed7bbdf831966e2b1d19dd1dd79720a3db763980016640a2e`.
- Baseline image `sha256:5ec5d7cf04846eb9b7b725b74df893503a31d8fad37eb7984e33c4f231792114`;
  candidate `sha256:f6bbd4c3c4b4e6fcb1e6b9ae3d647e9e121fab9764604cc61ca9761f3e5cb8ee`.
  Both carry the pinned upstream/variant labels. DB and both apps recorded
  `cpu.max = max 100000`, no container memory cap: **not a 2-CPU test**.
- Full run: 20 qualification + 6 warmup + 228 measured report responses, all
  HTTP 200 and valid against the complete aggregate oracle. This is 254 report
  responses, excluding login and separate smoke. Forty-two measured blocks.
  Timed response bodies are not retained except on failure; their validator
  results are recorded. Main revalidated the saved initial bodies independently.

Numbers below are medians of per-block medians (latency) and per-block
CPU-per-request (CPU milliseconds), excluding qualification/warmup:

| Sequential scope | API ms baseline → candidate | DB CPU ms/request baseline → candidate |
|---|---:|---:|
| 7d views / 3 steps | 26.35 → 22.40 (15.0% lower) | 16.30 → 12.06 (26.0% lower) |
| 7d all / 7 steps | 33.80 → 26.00 (23.1% lower) | 22.63 → 15.76 (30.4% lower) |
| 181d views / 3 steps | 391.80 → 286.60 (26.9% lower) | 387.33 → 274.56 (29.1% lower) |

Each row has six paired blocks, five requests per block (30 requests/variant).
All 18 individual paired blocks favored the candidate in both latency and CPU.
For four concurrent workers processing eight total 181d/3 requests, three
paired blocks favored the candidate in both measures: latency median of block
medians 421.30→316.45ms; eight-request completion median 854.1→654.9ms;
DB CPU/request 378.21→286.25ms. Do not translate this short closed-loop check
into production capacity or maximum throughput.

**Correctness qualification remains important.** Five of ten initial cases had
exactly equal baseline/candidate JSON; the other five involved known count ties.
All twenty initial outputs passed independent count-vector/multiset-subset
validation. Of 228 timed responses, 198 exactly matched the oracle's selected
top 100; all 228 passed valid-top-100 checks. This does not establish stable
displayed paths or universal exact response equality.

**Interpretation:** this local paired-build result supports the optimization:
it reduced database work rather than merely overlapping it. Short-range absolute
latency savings are only about 4–8ms; the long-range saving is about 105ms.
The sample is synthetic, one host/DB state, warm and without explicit CPU caps;
CPU counters include incidental DB work and do not prove production isolation.
No browser render, peak memory, concurrent ingestion, or ClickHouse improvement
is claimed. Keep the patch as a promising PostgreSQL optimization with explicit
tie-selection limitations, not an upstream-approved or deployed improvement.
