import { GLOBAL } from "./singleton"
import { getErrorMessageFromCode, MeetingEndReason } from "./state-machine/types"

describe("Global error replacement", () => {
  beforeEach(() => GLOBAL.resetErrorState())
  afterEach(() => GLOBAL.resetErrorState())

  it("replaces a protected terminal reason when stronger evidence exists", () => {
    GLOBAL.setError(MeetingEndReason.ExitingMeetingBeforeRecord)

    GLOBAL.replaceError(MeetingEndReason.ZoomAnonymousJoinNotAllowed)

    expect(GLOBAL.getEndReason()).toBe(MeetingEndReason.ZoomAnonymousJoinNotAllowed)
    expect(GLOBAL.getErrorMessage()).toBe(
      getErrorMessageFromCode(MeetingEndReason.ZoomAnonymousJoinNotAllowed)
    )
  })
})
