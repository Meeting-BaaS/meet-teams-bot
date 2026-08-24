import { SpeakerAttributionShadowTracker } from "./speaker-attribution-shadow"

const SALT = Buffer.alloc(32, 7)

function speaker(deviceId: string, name: string, isSpeaking = true) {
  return { deviceId, name, isSpeaking }
}

function trackerWith(events: Array<Record<string, unknown>>) {
  return new SpeakerAttributionShadowTracker({
    salt: SALT,
    logger: (event) => events.push(event)
  })
}

describe("SpeakerAttributionShadowTracker", () => {
  it("measures exact-device resolution without logging names or device ids", () => {
    const events: Array<Record<string, unknown>> = []
    const tracker = trackerWith(events)

    tracker.observeNetwork([speaker("raw-device-a", "Unknown")], 1_000, "network:dcrpc")
    tracker.observeUi([speaker("ui", "Alice")], 1_200)
    tracker.observeNetwork([speaker("raw-device-a", "Alice", false)], 1_600, "network:roster")
    tracker.finalize(2_000)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      event: "resolved_exact_device",
      resolver_source: "network:roster",
      resolution_delay_ms: 600,
      dcrpc_callbacks: 1,
      dcrpc_speaking_callbacks: 1,
      ui_candidate: {
        samples: 1,
        distinct_identities: 1,
        first_delay_ms: 200,
        matches_resolved: true
      }
    })
    expect(events[1]).toMatchObject({
      event: "summary",
      unresolved_dcrpc_devices: 1,
      exact_device_resolutions: 1,
      unresolved_final: 0
    })

    const output = JSON.stringify(events)
    expect(output).not.toContain("raw-device-a")
    expect(output).not.toContain("Alice")
    expect(events[0].device).toMatch(/^dev_[0-9a-f]{12}$/)
    expect(events[0].identity).toMatch(/^spk_[0-9a-f]{12}$/)
  })

  it("validates a unique resolved network candidate against later exact identity", () => {
    const events: Array<Record<string, unknown>> = []
    const tracker = trackerWith(events)

    tracker.observeNetwork([speaker("dcrpc-device", "Unknown")], 1_000, "network:dcrpc")
    tracker.observeNetwork([speaker("csrc-device", "Alice")], 1_250, "network:audio")
    tracker.observeNetwork([speaker("dcrpc-device", "Alice", false)], 1_900, "network:roster")

    expect(events[0]).toMatchObject({
      event: "resolved_exact_device",
      network_candidate: {
        samples: 1,
        ambiguous_samples: 0,
        distinct_identities: 1,
        first_delay_ms: 250,
        sources: ["network:audio"],
        matches_resolved: true
      }
    })
  })

  it("marks candidate evidence ambiguous when multiple devices are pending", () => {
    const events: Array<Record<string, unknown>> = []
    const tracker = trackerWith(events)

    tracker.observeNetwork(
      [speaker("device-a", "Unknown"), speaker("device-b", "Unknown")],
      1_000,
      "network:dcrpc"
    )
    tracker.observeUi([speaker("ui", "Alice")], 1_200)
    tracker.finalize(2_000)

    const unresolved = events.filter((event) => event.event === "unresolved_final")
    expect(unresolved).toHaveLength(2)
    for (const event of unresolved) {
      expect(event.ui_candidate).toMatchObject({
        samples: 0,
        ambiguous_samples: 1,
        distinct_identities: 0,
        identity: null
      })
    }
  })

  it("reports a consistent candidate for a device that never resolves", () => {
    const events: Array<Record<string, unknown>> = []
    const tracker = trackerWith(events)

    tracker.observeNetwork([speaker("device-a", "Unknown")], 1_000, "network:dcrpc")
    tracker.observeUi([speaker("ui", "Alice")], 1_100)
    tracker.observeUi([speaker("ui", "Alice")], 1_300)
    tracker.finalize(2_000)

    expect(events[0]).toMatchObject({
      event: "unresolved_final",
      pending_age_ms: 1_000,
      ui_candidate: {
        samples: 2,
        ambiguous_samples: 0,
        distinct_identities: 1,
        first_delay_ms: 100,
        last_delay_ms: 300,
        matches_resolved: null
      }
    })
  })

  it("finalizes once", () => {
    const events: Array<Record<string, unknown>> = []
    const tracker = trackerWith(events)

    tracker.finalize(1_000)
    tracker.finalize(2_000)

    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("summary")
  })
})
