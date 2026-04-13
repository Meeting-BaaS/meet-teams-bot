# Google Meet Bot Detection (April 2026)

## Problem

As of April 2026, Google Meet introduced a dual-queue system for screening meeting join requests:

1. **High-Risk Queue** — Participants flagged as potentially risky (automated bots, suspicious connections, unverifiable identities) are shown to hosts as "With potential threats". The default host action changed from **Admit to Deny**.
2. **Verified Queue** — Users on the meeting invite or in the same org get fast-tracked.

Our bots run as ephemeral pods in a Scaleway Kubernetes cluster. The data center IPs used by these pods are flagged by Google as high-risk, causing bots to land in the threat queue. The same bot code running locally (residential IP) is not flagged.

### Root Cause

Google's detection is based on the **source IP of the HTTPS request** at join time — not WebRTC, not browser fingerprinting. The flagging happens before the bot is admitted (at the "Join now" click), so it's purely the IP seen by Google's meeting API.

Data center IPs are trivially identifiable:
- **ASN lookup** reveals the IP belongs to a hosting provider
- **IP reputation databases** (MaxMind, IP2Location) categorize IPs as residential vs data center
- **Reverse DNS** often resolves to cloud provider hostnames (e.g., `xx-xx-xx-xx.scw.cloud`)

---

## Attempted Mitigation: Residential Proxy (Did Not Work)

### Approach

We built a local toggle proxy (`src/proxy/toggle-proxy.ts`) that routes browser traffic through a Bright Data residential proxy during the join phase, then switches to direct connections after admission.

```
Browser --[always]--> Local Toggle Proxy (localhost:PORT)
                          |
              +-----------+-----------+
              | Before admission      | After admission
              v                       v
    Bright Data Residential      Direct connection
    (brd.superproxy.io)          (no upstream)
```

### Why It Failed

**Google flags Bright Data's residential IPs too.** Even though these IPs are technically on residential ASNs, Google can distinguish them from genuine residential users:

- Bright Data is the largest residential proxy provider — Google has strong incentive to fingerprint their IP pool
- The same residential IPs rotate through millions of requests from different customers (scraping, automation, etc.), building a bad reputation score
- Google likely maintains a database of known proxy provider IP pools regardless of ASN classification
- Testing confirmed: bot running locally (genuine residential IP) = no threat flag; same bot through Bright Data residential proxy = flagged as "With potential threats"

### Code Status

The toggle proxy infrastructure is still in the codebase (behind the `RESIDENTIAL_PROXY_URL` env var) in case a different proxy provider works. Set the env var to enable it; leave it empty to disable. It only activates for Google Meet (`meeting_platform === "meet"`).

### Implementation Details

- **`src/proxy/toggle-proxy.ts`** — Local proxy using `proxy-chain`. Binds to a random port (port 0). Forwards to upstream proxy when active, goes direct when toggled.
- **`src/browser/browser.ts`** — Accepts optional `proxyUrl`, adds `--proxy-server` to Chromium args.
- **`src/state-machine/states/initialization-state.ts`** — Starts proxy before browser launch (Meet only).
- **`src/state-machine/states/waiting-room-state.ts`** — Calls `setDirectMode()` in `onJoinSuccess` callback.
- **`src/state-machine/states/cleanup-state.ts`** — Stops proxy during cleanup.
- **`src/config/env-vars.ts`** — `RESIDENTIAL_PROXY_URL` env var.

---

## Viable Paths Forward

### 1. Calendar Integration (Medium effort)
Add the bot as an actual calendar invitee on the meeting. If the bot's identity is on the invite, Google may route it to the verified queue instead of the threat queue.

### 2. Pre-meeting Host Notification (Low effort)
Email/Slack the host before the bot joins, telling them to expect it and to admit it from the waiting room. Doesn't fix the UX (host still sees "potential threat") but reduces friction.

### 3. Google Workspace Marketplace App (High effort, most robust)
Authenticate the bot as a proper Google Workspace app with OAuth. This is how Otter.ai, Fireflies, etc. avoid the threat queue entirely — they authenticate as trusted participants regardless of IP. This is the most scalable long-term solution for high volume (1000s of bots/day).

### 4. ISP/Static Residential Proxies (Uncertain)
Dedicated residential IPs (not shared/rotated) that don't carry shared proxy reputation. More expensive than rotating residential proxies and may eventually get flagged too from repeated bot-like usage patterns at scale.
