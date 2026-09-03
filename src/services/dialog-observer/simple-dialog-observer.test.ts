import { SimpleDialogObserver } from "./simple-dialog-observer"
import type { MeetingContext } from "../../state-machine/types"

jest.mock("../../singleton", () => ({
  GLOBAL: { get: () => ({ meeting_platform: "meet" }) }
}))
jest.mock("../html-snapshot-service", () => ({
  HtmlSnapshotService: { getInstance: () => ({ captureSnapshot: async () => {} }) }
}))

class Probe extends SimpleDialogObserver {
  abandoned(name: string) {
    return this.isAbandoned(name)
  }
  fail(name: string) {
    this.recordDismissFailure(name)
  }
}

describe("SimpleDialogObserver dismissal budget", () => {
  it("abandons a pattern after MAX_DISMISS_ATTEMPTS failures and not before", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const probe = new Probe({} as MeetingContext)
    const max = (SimpleDialogObserver as unknown as { MAX_DISMISS_ATTEMPTS: number })
      .MAX_DISMISS_ATTEMPTS

    for (let i = 1; i < max; i++) {
      probe.fail("camera_permission")
      expect(probe.abandoned("camera_permission")).toBe(false)
    }
    probe.fail("camera_permission")
    expect(probe.abandoned("camera_permission")).toBe(true)
    // Other patterns keep their own budget.
    expect(probe.abandoned("generic_dismiss")).toBe(false)
    warn.mockRestore()
  })
})
