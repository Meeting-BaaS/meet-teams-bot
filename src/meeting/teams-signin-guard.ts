// Session retries when a signed-in bot's pre-join still asks for a guest name.
export const SIGNED_IN_PREJOIN_RETRIES = 2

export type SignedInPreJoinAction = "join_signed_in" | "retry_sign_in" | "join_anonymously" | "fail"

/** A guest name field on the pre-join means Teams opened the meeting signed out. */
export function signedInPreJoinAction(
  guestNameVisible: boolean,
  retriesUsed: number,
  fallback: "fail" | "anonymous"
): SignedInPreJoinAction {
  if (!guestNameVisible) return "join_signed_in"
  if (retriesUsed < SIGNED_IN_PREJOIN_RETRIES) return "retry_sign_in"
  return fallback === "anonymous" ? "join_anonymously" : "fail"
}
