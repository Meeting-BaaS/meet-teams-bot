import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"
import { buildZoomWebClientUrl, parseZoomMeetingUrl } from "./zoomUrlParser"

// GLOBAL.setError is called on the throw path; stub the singleton so the parser
// unit tests don't need the full bot runtime.
jest.mock("../singleton", () => ({
  GLOBAL: { setError: jest.fn() }
}))

const setErrorMock = GLOBAL.setError as jest.Mock

describe("Zoom URL Parser", () => {
  beforeEach(() => {
    setErrorMock.mockClear()
  })
  describe("parseZoomMeetingUrl — canonical /j/ URLs", () => {
    test("regional host with pwd", async () => {
      const r = await parseZoomMeetingUrl("https://us05web.zoom.us/j/84335626851?pwd=aBcD1234")
      expect(r.meetingId).toBe("84335626851")
      expect(r.password).toBe("aBcD1234")
    })

    test("bare zoom.us host, no passcode", async () => {
      const r = await parseZoomMeetingUrl("https://zoom.us/j/84335626851")
      expect(r.meetingId).toBe("84335626851")
      expect(r.password).toBe("")
    })

    test("schemeless input", async () => {
      const r = await parseZoomMeetingUrl("zoom.us/j/84335626851?pwd=x")
      expect(r.meetingId).toBe("84335626851")
      expect(r.password).toBe("x")
    })

    test("legacy ?password= param", async () => {
      const r = await parseZoomMeetingUrl("https://zoom.us/j/84335626851?password=secret")
      expect(r.password).toBe("secret")
    })
  })

  describe("parseZoomMeetingUrl — web-client URLs", () => {
    test("react /wc/<id>/join", async () => {
      const r = await parseZoomMeetingUrl("https://app.zoom.us/wc/84335626851/join?pwd=z")
      expect(r.meetingId).toBe("84335626851")
      expect(r.password).toBe("z")
    })

    test("classic /wc/join/<id>", async () => {
      const r = await parseZoomMeetingUrl("https://us05web.zoom.us/wc/join/84335626851")
      expect(r.meetingId).toBe("84335626851")
    })
  })

  describe("parseZoomMeetingUrl — truncated canonical join URLs (terminal)", () => {
    // Seen in prod (bots 4204cdd8 / aaa78332): a line-wrapped invite loses the
    // id after "/j/" and the bot burned all 6 SQS attempts on it. Must throw.
    test("/j/ with no id throws terminal", async () => {
      await expect(parseZoomMeetingUrl("https://us02web.zoom.us/j/")).rejects.toThrow(
        /no meeting ID/
      )
      expect(setErrorMock).toHaveBeenCalledWith(MeetingEndReason.InvalidMeetingUrl)
    })

    test("/j/ with a too-short digit run throws terminal", async () => {
      await expect(parseZoomMeetingUrl("https://zoom.us/j/1234")).rejects.toThrow(
        /no meeting ID/
      )
      expect(setErrorMock).toHaveBeenCalledWith(MeetingEndReason.InvalidMeetingUrl)
    })

    test("/wc/join/ with no id throws terminal", async () => {
      await expect(parseZoomMeetingUrl("https://us05web.zoom.us/wc/join/")).rejects.toThrow(
        /no meeting ID/
      )
      expect(setErrorMock).toHaveBeenCalledWith(MeetingEndReason.InvalidMeetingUrl)
    })

    test("/s/ with no id throws terminal", async () => {
      await expect(parseZoomMeetingUrl("https://zoom.us/s/")).rejects.toThrow(
        /no meeting ID/
      )
      expect(setErrorMock).toHaveBeenCalledWith(MeetingEndReason.InvalidMeetingUrl)
    })

    test("bare /wc with no id throws terminal", async () => {
      await expect(parseZoomMeetingUrl("https://us02web.zoom.us/wc")).rejects.toThrow(
        /no meeting ID/
      )
      expect(setErrorMock).toHaveBeenCalledWith(MeetingEndReason.InvalidMeetingUrl)
    })

    test("thrown error does not leak the ?pwd= passcode", async () => {
      await expect(
        parseZoomMeetingUrl("https://us02web.zoom.us/j/?pwd=SuperSecret123")
      ).rejects.toThrow(/^(?!.*SuperSecret123)/)
    })

    test("personal /my/ links are NOT rejected", async () => {
      const raw = "https://zoom.us/my/lazare.rossi"
      const r = await parseZoomMeetingUrl(raw)
      expect(r.meetingId).toBe(raw)
    })
  })

  describe("parseZoomMeetingUrl — personalized webinar links (?tk=)", () => {
    // The tk token is what admits a registered attendee into a
    // registration-required webinar. Extracting only the numeric id would
    // rewrite to the anonymous /wc/ URL and hit the registration wall
    // (prod 2026-08-03: 136/148 join failures).
    test("/w/ link with tk carries the raw URL so the token survives", async () => {
      const raw = "https://zoom.us/w/99094129400?tk=abc.def&uuid=WN_xxx"
      const r = await parseZoomMeetingUrl(raw)
      expect(r.meetingId).toBe(raw)
    })

    test("regional host /w/ link with tk carries the raw URL", async () => {
      const raw = "https://us06web.zoom.us/w/85290429520?tk=xyz"
      const r = await parseZoomMeetingUrl(raw)
      expect(r.meetingId).toBe(raw)
    })

    test("/w/ link WITHOUT tk still falls back to the numeric id", async () => {
      const r = await parseZoomMeetingUrl("https://zoom.us/w/99094129400?uuid=WN_xxx")
      expect(r.meetingId).toBe("99094129400")
    })
  })

  describe("parseZoomMeetingUrl — white-label portals", () => {
    test("non-canonical host with numeric id falls back to id", async () => {
      const r = await parseZoomMeetingUrl(
        "https://zoom-lfx.platform.linuxfoundation.org/meeting/96088138284?password=p"
      )
      expect(r.meetingId).toBe("96088138284")
      expect(r.password).toBe("p")
    })

    test("non-canonical host without id carries the raw URL", async () => {
      const raw = "https://corp.example.com/portal/landing"
      const r = await parseZoomMeetingUrl(raw)
      expect(r.meetingId).toBe(raw)
    })
  })

  describe("buildZoomWebClientUrl", () => {
    test("rewrites canonical /j/ to app.zoom.us/wc/<id>/join and preserves pwd", () => {
      expect(buildZoomWebClientUrl("https://us05web.zoom.us/j/84335626851?pwd=abc")).toBe(
        "https://app.zoom.us/wc/84335626851/join?pwd=abc"
      )
    })

    test("injects a separately-supplied passcode", () => {
      expect(buildZoomWebClientUrl("https://zoom.us/j/84335626851", "sep")).toBe(
        "https://app.zoom.us/wc/84335626851/join?pwd=sep"
      )
    })

    test("leaves an existing /wc/ URL untouched", () => {
      const wc = "https://app.zoom.us/wc/84335626851/join?pwd=abc"
      expect(buildZoomWebClientUrl(wc)).toBe(wc)
    })

    test("leaves white-label portals untouched", () => {
      const portal = "https://zoom-lfx.platform.linuxfoundation.org/meeting/96088138284?password=p"
      expect(buildZoomWebClientUrl(portal)).toBe(portal)
    })

    test("leaves a personalized ?tk= webinar link byte-identical", () => {
      const tk = "https://zoom.us/w/99094129400?tk=abc.def&uuid=WN_xxx"
      expect(buildZoomWebClientUrl(tk)).toBe(tk)
    })

    test("still rewrites a /j/ URL without tk (no regression)", () => {
      expect(buildZoomWebClientUrl("https://zoom.us/j/84335626851?pwd=x")).toBe(
        "https://app.zoom.us/wc/84335626851/join?pwd=x"
      )
    })

    test("leaves zoom Events URLs untouched", () => {
      const ev = "https://events.zoom.us/ejl/AbCd"
      expect(buildZoomWebClientUrl(ev)).toBe(ev)
    })

    test("canonical /j/ with no id throws terminal without leaking the passcode", () => {
      let thrown: Error | undefined
      try {
        buildZoomWebClientUrl("https://us05web.zoom.us/j/?pwd=SuperSecret123")
      } catch (e) {
        thrown = e as Error
      }
      expect(thrown).toBeDefined()
      expect(thrown!.message).toMatch(/Invalid Zoom meeting URL/)
      expect(thrown!.message).not.toContain("SuperSecret123")
      expect(setErrorMock).toHaveBeenCalledWith(MeetingEndReason.InvalidMeetingUrl)
    })
  })
})
