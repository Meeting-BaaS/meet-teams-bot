import { SIGNED_IN_PREJOIN_RETRIES, signedInPreJoinAction } from "./teams-signin-guard"

describe("signedInPreJoinAction", () => {
  it.each(["anonymous", "fail"] as const)(
    "joins signed in when no guest name field shows (fallback %s)",
    (fallback) => {
      expect(signedInPreJoinAction(false, 0, fallback)).toBe("join_signed_in")
      expect(signedInPreJoinAction(false, SIGNED_IN_PREJOIN_RETRIES, fallback)).toBe(
        "join_signed_in"
      )
    }
  )

  it("retries the sign-in while retries remain", () => {
    for (let used = 0; used < SIGNED_IN_PREJOIN_RETRIES; used++) {
      expect(signedInPreJoinAction(true, used, "anonymous")).toBe("retry_sign_in")
      expect(signedInPreJoinAction(true, used, "fail")).toBe("retry_sign_in")
    }
  })

  it("joins as a guest once retries are spent and the fallback is anonymous", () => {
    expect(signedInPreJoinAction(true, SIGNED_IN_PREJOIN_RETRIES, "anonymous")).toBe(
      "join_anonymously"
    )
  })

  it("fails once retries are spent and the fallback is fail", () => {
    expect(signedInPreJoinAction(true, SIGNED_IN_PREJOIN_RETRIES, "fail")).toBe("fail")
  })
})
