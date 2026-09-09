# Upstream contribution check — 2026-09-08

Historical pre-submission audit, not a statement of current upstream policy or PR status.
For subsequent verification and submission, see [the visitor case](visitor-count-order.md#clean-verification-and-upstream-submission--2026-09-08).

Scope: public `umami-software/umami` GitHub repository surfaces checked on
2026-09-08: current `master` contribution guide, issue templates, public
issues/PRs/discussions, and the current default-branch files. This is not a
maintainer-policy survey beyond those public sources.

## Explicit contribution rules

[`CONTRIBUTING.md`](https://github.com/umami-software/umami/blob/master/CONTRIBUTING.md)
requires PRs to target `dev`, remain focused on one logical change, include
what changed and why, link related issues, and pass `pnpm build` and
`pnpm lint`. It asks bug reports to include reproduction steps, expected vs.
actual behavior, and environment; feature requests should describe the use
case before the proposed solution. The issue templates expose bug-report and
feature-request forms, but neither contains an AI-specific disclosure or ban:
[`1.bug_report.yml`](https://github.com/umami-software/umami/blob/master/.github/ISSUE_TEMPLATE/1.bug_report.yml),
[`2.feature_request.yml`](https://github.com/umami-software/umami/blob/master/.github/ISSUE_TEMPLATE/2.feature_request.yml).

No explicit public Umami rule was found that bans AI-assisted contributions,
requires disclosure of AI use, or uses “AI slop” as a review category. No
maintainer statement explicitly expressing dislike of AI-generated PRs was
found in the limited public surfaces searched. This is absence of evidence in
scope, not proof that no private or unindexed opinion exists. The actionable
standard is therefore ordinary: focused PR, rationale, reproduction/evidence,
and passing project checks.

One concrete AI-related example is [issue #4183](https://github.com/umami-software/umami/issues/4183).
The reporter, not a maintainer, wrote “AI slop warning” to disclose LLM drafting
and incomplete independent verification. Contributor Maxime-J subsequently
[discussed the technical cause](https://github.com/umami-software/umami/issues/4183#issuecomment-4295733337).
This is evidence of technical engagement with an AI-disclosed report, not a
blanket policy accepting AI-written code or unverified reports.

## Capped count and unnecessary ordering status

Checked on 2026-09-08: `master` is pinned
`ca661c7057984aa98ed4f7083d84dae2f65bfcb0`; `dev` is
`9fb7bacee62c34d6d05312d063a37c20d581de23`. Both retain the count-wrapper
structure: [`pagedRawQuery`](https://github.com/umami-software/umami/blob/9fb7bacee62c34d6d05312d063a37c20d581de23/src/lib/prisma.ts)
builds its capped count as `count(*)` over `select 1 from (${query}) ... limit
maxResults`, while [`getWebsiteSessions`](https://github.com/umami-software/umami/blob/dev/src/queries/sql/sessions/getWebsiteSessions.ts#L38-L80)
includes `order by max(website_event.created_at) desc, session.session_id` in
the caller SQL. Because the caller's `ORDER BY` is inside `${query}`, it is also
present inside the capped count subquery; this is a code fact, not a measured
planner cost. The cap was introduced by [`fbac751`](https://github.com/umami-software/umami/commit/fbac7518fc35c608a58fe7d55efaa17bba831417)
with the message “performance improvements,” without a public explanation of
this ordering interaction.

Important difference: pinned master sorts only by latest event time; current
dev adds `session.session_id` as a tie-breaker. Any upstream port must preserve
that secondary sort. The stored patch and measurements remain evidence for
the pinned version, not proof of performance or compatibility on current dev.

The narrow GitHub search found no duplicate public issue/PR specifically
proposing removal of that `ORDER BY` from the count path. [Issue #4462](https://github.com/umami-software/umami/issues/4462)
is a related pagination correctness report (count/page positions can diverge
from returned rows after joins), but it does not address this sort cost. A
possible `defaultOrderBy`/count-query separation is therefore a local
candidate, not an upstream-approved fix; prove SQL equivalence and planner
cost before proposing it.

## Local evidence audit and next decision

Reviewed the four README cases and the ingestion baseline against their owning
records and saved measurements. Journey public blocks exactly match the local
full-run blocks. All three visitor source hashes, blocks and container metadata
match the referenced local outputs. Recomputed headline timing/CPU summaries
support the recorded conclusions. No fabricated headline measurement was found
in this scope; saved validation flags are not independent re-execution of every
historical response comparison.

- Funnel: clarified p50 wording in README and its owning record. The script uses
  nearest-rank percentiles, not the average of the two central samples. Historical
  numbers are preserved; the small discrepancy was a statistic-definition issue.
- Journey: only 198 of 228 timed responses were exactly identical; the existing
  record correctly distinguishes valid tied top-100 choices from identical JSON.
- Visitor: long-window improvement is supported; short-window improvement and
  production reliability are not established.
- Performance report: contention regressions and the decision not to adopt
  unconditionally remain recorded. Ingestion remains a baseline/configuration
  comparison, not a new code optimization.

Recommendation: prepare visitor count ordering first if upstream submission is
desired. Port to current dev preserving its tie-breaker, provide a small disposable
dataset/reproducer independent of private local DB paths, and run focused checks
plus upstream build/lint. Historical datasets are not public; the current scripts
are not a turnkey fresh-clone reproduction. Do not rerun the entire experiment
catalog merely for ceremony. A focused PR after these steps is reasonable;
Discussion is useful for an unresolved design question, not a required ritual.
Other case patches have not received a full current-dev compatibility audit.

### Direct-PR procedure confirmed — 2026-09-08

Re-read `CONTRIBUTING.md` from live `dev` through the GitHub contents API.
It explicitly describes fork → branch from dev → focused change → build/lint
→ PR targeting dev. It does not require a prior issue, Discussion, maintainer
permission, or previous contributions. Therefore a direct focused PR is a
supported submission path for this optimization, not a promise of acceptance.
Actual readiness still depends on the patch and required checks; no submission
was made by this check.

## Limits

No upstream files, issues, PRs, or discussions were modified. Search was
limited to the repository's contribution guide/templates, GitHub search for
AI-related terms, visitor/count/order terms, and directly linked issue/PR
surfaces; private maintainer channels and unindexed content remain unknown.
