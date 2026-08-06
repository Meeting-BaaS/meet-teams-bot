import type { NetworkUser } from "./meeting/meet/network-interception/types"
import type { Participant } from "./types"

/**
 * The global speaker registry is append-only and ends up in the final payload,
 * so who gets written into it is a decision the network path has to make
 * correctly the first time. These tests drive the real network update with the
 * surrounding services stubbed out.
 */

const registeredSpeakers: string[] = []
const registeredParticipants: string[] = []
let params: Record<string, unknown> = {}

// The real registries are append-once and never remove, which is the whole
// reason the bot has to be kept out of them in the first place.
function addOnce(registry: string[], name: string) {
  if (!registry.includes(name)) registry.push(name)
}

jest.mock("./singleton", () => ({
  GLOBAL: {
    get: () => params,
    addParticipantIfNotExists: (participant: Participant) =>
      addOnce(registeredParticipants, participant.name),
    addSpeakerIfNotExists: (participant: Participant) =>
      addOnce(registeredSpeakers, participant.name)
  }
}))

jest.mock("./streaming", () => ({ Streaming: { instance: null } }))

jest.mock("./state-machine/machine", () => ({
  MeetingStateMachine: {
    instance: {
      getStartTime: () => 1785941000000,
      getContext: () => ({ noSpeakerDetectedTime: null }),
      updateParticipantState: () => {}
    }
  }
}))

jest.mock("./browser/page-logger", () => ({ enablePrintPageLogs: () => {} }))

jest.mock("./utils/PathManager", () => ({
  PathManager: { getInstance: () => ({ getSpeakerLogPath: () => "/dev/null" }) }
}))

jest.mock("./utils/PiiRedactor", () => ({
  PiiRedactor: { registerSpeaker: () => {}, redact: (input: string) => input }
}))

import { SpeakerManager } from "./speaker-manager"

function networkUser(name: string, isSpeaking: boolean, deviceId: string): NetworkUser {
  return { name, fullName: name, isSpeaking, deviceId } as NetworkUser
}

describe("SpeakerManager network speaker registration", () => {
  beforeEach(() => {
    registeredSpeakers.length = 0
    registeredParticipants.length = 0
    params = { bot_name: "SPEAKER SEP Test", streaming_input: undefined }
    // Each test gets its own manager: the singleton carries speaker state.
    ;(SpeakerManager as unknown as { instance: SpeakerManager | null }).instance = null
    jest.spyOn(console, "table").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("never registers a recording bot as a speaker", async () => {
    await SpeakerManager.getInstance().handleNetworkSpeakerUpdate(
      [networkUser("SPEAKER SEP Test", true, "device-bot"), networkUser("Amr El Shimy", true, "device-1")],
      1785941000000
    )

    expect(registeredSpeakers).toEqual(["Amr El Shimy"])
    // Still a participant: the bot belongs in the roster, just not on the floor.
    expect(registeredParticipants).toContain("SPEAKER SEP Test")
  })

  it("registers a bot that streams audio into the meeting", async () => {
    params = { bot_name: "Voice Agent", streaming_input: "wss://example.test/audio" }

    await SpeakerManager.getInstance().handleNetworkSpeakerUpdate(
      [networkUser("Voice Agent", true, "device-bot")],
      1785941000000
    )

    expect(registeredSpeakers).toEqual(["Voice Agent"])
  })

  it("registers humans who share nothing with the bot name", async () => {
    await SpeakerManager.getInstance().handleNetworkSpeakerUpdate(
      [networkUser("Johnny", true, "device-2"), networkUser("Silent Sam", false, "device-3")],
      1785941000000
    )

    expect(registeredSpeakers).toEqual(["Johnny"])
  })
})
