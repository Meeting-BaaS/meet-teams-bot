import {
  personalTeamsMeeting,
  SIGNED_IN_PREJOIN_RETRIES,
  signedInPreJoinAction
} from "./teams-signin-guard"

describe("personalTeamsMeeting", () => {
  it("reads the meeting ID and passcode from a teams.live.com link", () => {
    expect(personalTeamsMeeting("https://teams.live.com/meet/9316626699519?p=Abc123XyZ")).toEqual({
      meetingId: "9316626699519",
      passcode: "Abc123XyZ"
    })
  })

  it("keeps working after the parser adds anon=true", () => {
    expect(
      personalTeamsMeeting("https://teams.live.com/meet/9316626699519?p=Abc123XyZ&anon=true")
    ).toEqual({ meetingId: "9316626699519", passcode: "Abc123XyZ" })
  })

  it("returns an empty passcode when the link has none", () => {
    expect(personalTeamsMeeting("https://teams.live.com/meet/9316626699519")).toEqual({
      meetingId: "9316626699519",
      passcode: ""
    })
  })

  it.each([
    "https://teams.microsoft.com/meet/33493510506560?p=abc",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d",
    "https://teams.live.com/light-meetings/launch?coords=abc",
    "https://otherteams.live.com/meet/9316626699519?p=abc",
    "https://teams.live.com/meet/9316626699519abc?p=abc",
    "not a url"
  ])("ignores %p", (link) => {
    expect(personalTeamsMeeting(link)).toBeNull()
  })
})

describe("signedInPreJoinAction", () => {
  it.each(["anonymous", "fail"] as const)(
    "joins signed in on a confirmed signed-in pre-join (fallback %s)",
    (fallback) => {
      expect(signedInPreJoinAction("signed_in", 0, fallback)).toBe("join_signed_in")
      expect(signedInPreJoinAction("signed_in", SIGNED_IN_PREJOIN_RETRIES, fallback)).toBe(
        "join_signed_in"
      )
    }
  )

  it.each(["signed_out", "unresolved"] as const)(
    "retries the sign-in on a %s pre-join while retries remain",
    (state) => {
      for (let used = 0; used < SIGNED_IN_PREJOIN_RETRIES; used++) {
        expect(signedInPreJoinAction(state, used, "anonymous")).toBe("retry_sign_in")
        expect(signedInPreJoinAction(state, used, "fail")).toBe("retry_sign_in")
      }
    }
  )

  it.each(["signed_out", "unresolved"] as const)(
    "joins as a guest on a %s pre-join once retries are spent and the fallback is anonymous",
    (state) => {
      expect(signedInPreJoinAction(state, SIGNED_IN_PREJOIN_RETRIES, "anonymous")).toBe(
        "join_anonymously"
      )
    }
  )

  it.each(["signed_out", "unresolved"] as const)(
    "fails on a %s pre-join once retries are spent and the fallback is fail",
    (state) => {
      expect(signedInPreJoinAction(state, SIGNED_IN_PREJOIN_RETRIES, "fail")).toBe("fail")
    }
  )
})
