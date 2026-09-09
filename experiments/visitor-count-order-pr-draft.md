# PR submission text

Submitted 2026-09-08: https://github.com/umami-software/umami/pull/4523

Target: `umami-software/umami:dev`, prepared against
`9fb7bacee62c34d6d05312d063a37c20d581de23`.
Submission text finalized after the clean-install verification below.

## Title

perf(postgres): avoid sorting rows for visitor counts

## Body

### Summary

Move PostgreSQL visitor ordering to the data-page query so it is no longer
included in the count query. Preserve the existing timestamp/session-ID ordering,
pagination and count cap. Other callers retain their existing behavior;
ClickHouse is unchanged.

### Why

`pagedRawQuery` wraps the visitor query for counting, inheriting its `ORDER BY`.
In the observed PostgreSQL plan, this sorted matching visitor groups before
applying `maxResults`, preventing early termination even though the count does
not depend on their order.

An optional default-order argument keeps the visitor's full ordering expression
on the page query without including it in the shared count wrapper.

### Validation

- Regression tests cover capped/uncapped counts, page-only ordering, explicit
  ordering precedence and existing callers without a default.
- On the dev port with a fresh frozen-lockfile install:
  - `pnpm exec vitest run src/lib/prisma.test.ts src/lib/sort.test.ts`: 12 passed.
  - Changed-file Biome lint: passed.
  - `SKIP_DB_CHECK=1 pnpm build`: completed; database checks/migrations were
    skipped, and the upstream build configuration skips type checking.
  - Full `pnpm lint`: fails with 6 errors in unchanged files (the not-found
    page and SVG assets). Running the same Biome 2.5.11 on unpatched dev also
    reports 6 errors and 14 warnings. These are not introduced by this patch.
- Earlier A/B measurements on **v3.3.1 (`ca661c7`), not this dev revision** used
  a fixed synthetic PostgreSQL dataset. For a 181-day range, count-query median
  time decreased from approximately 542 to 56 ms; API time decreased from
  931 to 550 ms. Measured API responses matched. Shorter ranges did not show
  a meaningful API improvement.
- These results motivate the change; they are not production measurements or
  a speedup guarantee for current `dev` or other data distributions.

Historical methods, samples and limitations:
[visitor count experiment](https://github.com/dongwonmoon/umami-performance-lab/blob/be6c814d72e0f4aea8475308a3fdefa383437b15/experiments/visitor-count-order.md).

## Archived local preparation checklist (not part of the submitted body)

- [x] Patch applies to the recorded dev revision.
- [x] Focused helper tests passed with reused qualification dependencies.
- [x] Helper plus sorting tests: patched 12 passed, unpatched dev 9 passed.
  Changed-file lint passes. With the reused dependency set, full lint fails
  identically before and after the patch (existing `not-found.tsx` diagnostic).
- [x] Clean-install tests and changed-file lint verified; full lint baseline failure disclosed.
- [x] Isolated build completed; DB checks and type-checking exclusions disclosed.
- [x] Validation updated with final outcomes. No current-dev performance claim.
- [ ] Optional follow-up: portable SQL reproduction/current-dev runtime A/B;
  historical measurements are linked rather than represented as dev measurements.

No issue number is required. Do not invent a `Fixes` link or describe this
optimization as a production incident.
