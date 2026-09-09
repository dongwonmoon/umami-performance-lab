# Visitor-list count ordering optimization

Closed bounded local case: preserve visitor-list results while removing ordering
from capped count work. Submitted as [PR #4523](https://github.com/umami-software/umami/pull/4523)
on 2026-09-08; not merged or deployed as part of this work.

- Sequential 181d API: 931.3 → 550.2ms; DB CPU/request: 919.34 → 530.51ms.
- Four concurrent requests: 909.8 → 535.8ms completion; CPU/request: 855.20 → 490.50ms.
- Short-range improvement is not established. One fixed synthetic dataset only.
- [Public measurement samples](../evidence/2026-09-08/visitor-comparison.json)
- [Source and regression-test patch](../patches/visitor-count-order.patch)

Reliability boundary: no new shared state, caching, writes or query parallelism
was introduced. Count and page remain separate sequential reads; data arriving
between them can still produce different snapshots, as before. Concurrent writes
and universal race-freedom were not tested or claimed. The agreed validation is
complete; further optimization and upstream submission are separate decisions.

## Visitor-list capped count qualification — 2026-09-08

**Next candidate, not implemented.** Main traced the existing visitor-list UI
through `useWebsiteSessionsQuery`, sessions API, `getWebsiteSessions` and
`prisma.pagedRawQuery`. The UI requests maxResults=10000; the pager consumes count
and isCapped. Counting is necessary for that UI contract, but ordering the rows
being counted may not be. The shared helper wraps the complete caller SQL for
counting; the visitor query includes `ORDER BY max(website_event.created_at) DESC`.
That sort remains inside the capped-count subquery even though only its count
is returned. The data-page query is a separate, sequential query and needs its
own ordering retained.

Read-only probe captured the actual generated visitor SQL/params at the
pagedRawQuery boundary. It reconstructed the helper's exact count wrapper and
compared removal of **only this caller's final ORDER BY in the count path**.
No production SQL/helper/UI was edited; no regex-based general-purpose SQL
rewriter is proposed. Source/helper files were checked unmodified against HEAD.
Input: original fixed synthetic DB/site, inclusive UTC end 2026-09-06 15:00,
7/30/181 days, first page, no additional filters. The transient probe is local
`.local/visitor-count-probe.ts`; initial SQL/params/plans are in
`.local/visitor-count-probe-1788837716782.json` (ignored).

Initial counts matched: 3403 for 7 days, capped 10000 for 30 and 181 days.
At 181 days the original plan processed 91,225 groups and 262,196 event rows,
sorted them and returned a count of 10000. Without count-ordering it emitted
10,000 groups and consumed about 28,821 rows at the incremental-sort boundary
before stopping (28,831 at its underlying join). This is plan-specific early
termination, not a promise that every dataset can stop early. PostgreSQL already
pruned some unused aggregates in the count query: do not claim every displayed
statistic is calculated twice without inspecting the plan.

Six alternating-order EXPLAIN ANALYZE pairs for the 181-day **count query only**:

- Original ms: 485.596, 551.318, 563.605, 551.228, 511.741, 533.677.
- Without count ORDER BY ms: 57.151, 62.455, 52.055, 55.725, 55.618, 55.055.
- Medians: 542.4525 → 55.6715ms (~89.7% lower), with matching capped count 10000.
- Original wrote 1432 temporary blocks in every recorded pair; alternative zero.
- Initial data-page query alone was ~567ms. Removing count work does not remove
  page-query cost, so the ~90% count saving is **not a whole-API speedup claim**.

One authenticated request to the existing official app's sessions API exercised
the real UI-style range/page/maxResults parameters: HTTP 200, 993.1ms including
JSON decode, count=10000, isCapped=true, page=1, pageSize=20, twenty rows.
This is a single baseline qualification, not an API A/B benchmark.

Luna traced the cap to
[fbac751](https://github.com/umami-software/umami/commit/fbac7518fc35c608a58fe7d55efaa17bba831417),
whose message explicitly says performance improvements. Main verified the patch:
it adds MAX_PAGING_RESULTS to the visitor hook and the capped count wrapper.
No measured performance rationale for the value 10000 was established. The
candidate preserves that cap; it does not remove the pager or change the
meaning of the reported count.

**Decision:** worth a bounded next experiment. Check empty/under-cap/over-cap
and filtered inputs, preserve actual list ordering and paging, inspect other
helper callers before choosing a narrow implementation. Then measure API and
DB CPU; do not equate a count-only EXPLAIN probe with product improvement.
No performance patch, long benchmark, build, commit or upstream proposal was
made during this qualification.

### Compatibility review, stage 1 — 2026-09-08

Read-only source review; no production change or new performance measurement.
Luna traced the visitor API/UI contract; main checked the request parser, query,
helper and all five PostgreSQL caller bodies.

- `getWebsiteSessions` has one source caller, the sessions GET route. Its schema
  includes paging/search/filter parameters, not `sortingParams`; `parseRequest`
  uses parsed data, so ordinary client orderBy/sortDescending are stripped.
  The current visitor ordering is fixed, not user-selectable through this API.
- The helper already appends page-only ordering, but also returns its orderBy
  input as response metadata. Injecting a default into filters would therefore
  add metadata currently omitted in JSON. Reusing this mechanism is a candidate,
  not yet a proven drop-in replacement. Do not enable client sorting as part of
  the performance change; its SQL interpolation would require allow-listing.
- Other PostgreSQL callers are revenue sessions, session replays, event-property
  pivot and session-property pivot. All contain final display ordering; their
  performance has not been measured here. Internal array/window ordering must
  remain, especially latest-property selection by row_number. No regex stripping.
- Visitor grouping includes hostname as well as session identity. Do not replace
  the count with a distinct session-ID count: that would change semantics.
- Ties in latest event time have no explicit secondary key. Preserve the existing
  sort expression; do not silently add a tie-breaker. Compare tied boundary rows
  separately if actual page results differ. Count/data remain separate sequential
  reads; this work does not add snapshot consistency or concurrency guarantees.

Next stage: a local compatibility check with fixed inputs (empty, below/at/above
cap, cap omitted, filters/search, multiple pages, timestamp ties and multi-host
sessions), checking count/isCapped, complete rows and response metadata before
any API timing comparison. Prefer retaining identical page SQL and making only
the count path unordered; choose the smallest implementation after this check.

### SQL compatibility qualification, stage 2 — 2026-09-08

Main reviewed Luna's `scripts/visitor-count-check.ts`, replaced its handwritten
fixture query with the **actual captured visitor query** over VALUES CTEs, and
ran it against the disposable local PostgreSQL DB. No tables/data were written.
Command (qualification checkout and existing fixed DB required):

```sh
DATABASE_URL=postgres://umami:umami@127.0.0.1:5433/umami \
  /private/tmp/umami-qualification/node_modules/.bin/tsx \
  --tsconfig /private/tmp/umami-qualification/tsconfig.json \
  scripts/visitor-count-check.ts
```

Output: ignored `.local/visitor-count-check-2026-09-08T034504402Z.json`,
status complete, exit 0. Ten live cases matched ordered/unordered counts and
the original helper's response against a reconstruction with unchanged page
SQL: empty (0), 7d (3403), 181d (91225), cap 3402/3403/3404, search (2018),
browser (1990), hostname (3403), page 2. The hostname case did not narrow this
dataset; it establishes no selective-filter coverage by itself.

The hand-derived CTE has one session, three events, two hostname groups sharing
the same latest timestamp. Actual visitor SQL returned two groups (not one),
with views/visits 2/2 and 1/1. Counts matched with cap 1/2/3 and capped flags
true/true/false. No secondary timestamp ordering was introduced.

Limitations: the candidate count SQL is reconstructed outside the helper;
metadata/page equality is **not validation of an implemented patch**. No HTTP
A/B, all-sibling behavior test, concurrent-write test or new timing claim.
Both upstream production files remain unmodified. The SQL equivalence evidence
supports proceeding to a minimal implementation with its own focused regression
check; API response preservation must then be tested on that actual implementation.

### Actual patch compatibility, stage 3 — 2026-09-08

Implemented only in clean pinned archive `/private/tmp/umami-visitor-compat.bP8LG8`,
not in the running qualification checkout. Preserved as
`patches/visitor-count-order.patch` (two production files, existing test file).
The helper accepts an optional fifth `defaultOrderBy` SQL expression for page
ordering only. The visitor caller supplies its existing fixed timestamp order.
Count wrapper, explicit sort handling and returned orderBy metadata stay intact;
four-argument callers and ClickHouse are unchanged. The new argument is trusted
source-owned SQL, not a new request parameter. No client sorting feature added.

Luna reported the default-order test failing before implementation, then passing.
Main reviewed the diff, expanded coverage to uncapped defaults and page offset,
and ran `vitest run src/lib/prisma.test.ts src/lib/sort.test.ts`: **12 passed**
(two files). This is not the entire upstream suite or a typecheck/build.

`scripts/visitor-patch-check.ts` exercised **actual** getWebsiteSessions,
pagedRawQuery and PostgreSQL in separate baseline/candidate processes. It records
SQL at the DB boundary; fixture mode substitutes only table inputs via CTEs and
forwards all real helper arguments. Sixteen cases passed in both processes:
empty, 7d, below/at/above cap, 181d capped, search/browser/hostname, second page,
two-host tied-timestamp fixture, fixture caps 1/2/3, second/past-end fixture pages.
All complete JSON-serialized function results matched, including metadata and
rows. Page SQL matched after whitespace normalization; bound parameters matched.
Every candidate count query lacked the removed final ordering. This fixture's
ties matched; no general stable ordering guarantee is introduced.

Ignored outputs: `.local/visitor-patch-baseline.json` and
`.local/visitor-patch-candidate.json`. Run once per checkout with its own tsconfig:

```sh
DATABASE_URL=postgres://umami:umami@127.0.0.1:5433/umami \
  /private/tmp/umami-qualification/node_modules/.bin/tsx \
  --tsconfig /private/tmp/umami-visitor-compat.bP8LG8/tsconfig.json \
  scripts/visitor-patch-check.ts /private/tmp/umami-visitor-compat.bP8LG8 \
  .local/visitor-patch-candidate.json
/private/tmp/umami-qualification/node_modules/.bin/tsx scripts/visitor-patch-check.ts \
  --compare .local/visitor-patch-baseline.json .local/visitor-patch-candidate.json
```

For baseline use `/private/tmp/umami-qualification` for both root and tsconfig,
and the baseline output name. Local archive reuses installed node_modules and
generated Prisma client; no dependency installation was performed. Comparison
asserts actual response equality and absence of count sorting, not elapsed time.
`git apply --check` passed for the saved patch. Original production files remain
unmodified; no service replacement, commit, push or upstream submission.

**Decision:** compatible within this measured function/DB scope; proceed to
production-build HTTP comparison before claiming API improvement or full readiness.
Authentication/route integration, build/typecheck, concurrency and new performance
numbers remain unverified. Leave lengthy builds/measurements to the user.

### User-run production API preparation — 2026-09-08

Prepared `compose/visitor.yml`, `scripts/run-visitor-ab.sh` and
`scripts/visitor-api-ab.mjs`. Run from this lab:

```sh
bash scripts/run-visitor-ab.sh
```

Creates clean pinned baseline/candidate build archives, applies only the saved
visitor patch, builds sequentially and starts separate apps on localhost
3009/3010. Existing DB/app are not replaced; command `node server.js` skips
migrations. Authentication uses the disposable admin/umami account; tokens
remain in memory. This assumes the original fixed synthetic DB still exists.

Smoke checks all six API cases: empty, capped 7/30/181d, Chrome filter and page 2.
Full run repeats qualification, warms each measured variant/range, then measures
three paired rounds of three sequential requests per variant for capped 7/30/181d
(54 timed requests). Order alternates AB/BA/AB; this small qualification is not a
balanced large-sample performance conclusion. Every timed response must exactly
match its frozen baseline response; a mismatch fails the run and saves diagnostics
rather than accepting timestamp ties silently. Record app/DB image and resource
limits, per-request elapsed time and per-block DB CPU usage. Shared-DB CPU includes
other activity: keep other benchmarks and data ingestion idle during execution.

Preparation checks passed: Bash syntax, Node syntax, offline response-validator
checks and Compose config validation. **No builds, container start, HTTP smoke
or benchmark were executed here.** Results will be ignored
`.local/visitor-api-ab-*.json`; ask the user for the final complete/failed path.

### Production API results — 2026-09-08

User executed the prepared build/runner. Main inspected both JSONs and checked
HTTP status, error/validation fields, sample counts and CPU counters:

- Smoke `visitor-api-ab-2026-09-08T051241727Z.json`, SHA-256
  `cb5fc2dbef9a7107835dd61c3b4426d2cf735dcc1f7239c492ff9131e8e56c40`.
- Full `visitor-api-ab-2026-09-08T051245738Z.json`, SHA-256
  `4c0f871c7afbd4a36522bd9a74e612b910a932c9eba981a21a4456c81f014f6f`.
- Both complete. 84 report responses total: 12 smoke + 12 full qualification +
  6 warmup + 54 timed. All HTTP 200 with no validation errors. Twelve responses
  establish baseline oracles; the remaining 72 record successful exact JSON
  comparisons. Timed bodies are not stored, so offline inspection verifies the
  recorded validator outcomes rather than independently re-comparing those bodies.
- Distinct baseline/candidate image IDs have the expected pinned commit/variant
  labels. Both apps and the PG15 DB record unlimited container CPU (`max 100000`)
  and no explicit memory limit; host resources are still finite.

Each figure below is the median of three block values. Latency block value is
the median of three HTTP+JSON-decode request times; CPU block value is measured
DB cgroup CPU delta divided by three completed requests, expressed in ms.

| Range, cap 10000 | API baseline → candidate | DB CPU/request baseline → candidate |
|---|---:|---:|
| 7d | 74.9 → 72.2ms | 61.25 → 60.68ms |
| 30d | 140.5 → 135.2ms | 167.07 → 167.72ms |
| 181d | 931.3 → 550.2ms | 919.34 → 530.51ms |

181d improves latency ~40.9% (381.1ms) and DB CPU ~42.3%; all three paired
rounds improve both metrics. Candidate block median latency varies
527.3/697.4/550.2ms; one individual request reaches 810.2ms. Do not delete that
variation or assert its cause. 7/30d differences are small, and 30d representative
CPU is ~0.4% higher: no meaningful general short-range improvement claim.

Decision: positive production-build **local sequential** evidence, consistent
with removing count-only work while preserving the page query. Not a 90% API
improvement; not evidence of production traffic, p95, concurrency capacity,
browser UX, or all sibling features. Three AB/BA/AB pairs and shared DB CPU
remain limitations. No code change, rerun, merge, commit or upstream proposal
was made while interpreting these results.

### Bounded concurrent follow-up prepared — 2026-09-08

User approved only the existing 181d request under four concurrent requests.
`node scripts/visitor-api-ab.mjs --concurrent` reuses running comparison images;
no rebuild or resource tuning. It establishes one baseline oracle, checks the
candidate, warms both, then runs AB/BA/AB pairs of four simultaneous requests
per variant (24 timed + 4 qualification/warmup responses). Records per-block
wall time excluding Docker CPU-counter reads, request latency, completed count,
DB CPU and exact response validation; failed blocks have no CPU/request estimate.
It does not run the sequential matrix again or mix baseline and candidate load.

Offline syntax/validator checks pass, including a deferred-promise check that all
four requests start before any completes. Actual concurrent measurement remains
user-run. Keep other DB load idle. This is a four-request burst qualification,
not sustained concurrency, typical-usage prevalence or maximum-capacity evidence.

### Concurrent follow-up results — 2026-09-08

User-run `.local/visitor-api-ab-2026-09-08T052108526Z.json`, SHA-256
`44f69333da66a22f189513b0eb3ffc778c24282e0fe1f7d6902c71bfd87078b0`.
Main inspected the output: complete, no errors, all 24 timed responses HTTP 200
and marked exact-JSON-equal to the frozen baseline. Two qualification and two
warmup responses also succeeded (28 total). Same image IDs as the sequential run;
no explicit container CPU/memory caps. This is a four-request burst, not a queue
of four sequential requests or a sustained-load test.

| Paired round | Four-request completion, original → patch | DB CPU/request, original → patch |
|---|---:|---:|
| 1 | 909.8 → 535.8ms | 841.12 → 490.50ms |
| 2 | 897.0 → 515.4ms | 855.20 → 470.87ms |
| 3 | 976.9 → 653.0ms | 925.32 → 555.01ms |
| Median of three blocks | 909.8 → 535.8ms | 855.20 → 490.50ms |

Completion time decreases ~41.1%; per-request DB CPU ~42.6%. Both improve in
all three pairs, including the candidate's slower third block. Total CPU across
parallel workers can exceed wall time; these metrics are not interchangeable.
No new cause for timing variation is inferred from these counters.

Decision: the agreed concurrent regression check is positive. Together with
function/SQL compatibility and sequential HTTP evidence, sufficient to close
this bounded local case and preserve it; do not expand into another bottleneck
or capacity study. Limits remain: one fixed synthetic distribution, three paired
bursts, no production traffic or write overlap, and validator flags rather than
saved full timed response bodies. No upstream acceptance claim.

### Development-branch port check — 2026-09-08

The same narrow change was ported without changing the historical qualification
checkout, to
the live `dev` commit
`9fb7bacee62c34d6d05312d063a37c20d581de23` (current at preparation time). A
clean detached archive is retained at
`/private/tmp/umami-visitor-dev-9fb7bace`; the generated patch is
[`patches/visitor-count-order-dev.patch`](../patches/visitor-count-order-dev.patch).

The development branch already includes `max(website_event.created_at) desc,
session.session_id` for visitor pages. The port removes that ordering only from
the capped count wrapper and passes the complete expression as the trusted
page-only default. Focused regression tests retain the uncapped/capped,
explicit-order override and legacy no-order cases while checking both ordering
terms appear only on the page query, with unchanged count, cap, page offset and
omitted `orderBy` metadata. `git diff --check`, Biome formatting on the three
changed upstream files, and `vitest run src/lib/prisma.test.ts` passed (7 tests);
the local Biome check still reports unrelated pre-existing formatting in
`src/lib/prisma.ts`, which was left untouched to keep the port minimal.

No build, service start, database write, benchmark, commit, push or upstream
submission was performed. The test uses the qualification checkout's existing
dependencies and generated client only; it does not establish API or runtime
compatibility for the development branch.

### Development-branch pre-PR verification — 2026-09-08

Verification used the patched archive
`/private/tmp/umami-visitor-dev-9fb7bace` at the same dev SHA and a clean
unpatched archive at `/private/tmp/umami-visitor-dev-applycheck.lCKVZ3`.

- `pnpm exec vitest run src/lib/prisma.test.ts src/lib/sort.test.ts`: patched
  **12 passed**; clean **9 passed**. The three-test increase is the ported
  default-order coverage (uncapped/capped, explicit override and legacy
  no-order behavior).
- `pnpm exec biome lint` on the three changed files passed in both archives.
- Full `pnpm lint` failed identically in both archives: one existing error in
  `src/app/not-found.tsx`, 14 warnings, and a configuration-schema notice
  because the reused Biome CLI is 2.5.5 while the checkout schema is 2.3.6.
  This is baseline lint debt, not a diagnostic introduced by the port.
- The reused dependency tree is not a lockfile match: `pnpm` is 10.34.1 while
  the Dockerfile pins 11.21.0; requested/installed versions include Vitest
  `^4.1.11`/`4.1.10`, Biome `^2.5.11`/`2.5.5`, and tsx `^4.23.13`/`4.23.1`.
  The dev and qualification lockfiles also differ in several dependency
  ranges and workspace entries. The scratch test symlinks
  `node_modules` and `src/generated` to the qualification checkout; these
  symlinks are test-only and must not be used as a build artifact.

For the user-run clean install/build, use a separate checkout without the
test-only dependency symlinks. Pin pnpm to the upstream Dockerfile version.
`SKIP_DB_CHECK=1` skips both database connection checks and migrations;
the dummy URL is only for client generation. This verifies the build, not DB
migration or runtime compatibility. Do not use the historical Compose labels.

```sh
(
  set -eu
  set -o pipefail
  VISITOR_VERIFY_DIR=$(mktemp -d /private/tmp/umami-visitor-pr-check.XXXXXX)
  echo "Verification checkout: $VISITOR_VERIFY_DIR"
  git -C /private/tmp/umami-visitor-dev-9fb7bace archive 9fb7bacee62c34d6d05312d063a37c20d581de23 | tar -x -C "$VISITOR_VERIFY_DIR"
  cd "$VISITOR_VERIFY_DIR"
  git init -q
  git apply --check /Users/dongwon/workspace/umami-performance-lab/patches/visitor-count-order-dev.patch
  git apply /Users/dongwon/workspace/umami-performance-lab/patches/visitor-count-order-dev.patch
  export DATABASE_URL=postgresql://user:pass@127.0.0.1:1/dummy
  export SKIP_DB_CHECK=1
  npx --yes pnpm@11.21.0 install --frozen-lockfile
  npx --yes pnpm@11.21.0 build 2>&1 | tee build-verification.log
  npx --yes pnpm@11.21.0 exec vitest run src/lib/prisma.test.ts src/lib/sort.test.ts 2>&1 | tee tests-verification.log
  npx --yes pnpm@11.21.0 lint 2>&1 | tee lint-verification.log
)
```

At this preparation checkpoint, these commands had not been executed; the later
clean-verification section records the completed run. A build/install failure
stops the sequence and must be inspected before claiming readiness. If full
lint still fails, compare against the same clean revision and dependency set
without the patch before attributing it to upstream. No service is started.

Preparation correction: local cloning failed before installation because the
source is a promisor partial clone (`blob:none`) and upload-pack could not fetch
a missing object. This does not establish repository corruption. Exporting the
pinned tree with `git archive` succeeded; a fresh archive at
`/private/tmp/umami-visitor-pr-check.dOV9fg` was extracted and the dev patch
apply-check/application succeeded. No dependencies or build have been run there.
The command above now exports only the pinned tree instead of cloning history.

### Clean verification and upstream submission — 2026-09-08

User ran the isolated build at `/private/tmp/umami-visitor-pr-check.dOV9fg`.
Main inspected build/test/lint logs: build completed with DB checks/migrations
skipped and upstream type checking disabled; focused tests passed 12/12.
Changed-file lint passed with fresh Biome 2.5.11. Full lint reported 6 errors
and 14 warnings; the same binary on unpatched dev reproduced these totals.
Errors concern the unchanged not-found page and five SVG assets. These limits
are disclosed in the submitted body; no current-dev performance claim is made.

User authorized submission. Fork `dongwonmoon/umami`, branch
`codex/visitor-count-order`, commit `1ee36860`, targets upstream `dev` at
`9fb7bacee62c34d6d05312d063a37c20d581de23`.
[PR #4523](https://github.com/umami-software/umami/pull/4523) contains only
`src/lib/prisma.ts`, `src/lib/prisma.test.ts` and
`src/queries/sql/sessions/getWebsiteSessions.ts`. Submission is not acceptance.

Evidence-link correction: the original PR link referenced local-only `98c6fef`
and returned 404. Published only this case's eight evidence/reproduction files
on lab branch `evidence/visitor-count-order`, commit
`be6c814d72e0f4aea8475308a3fdefa383437b15`, and updated the PR body to that
public immutable link. GitHub contents API confirmed the document is accessible.
Unrelated local experiments and working-tree edits were not published in that
evidence-only commit. Subsequent lab main commits preserve the remaining records.

Supporting records: [pre-submission audit](upstream-contribution-check.md) and
[submitted PR text with archived checklist](visitor-count-order-pr-draft.md).
