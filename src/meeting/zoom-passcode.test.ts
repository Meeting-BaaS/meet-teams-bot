import { MeetingEndReason } from "../state-machine/types"
import {
  classifyZoomPasscodeFailure,
  type ZoomPasscodeDomState
} from "./zoom-passcode"

const state = (overrides: Partial<ZoomPasscodeDomState> = {}): ZoomPasscodeDomState => ({
  present: true,
  value: "",
  invalid: false,
  errorText: "",
  ...overrides
})

describe("Zoom passcode failure classification", () => {
  it("ignores pages without a passcode field", () => {
    expect(classifyZoomPasscodeFailure(state({ present: false }), "")).toBeNull()
  })

  it("classifies a rendered field with no supplied passcode as required", () => {
    expect(classifyZoomPasscodeFailure(state(), "")).toBe(
      MeetingEndReason.ZoomPasscodeRequired
    )
  })

  it.each(["Incorrect Password", "Invalid meeting passcode", "Password is wrong"])(
    "classifies Zoom's explicit rejection: %s",
    (errorText) => {
      expect(
        classifyZoomPasscodeFailure(
          state({ value: "redacted", invalid: true, errorText }),
          "redacted"
        )
      ).toBe(MeetingEndReason.ZoomInvalidPasscode)
    }
  )

  it("uses aria-invalid when Zoom omits helper text", () => {
    expect(
      classifyZoomPasscodeFailure(state({ value: "redacted", invalid: true }), "redacted")
    ).toBe(MeetingEndReason.ZoomInvalidPasscode)
  })

  it("allows a supplied passcode to be filled before classifying it", () => {
    expect(
      classifyZoomPasscodeFailure(
        state({ invalid: true, errorText: "Meeting passcode is required" }),
        "redacted"
      )
    ).toBeNull()
  })
})
