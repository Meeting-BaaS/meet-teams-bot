# Google Meet Bot Detection (April 2026)

## Problem

As of April 2026, Google Meet introduced a dual-queue system for screening meeting join requests:

1. **High-Risk Queue** — Participants flagged as potentially risky (automated bots, suspicious connections, unverifiable identities) are shown to hosts as "With potential threats". The default host action changed from **Admit to Deny**.
2. **Verified Queue** — Users on the meeting invite or in the same org get fast-tracked.

Our bots run as ephemeral pods in a Scaleway Kubernetes cluster. The data-center IPs used by these pods are flagged by Google as high-risk, causing bots to land in the threat queue. The same bot code running locally (residential IP) is not flagged.

---

## Detection Mechanics

Based on a call with Allan (tldv) — they have flag rate at ~1–5% in production, varying by time of day (weekends worse). Two systems feed a composite score in `[0, 1]`:

1. **BotGuard** — hard-blocks join entirely. We already handle this implicitly: the pod exits, SQS retries the bot on a fresh pod.
2. **reCAPTCHA Enterprise** — flags with the visible "potential threats" banner. Hosts can still admit, but the default action flips to Deny and the UX suffers.

The composite score is **multi-factor**: IP reputation + browser fingerprint + behavioral signals all contribute. Earlier-IP-only hypotheses were wrong — when we tested dropping the proxy after page load (assuming session-cookie-based scoring), preprod batches at scale showed worse threat-queue rates than the safer flip-after-admission flow (see `wip/google-meet-bot-detection-proxy-poc` branch arc).

Key insight from Allan: their team **reverse-engineered the protobuf protocol** Meet uses to broadcast participant state, and they read the flag in real time from the bot's own row in the roster. This is treated as a prerequisite for any further work — without measurement signal, every change is iterated blind.

---

## What We've Tried

### Residential proxy via Bright Data — flagged

Built a local toggle proxy (`src/proxy/toggle-proxy.ts`) routing browser traffic through a Bright Data residential upstream during the join phase, switching to direct after admission.

```text
Browser --[always]--> Local Toggle Proxy (localhost:PORT)
                          |
              +-----------+-----------+
              | Before admission      | After admission
              v                       v
       Residential upstream    Direct connection
       (Bright Data / Decodo)  (no upstream)
```

**Result**: Bright Data IPs are also flagged. Allan confirmed independently — their residential pool reputation is shared across customers (scraping, automation, etc.), and Google maintains a database of known proxy provider IP pools regardless of ASN classification.

### Decodo residential — pending

Switched the upstream provider configuration to Decodo. Same on/off mechanism, different IP pool. Awaiting batch results.

### Aggressive proxy timing — disproved at scale

Hypothesis: after the Meet SPA bundle is fetched under a residential IP, subsequent requests (including the join POST) can go direct because classification might be session-cookie-based. Tested via post-page-load `setDirectMode()` (commit `2b8faa03`). Preprod batches at volume showed *worse* threat-queue rates than the original post-admission flip. Reverted in `d71d569e`. Lesson: 1–2 bot local tests do not represent classifier behavior at scale.

### Bandwidth optimisation — kept

Chrome background services consume disproportionate residential bandwidth without affecting detection. Hosts bypassed in `toggle-proxy.ts:PROXY_BYPASS_HOSTS` always go direct: `optimizationguide-pa.googleapis.com`, `fonts.gstatic.com`, `gstatic.com`, `play.google.com`. Saves ~1GB/bot per Decodo's traffic breakdown without measurable detection impact.

---

## Current Avoidance Work

The following changes are in flight, ordered roughly by impact:

### 1. v4l2 webcam label hardening (deployment)

The kernel-level v4l2 loopback device that serves the bot's branding image to Chrome was labeled `MeetingBot_WebCam` — a direct giveaway via `getUserMedia / enumerateDevices()`. Changed to `HD Pro Webcam C920` (plausible consumer Logitech device).

Source: `deployment/helm-charts/video_device_plugin_chart/values.yaml` → `v4l2.cardLabel`.

### 2. rebrowser-playwright drop-in

Swapped `chromium` import in `src/browser/browser.ts` from `@playwright/test` to `rebrowser-playwright`. The patches are **narrower in scope than the project README implies** — verified in `rebrowser-playwright-core@1.52.0`:

- ✅ **Hidden**: CDP `Runtime.enable` — Playwright's standard `Runtime.enable` call leaks a detectable side-effect (execution-context lifecycle events) that scoring scripts probe. rebrowser skips this call by default and re-implements binding evaluation through `Page.addScriptToEvaluateOnNewDocument`. This is the main win.
- ❌ **Not handled**: `--enable-automation` is still listed in rebrowser's `chromiumSwitches.js:87` defaults. It is NOT removed automatically.
- ❌ **Not handled**: `navigator.webdriver` — no patches in rebrowser's `lib/` reference `webdriver`. Without a separate counter-flag, it reports `true`.

So we **continue to pass** `--disable-blink-features=AutomationControlled` ourselves. It tells Blink to ignore the `--enable-automation` infobar AND keeps `navigator.webdriver === undefined`. The two-flag combination (rebrowser's Runtime.enable patch + our `AutomationControlled` flag) covers both surfaces.

A previous version of this document claimed rebrowser made the flag redundant. That was wrong; the flag stays.

Also dropped from `browser.ts`:

- `--enable-logging=stderr`, `--log-level=1`, `--vmodule=*audio*=3` — distinctive stderr fingerprints in prod. Gated behind `NODE_ENV === "development"`.

We continue to launch **real Google Chrome** (installed in `apps/api-server/dockerfile.meet-teams-bot` via `google-chrome-stable` apt package), not Playwright's bundled Chromium. Real Chrome contributes Widevine DRM, real `navigator.plugins`, real `navigator.userAgentData.brands` — all checked by reCAPTCHA Enterprise scoring.

### 3. OS-level (X11) input via xdotool

New module `src/utils/human-input.ts` dispatches clicks, keystrokes, and typing through `xdotool` instead of Playwright's CDP `Input.*` events. Detection rationale:

- `page.fill(input, text)` uses CDP `Input.insertText` — **doesn't dispatch keydown/keypress events at all**. Trivially detected by any field listener.
- `locator.click()` is a synthetic mouse event with no pointer movement.
- `page.keyboard.press()` is dispatched via CDP, distinguishable from real OS-level key events.

Pre-join interactions migrated to `humanClick` / `humanType` / `humanKey` in `src/meeting/meet.ts`:

| Function | Before | After |
| --- | --- | --- |
| `typeBotName` | `page.fill()` | `humanType()` with per-char delays |
| `clickDismiss` | `button.click()` | `humanClick()` |
| `clickWithInnerText` | `element.click()` | `humanClick()` |
| `clickJoinCtaIfPresent` | `keyboard.press("Escape")` + `locator.click()` | `humanKey("Escape")` + `humanClick()` |
| `toggleCameraWithShortcut` | `keyboard.press("Control+E")` | `humanKey("ctrl+e")` |
| `toggleMicrophoneWithShortcut` | `keyboard.press("Control+D")` | `humanKey("ctrl+d")` |
| `ensure{Camera,Microphone}{On,Off}` fallback | `btn.click()` | `humanClick(btn)` |
| `activate/deactivateMicrophone`, `deactivateCamera` (lobby) | `.click()` | `humanClick()` |
| `clickOutsideModal` | `page.mouse.click(10, 10) × 3` (CDP, botlike pattern) | `humanKey("Escape") × 3` |

Post-join interactions (People panel, Chat panel, `changeLayout`, `closeAdjustViewDialogIfOpen`) are intentionally left on Playwright APIs — they're outside the pre-admission scoring window.

**Teams join flow is untouched** — the dual-queue lobby is a Meet-only construct. Humanizing Teams interactions would add risk without upside.

xdotool dependency:

- Production: added to `apps/api-server/dockerfile.meet-teams-bot` apt install list.
- Dev: added to `scripts/check-start-deps.sh` so `./scripts/check-start-deps.sh` flags it if missing.

### 4. Hybrid pre-recorded mouse trajectories

`human-input.ts` ships 10 normalized cursor trajectories with distinct human-shaped acceleration profiles: smooth-S, overshoot+correction, impatient quick path, curved drift above the line, hesitant-pauses-midway, bezier-smooth, opposite-curved-below-the-line, shallow overshoot, ramped acceleration, choppy trackpad-style segments.

At replay time:

- A trajectory is picked at random.
- Time-axis scaled to a jittered total duration (250–450ms by default), with ±10% per-replay time stretch.
- Position-axis scaled to the actual screen displacement.
- Per-waypoint ±2px pixel jitter on intermediate samples (endpoints land exactly on target).
- Off-centre target landing (±25% of half-extents from element centre).
- Pre-click hover delay (60–150ms before button press).

This avoids pure-algorithmic motion (which has detectable mathematical signatures — Bezier control points produce identifiable acceleration curves) while also avoiding raw replay of 10 identical sequences (which would cluster statistically). Future improvement: replace synthetic waypoints with recordings of real human cursor traces.

Typing has analogous treatment in `humanType`: per-character random delays (60–180ms by default), 8% probability of an extra "thinking" pause (300–600ms), select-all+delete before typing to clear pre-existing content.

---

## Validated Dead-Ends

### Authenticated Google accounts (don't pursue as flagging fix)

Allan tried this 5 years ago — difficult to manage, did **not** reduce flag rate. Recall.ai independently confirmed the same. The only marginal benefit is that bots on a calendar invite skip the waiting room entirely (bypassing the flag banner) — but this loses bot name/avatar customisation and doesn't help bots that are added ad-hoc.

This contradicts earlier notes in older versions of this document about the Google Workspace Marketplace App being the "most robust" path. It is not.

### ISP / static residential proxies

Allan rejected this approach in production: pay-per-IP economics, 300 IPs burn through fast as reputation builds, doesn't scale. We are not pursuing this.

### Aggressive proxy deactivation timing

Disproved at scale on `wip/google-meet-bot-detection-proxy-poc` (see proxy timing experiment above).

---

## Priority Order for Further Work

Ordered by Allan's recommendation; ordering is fixed.

1. **Protobuf flag detection — prerequisite for everything below.** Read `is_suspected_bot` (or its actual name) from the bot's own row in the Meet roster protobuf, plumb to a metric. Without this we cannot honestly measure the impact of any other change. A teammate is currently working on this.

2. **Selective proxying (allowlist of scoring endpoints, not host-bypass list).** Today our `toggle-proxy.ts` proxies everything by default. Allan's approach is the inverse — direct by default, allowlist only the specific Google scoring requests. This drops per-meeting bandwidth from multi-MB to ~100–200KB, making residential viable at scale. Deferred until we have flag-detection telemetry to validate allowlist coverage; Decodo's analytics will help identify the endpoints to allowlist.

3. **Geo-matched proxy region** — Decodo supports region targeting via username suffixing. Pick the proxy region by the booking user's timezone (or `start_time` heuristic). Requires schema changes in api-server + sqs-consumer to propagate the region to the bot params. Deferred until selective proxying ships.

4. **CamoFox migration** — Firefox-fork built for anti-bot evasion. Last-resort move if the cumulative impact of 1–3 plus the work already in flight (rebrowser, v4l2, human-input) isn't enough. Effort estimate: weeks (Firefox-Playwright migration, re-validating PulseAudio + v4l2 capture + network-interception layer in Firefox).

---

## Open Questions

- **Selective-proxy allowlist composition** — which exact endpoints feed Google's scoring? Likely candidates: `meet.google.com/_/meet/*`, `signaler-pa.clients6.google.com/*`, `meet.googleapis.com/*`, `recaptcha.net/*`. The protobuf discovery dump already captures every fetch URL crossing the bot — we can cross-reference with Decodo's bandwidth-by-host dashboard to confirm.
- **Self-visible vs observer-side flag** — Allan said the bot can read its own flag from the protobuf. Worth re-confirming once telemetry is live; if it's only visible to observers, single-bot test runs won't surface the field.
- **Decodo flag rate** — open. Pending preprod batch results.
- **rebrowser-playwright version drift** — pinned to 1.52.0 while `@playwright/test` resolves to 1.56.x. Runtime is fine; if we adopt a 1.56-only API in the bot, the type cast in `browser.ts` won't save us.

---

## Code Status

The toggle proxy infrastructure remains in the codebase (behind `RESIDENTIAL_PROXY_URL` env var, Meet-only via `meeting_platform === "meet"` check). Set the env var to enable; leave empty to disable.

| Component | File |
| --- | --- |
| Toggle proxy | `src/proxy/toggle-proxy.ts` |
| Browser launch + rebrowser swap | `src/browser/browser.ts` |
| Proxy lifecycle (start) | `src/state-machine/states/initialization-state.ts` |
| Proxy lifecycle (flip to direct) | `src/state-machine/states/waiting-room-state.ts` (`onJoinSuccess`) |
| Proxy lifecycle (stop) | `src/state-machine/states/cleanup-state.ts` |
| Env vars | `src/config/env-vars.ts` (`RESIDENTIAL_PROXY_URL`) |
| OS-level input wrapper | `src/utils/human-input.ts` |
| Meet pre-join migrations | `src/meeting/meet.ts` |
| v4l2 card label | `deployment/helm-charts/video_device_plugin_chart/values.yaml` |
| xdotool runtime dep | `apps/api-server/dockerfile.meet-teams-bot` |
| xdotool dev dep check | `scripts/check-start-deps.sh` |
