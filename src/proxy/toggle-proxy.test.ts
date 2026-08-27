import { setZoomJoinHost, shouldProxy } from "./toggle-proxy"

// toggle-proxy pulls in the singleton for the geo/rotation helpers. Nothing
// under test reads it — the allowlist is a flat constant, not platform-scoped —
// but the import has to resolve.
jest.mock("../singleton", () => ({
  GLOBAL: { get: () => ({ bot_uuid: "test-bot", proxy_countries: [] }) }
}))

// Module-level state: every test declares the join host it is testing under, so
// one test's registration can never leak into the next.
beforeEach(() => setZoomJoinHost("app.zoom.us"))

describe("residential proxy host selection", () => {
  describe("zoom", () => {
    it("proxies the hosts that make the join decision", () => {
      expect(shouldProxy("app.zoom.us")).toBe(true)
      expect(shouldProxy("zoom.us")).toBe(true)
      expect(shouldProxy("www.zoom.us")).toBe(true)
      expect(shouldProxy("events.zoom.us")).toBe(true)
    })

    it("does NOT proxy the asset CDN", () => {
      // Measured on a real local run: us04st1.zoom.us alone was 15.46 MB of a
      // bot's 16.77 MB residential spend — 92%. The anti-bot check never looks
      // at it.
      expect(shouldProxy("us04st1.zoom.us")).toBe(false)
      expect(shouldProxy("us05st1.zoom.us")).toBe(false)
      expect(shouldProxy("st1.zoom.us")).toBe(false)
      expect(shouldProxy("source.zoom.us")).toBe(false)
      expect(shouldProxy("ssrweb.zoom.us")).toBe(false)
      expect(shouldProxy("us04st-cf.zoom.us")).toBe(false)
    })

    it("does NOT proxy media relays or telemetry", () => {
      // Real hostnames, taken from the Decodo billing export and local runs.
      expect(shouldProxy("zoomiad206247100214rwg.iad.zoom.us")).toBe(false)
      expect(shouldProxy("rwciad.iad.zoom.us")).toBe(false)
      expect(shouldProxy("us.telemetry.zoom.us")).toBe(false)
      expect(shouldProxy("log-gateway.zoom.us")).toBe(false)
      expect(shouldProxy("das.zoom.us")).toBe(false)
    })
  })

  describe("the join host, registered at runtime", () => {
    it("proxies a regional web host the static list does not name", () => {
      setZoomJoinHost("us06web.zoom.us")
      expect(shouldProxy("us06web.zoom.us")).toBe(true)
      // …and only that one. Its neighbours stay direct.
      expect(shouldProxy("us05web.zoom.us")).toBe(false)
    })

    it("proxies a white-label portal host", () => {
      setZoomJoinHost("meet.acmecorp.com")
      expect(shouldProxy("meet.acmecorp.com")).toBe(true)
      expect(shouldProxy("cdn.acmecorp.com")).toBe(false)
    })

    it("replaces rather than accumulates, and an empty host clears it", () => {
      setZoomJoinHost("us06web.zoom.us")
      setZoomJoinHost("")
      expect(shouldProxy("us06web.zoom.us")).toBe(false)
      // The static list is unaffected by clearing the join host.
      expect(shouldProxy("app.zoom.us")).toBe(true)
    })

    it("is case-insensitive", () => {
      setZoomJoinHost("US06Web.Zoom.US")
      expect(shouldProxy("us06web.zoom.us")).toBe(true)
      expect(shouldProxy("US06WEB.ZOOM.US")).toBe(true)
    })
  })

  describe("shared anti-bot infrastructure", () => {
    it("proxies reCAPTCHA, which is what Zoom's wall actually is", () => {
      // Regression test. Scoping these hosts to Meet sent them out of the pod's
      // datacenter IP on a Zoom join and every Zoom bot was walled with
      // zoomAnonymousJoinNotAllowed, while a bot from the old build joined the
      // same meeting four seconds earlier. reCAPTCHA scores the IP that fetches
      // it — it must never be behind a platform branch.
      expect(shouldProxy("google.com")).toBe(true)
      expect(shouldProxy("www.google.com")).toBe(true)
    })

    it("does not pull in the rest of google.com", () => {
      // Exact match, not suffix — these are push/telemetry, not anti-bot.
      expect(shouldProxy("play.google.com")).toBe(false)
      expect(shouldProxy("mtalk.google.com")).toBe(false)
    })

    it("proxies the exit-IP probe", () => {
      expect(shouldProxy("ip.decodo.com")).toBe(true)
    })
  })

  describe("meet", () => {
    it("keeps the existing suffix behaviour", () => {
      expect(shouldProxy("meet.google.com")).toBe(true)
      expect(shouldProxy("accounts.google.com")).toBe(true)
      expect(shouldProxy("apis.google.com")).toBe(true)
      expect(shouldProxy("hangouts.clients6.google.com")).toBe(true)
    })

    it("still excludes the asset hosts that were never allowlisted", () => {
      expect(shouldProxy("www.gstatic.com")).toBe(false)
      expect(shouldProxy("ssl.gstatic.com")).toBe(false)
      expect(shouldProxy("lh3.googleusercontent.com")).toBe(false)
    })
  })

  it("routes anything unlisted direct", () => {
    expect(shouldProxy("example.com")).toBe(false)
    expect(shouldProxy("teams.microsoft.com")).toBe(false)
    // Suffix matching must not be fooled by a lookalike registrable domain.
    expect(shouldProxy("notzoom.us")).toBe(false)
    expect(shouldProxy("evil-app.zoom.us.attacker.com")).toBe(false)
  })
})
