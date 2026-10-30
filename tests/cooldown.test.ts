import { describe, expect, it } from "vitest"
import { usageLimitCooldownMs } from "../src/index.js"
import { WINDOW_WEEK } from "../src/ledger.js"

describe("Go usage-limit cooldown", () => {
  it("uses the reset in the error instead of a fixed hour", () => {
    expect(usageLimitCooldownMs({ status: 429, message: "5-hour usage limit reached. Resets in 40min." })).toBe(40 * 60_000)
    expect(usageLimitCooldownMs({ status: 429, message: "Weekly usage limit reached. Resets in 2 days." })).toBe(
      2 * 24 * 3_600_000,
    )
  })

  it("falls back to the window named in the error", () => {
    expect(usageLimitCooldownMs({ status: 429, message: "weekly usage limit reached" })).toBe(WINDOW_WEEK)
    expect(usageLimitCooldownMs({ status: 429, message: "monthly usage limit reached" })).toBe(30 * 24 * 3_600_000)
  })

  it("uses one hour when the message has no reset", () => {
    expect(usageLimitCooldownMs({ status: 429, message: "usage limit reached" })).toBe(3_600_000)
  })
})
