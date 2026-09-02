import { getZoomJoinAttemptIndex, rotateCountriesForAttempt } from "./country-rotation"

describe("Zoom proxy country rotation", () => {
  const countries = ["it", "fr", "de", "nl", "gb", "se"]
  const attemptsPerPod = 3

  it("uses a different region for every in-process and outer retry", () => {
    const selected = [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 0]
    ].map(([outerRetry, inProcessAttempt]) => {
      const attemptIndex = getZoomJoinAttemptIndex(outerRetry, inProcessAttempt, attemptsPerPod)
      return rotateCountriesForAttempt(countries, attemptIndex)[0]
    })

    expect(selected).toEqual(["it", "fr", "de", "nl", "gb", "se", "it"])
  })

  it("preserves one-region and empty pools", () => {
    expect(rotateCountriesForAttempt(["it"], 8)).toEqual(["it"])
    expect(rotateCountriesForAttempt([], 8)).toEqual([])
  })

  it("does not mutate the bot-stable country order", () => {
    const original = [...countries]
    expect(rotateCountriesForAttempt(countries, 2)).toEqual(["de", "nl", "gb", "se", "it", "fr"])
    expect(countries).toEqual(original)
  })
})
