// Zoom network speaker observation. The Node sink and bridge are shared with
// Meet/Teams, so re-export their contract and only add Zoom's diag shape here.

export type {
  ChatMessage,
  NetworkPayload,
  NetworkUser
} from "../../meet/network-interception/types"

// Counters the browser bundle publishes for Node to read. All non-PII, so they
// are safe to log every meeting.
export type ZoomNetDiag = {
  wsCreated: number
  wsFrames: number
  jsonFrames: number
  workerMsgs: number
  rosterFrames: number
  rosterParticipants: number
  speakerFrames: number
  rtcCreated: number
  receiversAdded: number
  csrcAvailable: boolean
  csrcMapped: number
  broadcasts: number
  queueLen: number
  // opcode -> frame count
  evtCounts: Record<string, number>
  // keys that produced a speaker hit
  speakerKeys: string[]
  // opcode -> sampled key paths ("body.users[].dn2:string"). Paths only, no values.
  evtShapes: Record<string, string[]>
  // observed nLevel range; -1 = never seen
  levelMin: number
  levelMax: number
  // true once nLevel has been seen both zero and non-zero
  levelsAuthoritative: boolean
  // opcode the active speaker was learned from (-1 = not yet)
  activeSpeakerEvt: number
}
