import { GLOBAL } from "./singleton"
import type { Participant } from "./types"
import { UNKNOWN_SPEAKER } from "./types"

/**
 * Regression cover for the collapse that made a multi-speaker meeting report one
 * speaker: the registries deduped on name, and "Unknown" is the placeholder every
 * interceptor shares before a roster resolves.
 */
describe("participant/speaker identity registry", () => {
  const p = (over: Partial<Participant>): Participant => ({
    name: UNKNOWN_SPEAKER,
    id: null,
    isNetworkDetected: true,
    ...over
  })

  beforeEach(() => {
    // The registries are append-only for the life of a bot; reset between cases.
    GLOBAL.getParticipants().length = 0
    GLOBAL.getSpeakers().length = 0
  })

  it("keeps unidentified participants on distinct devices apart", () => {
    GLOBAL.addParticipantIfNotExists(p({ participantId: "spaces/s/devices/1" }))
    GLOBAL.addParticipantIfNotExists(p({ participantId: "spaces/s/devices/2" }))
    GLOBAL.addParticipantIfNotExists(p({ participantId: "spaces/s/devices/3" }))
    expect(GLOBAL.getParticipants()).toHaveLength(3)
  })

  it("does the same for speakers — the reported symptom", () => {
    GLOBAL.addSpeakerIfNotExists(p({ participantId: "d1" }))
    GLOBAL.addSpeakerIfNotExists(p({ participantId: "d2" }))
    expect(GLOBAL.getSpeakers()).toHaveLength(2)
  })

  it("still collapses one named person seen on two endpoints", () => {
    GLOBAL.addParticipantIfNotExists(p({ name: "Alice", id: 1, participantId: "d1" }))
    GLOBAL.addParticipantIfNotExists(p({ name: "Alice", id: 1, participantId: "d2" }))
    expect(GLOBAL.getParticipants()).toHaveLength(1)
  })

  it("keeps roster metadata a later naming update does not carry", () => {
    // The update that resolves a name is often a speaking event with no avatar
    // or display name on it; assigning those blindly erased what the roster had
    // already told us about the device.
    GLOBAL.addParticipantIfNotExists(
      p({ participantId: "d1", displayName: "Bobby", profilePicture: "https://cdn/x.png" })
    )
    GLOBAL.addParticipantIfNotExists(p({ name: "Bob", id: 2, participantId: "d1" }))
    expect(GLOBAL.getParticipants()[0]).toMatchObject({
      name: "Bob",
      displayName: "Bobby",
      profilePicture: "https://cdn/x.png"
    })
  })

  it("still lets a naming update replace metadata it does carry", () => {
    GLOBAL.addParticipantIfNotExists(p({ participantId: "d1", displayName: "old" }))
    GLOBAL.addParticipantIfNotExists(
      p({ name: "Bob", id: 2, participantId: "d1", displayName: "new" })
    )
    expect(GLOBAL.getParticipants()[0].displayName).toBe("new")
  })

  it("renames a placeholder in place once the roster resolves", () => {
    GLOBAL.addParticipantIfNotExists(p({ participantId: "d1" }))
    GLOBAL.addParticipantIfNotExists(p({ name: "Bob", id: 2, participantId: "d1" }))
    expect(GLOBAL.getParticipants()).toHaveLength(1)
    expect(GLOBAL.getParticipants()[0]).toMatchObject({ name: "Bob", id: 2, participantId: "d1" })
  })

  it("drops the placeholder instead of duplicating an already-listed person", () => {
    GLOBAL.addParticipantIfNotExists(p({ name: "Bob", id: 2, participantId: "d1" }))
    GLOBAL.addParticipantIfNotExists(p({ participantId: "d2" }))
    GLOBAL.addParticipantIfNotExists(p({ name: "Bob", id: 2, participantId: "d2" }))
    expect(GLOBAL.getParticipants()).toHaveLength(1)
    expect(GLOBAL.getParticipants()[0].name).toBe("Bob")
  })

  it("does not grow a placeholder row per callback when there is no device id", () => {
    GLOBAL.addParticipantIfNotExists(p({}))
    GLOBAL.addParticipantIfNotExists(p({}))
    GLOBAL.addParticipantIfNotExists(p({}))
    expect(GLOBAL.getParticipants()).toHaveLength(1)
  })

  it("keeps two different named people apart", () => {
    GLOBAL.addParticipantIfNotExists(p({ name: "Alice", id: 1, participantId: "d1" }))
    GLOBAL.addParticipantIfNotExists(p({ name: "Bob", id: 2, participantId: "d2" }))
    expect(
      GLOBAL.getParticipants()
        .map((x) => x.name)
        .sort()
    ).toEqual(["Alice", "Bob"])
  })
})
