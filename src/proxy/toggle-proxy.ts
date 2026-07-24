import axios from "axios"
// https-proxy-agent v9 is ESM-only with the modern `exports` field; our
// tsconfig sits on legacy moduleResolution: "node" so TS can't resolve the
// types. Runtime works fine — only the d.ts lookup fails. Suppress until
// the codebase moves to moduleResolution: "bundler" or "node16".
// @ts-expect-error - see comment above; remove this once tsconfig moves on.
import { HttpsProxyAgent } from "https-proxy-agent"
import type { ConnectionStats } from "proxy-chain"
import { Server } from "proxy-chain"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"

// Allowlist of hosts that route through the residential upstream. Everything
// else goes direct from the pod IP. Default-direct is intentional: if Google
// adds a new asset CDN tomorrow, it goes direct automatically and doesn't
// surprise us with a residential bandwidth balloon. The trade-off vs a
// deny-list is that a missing entry here costs detection rate rather than
// money — re-check the Decodo dashboard + the [Meet] 🚨/✅ signal after
// adjusting this list.
//
// Suffix matches cover the host itself AND any subdomain. Exact matches do
// not — `google.com` exact is intentional so we don't pull `play.google.com`
// or `mtalk.google.com` into the proxied set.
const PROXY_ALLOWLIST_SUFFIXES: readonly string[] = [
  "meet.google.com", // SPA + the $rpc scoring endpoints
  "accounts.google.com", // OAuth / login flow
  "apis.google.com", // Google APIs the Meet client calls during join
  "clients6.google.com", // Meet signaling — hangouts., feedback-pa., scone-pa.
  // Zoom web client — one suffix covers every host the join touches:
  // app.zoom.us (the /wc/ web client), us05web./<region>.zoom.us and
  // zoom.us (invite hosts we rewrite from), events.zoom.us. Testing whether
  // residential egress moves the browser-join anti-bot / RTMS wall.
  // Bandwidth trade-off: Zoom's pre-join assets are heavier than Meet's, so
  // this costs more Decodo bytes per join — but setDirectMode() flips the
  // upstream off at admission, so in-call media stays off the residential link.
  "zoom.us"
]

const PROXY_ALLOWLIST_EXACT: ReadonlySet<string> = new Set([
  "google.com",
  "www.google.com",
  "ip.decodo.com" // our own residential-IP probe
])

function shouldProxy(target: string): boolean {
  if (PROXY_ALLOWLIST_EXACT.has(target)) return true
  return PROXY_ALLOWLIST_SUFFIXES.some(
    (suffix) => target === suffix || target.endsWith(`.${suffix}`)
  )
}

let server: Server | null = null
// Proxy is on from startup. Lazy-enable (SPA loads direct, flip on at join)
// was tested and increased flag rate — Google appears to correlate
// page-load IP with RPC-IP — so we keep upstream active the whole pre-join
// window. setDirectMode() flips it off post-admission.
let useUpstream = true
let exitIp: string | null = null
let currentSessionId: string | null = null
let proxyDisabledReason: string | null = null
// Country code + IANA timezone of the current exit IP (set by logExitIp), so the
// browser can align its locale/timezone with the proxied egress geo instead of a
// hardcoded en-US/UTC. Null until the exit-IP probe runs.
let exitGeo: { country: string | null; timezone: string | null } | null = null
// ASN of the current exit IP (set by logExitIp). The burned-network unit —
// residential IPs rarely repeat but ASNs do. Null until the probe runs.
let exitAsn: number | null = null

export type ProxyTelemetry = {
  enabled: boolean
  mode: "selective" | "none"
  provider: string | null
  type: "residential" | null
  exit_ip: string | null
  exit_asn: number | null
  exit_country: string | null
  exit_timezone: string | null
  session_id: string | null
  disabled_reason: string | null
}

/** Country code + IANA timezone of the current exit IP, or null until probed. */
export function getExitGeo(): { country: string | null; timezone: string | null } | null {
  return exitGeo
}

/** ASN of the current exit IP, or null until the exit-IP probe runs. */
export function getExitAsn(): number | null {
  return exitAsn
}

export function markProxyDisabledReason(reason: string): void {
  proxyDisabledReason = reason
}

export function getProxyTelemetry(): ProxyTelemetry {
  const configured = Boolean(envVars.RESIDENTIAL_PROXY_TEMPLATE)
  // Report UPSTREAM routing state, not local-server existence. The local proxy
  // server stays alive after setDirectMode() (useUpstream=false) so it can be
  // flipped back on — but while direct, traffic does NOT go through the exit,
  // so enabled/mode/exit_* must reflect useUpstream or the detection telemetry
  // records a proxied join that was actually direct.
  const upstreamEnabled = server !== null && useUpstream
  return {
    enabled: upstreamEnabled,
    mode: upstreamEnabled ? "selective" : "none",
    provider: configured ? inferProxyProvider() : null,
    type: configured ? "residential" : null,
    exit_ip: upstreamEnabled ? exitIp : null,
    exit_asn: upstreamEnabled ? exitAsn : null,
    exit_country: upstreamEnabled ? (exitGeo?.country ?? null) : null,
    exit_timezone: upstreamEnabled ? (exitGeo?.timezone ?? null) : null,
    session_id: currentSessionId,
    disabled_reason: upstreamEnabled ? null : proxyDisabledReason
  }
}

/**
 * Country to pin the residential exit to. Per-bot region (set by the user in
 * settings) takes precedence over the RESIDENTIAL_PROXY_COUNTRY env default.
 * Returns "" for no pinning. The per-bot value is fed via GLOBAL once the
 * settings field ships; until then this resolves to the env default.
 */
function resolveProxyCountry(): string {
  // Only let a VALID per-bot value override the env default — an invalid
  // non-empty value (e.g. "USA") must not win and then get blanked downstream,
  // silently discarding a valid RESIDENTIAL_PROXY_COUNTRY.
  const perBot = GLOBAL.get().proxy_country
  if (typeof perBot === "string" && /^[a-z]{2}$/i.test(perBot.trim())) return perBot.trim()
  return envVars.RESIDENTIAL_PROXY_COUNTRY
}

function inferProxyProvider(): string {
  try {
    const host = new URL(envVars.RESIDENTIAL_PROXY_TEMPLATE).hostname
    if (host.includes("decodo")) return "decodo"
    return "unknown"
  } catch {
    return "unknown"
  }
}

// Set of connectionIds that were routed through the residential upstream.
// Used to filter stats so only Decodo-billed traffic is counted.
const proxiedConnectionIds = new Set<number>()

// Accumulated byte counts from closed upstream-proxied connections only.
// trgTxBytes/trgRxBytes are the bytes over the Decodo link (what Decodo bills).
const stats = {
  trgTxBytes: 0,
  trgRxBytes: 0,
  connectionCount: 0
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function logStats(label: string): void {
  // Start with bytes from already-closed proxied connections
  let trgTx = stats.trgTxBytes
  let trgRx = stats.trgRxBytes
  let count = stats.connectionCount

  // Add bytes from proxied connections still open at log time — long-lived
  // keep-alive/H2 tunnels carry most traffic but may not have closed yet.
  if (server) {
    for (const id of proxiedConnectionIds) {
      const cs = server.getConnectionStats(id)
      if (cs) {
        trgTx += cs.trgTxBytes ?? 0
        trgRx += cs.trgRxBytes ?? 0
        count++
      }
    }
  }

  // trgTx + trgRx = bytes over the Decodo residential link — matches dashboard billing
  const ipSuffix = exitIp ? ` | exit IP: ${exitIp}` : ""
  console.log(
    `[ToggleProxy] 📊 ${label} | ` +
      `proxied connections: ${count} | ` +
      `→ Decodo: ${formatBytes(trgTx)} | ` +
      `← Decodo: ${formatBytes(trgRx)} | ` +
      `total (Decodo billed): ${formatBytes(trgTx + trgRx)}` +
      ipSuffix
  )
}

export async function startToggleProxy(
  sessionId: string,
  retryCount = 0,
  sessionSuffix = ""
): Promise<string | null> {
  if (!envVars.RESIDENTIAL_PROXY_TEMPLATE) {
    currentSessionId = null
    proxyDisabledReason = "template_missing"
    console.log("[ToggleProxy] No RESIDENTIAL_PROXY_TEMPLATE configured, skipping proxy")
    return null
  }
  // Decodo session labels must be alphanumeric; bot UUIDs have hyphens.
  // Append the SQS retry count so each requeued pod lands on a different
  // residential IP; sessionSuffix (e.g. "x1") advances the IP again for an
  // in-process retry within the SAME pod without touching retry_count.
  const session = `${sessionId.replace(/-/g, "")}${retryCount}${sessionSuffix}`

  // Optional geo pinning. Decodo username params are dash-appended and go
  // BEFORE `-session-`, so the template must carry a `{GEO}` placeholder there
  // (e.g. `user-<u>{GEO}-session-{SESSION}`). Resolve the country from the
  // per-bot region the user picked in settings, falling back to the env
  // default; empty → no pinning (backward compatible). Only alpha-2 letters
  // are accepted so a bad value can't corrupt the auth string.
  const rawCountry = resolveProxyCountry()
  const country = /^[a-z]{2}$/i.test(rawCountry) ? rawCountry.toLowerCase() : ""
  const geoParam = country ? `-country-${country}` : ""
  if (country && !envVars.RESIDENTIAL_PROXY_TEMPLATE.includes("{GEO}")) {
    console.warn(
      `[ToggleProxy] country=${country} requested but template has no {GEO} placeholder — proceeding without geo pinning`
    )
  }
  const upstreamUrl = envVars.RESIDENTIAL_PROXY_TEMPLATE.replaceAll("{SESSION}", session).replaceAll(
    "{GEO}",
    geoParam
  )
  if (country && envVars.RESIDENTIAL_PROXY_TEMPLATE.includes("{GEO}")) {
    console.log(`[ToggleProxy] 🌍 Pinning residential exit to country: ${country}`)
  }
  currentSessionId = session
  proxyDisabledReason = null
  useUpstream = true

  // Reset stats, proxied-connection tracking, and exit IP for this new session
  stats.trgTxBytes = 0
  stats.trgRxBytes = 0
  stats.connectionCount = 0
  proxiedConnectionIds.clear()
  exitIp = null
  exitAsn = null
  exitGeo = null

  // Re-entrant: the burned-ASN rotation calls startToggleProxy again within the
  // same pod. Tear down any existing server before creating a new one — otherwise
  // its listening socket leaks for the pod's lifetime, and a later failure path
  // (server = null) would leave the browser proxying through an orphaned server
  // while telemetry reports the join as direct.
  if (server) {
    await server.close(true).catch(() => {})
    server = null
  }

  try {
    server = new Server({
      port: 0,
      prepareRequestFunction: ({ connectionId, request }) => {
        // CONNECT requests use "host:port" format, not a full URL
        const target = request.url.includes("://")
          ? new URL(request.url).hostname
          : request.url.split(":")[0]
        if (!shouldProxy(target)) {
          console.log(`[ToggleProxy] DIRECT  → ${target} (not allowlisted)`)
          return {}
        }
        if (useUpstream) {
          proxiedConnectionIds.add(connectionId)
          console.log(`[ToggleProxy] PROXIED → ${target}`)
          return { upstreamProxyUrl: upstreamUrl, ignoreUpstreamProxyCertificate: true }
        }
        console.log(`[ToggleProxy] DIRECT  → ${target} (post-admission)`)
        return {}
      }
    })

    // Accumulate per-connection byte counts as connections close.
    // The local proxy server must stay running after joining (Chrome was launched
    // with --proxy-server pointing here), but setDirectMode() stops routing through
    // the upstream residential proxy — so stats at that point reflect residential usage.
    server.on(
      "connectionClosed",
      ({ connectionId, stats: cs }: { connectionId: number; stats: ConnectionStats }) => {
        if (!proxiedConnectionIds.has(connectionId)) return
        proxiedConnectionIds.delete(connectionId)
        stats.connectionCount++
        stats.trgTxBytes += cs.trgTxBytes ?? 0
        stats.trgRxBytes += cs.trgRxBytes ?? 0
      }
    )

    await server.listen()
    const port = server.port
    const proxyUrl = `http://127.0.0.1:${port}`
    console.log(`[ToggleProxy] ✅ Started on ${proxyUrl} (attempt ${retryCount + 1})`)
    // Verify the upstream is reachable. If not (wrong credentials, server
    // down, etc.), tear down and let the bot run direct.
    const upstreamOk = await logExitIp(upstreamUrl)
    if (!upstreamOk) {
      await server.close(true).catch(() => {})
      server = null
      proxyDisabledReason = "upstream_unreachable"
      return null
    }
    return proxyUrl
  } catch (error) {
    console.error(
      `[ToggleProxy] ❌ Failed to start, proceeding without proxy: ${error instanceof Error ? error.message : String(error)}`
    )
    server = null
    proxyDisabledReason = "start_failed"
    return null
  }
}

/**
 * Probes the residential exit IP via the Decodo upstream and logs it
 * (country/city/ISP/ASN). Talks to the upstream URL directly, NOT via our
 * local toggle proxy — that way the probe works regardless of useUpstream
 * state, and runs once at startup before we've decided whether to flip the
 * toggle on. Bounded to 5s; fails soft on any error.
 */
async function logExitIp(upstreamProxyUrl: string): Promise<boolean> {
  try {
    // axios's `proxy` config doesn't tunnel HTTPS targets through an HTTP
    // proxy via CONNECT correctly. HttpsProxyAgent as `httpsAgent` (with
    // `proxy: false` to disable axios's own proxy handling) issues CONNECT
    // properly.
    const res = await axios.get<{
      proxy?: { ip?: string }
      country?: { code?: string; name?: string }
      city?: { name?: string; time_zone?: string }
      isp?: { isp?: string; asn?: number }
    }>("https://ip.decodo.com/json", {
      httpsAgent: new HttpsProxyAgent(upstreamProxyUrl),
      proxy: false,
      timeout: 5000
    })
    const d = res.data
    const ip = d.proxy?.ip ?? null
    exitIp = ip
    exitAsn = d.isp?.asn ?? null
    exitGeo = { country: d.country?.code ?? null, timezone: d.city?.time_zone ?? null }
    const geo = `${d.country?.code ?? "?"}/${d.city?.name ?? "?"}`
    const isp = `${d.isp?.isp ?? "?"} (AS${d.isp?.asn ?? "?"})`
    console.log(`[ToggleProxy] 🌍 Exit IP: ${ip ?? "unknown"} | ${geo} | ${isp}`)
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[ToggleProxy] ⚠️  Upstream proxy unreachable (${msg}) — continuing without proxy`)
    return false
  }
}

export function setDirectMode(): void {
  useUpstream = false
  // Log residential proxy usage at the moment we stop routing through the upstream.
  // Connections that were still open at this point close shortly after, so the count
  // here is a near-complete picture of residential bandwidth consumed during join.
  logStats("Residential upstream disabled (join complete)")
  console.log("[ToggleProxy] Switched to direct mode (no upstream proxy)")
}

export async function stopToggleProxy(): Promise<void> {
  if (server) {
    try {
      await server.close(true)
      logStats("Final stats at proxy shutdown")
      console.log("[ToggleProxy] Server stopped")
    } catch (error) {
      console.warn(
        `[ToggleProxy] Error stopping server: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    server = null
  }
}
