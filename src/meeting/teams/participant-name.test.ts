import { resolveTeamsTileName } from "./participant-name"

describe("resolveTeamsTileName", () => {
  it("takes the nametag over the badge-carrying aria-label (live DOM, 2026-09-18)", () => {
    expect(
      resolveTeamsTileName({
        nametags: ["", "Amr El Shimy"],
        dataTid: "Amr El Shimy",
        ariaLabel: "Amr El Shimy External unfamiliar, video is on, Context menu is available"
      })
    ).toBe("Amr El Shimy")
  })

  it("keeps a name that looks like a Teams label", () => {
    expect(
      resolveTeamsTileName({
        nametags: ["Bot Unfamiliar"],
        dataTid: "Bot Unfamiliar",
        ariaLabel: "Bot Unfamiliar External unfamiliar, muted, Context menu is available"
      })
    ).toBe("Bot Unfamiliar")
  })

  it("falls back to data-tid when no nametag has rendered yet", () => {
    expect(
      resolveTeamsTileName({
        nametags: [""],
        dataTid: "Marc",
        ariaLabel: "Marc Unverified, video is off"
      })
    ).toBe("Marc")
  })

  it.each([
    ["menur1j", "Marc Unverified, muted", "Marc Unverified"],
    ["participant-info", "Jonny (Guest), video is on", "Jonny"],
    ["calling-stream", "Amr Şimi, muted", "Amr Şimi"]
  ])("ignores the structural data-tid %p and reads the aria-label", (dataTid, aria, expected) => {
    expect(resolveTeamsTileName({ dataTid, ariaLabel: aria })).toBe(expected)
  })

  it("never returns an email from data-tid", () => {
    expect(
      resolveTeamsTileName({ dataTid: "amr@meetingbaas.com", ariaLabel: "Amr Şimi, muted" })
    ).toBe("Amr Şimi")
  })

  it.each([
    [{ nametags: ["Jonny (Guest)"] }, "Jonny"],
    [{ dataTid: "Jonny (Guest)" }, "Jonny"],
    [{ dataTid: "menur1j", ariaLabel: "Jonny (Guest), muted" }, "Jonny"]
  ])("drops a bracketed guest label from %p", (parts, expected) => {
    expect(resolveTeamsTileName(parts)).toBe(expected)
  })

  it("returns an empty string when the tile carries no name at all", () => {
    expect(resolveTeamsTileName({})).toBe("")
  })
})
