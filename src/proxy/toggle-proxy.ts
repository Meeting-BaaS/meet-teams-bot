import axios from "axios"
// https-proxy-agent v9 is ESM-only with the modern `exports` field; our
// tsconfig sits on legacy moduleResolution: "node" so TS can't resolve the
// types. Runtime works fine — only the d.ts lookup fails. Suppress until
// the codebase moves to moduleResolution: "bundler" or "node16".
// @ts-expect-error - see comment above; remove this once tsconfig moves on.
import { HttpsProxyAgent } from "https-proxy-agent"
import { Server } from "proxy-chain"
import { envVars } from "../config/env-vars"

// Chrome background services & static-asset CDNs that aren't needed for Meet
// but consume disproportionate residential bandwidth. Always go direct, even
// while the rest of the session is proxied. Exact hostname match — add hosts
// here as Decodo dashboard reveals them.
const PROXY_BYPASS_HOSTS = new Set([
  "optimizationguide-pa.googleapis.com", // Chrome ML model downloads
  "fonts.gstatic.com", // Google Fonts CDN
  "gstatic.com", // Google static asset CDN
  "play.google.com" // Chrome Play Store / extension chatter
])

let server: Server | null = null
let useUpstream = true

export async function startToggleProxy(sessionId: string): Promise<string | null> {
  if (!envVars.RESIDENTIAL_PROXY_TEMPLATE) {
    console.log("[ToggleProxy] No RESIDENTIAL_PROXY_TEMPLATE configured, skipping proxy")
    return null
  }
  // Decodo session labels must be alphanumeric; bot UUIDs have hyphens.
  const session = sessionId.replace(/-/g, "")
  const upstreamUrl = envVars.RESIDENTIAL_PROXY_TEMPLATE.replaceAll("{SESSION}", session)

  try {
    server = new Server({
      port: 0,
      prepareRequestFunction: ({ request }) => {
        // CONNECT requests use "host:port" format, not a full URL
        const target = request.url.includes("://")
          ? new URL(request.url).hostname
          : request.url.split(":")[0]
        if (PROXY_BYPASS_HOSTS.has(target)) {
          console.log(`[ToggleProxy] BYPASS  → ${target}`)
          return {}
        }
        if (useUpstream) {
          console.log(`[ToggleProxy] PROXIED → ${target}`)
          return { upstreamProxyUrl: upstreamUrl }
        }
        console.log(`[ToggleProxy] DIRECT  → ${target}`)
        return {}
      }
    })

    await server.listen()
    const port = server.port
    const proxyUrl = `http://127.0.0.1:${port}`
    console.log(`[ToggleProxy] ✅ Started on ${proxyUrl}`)
    // One-shot exit-IP probe so each bot's log includes the residential IP
    // (and its ISP/country) it will use for the join. Goes through the local
    // toggle proxy on purpose — same path Chrome takes, so the IP we observe
    // here is what Google will see. Fails soft if the upstream is unreachable.
    await logExitIp(proxyUrl)
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
 * Probes the exit IP that the upstream residential proxy has assigned to this
 * bot's session and logs the result. Goes through the local toggle proxy — same
 * path Chrome takes, so the IP we observe is what Google will see. Bounded
 * to 5s so a slow/stuck residential link doesn't delay bot startup; fails
 * soft (log a warning, return) on any error.
 */
async function logExitIp(localProxyUrl: string): Promise<void> {
  try {
    // axios's `proxy` config doesn't tunnel HTTPS targets through an HTTP
    // proxy via CONNECT — proxy-chain returns 400 for the resulting request.
    // HttpsProxyAgent as `httpsAgent` (and `proxy: false` to disable axios's
    // own proxy handling) issues CONNECT correctly.
    const res = await axios.get<{
      proxy?: { ip?: string }
      country?: { code?: string; name?: string }
      city?: { name?: string }
      isp?: { isp?: string; asn?: number }
    }>("https://ip.decodo.com/json", {
      httpsAgent: new HttpsProxyAgent(localProxyUrl),
      proxy: false,
      timeout: 5000
    })
    const d = res.data
    const ip = d.proxy?.ip ?? "unknown"
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
  console.log("[ToggleProxy] Switched to direct mode (no upstream proxy)")
}

export async function stopToggleProxy(): Promise<void> {
  if (server) {
    try {
      await server.close(true)
      console.log("[ToggleProxy] Server stopped")
    } catch (error) {
      console.warn(
        `[ToggleProxy] Error stopping server: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    server = null
  }
}
