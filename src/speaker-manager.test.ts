import type { NetworkUser } from "./meeting/meet/network-interception/types"
import type { Participant, SpeakerData } from "./types"

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

let networkInterceptionFailed = false
let diarizationFallbackTriggered = false
let rearmedNetworkDiarization = false

jest.mock("./singleton", () => ({
  GLOBAL: {
    get: () => params,
    addParticipantIfNotExists: (participant: Participant) =>
      addOnce(registeredParticipants, participant.name),
    addSpeakerIfNotExists: (participant: Participant) =>
      addOnce(registeredSpeakers, participant.name),
    hasNetworkInterceptionSetupFailed: () => networkInterceptionFailed,
    hasDiarizationFallbackTriggered: () => diarizationFallbackTriggered,
    hasRearmedNetworkDiarization: () => rearmedNetworkDiarization
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

// The observers run in the page with no id manager, so they emit the id-0
// sentinel; reconciliation happens node-side.
function uiSpeaker(name: string, isSpeaking: boolean): SpeakerData {
  return { name, id: 0, timestamp: 1785941000000, isSpeaking }
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

/**
 * The UI bridge feeds the diarization only while the network path has nothing:
 * a participant's audio track spins up seconds after they first speak, while
 * Meet's UI indicator fires immediately. Once the network path reports a real
 * speaker it is authoritative, unless it is later retired by the fallback.
 */
describe("SpeakerManager UI bridge arbitration", () => {
  beforeEach(() => {
    registeredSpeakers.length = 0
    registeredParticipants.length = 0
    params = { bot_name: "SPEAKER SEP Test", streaming_input: undefined }
    networkInterceptionFailed = false
    diarizationFallbackTriggered = false
    rearmedNetworkDiarization = false
    ;(SpeakerManager as unknown as { instance: SpeakerManager | null }).instance = null
    jest.spyOn(console, "table").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("passes UI events through while the network path has no speaker yet", async () => {
    await SpeakerManager.getInstance().handleUiBridgeUpdate([uiSpeaker("Early Speaker", true)])

    expect(registeredSpeakers).toEqual(["Early Speaker"])
  })

  it("mutes UI events after the network path reports its first speaker", async () => {
    const manager = SpeakerManager.getInstance()
    await manager.handleNetworkSpeakerUpdate([networkUser("Net Speaker", true, "device-1")], 1785941000000)

    await manager.handleUiBridgeUpdate([uiSpeaker("Late UI Speaker", true)])

    expect(registeredSpeakers).toEqual(["Net Speaker"])
    expect(registeredParticipants).not.toContain("Late UI Speaker")
  })

  it("keeps shadow UI evidence while unresolved dcrpc mutes attribution", async () => {
    const manager = SpeakerManager.getInstance()
    const log = jest.spyOn(console, "log").mockImplementation(() => {})

    await manager.handleNetworkSpeakerUpdate(
      [networkUser("Unknown", true, "device-1")],
      1785941000000,
      "network:dcrpc"
    )
    await manager.handleUiBridgeUpdate([uiSpeaker("Alice", true)])
    await manager.handleNetworkSpeakerUpdate(
      [networkUser("Alice", false, "device-1")],
      1785941000600,
      "network:roster"
    )

    // UI remains muted for product behavior.
    expect(registeredSpeakers).toEqual(["Unknown"])
    // Alice enters participants only when the later roster callback resolves her.
    expect(registeredParticipants).toContain("Alice")

    const shadowLine = log.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('"event":"resolved_exact_device"'))
    if (!shadowLine) throw new Error("resolved shadow event not logged")
    const event = JSON.parse(shadowLine.slice(shadowLine.indexOf("{")))
    expect(event.ui_candidate).toMatchObject({
      samples: 1,
      distinct_identities: 1,
      matches_resolved: true
    })
  })

  it("does not mute the bridge on roster-only network updates (nobody speaking)", async () => {
    const manager = SpeakerManager.getInstance()
    await manager.handleNetworkSpeakerUpdate([networkUser("Silent Sam", false, "device-3")], 1785941000000)

    await manager.handleUiBridgeUpdate([uiSpeaker("Early Speaker", true)])

    expect(registeredSpeakers).toEqual(["Early Speaker"])
  })

  it("unmutes the bridge when the network path is retired by the fallback", async () => {
    const manager = SpeakerManager.getInstance()
    await manager.handleNetworkSpeakerUpdate([networkUser("Net Speaker", true, "device-1")], 1785941000000)

    diarizationFallbackTriggered = true
    await manager.handleUiBridgeUpdate([uiSpeaker("Fallback Speaker", true)])

    expect(registeredSpeakers).toEqual(["Net Speaker", "Fallback Speaker"])
  })
})

describe("SpeakerManager network updates after fallback", () => {
  beforeEach(() => {
    registeredSpeakers.length = 0
    registeredParticipants.length = 0
    params = { bot_name: "SPEAKER SEP Test", streaming_input: undefined }
    networkInterceptionFailed = false
    diarizationFallbackTriggered = false
    rearmedNetworkDiarization = false
    ;(SpeakerManager as unknown as { instance: SpeakerManager | null }).instance = null
    jest.spyOn(console, "table").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("drops straggler network updates once the fallback has retired the network path", async () => {
    const manager = SpeakerManager.getInstance()

    diarizationFallbackTriggered = true
    await manager.handleNetworkSpeakerUpdate([networkUser("Straggler", true, "device-9")], 1785941000000)

    expect(registeredSpeakers).toEqual([])
    expect(registeredParticipants).toEqual([])
  })

  it("re-mutes the UI bridge on re-arm, before the network path reports a speaker", async () => {
    const manager = SpeakerManager.getInstance()

    // A re-arm follows a never-produced fallback, so the network path has never
    // reported a speaker: the bridge's own first-speaker latch is still false.
    // Without the re-arm check both sources would commit boundaries here.
    diarizationFallbackTriggered = true
    await manager.handleUiBridgeUpdate([uiSpeaker("During Fallback", true)])
    expect(registeredSpeakers).toEqual(["During Fallback"])

    diarizationFallbackTriggered = false
    networkInterceptionFailed = false
    rearmedNetworkDiarization = true
    await manager.handleUiBridgeUpdate([uiSpeaker("After Rearm", true)])

    expect(registeredSpeakers).toEqual(["During Fallback"])
  })

  it("shadow-logs a muted UI observation without committing attribution", async () => {
    const fs = require("node:fs")
    const appendSpy = jest.spyOn(fs.promises, "appendFile").mockResolvedValue(undefined)
    const manager = SpeakerManager.getInstance()

    // Network owns the floor → bridge is muted.
    ;(manager as any).networkSpeakerActive = true
    const before = [...registeredSpeakers]

    await manager.handleUiBridgeUpdate([uiSpeaker("Shadow Only", true)])

    // Attribution untouched…
    expect(registeredSpeakers).toEqual(before)
    // …but the observation was written to the speaker log as a ui-shadow line.
    const shadowCalls = appendSpy.mock.calls.filter(([, line]) =>
      String(line).includes('"src":"ui-shadow"')
    )
    expect(shadowCalls.length).toBe(1)
    expect(String(shadowCalls[0]![1])).toContain("Shadow Only")

    // Identical consecutive observation is deduped (no second line).
    await manager.handleUiBridgeUpdate([uiSpeaker("Shadow Only", true)])
    expect(
      appendSpy.mock.calls.filter(([, line]) => String(line).includes('"src":"ui-shadow"')).length
    ).toBe(1)

    // A change in the speaking set writes again.
    await manager.handleUiBridgeUpdate([uiSpeaker("Shadow Only", false)])
    expect(
      appendSpy.mock.calls.filter(([, line]) => String(line).includes('"src":"ui-shadow"')).length
    ).toBe(2)

    appendSpy.mockRestore()
    ;(manager as any).networkSpeakerActive = false
  })

  it("gives a UI speaker the id the network already assigned to that name", async () => {
    const manager = SpeakerManager.getInstance()

    // Network names Alice, so she holds a real sequential id. A fallback then
    // hands the floor to the observer, which emits id 0 — and a re-arm hands it
    // back. Without reconciliation Alice is two speakers in one meeting.
    await manager.handleNetworkSpeakerUpdate([networkUser("Alice", true, "device-1")], 1785941000000)

    diarizationFallbackTriggered = true
    const captured: SpeakerData[] = []
    jest
      .spyOn(
        manager as unknown as {
          handleSpeakerUpdate: (s: SpeakerData[], src: string) => Promise<void>
        },
        "handleSpeakerUpdate"
      )
      .mockImplementation(async (speakers: SpeakerData[]) => {
        captured.push(...speakers)
      })

    await manager.handleUiBridgeUpdate([uiSpeaker("Alice", true)])
    await manager.handleUiBridgeUpdate([uiSpeaker("Never Networked", true)])

    expect(captured[0].id).toBe(1)
    // Nobody the network ever named keeps the id-0 sentinel, so observer-only
    // meetings are unchanged.
    expect(captured[1].id).toBe(0)
  })
})
