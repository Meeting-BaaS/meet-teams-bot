import { SIGNED_IN_PREJOIN_RETRIES, signedInPreJoinAction } from "./teams-signin-guard"

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
