# CloakBrowser perf: CPU throttling vs humanize latency (for #dev)

Two **independent** issues surfaced on preprod. They have separate causes and separate fixes — don't conflate them.

| | Issue 1 — CPU usage | Issue 2 — post-join latency |
|---|---|---|
| **Symptom** | Pod pins its 4-core limit → CFS throttling → jittery video, sluggish UI | Bot spends seconds doing humanised popup/layout clicks before it outputs clean video |
| **Cause** | CloakBrowser forces GPU/WebGL/compositing onto **SwiftShader** (CPU rasterizer) | `humanize:true` patches **every** Playwright action, including post-join internals |
| **Cost type** | **CPU** (cores) | **Latency** (wall-clock), ~0 CPU |
| **Fix** | `--disable-gpu` | scope humanize to the **admission gate** only |

---

## Issue 1 — CPU: `--disable-gpu`

**Mechanism (from CloakBrowser source):** `config.py` strips `--enable-unsafe-swiftshader` and `browser.py:991` injects `--ignore-gpu-blocklist` in **headed** mode, *"to let SwiftShader serve WebGL on software GPUs in Docker/Xvfb."* That's deliberate — it keeps a realistic "real GPU" fingerprint. But on a **GPU-less node** (Xvfb / k8s pod) it runs the GPU pipeline in a CPU rasterizer.

**Measured (local, GPU-less Xvfb = pod-equivalent, churn-proof per-PID CPU, in-call):**

| Browser | cloak CPU in-call |
|---|---|
| CloakBrowser (default) | **~1.3 cores / bot** |
| CloakBrowser + `--disable-gpu` | **~0.65 cores / bot** (two runs: 0.64, 0.66) |

→ `--disable-gpu` ~**halves** the browser's in-call CPU. On a 4-core pod the browser was eating ~⅓ of the budget *before* FFmpeg — enough to tip into throttling. Halving it should pull it back under the cap.

**Safe for Meet:** Meet does **not** fingerprint the WebGL renderer at the join screen (that's a Cloudflare/FingerprintJS behavior). The stealth that matters at admission — `navigator.webdriver=false`, `platform=Win32`, the Windows UA — is **not GPU-related** and is fully intact with `--disable-gpu`. Only the (Meet-irrelevant) WebGL renderer string is lost.

**Can it be flipped live (in-call)?** No — it's a launch flag; changing it means relaunch/rejoin. But you don't need to: launch GPU-off from the start. If you ever onboard a platform that *does* fingerprint WebGL at join, gate GPU per-platform **at launch**, not mid-call.

> Note: the `--fingerprint-noise=false` flag is **not** the CPU lever — measured doing nothing (noise hooks fire on fingerprint *reads*, not the render path). The lever is `--disable-gpu`.

---

## Issue 2 — humanize latency: scope it to the join

`humanize` is **behavioral** (bézier mouse, per-char typing, thinking pauses) → it costs **time, not CPU**. The slowness is because `humanize:true` patches the page **globally**, so post-join internals (dismiss popup, change layout, spotlight) each get a bézier move + delays — pure overhead, because **no bot-detector watches post-join UI**. Detection happens at the **admission gate** (name entry + "Ask to join"); once admitted you're a participant.

**Fix (wrapper path): use `page._original.*` for post-join actions.** `humanize` is a runtime JS patch (not a launch flag), so it **can** be bypassed mid-call — CloakBrowser exposes the un-patched page at `page._original` for exactly this (*"raw speed for a specific call"*):

```js
// Admission gate — keep humanised (detection watches here):
await page.locator('input[type=text]').fill(botName)
await page.getByText('Ask to join').click()

// Admitted -> go fast, nothing's watching:
await page._original.click(closePopupSelector)    // instant
await page._original.click(changeLayoutSelector)   // instant
await page._original.click(spotlightSelector)      // instant
```

Net: humanised admission, instant post-join. No relaunch.

**Flip-live asymmetry:**

| Flag | Flip in-call? | How |
|---|---|---|
| `--disable-gpu` | ❌ launch flag | relaunch only (just launch GPU-off for Meet) |
| `humanize` | ✅ runtime patch | `page._original.*` per post-join call |

---

## State of the nixos (binary-direct) build

This build launches the CloakBrowser **binary directly** (`executablePath`), not the npm wrapper, so it doesn't use the wrapper's `humanize:true`. Behavior comes from `meet-teams-bot/src/meeting/humanize.ts`, which is **already scoped to the admission flow** (`typeBotName`, the "Ask to join" click, lobby mic/cam). `changeLayout`, popup-dismissal, and in-call actions use plain `.click()` → already instant. `--disable-gpu` is shipped here (commit `baa7ce8`).

→ **The Issue-2 action item is the wrapper/preprod path (Amr's launch), not this build.**
