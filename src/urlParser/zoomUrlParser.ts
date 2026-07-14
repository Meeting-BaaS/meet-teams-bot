import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"

interface ZoomUrlComponents {
  meetingId: string // numeric Zoom meeting id
  password: string // decoded ?pwd= value, or "" when absent
}

/**
 * Parse a Zoom invite URL into its meeting id and passcode.
 *
 * Zoom hands out several URL shapes; we normalise the canonical ones:
 *   https://us05web.zoom.us/j/84335626851?pwd=abc  → { id: 84335626851, pwd: abc }
 *   https://zoom.us/j/84335626851                   → { id: 84335626851, pwd: "" }
 *   https://app.zoom.us/wc/84335626851/join?pwd=abc → { id: 84335626851, pwd: abc }
 *   https://us05web.zoom.us/wc/join/84335626851     → classic web-client join
 *
 * White-label / enterprise portals (zoom-lfx.platform.linuxfoundation.org, corp
 * portals, AWS Chime …) are NOT canonical Zoom hosts. We can't reliably extract
 * an id from them and must not rewrite — getMeetingLink returns the original URL
 * so the bot navigates the portal and a human can VNC in. parseMeetingUrl still
 * needs an id for logging/pathing, so for a non-canonical host we fall back to
 * the first long digit run in the URL, or the raw URL as the id.
 */
export async function parseZoomMeetingUrl(meeting_url: string): Promise<ZoomUrlComponents> {
  let cleanUrl = meeting_url.trim().replace(/^"(.*)"$/, "$1")
  if (cleanUrl.startsWith("zoom.") || cleanUrl.startsWith("app.zoom.")) {
    cleanUrl = `https://${cleanUrl}`
  }

  try {
    const url = new URL(cleanUrl)
    const isCanonicalZoomHost =
      url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")

    // Passcode: ?pwd= is the standard; some portals use ?password=
    const pwd = url.searchParams.get("pwd") || url.searchParams.get("password") || ""

    // Meeting id from the path: /j/<id>, /wc/<id>/join, /wc/join/<id>, /s/<id>
    const pathMatch = url.pathname.match(/\/(?:j|s|wc|wc\/join)\/(\d{8,})/)
    const meetingId = pathMatch?.[1] ?? url.pathname.match(/(\d{8,})/)?.[1]

    if (isCanonicalZoomHost && meetingId) {
      return { meetingId, password: pwd }
    }

    // Non-canonical (white-label) host, or canonical host we couldn't parse:
    // keep an id if we found one, otherwise carry the original URL so the bot
    // can still navigate it. Do NOT throw — a human may complete the portal.
    if (meetingId) {
      return { meetingId, password: pwd }
    }
    return { meetingId: meeting_url, password: pwd }
  } catch (error) {
    GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
    throw error
  }
}

/**
 * Build the Zoom Web Client URL the bot actually navigates.
 * Rewrites ONLY canonical zoom.us hosts to app.zoom.us/wc/<id>/join; everything
 * else (white-label portals, or an already-built /wc/ URL) is returned as-is.
 * Ported from vexa buildZoomWebClientUrl (join/zoom/join.ts).
 */
export function buildZoomWebClientUrl(meetingUrl: string, password?: string): string {
  try {
    const url = new URL(meetingUrl)

    // Zoom Events URLs self-redirect to the web client — leave untouched.
    if (url.hostname === "events.zoom.us") return meetingUrl
    // Already a web-client URL — leave untouched (but ensure pwd is present).
    if (meetingUrl.includes("/wc/")) return meetingUrl

    const isCanonicalZoomHost =
      url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")
    if (!isCanonicalZoomHost) {
      // White-label portal — navigate the original; human assists via VNC.
      return meetingUrl
    }

    const meetingId = url.pathname.match(/\/(?:j|s)\/(\d+)/)?.[1]
    if (!meetingId) {
      throw new Error(`Cannot extract meeting ID from Zoom URL: ${meetingUrl}`)
    }
    const pwd = url.searchParams.get("pwd") || password || ""
    const wcUrl = new URL(`https://app.zoom.us/wc/${meetingId}/join`)
    if (pwd) wcUrl.searchParams.set("pwd", pwd)
    return wcUrl.toString()
  } catch (err) {
    if (meetingUrl.includes("/wc/")) return meetingUrl
    throw new Error(
      `Invalid Zoom meeting URL: ${meetingUrl} — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
