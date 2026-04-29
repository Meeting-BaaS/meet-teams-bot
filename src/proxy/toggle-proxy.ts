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

export async function startToggleProxy(): Promise<string | null> {
  const upstreamUrl = envVars.RESIDENTIAL_PROXY_URL
  if (!upstreamUrl) {
    console.log("[ToggleProxy] No RESIDENTIAL_PROXY_URL configured, skipping proxy")
    return null
  }

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
    return proxyUrl
  } catch (error) {
    console.error(
      `[ToggleProxy] ❌ Failed to start, proceeding without proxy: ${error instanceof Error ? error.message : String(error)}`
    )
    server = null
    return null
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
