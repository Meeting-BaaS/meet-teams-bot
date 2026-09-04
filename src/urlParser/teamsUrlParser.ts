import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"
import { formatError } from "../utils/Logger"

interface TeamsUrlComponents {
  meetingId: string
  password: string
}

/**
 * Teams is not served from a fixed set of hostnames and never will be again.
 * Besides the global cloud and personal Teams, meetings arrive on the unified
 * Microsoft 365 domain (teams.cloud.microsoft) and on the sovereign / national
 * partner clouds, which run the same web client on their own domain
 * (teams.sovcloud.fr in France, with more announced across the EU). A hostname
 * allowlist makes every new one a support ticket, so recognize Teams by URL
 * SHAPE and use the hostname only as a hint.
 *
 * Keep this in step with isTeamsUrl in the API server's utils/meeting-url.ts:
 * a URL accepted there but rejected here reaches the bot and dies on
 * "Invalid Teams URL" instead.
 */
const TEAMS_PATH_SHAPES = [
  /^\/l\//, // deep links: /l/meetup-join/, /l/meeting/…
  /^\/v2\//, // the join format transformTeamsLink rewrites to
  /^\/meet\//, // short join codes
  /^\/dl\/launcher\//, // launcher shell
  /\/light-meetings\/launch/ // personal/free Teams launcher
]

export function isTeamsUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase()
  // The classic web client keeps the deep link in the FRAGMENT
  // (teams.microsoft.com/_#/l/meetup-join/…), so the signature has to include it.
  const signature = `${path}${url.hash.toLowerCase()}`

  // Unmistakably Teams on ANY host — this is what makes the next sovereign
  // cloud work without a code change.
  if (signature.includes("/l/meetup-join/") || signature.includes("/light-meetings/launch")) {
    return true
  }

  // The remaining shapes are generic enough to need a host that names Teams.
  // The path check is what keeps teams.zoom.us (a Zoom vanity host carrying a
  // "teams" label) out.
  const namesTeams = url.hostname.toLowerCase().split(".").includes("teams")
  return namesTeams && TEAMS_PATH_SHAPES.some((shape) => shape.test(path))
}

const SAFELINKS_WRAPPER = /^https:\/\/[^/]*safelinks\.protection\.outlook\.com\//i

function convertLightMeetingToStandard(url: URL): string {
  const coords = url.searchParams.get("coords")
  if (!coords) {
    GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
    throw new Error("Missing coordinates in Teams URL")
  }

  try {
    // TODO: decodeURIComponent after atob is unnecessary (searchParams.get already URL-decodes)
    // and could cause URIError if decoded JSON contains % characters. Left as-is for now since
    // this has been working in production for ~1 year.
    const decodedCoords = JSON.parse(decodeURIComponent(atob(coords)))
    const { conversationId, tenantId, messageId, organizerId } = decodedCoords
    if (!conversationId || !tenantId || !messageId) {
      GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
      throw new Error("Invalid Teams URL structure")
    }

    // Build the working link format directly instead of standard format
    const context = {
      Tid: tenantId,
      ...(organizerId ? { Oid: organizerId } : {})
    }

    // Authenticated bots join as the signed-in user; only anonymous bots pass anon=true.
    const anonSuffix = GLOBAL.get().teams_login_config ? "" : "&anon=true"
    // url.origin, not a hard-coded teams.microsoft.com: a sovereign-cloud link
    // rewritten onto the global cloud points the bot at a tenant that does not
    // exist there.
    return `${url.origin}/v2/?meetingjoin=true#/l/meetup-join/${conversationId}/${messageId}?context=${encodeURIComponent(JSON.stringify(context))}${anonSuffix}`
  } catch (e) {
    console.error("🥕❌ Error converting light meeting URL:", formatError(e))
    GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
    throw new Error("Failed to convert Teams light meeting URL")
  }
}

function transformTeamsLink(originalLink: string): string {
  try {
    // Check if it's already in the working format
    if (originalLink.includes("/v2/?meetingjoin=true")) {
      return originalLink
    }

    const url = new URL(originalLink)

    // NOTE on authenticated bots: teams.microsoft.com/meet/<code> server-redirects to
    // the "anon=true" launcher even for a signed-in user — but that's just the launcher
    // shell. A human signed into Teams who opens this exact raw link clicks "Continue on
    // this browser" and joins AUTHENTICATED, because the browser session (login.micro-
    // softonline.com + teams cookies) carries through. So we pass the raw /meet/ link
    // UNCHANGED and let the signed-in page + "Continue on this browser" do the rest.
    // (An earlier /v2/#/meet/<code> rewrite was unverified and did not help.)

    // Handle light-meetings format
    if (url.pathname.includes("/light-meetings/launch")) {
      console.log("🥕➡️ Detected light-meetings URL, converting to working format")
      return convertLightMeetingToStandard(url)
    }

    // Extract the important parts from the original URL. Host-agnostic on
    // purpose: the same deep link is served by every Teams cloud, only the
    // origin differs.
    const regex = /\/l\/meetup-join\/(.*?)\/(\d+)\?context=(.*?)(?:$|&)/
    const match = originalLink.match(regex)

    if (!match || match.length < 4) {
      return originalLink
    }

    const [_, threadId, timestamp, context] = match

    // Build the working link format on the URL's OWN origin. Authenticated bots
    // join as the signed-in user; only anonymous bots pass anon=true.
    const anonSuffix = GLOBAL.get().teams_login_config ? "" : "&anon=true"
    return `${url.origin}/v2/?meetingjoin=true#/l/meetup-join/${threadId}/${timestamp}?context=${context}${anonSuffix}`
  } catch (error) {
    console.error("Error transforming Teams link:", formatError(error))
    return originalLink
  }
}

export function parseMeetingUrlFromJoinInfos(meeting_url: string): TeamsUrlComponents {
  let transformed_meeting_url = meeting_url
  try {
    if (!transformed_meeting_url) {
      GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
      throw new Error("No meeting URL provided")
    }

    console.log("Parsing meeting URL:", transformed_meeting_url)

    // Unwrap redirect wrappers: Google's redirect, and Microsoft Defender
    // SafeLinks, which rewrites every link in an Outlook invite — the wrapper's
    // hostname is all a host check would ever see.
    if (transformed_meeting_url.startsWith("https://www.google.com/url")) {
      const url = new URL(transformed_meeting_url)
      transformed_meeting_url = url.searchParams.get("q") || transformed_meeting_url
    } else if (SAFELINKS_WRAPPER.test(transformed_meeting_url)) {
      const url = new URL(transformed_meeting_url)
      transformed_meeting_url = url.searchParams.get("url") || transformed_meeting_url
    }

    // Decode URL if needed
    if (transformed_meeting_url.startsWith("https%3A")) {
      transformed_meeting_url = decodeURIComponent(transformed_meeting_url)
    }

    const url = new URL(transformed_meeting_url)

    // Personal / free Teams keeps its own branch: its launcher formats
    // (dl/launcher, light-meetings with a meetingCode) are specific to that
    // product, not to the hostname.
    if (url.hostname.endsWith("teams.live.com")) {
      // Handle launcher/deep-link wrapper URLs
      // e.g. teams.live.com/dl/launcher/launcher.html?url=/_#/meet/123?p=abc&anon=true
      if (url.pathname.startsWith("/dl/launcher/")) {
        const embeddedPath = url.searchParams.get("url")
        if (embeddedPath) {
          const meetMatch = embeddedPath.match(/\/meet\/(\d+)/)
          const pMatch = embeddedPath.match(/[?&]p=([^&]+)/)
          if (meetMatch) {
            const directUrl = `${url.origin}/meet/${meetMatch[1]}${pMatch ? `?p=${pMatch[1]}&anon=true` : "?anon=true"}`
            console.log(`Detected Teams launcher URL, resolved to: ${directUrl}`)
            return {
              meetingId: directUrl,
              password: pMatch ? pMatch[1] : ""
            }
          }
        }
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw new Error("Invalid Teams launcher URL: could not extract meeting info")
      }

      // Handle personal/free Teams light-meetings launcher URLs
      // e.g. teams.live.com/light-meetings/launch?coords=<base64>&p=abc&anon=true
      // The coords param is base64-encoded JSON with meetingCode + passcode
      if (url.pathname.includes("/light-meetings/launch")) {
        const coords = url.searchParams.get("coords")
        if (coords) {
          try {
            const decoded = JSON.parse(atob(coords))
            if (decoded.meetingCode) {
              const passcode = decoded.passcode || url.searchParams.get("p") || ""
              const directUrl = `${url.origin}/meet/${decoded.meetingCode}${passcode ? `?p=${passcode}&anon=true` : "?anon=true"}`
              console.log(`Detected Teams light-meetings launcher URL, resolved to: ${directUrl}`)
              return {
                meetingId: directUrl,
                password: passcode
              }
            }
          } catch (e) {
            console.error("Error parsing light-meetings coords:", formatError(e))
          }
        }
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw new Error("Invalid Teams light-meetings URL: could not extract meeting info from coords")
      }

      const meetPath = url.pathname.split("/meet/")[1]
      if (!meetPath) {
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw new Error("Invalid Teams live URL format")
      }
      return {
        meetingId: transformed_meeting_url,
        password: url.searchParams.get("p") || ""
      }
    }

    // Every other Teams cloud — the global one, the unified Microsoft 365
    // domain, and the sovereign / national partner clouds — serves the same web
    // client, so match on shape instead of on a hostname list. transformTeamsLink
    // rewrites onto the URL's own origin, so a sovereign link stays on its own
    // cloud; a URL it does not recognize is returned untouched, which is already
    // how raw /meet/<code> links are handled.
    if (isTeamsUrl(url)) {
      console.log(
        `🥕🥕🥕 Detected Teams URL on ${url.hostname}: ${transformed_meeting_url}\n, transforming to more compatible format 🥕🥕🥕`
      )
      const transformedUrl = transformTeamsLink(transformed_meeting_url)
      console.log("Using transformed Teams URL:", transformedUrl)
      return {
        meetingId: transformedUrl,
        password: url.searchParams.get("p") || ""
      }
    }

    GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
    throw new Error("Invalid Teams URL")
  } catch (error) {
    GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
    throw error
  }
}

// // Export for testing
// export const __testing = {
//     convertLightMeetingToStandard,
//     convertStandardToLightMeeting
// }
