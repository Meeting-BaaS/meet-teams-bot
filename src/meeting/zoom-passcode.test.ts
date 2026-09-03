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

  it("does not trust retained aria-invalid without explicit rejection text", () => {
    expect(
      classifyZoomPasscodeFailure(
        state({ value: "redacted", invalid: true, errorText: "Meeting passcode is required" }),
        "redacted"
      )
    ).toBeNull()
  })

  it("allows a supplied passcode to be filled before validation clears", () => {
    expect(
      classifyZoomPasscodeFailure(
        state({ value: "redacted", invalid: true }),
        "redacted"
      )
    ).toBeNull()
  })
})
