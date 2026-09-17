// Session retries when a signed-in bot's pre-join is not confirmed signed in.
export const SIGNED_IN_PREJOIN_RETRIES = 2

// signed_out: a guest name field shows. unresolved: no pre-join rendered at all.
export type PreJoinState = "signed_in" | "signed_out" | "unresolved"

export type SignedInPreJoinAction = "join_signed_in" | "retry_sign_in" | "join_anonymously" | "fail"

/** Only a confirmed signed-in pre-join joins as the account; anything else retries, then falls back. */
export function signedInPreJoinAction(
  state: PreJoinState,
  retriesUsed: number,
  fallback: "fail" | "anonymous"
): SignedInPreJoinAction {
  if (state === "signed_in") return "join_signed_in"
  if (retriesUsed < SIGNED_IN_PREJOIN_RETRIES) return "retry_sign_in"
  return fallback === "anonymous" ? "join_anonymously" : "fail"
}
