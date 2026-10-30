import { describe, expect, it } from "vitest"
import { allowanceCost, type TokenUsage } from "../src/allowance.js"
import { model } from "./helpers.js"

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...partial }
}

const glm = model({
  providerID: "opencode-go",
  modelID: "glm-5.3-flash",
  cost: { input: 0.15, output: 0.5, cacheRead: 0.03 },
})

describe("allowanceCost", () => {
  it("prices each token kind with its own Go price", () => {
    expect(allowanceCost(glm, usage({ input: 1_000_000 }))).toBeCloseTo(0.15, 8)
    expect(allowanceCost(glm, usage({ output: 1_000_000 }))).toBeCloseTo(0.5, 8)
    expect(allowanceCost(glm, usage({ cacheRead: 1_000_000 }))).toBeCloseTo(0.03, 8)
  })

  it("bills reasoning tokens as output", () => {
    expect(allowanceCost(glm, usage({ output: 1000, reasoning: 500 }))).toBeCloseTo((1500 * 0.5) / 1e6, 8)
  })

  it("matches the allowance the Go API reports for a small request", () => {
    // The Go API reported allowance 0.00000655 for 17 input and 8 output tokens.
    expect(allowanceCost(glm, usage({ input: 17, output: 8 }))).toBe(0.00000655)
  })

  it("bills a cache read as input when the model has no cache-read price", () => {
    const model = {
      ...glm,
      cost: { input: 1, output: 2 },
    }
    expect(allowanceCost(model, usage({ cacheRead: 1_000_000 }))).toBeCloseTo(1, 8)
  })

  it("does not charge for cache writes without a cache-write price", () => {
    expect(allowanceCost(glm, usage({ cacheWrite: 1_000_000 }))).toBe(0)
    const writer = { ...glm, cost: { input: 1, output: 2, cacheWrite: 0.25 } }
    expect(allowanceCost(writer, usage({ cacheWrite: 1_000_000 }))).toBeCloseTo(0.25, 8)
  })

  it("uses the tier price above the context size", () => {
    const tiered = model({
      providerID: "opencode-go",
      modelID: "claude-haiku-5-5",
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      tiers: [{ size: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    })
    // A prompt of exactly the tier size stays on the base price.
    expect(allowanceCost(tiered, usage({ input: 100_000 }))).toBeCloseTo(0.01, 8)
    // One token more switches the whole request to the tier price.
    expect(allowanceCost(tiered, usage({ input: 100_001 }))).toBeCloseTo((100_001 * 0.5) / 1e6, 8)
    expect(allowanceCost(tiered, usage({ cacheRead: 200_000 }))).toBeCloseTo(0.01, 8)
  })

  it("doubles DeepSeek prices in its published peak windows", () => {
    const deepseek = model({
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
    })
    const peak = Date.parse("2026-10-28T02:00:00Z") // Wednesday, 01:00-04:00 UTC
    const latePeak = Date.parse("2026-10-28T06:30:00Z") // Wednesday, 06:00-10:00 UTC
    const offPeak = Date.parse("2026-10-28T05:00:00Z")
    const weekend = Date.parse("2026-10-31T02:00:00Z") // Saturday

    expect(allowanceCost(deepseek, usage({ input: 1_000_000 }), peak)).toBeCloseTo(0.3, 8)
    expect(allowanceCost(deepseek, usage({ output: 1_000_000 }), latePeak)).toBeCloseTo(1.2, 8)
    expect(allowanceCost(deepseek, usage({ input: 1_000_000 }), offPeak)).toBeCloseTo(0.15, 8)
    expect(allowanceCost(deepseek, usage({ input: 1_000_000 }), weekend)).toBeCloseTo(0.15, 8)
  })

  it("does not apply the DeepSeek peak price to other models", () => {
    expect(allowanceCost(glm, usage({ input: 1_000_000 }), Date.parse("2026-10-28T02:00:00Z"))).toBeCloseTo(0.15, 8)
  })

  it("rounds to eight decimals, like the Go API", () => {
    const tiny = { ...glm, cost: { input: 0.123456789, output: 0 } }
    expect(allowanceCost(tiny, usage({ input: 1 }))).toBe(0.00000012)
  })
})
