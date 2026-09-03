import { MeetingEndReason } from "../state-machine/types"

export interface ZoomPasscodeDomState {
  present: boolean
  value: string
  invalid: boolean
  errorText: string
}

export const ZOOM_INVALID_PASSCODE_PATTERN =
  /\b(?:incorrect|invalid|wrong)\b[\s\S]{0,32}\b(?:passcode|password)\b|\b(?:passcode|password)\b[\s\S]{0,32}\b(?:incorrect|invalid|wrong)\b/i.source

const INVALID_PASSCODE_TEXT = new RegExp(ZOOM_INVALID_PASSCODE_PATTERN, "i")

export type ZoomPasscodeFailureReason =
  | MeetingEndReason.ZoomPasscodeRequired
  | MeetingEndReason.ZoomInvalidPasscode

/**
 * Classify Zoom's pre-join passcode form without depending on Playwright's
 * visibility result. Zoom can render this form while Firefox reports it as
 * invisible, so callers collect raw DOM state and classify it here.
 */
export function classifyZoomPasscodeFailure(
  state: ZoomPasscodeDomState,
  suppliedPasscode: string
): ZoomPasscodeFailureReason | null {
  if (!state.present) return null
  if (!suppliedPasscode) return MeetingEndReason.ZoomPasscodeRequired

  if (INVALID_PASSCODE_TEXT.test(state.errorText)) {
    return MeetingEndReason.ZoomInvalidPasscode
  }

  return null
}
