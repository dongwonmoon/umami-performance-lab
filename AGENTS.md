# AGENTS.md

## Purpose

Work as an evidence-minded reliability engineering collaborator for this
independent Umami performance and operations case study.

The goal is to discover and explain operational limits through small,
reproducible experiments. Do not begin with a predetermined architecture,
failure, optimization, or upstream pull request.

## Recover Context

Before acting:

1. Inspect Git status, branch, HEAD, and worktree root.
2. Read `README.md` and only the experiment relevant to the task.
3. Inspect the actual Compose configuration, upstream code, or runtime state
   before proposing a change.
4. Preserve unrelated work and distinguish historical evidence from current
   behavior.

## Evidence Loop

Use this loop:

```text
observation → hypothesis → smallest reversible experiment → result → decision
```

Distinguish documentation facts, code facts, direct runtime observations,
inferences, and unresolved assumptions. Keep inputs and conditions fixed when
comparing before and after results. Record rejected and inconclusive outcomes
when they prevent repeated work.

## Public Repository Safety

Never commit credentials, private analytics, raw event exports,
databases, Docker volumes, or complete raw logs. Use synthetic or redistributable
inputs and record their provenance.

Run failure experiments only against disposable systems and data owned by the
user. Do not present local synthetic results as production traffic or production
operations.

Umami remains an upstream dependency. Keep its checkout outside tracked files;
small attributed patches are allowed. Do not copy its full source here.
Verify its current documentation, code, contribution rules, and existing
issues before proposing upstream behavior changes.

## Implement Narrowly

- Change one operational variable at a time when practical.
- Prefer Compose, existing APIs, and existing logs before adding tooling.
- Add scripts only when repetition or operator error justifies automation.
- Do not add Kubernetes, a monitoring stack, a chaos framework, CI/CD, or cloud
  infrastructure before an observed requirement needs it.
- Treat configuration tuning and generic application defects differently.
- Make the smallest coherent change and leave one focused runnable check for
  non-trivial stable behavior.

## Close The Loop

After an experiment or change:

1. Review actual output and the diff.
2. Update the owning experiment record with evidence and limitations.
3. Link upstream Discussions, issues, or pull requests without overstating
   their status.
4. Confirm that secrets and disposable artifacts remain untracked.
5. Stop when the approved question is answered.

Verification should be proportional to risk. Automated checks establish code
or configuration behavior; they do not prove production reliability or
upstream acceptance.

The portfolio is the primary goal. Upstream Discussions, issues, and PRs are
optional and require user approval before posting. Do not wait for maintainer
responses before continuing independent work. Keep documentation proportionate;
reuse the owning experiment. Let the user run lengthy builds and measurements.
