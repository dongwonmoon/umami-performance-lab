# Tracker navigation and collection-response coupling

Status: local candidate verified and packaged; not submitted upstream.
Pinned upstream: `9fb7bacee62c34d6d05312d063a37c20d581de23`.
This record includes rejected approaches and limits, not a production reliability claim.

### Collection-path screening — 2026-09-09

Read pinned dev9fb7bace tracker, send route, saveEvent/saveEventData/saveRevenue,
and getWebsiteStats; Luna inspected client dispatch and main checked its source.
Existing batch/overlap measurements were not repeated. Bot/DNT/domain exclusions
and non-pageview metric exclusions are not automatically data-loss bugs.
Client sends have no retry; that alone does not justify a queue, since ambiguous
delivery retries could duplicate events. Sequential event/property/revenue writes
could partially succeed on failure, but no ordinary-use failure was demonstrated.

More concrete next candidate: `src/tracker/index.ts:349-365` prevents default
navigation for ordinary same-window anchors bearing a tracking event, then assigns
location only in `trackElement(...).finally(...)`. Its send function awaits fetch
and response JSON with no explicit application timeout (383-418). Hypothesis:
slow analytics responses delay the host site's link navigation. This is not yet
a measured browser result, nor proof that waiting is unintended: preserving the
click event is a plausible reason. Untracked links and new-tab clicks are controls.

Main also fetched the current upstream dev tracker through GitHub API and confirmed
the same flow. Limited issue searches `navigation tracking` and `link delay` returned
no results; this is not an exhaustive duplicate/history check.
Next smallest check: use the real tracker in a disposable browser page, vary only
mocked collection-response delay, and compare tracked/untracked link navigation.
No retry design or timeout patch selected. No app/DB restarted, source changed,
benchmark rerun, commit, or upstream post in this screening.

### Tracked-link delay probe — 2026-09-09

History check found closed [#4304](https://github.com/umami-software/umami/issues/4304)
and commit18b72d3008: `.then` changed to `.finally` to restore navigation on
rejection. That fix does not remove waiting for a pending request. Preserving
delivery before navigation remains a plausible intent, not a confirmed rationale.

Luna used the actual existing public/script.js bundle (SHA256
`f7466a453d625adbdfa6a7c61d8b8c272e9270781e3c9737fbc0780ea11bb807`)
in intercepted http://umami-probe.test pages, without an app or DB. One plain /
tracked link pair used a mocked1500ms collection response. Agent reported CLI
wall times1.31s/2.26s and collection dispatch for the tracked click. These include
automation overhead and are NOT browser navigation timings or a reliable effect
size; no zero-delay baseline or repeats completed. Main verified the bundle's
finally-based navigation and fixture/destination snapshots, not the timing trace.
Retained ignored snapshots: `.playwright-cli/page-2026-09-09T08-56-42-602Z.yml`
and `page-2026-09-09T08-56-54-051Z.yml`. They prove page states, not causality.

Discarded preliminary data-URL attempt: Chromium blocked top-frame navigation.
The earlier localhost connection refusal was expected with our app stopped, not
an Umami failure. Browser closed per agent; no source patch or service start.
Decision: source-supported coupling with directional browser evidence, not a
completed latency qualification. Before any fix, measure click-to-destination
inside one browser clock with zero/delayed response controls; weigh delivery
preservation against bounded navigation delay. Do not report CLI timings as UX.

### Browser-clock confirmation — 2026-09-09

Main repeated the probe directly with the same real tracker bundle. All HTTP
routes were intercepted locally; no app/DB or external analytics requests.
Automatic pageviews were disabled. A capture-phase click listener records
`performance.now()`; pagehide stores the difference in sessionStorage before
the same-origin destination reads it. Thus both timestamps use the source
document's monotonic clock. Metric is **click to leaving the current document**,
not destination rendering or CLI wall time.

Three repetitions per condition, condition order reversed in the middle repeat:

| Link | Mock collection delay | Samples (ms, rounded) | Median (ms) |
|---|---:|---|---:|
| Plain | 0 | 22.1, 11.0, 6.7 | 11.0 |
| Tracked | 0 | 22.3, 21.0, 20.9 | 21.0 |
| Plain | 1500 | 9.0, 34.5, 10.1 | 10.1 |
| Tracked | 1500 | 1530.0, 1526.3, 1514.5 | 1526.3 |

All12 destination navigations completed; runnable assertions checked finite
timings and exactly0 collection requests for plain links /1 for tracked links.
For plain links, the delay setting is inert: no collection request is sent.
Tracked median increased1505.3ms when only response delay increased1500ms.
This confirms the coupling in this browser, not how frequently a real server
is slow. No packet loss, durable delivery, other browsers, or patch was tested.

Local reproducible CLI snippets: `.local/navigation-clock-setup.js` then
`.local/navigation-clock-measure.js` via Playwright CLI `run-code --filename`.
Exact samples: `.local/navigation-clock-results.json`. Initial setup used an
unsupported URL global in the CLI sandbox and was corrected. A preliminary
successful loop did not return its values; it is not included in this table.

Decision: a justified navigation-reliability candidate, not a performance fix
already achieved. Waiting preserves an opportunity to finish delivery; removing
the wait or bounding it needs a separate delivery/navigation trade-off check.
Do not add a retry queue or arbitrary timeout based solely on these samples.

### Immediate-navigation delivery trade-off — 2026-09-09

User approved original vs immediate navigation, with default and asynchronous
beforeSend; compare real receiver arrivals and do not adopt if delivery regresses.
Main ran a throwaway Node HTTP receiver on127.0.0.1:3099, no request interception,
app or database. Same pinned built tracker hash as above. In-memory variant
replaces the single verified minified navigation block
`return i||e.preventDefault(),t(a).finally(()=>{i||(("_top"===r?l.location:o).href=n)})`
with `return t(a)`, leaving fetch/keepalive untouched and allowing native anchor
navigation. This is an experimental bundle transformation, not a source patch.

HeadlessChrome152.0.0.0/macOS; same-origin small payload. Receiver buffers the
complete request body, records a unique run ID, and delays its response1500ms.
Optional beforeSend waits1000ms before returning the unchanged payload. Two
repeats reverse variant order. Source-page click-to-pagehide uses performance.now;
after navigation, wait2800ms before checking arrivals. No automatic pageviews.

| Settings | Original departure ms | Immediate departure ms | Received original / immediate |
|---|---|---|---|
| Default | 1528.6, 1518.4 | 7.9, 14.3 | 2/2 vs 2/2 |
| Async beforeSend | 2515.5, 2517.3 | 6.1, 7.6 | 2/2 vs 0/2 |

Independent curl of receiver after the loop still showed exactly6 run IDs;
all6 responses emitted server finish. This proves complete request-body arrival
at our receiver, not Umami DB storage or client-side response handling. Missing
events were not observed within the window; permanent loss is not established.

Decision: reject unconditional wait removal as a general fix. It helps default
navigation here but regresses the supported async hook path. Code explains why:
send awaits beforeSend before starting fetch; keepalive only protects a request
that has started, not the preceding JavaScript timer. Further candidate, not
implemented: separate preparation/dispatch completion from response completion.
That would still wait for a slow hook and adds internal lifecycle complexity;
do not claim it solves all navigation blocking or is already worthwhile.

Repro scripts: ignored `.local/navigation-delivery-server.mjs` (node),
`.local/navigation-delivery-measure.js` (Playwright CLI run-code --filename).
Samples: `.local/navigation-delivery-results.json`. Browser and receiver stopped
after measurement. No upstream edits, dependency installs, commit, push, or PR.

### Dispatch-only candidate plan — 2026-09-09

Approved next question: can same-window tracked anchors await preparation and
fetch invocation without awaiting its response? Keep public track/identify
completion behavior, request headers, keepalive and response handling unchanged.
No queue, timeout, dependency, or production adoption. Private tracker control
flow only; ordinary buttons/new-tab links retain the existing path.

- [x] Create a scratch source candidate plus a focused runnable check that fails
  on the original: navigation must wait for beforeSend, but not pending response;
  disabled/cancelled/rejected preparation must not strand navigation.
- [x] Compare original/candidate using the existing real loopback receiver with
  1500ms response and optional1000ms hook, recording arrival counts and departure.
- [x] Review actual source diff and evidence; record remaining browser/transport
  limits, stop temporary services. No commit or upstream submission in this step.

### Dispatch-only candidate result — 2026-09-09

Luna implemented scratch TypeScript; main reviewed the diff and ran actual browser
checks. Initial review caught public-track signature expansion and lost synchronous
error handling; both corrected before measurement. Final source diff24 additions /
12 deletions in one file (net12), private waitForResponse flag only. Public track
and identify source unchanged. trackElement calls the same send payload directly;
same-window anchors pass false, other paths retain true. Async beforeSend still
finishes before fetch. Response JSON/cache handling continues with a rejection
handler, while the navigation path awaits only send preparation/fetch invocation.

Runnable red check failed original at1522.1ms (expected departure below800ms with
1500ms server response); final candidate passed at20ms. The threshold separates
the controlled1500ms delay, not a product SLO. Both comparison bundles were built
from source using the same installed esbuild settings, rather than comparing a
different minified build to a source candidate.

Two real-loopback repeats with reversed variant order; all8 events arrived once:

| Setting | Original samples ms | Candidate samples ms | Arrivals original / candidate |
|---|---|---|---|
| Default | 1520.0, 1514.3 | 12.7, 9.2 | 2/2 vs 2/2 |
| Async1000ms hook | 2541.0, 2522.5 | 1020.3, 1014.2 | 2/2 vs 2/2 |

Additional main checks passed for both: hook returns null, hook throws, tracking
disabled (all navigate, zero arrivals); public await track still waits for response
(1505.2/1502.7ms); circular-payload stringify errors retain prior swallowed behavior.
Throwing-hook promise rejection itself is not claimed eliminated; the assertion
checks navigation recovery. Final independent receiver read:11 complete bodies
(8 comparison,1 green,2 public calls), all server response-finish events seen.

Decision: promising bounded candidate, not yet production-ready or upstream-ready.
The small added complexity is distinguishing dispatch from response completion;
no queue, timer, dependencies or public setting. A slow/never-settling beforeSend
still delays navigation by design. Keepalive invocation does not prove delivery:
cross-origin/preflight, old browsers, Firefox/Safari, payload limits, real Umami
storage, and background response/cache behavior on same-document navigation remain
unverified. These transport/lifecycle boundaries matter before adoption; avoid
turning two successful local repeats into a general reliability claim.

Ignored artifacts: `.local/navigation-dispatch.ts`, `.patch`, `.js`,
`navigation-dispatch-original.js`, `navigation-dispatch-check.js`,
`navigation-dispatch-measure.js`, `navigation-dispatch-edges.js`, and
`navigation-dispatch-results.json`. Receiver is the existing
`.local/navigation-delivery-server.mjs`. Main recorded hashes and exact samples
in results JSON. Browser/receiver stopped. No upstream checkout modifications,
commit, push, or PR; lab artifact source is not an adopted product change.

### Cross-origin/preflight check — 2026-09-09

Main reused the real HTTP receiver (`CROSS_ORIGIN=1 node
.local/navigation-delivery-server.mjs`). Page origin127.0.0.1:3099, collector
localhost:3100; different hostname and port, both loopback HTTP. Tracker uses
its existing data-host-url option. No tracker changes. CORS allows only the
fixture page origin and existing request headers; credentials remain omit.
Each run has a unique collector URL and max-age0 to require a fresh preflight.
Receiver delays OPTIONS500ms and POST response1500ms; optional hook1000ms.

HeadlessChrome152; two repeats with reversed variant order:

| Settings | Original departure samples ms | Candidate departure samples ms |
|---|---|---|
| Default | 2027.8, 2016.3 | 6.1, 5.6 |
| Async hook | 3016.6, 3019.4 | 1013.8, 1015.4 |

All8 runs had exactly one OPTIONS and one complete POST body, correct Origin,
and finished preflight response. An independent final receiver read confirmed
8 preflights/8 events and all server responses finished. Candidate navigation
therefore did not prevent the cold preflight followed by delivery in this probe.
Observation window3200ms after navigation. The8-run Boolean checks passed;
this does not establish a production loss rate or database storage.

Exact samples and actual receiver logs: `.local/navigation-cross-origin-results.json`.
Runner: `.local/navigation-cross-origin.js` via Playwright CLI run-code --filename.
Same candidate/baseline bundles as preceding comparison. No HTTPS, real remote
domain, cookie credentials, large payload, or denied CORS scenario tested.

Firefox and WebKit launches both failed because their Playwright executables
are not installed. System Safari exists but is not the Playwright WebKit build;
do not claim Safari coverage. Download/install is left to user, then rerun this
same comparison using --browser firefox / --browser webkit. Those checks remain
open; candidate is not yet adopted. Chromium session and both local listeners
stopped. No source patch changes, commit, push, or upstream post.

### Firefox and WebKit cross-origin confirmation — 2026-09-09

After user installed the missing runtimes, main ran the unchanged
navigation-cross-origin.js against the same receiver/bundles in isolated
Firefox and WebKit sessions. Sessions overlapped at tiny request volume; this
is a seconds-scale lifecycle test, not a browser speed ranking. Same cold
OPTIONS500ms, response1500ms, optional hook1000ms,3200ms post-navigation window.

| Engine / setting | Original samples ms | Candidate samples ms |
|---|---|---|
| Firefox155 / default | 2026,2020 | 5,5 |
| Firefox155 / async hook | 3021,3022 | 1017,1019 |
| Playwright WebKit / default | 2020,2018 | 7,5 |
| Playwright WebKit / async hook | 3019,3015 | 1010,1011 |

Both8-run checks returned passed=true. Each had one matching OPTIONS and one
complete event body per run, correct Origin and finite source-clock timings.
Main independently read receiver state at the end:16 distinct run IDs,16
preflights,16 events, all response-finish flags true. No duplicates or missing
bodies in this bounded run. Chromium's earlier8-run result remains separate.

Firefox UA reports155.0. WebKit UA reports Version26.5/Safari605.1.15; this is
Playwright's WebKit build, NOT a test of the installed Safari app or iOS Safari.
Results are ignored `.local/navigation-cross-origin-firefox-results.json` and
`navigation-cross-origin-webkit-results.json`; independent receiver snapshot is
`navigation-cross-origin-multibrowser-receiver.json`. Exact rows include run IDs,
timestamps, headers and completion observations. All inputs remain synthetic.

Decision: cross-engine cold-preflight delivery concern did not reproduce on the
installed engines; candidate remains promising and this approved comparison is
complete. Not a claim of zero production loss or all-browser compatibility.
Earlier caveats about real Umami storage, payload limits, HTTPS/credentials and
same-document response handling remain. Do not add machinery merely to erase
every hypothetical limit. Next useful work is packaging/reviewing the narrow
source patch and its focused checks, not extending this timing matrix indefinitely.
Both browser sessions and receiver listeners stopped; no product source edits,
commit, push, or PR in this step.

### Patch packaging and final local review — 2026-09-09

Public artifact: `patches/tracker-navigation-dispatch.patch`, pinned to
9fb7bacee62c34d6d05312d063a37c20d581de23. Main applied it to a fresh archived
tracker file, not an active checkout. Result SHA256
`dd18d836b625a10e681cbbc26d70f0c4127409c9b6fdcba5ef041c8e34a418ec`
matches the browser-tested candidate. Apply-check and strict standalone TypeScript
check passed. Source remains24 additions/12 deletions; no production code redesign.

Reusable regression runner: `scripts/tracker-navigation-check.mjs`. It loads
TypeScript from an existing upstream node_modules, transpiles the full actual
tracker and executes it in a Node VM with browser-boundary doubles and controlled
promises. No network, browser download, database, or new dependency. This is a
control-flow check, NOT another browser delivery test or full app build.

```sh
# Existing upstream checkout must have its dependencies installed.
node scripts/tracker-navigation-check.mjs /path/to/umami /path/to/patched/src/tracker/index.ts

# Unpatched source: expected nonzero exit, exposes response-waiting behavior.
node scripts/tracker-navigation-check.mjs /path/to/umami
```

Main verified original exits1 (two navigation assertions fail, four controls pass)
and packaged patched source exits0 (six checks pass): wait for async preparation,
not response; background cache processing; public track response wait/cache;
cancelled/rejected preparation; disabled tracking; consumed fetch rejection.
The tests do not redefine existing throwing-hook behavior as error-free. Browser
evidence from preceding sections remains necessary for actual unload/CORS delivery.

Public `evidence/2026-09-09/tracker-navigation.json` preserves40 synthetic timing
samples across rejected immediate navigation, dispatch-only same-origin and
three cross-origin engines. It omits raw receiver logs and private paths/tokens.
Two immediate/async events were absent in the bounded observation window; do not
hide them or label all experimental variants successful.

Final judgment: retain this as a reviewed local improvement candidate. No blocker
found in the narrow source diff after the earlier two corrections. Its trade-off
is a private distinction between dispatch and response completion and dependence
on browser keepalive; slow beforeSend still blocks. No queue/retry or new user
configuration is justified. Not upstream acceptance, full-app qualification,
or proof of zero production loss. Packaged for the lab repository; no upstream PR
submitted for this candidate.
