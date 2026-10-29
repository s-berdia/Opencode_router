import { describe, expect, it } from "vitest"
import { blendedCost, modelClass, resolveEndurance, resolveIntelligence } from "../src/scoring.js"
import { resolveConfig } from "../src/config.js"
import { loadDefaultTable } from "../src/score-table.js"
import { emptyFeedScores } from "../src/scoring.js"
import { model, sampleCatalog } from "./helpers.js"

const cfg = resolveConfig({ plan: "go" }, sampleCatalog, "go")
const table = loadDefaultTable()

describe("blendedCost", () => {
  it("uses the configured input/output blend", () => {
    const m = model({ providerID: "opencode-go", modelID: "x", cost: { input: 1, output: 2, cacheRead: 0 } })
    expect(blendedCost(m, cfg)).toBeCloseTo(0.75 * 1 + 0.25 * 2, 6)
  })
})

describe("resolveEndurance", () => {
  it("scores free models as unlimited", () => {
    const m = model({ providerID: "opencode", modelID: "f", free: true, cost: { input: 0, output: 0 } })
    const result = resolveEndurance(m, table, cfg)
    expect(result.score).toBe(100)
    expect(result.tokensPer5h).toBeNull()
  })

  it("scores cheap high-cap models above expensive low-cap models", () => {
    const cheap = model({
      providerID: "opencode-go",
      modelID: "wh",
      cost: { input: 0.15, output: 0.6 },
    })
    const pricey = model({
      providerID: "opencode-go",
      modelID: "big",
      cost: { input: 4, output: 20 },
    })
    const t = loadDefaultTable()
    t.monthlyCaps["opencode-go/wh"] = { go: 80, goPlus: 160 }
    t.monthlyCaps["opencode-go/big"] = { go: 60, goPlus: 240 }

    const cheapResult = resolveEndurance(cheap, t, cfg)
    const priceyResult = resolveEndurance(pricey, t, cfg)
    expect(cheapResult.score).toBeGreaterThan(priceyResult.score)
    expect(priceyResult.score).toBeLessThan(100)
  })
})

describe("modelClass", () => {
  it("classifies free, subscription, and paid", () => {
    expect(modelClass(model({ providerID: "opencode", modelID: "a", free: true }))).toBe("free")
    expect(modelClass(model({ providerID: "opencode-go", modelID: "b" }))).toBe("subscription")
    expect(modelClass(model({ providerID: "opencode", modelID: "c" }))).toBe("paid")
  })
})

describe("resolveIntelligence", () => {
  it("uses the generated table entry as a benchmark score", () => {
    const m = model({ providerID: "opencode-go", modelID: "glm-5.2" })
    const t = loadDefaultTable()
    t.models["opencode-go/glm-5.2"] = { intelligence: 88 }
    const result = resolveIntelligence(m, t, emptyFeedScores())
    expect(result.source).toBe("benchmark")
    expect(result.value).toBe(88)
  })

  it("lets a user pin win over the generated entry", () => {
    const m = model({ providerID: "opencode-go", modelID: "glm-5.2" })
    const t = loadDefaultTable()
    t.overrides = { "opencode-go/glm-5.2": { intelligence: 42 } }
    const result = resolveIntelligence(m, t, emptyFeedScores())
    expect(result.source).toBe("override")
    expect(result.value).toBe(42)
  })
})
