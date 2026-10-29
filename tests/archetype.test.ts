import { describe, expect, it } from "vitest"
import { selectArchetype, DEFAULT_INTELLIGENCE_BANDS } from "../src/archetype.js"
import { resolveConfig } from "../src/config.js"
import { loadDefaultTable } from "../src/score-table.js"
import { emptyFeedScores } from "../src/scoring.js"
import { model } from "./helpers.js"
import type { CatalogModel, RoleName } from "../src/types.js"

function catalog(): CatalogModel[] {
  return [
    model({
      providerID: "opencode-go",
      modelID: "smart",
      family: "smart",
      limit: { context: 1_000_000, output: 128_000 },
      cost: { input: 1, output: 4 },
    }),
    model({
      providerID: "opencode-go",
      modelID: "cheap",
      family: "cheap",
      limit: { context: 1_000_000, output: 128_000 },
      cost: { input: 1, output: 4 },
    }),
    model({
      providerID: "opencode-go",
      modelID: "prior",
      family: "prior",
      limit: { context: 1_000_000, output: 128_000 },
      cost: { input: 1, output: 4 },
    }),
    model({ providerID: "opencode-go", modelID: "no-tool", toolCall: false }),
    model({ providerID: "opencode", modelID: "zen-paid", cost: { input: 2, output: 6 } }),
    model({ providerID: "opencode-go", modelID: "tiny", limit: { context: 8000, output: 2000 } }),
  ]
}

function table() {
  const t = loadDefaultTable()
  for (const id of ["smart", "cheap", "prior", "no-tool", "tiny"]) {
    t.monthlyCaps[`opencode-go/${id}`] = { go: 60, goPlus: 120 }
  }
  t.models = {
    "opencode-go/smart": { intelligence: 90, speed: 20 },
    "opencode-go/cheap": { intelligence: 40, speed: 90 },
    "opencode-go/prior": { intelligence: 70, speed: 50 },
    "opencode-go/no-tool": { intelligence: 99, speed: 10 },
    "opencode-go/tiny": { intelligence: 99, speed: 10 },
  }
  return t
}

function select(role: RoleName, measured: string[], band?: number, t = table()) {
  const models = catalog()
  return selectArchetype({
    catalog: models,
    role,
    table: t,
    cfg: resolveConfig({ plan: "go" }, models, "go"),
    feeds: emptyFeedScores(),
    measured: new Set(measured),
    band,
  })
}

describe("selectArchetype", () => {
  it("gates measured models below the band but never gates an unmeasured prior", () => {
    const result = select("build", ["opencode-go/smart", "opencode-go/cheap"])

    expect(result.gate).toMatchObject({ band: DEFAULT_INTELLIGENCE_BANDS.build, best: 90, bestID: "opencode-go/smart" })
    expect(result.gate.threshold).toBe(70)
    expect(result.gated).toEqual([{ id: "opencode-go/cheap", intelligence: 40, threshold: 70 }])
    expect(result.ranked.some((entry) => entry.model.id === "opencode-go/smart")).toBe(true)
    expect(result.ranked.some((entry) => entry.model.id === "opencode-go/cheap")).toBe(false)
    expect(result.unmeasured).toContain("opencode-go/prior")
    expect(result.ranked.some((entry) => entry.model.id === "opencode-go/prior")).toBe(true)
  })

  it("reports the eligibility rule that removed each model", () => {
    const result = select("build", ["opencode-go/smart"])
    const reasons = new Map(result.excluded.map((entry) => [entry.id, entry.reason]))

    expect(reasons.get("opencode-go/no-tool")).toBe("tool-call")
    expect(reasons.get("opencode-go/tiny")).toBe("min-context")
    expect(reasons.get("opencode/zen-paid")).toBe("plan")
  })

  it("lets an explicit band widen the gate", () => {
    const result = select("build", ["opencode-go/smart", "opencode-go/cheap"], 60)
    expect(result.gated).toEqual([])
    expect(result.ranked.some((entry) => entry.model.id === "opencode-go/cheap")).toBe(true)
  })

  it("orders survivors by the role's weights, not by intelligence alone", () => {
    const t = table()
    t.models["opencode-go/cheap"] = { intelligence: 80, speed: 90 }
    t.roles.build = {
      ...t.roles.build!,
      weights: { intelligence: 0.1, speed: 0.8, endurance: 0.05, reliability: 0.05 },
    }
    const result = select("build", ["opencode-go/smart", "opencode-go/cheap"], 15, t)
    expect(result.ranked[0]?.model.id).toBe("opencode-go/cheap")
  })

  it("keeps every model when no public benchmark matched", () => {
    const result = select("build", [])
    expect(result.gate.threshold).toBeUndefined()
    expect(result.gated).toEqual([])
    expect(result.ranked.length).toBeGreaterThan(0)
    expect(result.unmeasured.length).toBeGreaterThan(0)
  })

  it("limits the reported ranking without changing the gate", () => {
    const result = selectArchetype({
      catalog: catalog(),
      role: "build",
      table: table(),
      cfg: resolveConfig({ plan: "go" }, catalog(), "go"),
      feeds: emptyFeedScores(),
      measured: new Set(["opencode-go/smart"]),
      limit: 1,
    })
    expect(result.ranked).toHaveLength(1)
  })
})
