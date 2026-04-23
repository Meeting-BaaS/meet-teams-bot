import { type MeetingContext, MeetingStateType } from "../types"
import type { BaseState } from "./base-state"
import { CleanupState } from "./cleanup-state"

import { ErrorState } from "./error-state"

import { InCallState } from "./in-call-state"
import { InitializationState } from "./initialization-state"
import { RecordingState } from "./recording-state"
import { TerminatedState } from "./terminated-state"
import { WaitingRoomState } from "./waiting-room-state"

export function getStateInstance(type: MeetingStateType, context: MeetingContext): BaseState {
  switch (type) {
    case MeetingStateType.Initialization:
      return new InitializationState(context, type)
    case MeetingStateType.WaitingRoom:
      return new WaitingRoomState(context, type)
    case MeetingStateType.InCall:
      return new InCallState(context, type)
    case MeetingStateType.Recording:
      return new RecordingState(context, type)
    case MeetingStateType.Cleanup:
      return new CleanupState(context, type)
    case MeetingStateType.Error:
      return new ErrorState(context, type)
    case MeetingStateType.Terminated:
      return new TerminatedState(context, type)
    default:
      throw new Error(`Unknown state type: ${type}`)
  }
}
