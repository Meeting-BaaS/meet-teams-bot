import type { MeetingProvider } from "../types"

export function detectMeetingProvider(url: string): MeetingProvider {
  if (url.includes("https://teams")) {
    return "Teams"
  }
  if (url.includes("https://meet")) {
    return "Meet"
  }
  throw new Error("Unsupported meeting provider")
}
