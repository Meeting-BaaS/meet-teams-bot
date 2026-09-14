import type { Page } from "@playwright/test"
import {
  countIsolated,
  isCspEvaluateBlock,
  PageReadTimeoutError,
  readVisibleTextIsolated,
  withTimeout
} from "./page-reads"

describe("withTimeout", () => {
  it("resolves with the value when the read settles in time", async () => {
    await expect(withTimeout(Promise.resolve("Zoom"), 50, "page.title")).resolves.toBe("Zoom")
  })

  it("rejects instead of hanging on a read that never settles", async () => {
    await expect(
      withTimeout(new Promise<never>(() => {}), 20, "page.title")
    ).rejects.toBeInstanceOf(PageReadTimeoutError)
  })

  it("passes the read's own failure through", async () => {
    await expect(withTimeout(Promise.reject(new Error("Target closed")), 50, "x")).rejects.toThrow(
      "Target closed"
    )
  })
})

describe("isCspEvaluateBlock", () => {
  it("recognises the stealthfox CSP refusal seen in production", () => {
    const prod = new Error(
      "page.evaluate: call to eval() blocked by CSP\nevaluate@eval code:291:30\n@eval code:1:44\n"
    )
    expect(isCspEvaluateBlock(prod)).toBe(true)
  })

  it.each([new Error("Target page, context or browser has been closed"), "timeout", null])(
    "does not mistake other failures for a CSP refusal: %p",
    (error) => {
      expect(isCspEvaluateBlock(error)).toBe(false)
    }
  )
})

describe("isolated reads", () => {
  const pageWith = (locator: object) => ({ locator: () => locator }) as unknown as Page

  it("lowercases visible text", async () => {
    const page = pageWith({ innerText: async () => "Automated bots AREN'T allowed" })
    await expect(readVisibleTextIsolated(page)).resolves.toBe("automated bots aren't allowed")
  })

  it("returns empty text when the page cannot be read", async () => {
    const page = pageWith({ innerText: async () => Promise.reject(new Error("timeout")) })
    await expect(readVisibleTextIsolated(page)).resolves.toBe("")
  })

  it("returns 0 rather than hanging when a count never settles", async () => {
    const page = pageWith({ count: () => new Promise<never>(() => {}) })
    await expect(countIsolated(page, "#input-for-name", 20)).resolves.toBe(0)
  })
})
