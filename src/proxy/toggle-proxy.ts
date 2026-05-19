import axios from "axios"
// https-proxy-agent v9 is ESM-only with the modern `exports` field; our
// tsconfig sits on legacy moduleResolution: "node" so TS can't resolve the
// types. Runtime works fine — only the d.ts lookup fails. Suppress until
// the codebase moves to moduleResolution: "bundler" or "node16".
// @ts-expect-error - see comment above; remove this once tsconfig moves on.
import { HttpsProxyAgent } from "https-proxy-agent"
import { Server } from "proxy-chain"
import type { ConnectionStats } from "proxy-chain"
import { envVars } from "../config/env-vars"

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
  "clients6.google.com" // Meet signaling — hangouts., feedback-pa., scone-pa.
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

// Accumulated byte counts from closed connections, reset on each startToggleProxy call.
// srcTx/srcRx = bytes between Chrome and local proxy; trgTx/trgRx = bytes between local
// proxy and the upstream residential proxy (or target when in direct mode).
const stats = {
  srcTxBytes: 0,
  srcRxBytes: 0,
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
  // Start with bytes from already-closed connections
  let srcTx = stats.srcTxBytes
  let srcRx = stats.srcRxBytes
  let trgTx = stats.trgTxBytes
  let trgRx = stats.trgRxBytes
  let count = stats.connectionCount

  // Add bytes from connections still open at log time — these are long-lived
  // keep-alive/H2 tunnels that carry most of the traffic but haven't closed yet.
  if (server) {
    for (const id of server.getConnectionIds()) {
      const cs = server.getConnectionStats(id)
      if (cs) {
        srcTx += cs.srcTxBytes
        srcRx += cs.srcRxBytes
        trgTx += cs.trgTxBytes ?? 0
        trgRx += cs.trgRxBytes ?? 0
        count++
      }
    }
  }

  const ipSuffix = exitIp ? ` | exit IP: ${exitIp}` : ""
  console.log(
    `[ToggleProxy] 📊 ${label} | ` +
      `connections: ${count} | ` +
      `client→proxy: ${formatBytes(srcTx)} | ` +
      `proxy→client: ${formatBytes(srcRx)} | ` +
      `proxy→target: ${formatBytes(trgTx)} | ` +
      `target→proxy: ${formatBytes(trgRx)} | ` +
      `total: ${formatBytes(srcTx + srcRx)}` +
      ipSuffix
  )
}

export async function startToggleProxy(sessionId: string): Promise<string | null> {
  if (!envVars.RESIDENTIAL_PROXY_TEMPLATE) {
    console.log("[ToggleProxy] No RESIDENTIAL_PROXY_TEMPLATE configured, skipping proxy")
    return null
  }
  // Decodo session labels must be alphanumeric; bot UUIDs have hyphens.
  const session = sessionId.replace(/-/g, "")
  const upstreamUrl = envVars.RESIDENTIAL_PROXY_TEMPLATE.replaceAll("{SESSION}", session)

  // Reset stats and exit IP for this new session
  stats.srcTxBytes = 0
  stats.srcRxBytes = 0
  stats.trgTxBytes = 0
  stats.trgRxBytes = 0
  stats.connectionCount = 0
  exitIp = null

  try {
    server = new Server({
      port: 0,
      prepareRequestFunction: ({ request }) => {
        // CONNECT requests use "host:port" format, not a full URL
        const target = request.url.includes("://")
          ? new URL(request.url).hostname
          : request.url.split(":")[0]
        if (!shouldProxy(target)) {
          console.log(`[ToggleProxy] DIRECT  → ${target} (not allowlisted)`)
          return {}
        }
        if (useUpstream) {
          console.log(`[ToggleProxy] PROXIED → ${target}`)
          return { upstreamProxyUrl: upstreamUrl }
        }
        console.log(`[ToggleProxy] DIRECT  → ${target} (post-admission)`)
        return {}
      }
    })

    // Accumulate per-connection byte counts as connections close.
    // The local proxy server must stay running after joining (Chrome was launched
    // with --proxy-server pointing here), but setDirectMode() stops routing through
    // the upstream residential proxy — so stats at that point reflect residential usage.
    server.on("connectionClosed", ({ stats: cs }: { connectionId: number; stats: ConnectionStats }) => {
      stats.connectionCount++
      stats.srcTxBytes += cs.srcTxBytes
      stats.srcRxBytes += cs.srcRxBytes
      stats.trgTxBytes += cs.trgTxBytes ?? 0
      stats.trgRxBytes += cs.trgRxBytes ?? 0
    })

    await server.listen()
    const port = server.port
    const proxyUrl = `http://127.0.0.1:${port}`
    console.log(`[ToggleProxy] ✅ Started on ${proxyUrl}`)
    // One-shot exit-IP probe. Goes straight to the residential upstream
    // (bypasses our local toggle) so we always see the IP regardless of
    // useUpstream state. Fails soft if the upstream is unreachable.
    await logExitIp(upstreamUrl)
    return proxyUrl
  } catch (error) {
    console.error(
      `[ToggleProxy] ❌ Failed to start, proceeding without proxy: ${error instanceof Error ? error.message : String(error)}`
    )
    server = null
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
async function logExitIp(upstreamProxyUrl: string): Promise<void> {
  try {
    // axios's `proxy` config doesn't tunnel HTTPS targets through an HTTP
    // proxy via CONNECT correctly. HttpsProxyAgent as `httpsAgent` (with
    // `proxy: false` to disable axios's own proxy handling) issues CONNECT
    // properly.
    const res = await axios.get<{
      proxy?: { ip?: string }
      country?: { code?: string; name?: string }
      city?: { name?: string }
      isp?: { isp?: string; asn?: number }
    }>("https://ip.decodo.com/json", {
      httpsAgent: new HttpsProxyAgent(upstreamProxyUrl),
      proxy: false,
      timeout: 5000
    })
    const d = res.data
    const ip = d.proxy?.ip ?? "unknown"
    exitIp = ip
    const geo = `${d.country?.code ?? "?"}/${d.city?.name ?? "?"}`
    const isp = `${d.isp?.isp ?? "?"} (AS${d.isp?.asn ?? "?"})`
    console.log(`[ToggleProxy] 🌍 Exit IP: ${ip} | ${geo} | ${isp}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[ToggleProxy] Could not verify exit IP: ${msg}`)
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
