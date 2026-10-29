import { describe, expect, it } from "vitest"
import { ineligibilityReason, providerAllowed, rankRole } from "../src/rank.js"
import { resolveConfig } from "../src/config.js"
import { loadDefaultTable } from "../src/score-table.js"
import { emptyFeedScores } from "../src/scoring.js"
import { model, sampleCatalog } from "./helpers.js"
import type { CatalogModel, PlanProfile } from "../src/types.js"

function table() {
  const t = loadDefaultTable()
  for (const id of ["opencode-go/smart-big", "opencode-go/workhorse", "opencode-go/no-tool", "opencode-go/tiny-context"]) {
    t.monthlyCaps[id] = { go: 60, goPlus: 120 }
  }
  return t
}

function cfgFor(plan: PlanProfile) {
  return resolveConfig({ plan }, sampleCatalog, plan)
}

describe("plan tiers", () => {
  const zenFree = model({ providerID: "opencode", modelID: "zen-free", family: "zf", free: true, cost: { input: 0, output: 0 } })
  const goFree = model({ providerID: "opencode-go", modelID: "go-free", family: "gf", free: true, cost: { input: 0, output: 0 } })
  const goPaid = model({ providerID: "opencode-go", modelID: "go-paid", family: "gp", cost: { input: 1, output: 2 } })
  const zenPaid = model({ providerID: "opencode", modelID: "zen-paid", family: "zp", cost: { input: 2, output: 6 } })

  it("free may only use the Zen $0 tier", () => {
    expect(providerAllowed(zenFree, "free")).toBe(true)
    expect(providerAllowed(goFree, "free")).toBe(false)
    expect(providerAllowed(goPaid, "free")).toBe(false)
    expect(providerAllowed(zenPaid, "free")).toBe(false)
  })

  it("go may use the Go subscription plus Zen $0", () => {
    expect(providerAllowed(zenFree, "go")).toBe(true)
    expect(providerAllowed(goFree, "go")).toBe(true)
    expect(providerAllowed(goPaid, "go")).toBe(true)
    expect(providerAllowed(zenPaid, "go")).toBe(false)
  })

  it("go-plus adds the paid Zen tier", () => {
    expect(providerAllowed(zenFree, "go-plus")).toBe(true)
    expect(providerAllowed(goFree, "go-plus")).toBe(true)
    expect(providerAllowed(goPaid, "go-plus")).toBe(true)
    expect(providerAllowed(zenPaid, "go-plus")).toBe(true)
  })

  it("never routes a provider the router does not know", () => {
    expect(providerAllowed(model({ providerID: "other", modelID: "x" }), "go-plus")).toBe(false)
  })
})

describe("go-plus paid tier", () => {
  it("puts a paid Zen model in a go-plus chain and never on go or free", () => {
    const goPlus = rankRole(sampleCatalog, "build", table(), cfgFor("go-plus"), emptyFeedScores())
    expect(goPlus.some((entry) => entry.id === "opencode/zen-paid" && entry.class === "paid")).toBe(true)

    for (const plan of ["go", "free"] as const) {
      const chain = rankRole(sampleCatalog, "build", table(), cfgFor(plan), emptyFeedScores())
      expect(chain.some((entry) => entry.class === "paid")).toBe(false)
    }
  })

  it("does not apply the subscription unknown-cap rule to a metered Zen model", () => {
    const t = table()
    const role = t.roles.build!
    const cfg = cfgFor("go-plus")
    const paid = model({ providerID: "opencode", modelID: "zen-paid", cost: { input: 2, output: 6 } })
    const subscription = model({ providerID: "opencode-go", modelID: "no-cap" })

    expect(ineligibilityReason(paid, role, t, cfg)).toBeNull()
    expect(ineligibilityReason(subscription, role, t, cfg)).toBe("unknown-cap")
  })
})

describe("rankRole", () => {
  it("excludes Zen-paid models on the go plan", () => {
    const chain = rankRole(sampleCatalog, "build", table(), cfgFor("go"), emptyFeedScores())
    expect(chain.some((e) => e.id === "opencode/zen-paid")).toBe(false)
  })

  it("on the free plan only uses the Zen $0 tier", () => {
    const chain = rankRole(sampleCatalog, "build", table(), cfgFor("free"), emptyFeedScores())
    expect(chain.length).toBeGreaterThan(0)
    expect(chain.every((e) => e.id.startsWith("opencode/") && e.class === "free")).toBe(true)
  })

  it("honors toolCall and minContext requirements", () => {
    const chain = rankRole(sampleCatalog, "build", table(), cfgFor("go"), emptyFeedScores())
    expect(chain.some((e) => e.modelID === "no-tool")).toBe(false)
    expect(chain.some((e) => e.modelID === "tiny-context")).toBe(false)
  })

  it("puts subscription models ahead of free ones for a builder role (go plan)", () => {
    const chain = rankRole(sampleCatalog, "build", table(), cfgFor("go"), emptyFeedScores())
    expect(chain[0]?.class).toBe("subscription")
  })

  it("respects chain depth", () => {
    const t = table()
    t.roles.build = { ...t.roles.build!, chainDepth: 2 }
    const chain = rankRole(sampleCatalog, "build", t, cfgFor("go"), emptyFeedScores())
    expect(chain.length).toBeLessThanOrEqual(2)
  })

  it("denylist removes a model", () => {
    const chain = rankRole(
      sampleCatalog,
      "build",
      table(),
      { ...cfgFor("go"), denyModels: ["opencode-go/workhorse"] },
      emptyFeedScores(),
    )
    expect(chain.some((e) => e.id === "opencode-go/workhorse")).toBe(false)
  })

  it("privacy=false removes free models from real-work roles only", () => {
    const cfg = { ...cfgFor("go"), privacy: { freeModelsOk: false } }
    const build = rankRole(sampleCatalog, "build", table(), cfg, emptyFeedScores())
    expect(build.some((e) => e.class === "free")).toBe(false)

    const explore = rankRole(sampleCatalog, "explore", table(), cfg, emptyFeedScores())
    expect(explore.length).toBeGreaterThan(0)
  })

  it("explore weighs search capability above raw speed (issue #16)", () => {
    const t = table()
    t.roles.explore = {
      ...t.roles.explore!,
      chainDepth: 4,
      weights: { intelligence: 0.45, speed: 0.15, endurance: 0.4 },
    }
    t.models["opencode/fast-sweep"] = { intelligence: 45, speed: 90 }
    t.models["opencode/careful-sweep"] = { intelligence: 80, speed: 45 }
    const catalog: CatalogModel[] = [
      model({ providerID: "opencode", modelID: "fast-sweep", family: "fast", free: true }),
      model({ providerID: "opencode", modelID: "careful-sweep", family: "careful", free: true }),
    ]
    const chain = rankRole(catalog, "explore", t, cfgFor("free"), emptyFeedScores())
    expect(chain[0]!.id).toBe("opencode/careful-sweep")
  })
})

describe("free fallback", () => {
  // Five Go models outscore the free model, so without a fallback the list has no free model.
  const goModels = ["a", "b", "c", "d", "e"].map((name) =>
    model({ providerID: "opencode-go", modelID: `go-${name}`, family: name, cost: { input: 0.1, output: 0.5 } }),
  )
  const free = model({ providerID: "opencode", modelID: "free-fast", family: "ff", cost: { input: 0, output: 0 }, free: true })
  const catalog = [...goModels, free]

  function goTable() {
    const t = table()
    for (const m of goModels) t.monthlyCaps[m.id] = { go: 60, goPlus: 120 }
    return t
  }

  it("ends the list of a real-work role with a free model on the go plan", () => {
    const chain = rankRole(catalog, "build", goTable(), cfgFor("go"), emptyFeedScores())
    expect(chain).toHaveLength(4)
    expect(chain.slice(0, 3).every((e) => e.class === "subscription")).toBe(true)
    expect(chain[3]?.id).toBe("opencode/free-fast")
  })

  it("keeps the first model when the chain depth is 1", () => {
    const t = goTable()
    t.roles.build = { ...t.roles.build!, chainDepth: 1 }
    const chain = rankRole(catalog, "build", t, cfgFor("go"), emptyFeedScores())
    expect(chain.map((e) => e.class)).toEqual(["subscription", "free"])
  })

  it("adds no free model when privacy.freeModelsOk is false", () => {
    const cfg = { ...cfgFor("go"), privacy: { freeModelsOk: false } }
    const chain = rankRole(catalog, "build", goTable(), cfg, emptyFeedScores())
    expect(chain.some((e) => e.class === "free")).toBe(false)
  })

  it("keeps a metered Zen model when the free fallback is appended on go-plus", () => {
    const subs = ["s1", "s2", "s3", "s4", "s5"].map((name) =>
      model({ providerID: "opencode-go", modelID: `sub-${name}`, family: name, cost: { input: 0.1, output: 0.5 } }),
    )
    const metered = model({ providerID: "opencode", modelID: "zen-metered", family: "zm", cost: { input: 2, output: 6 } })
    const free = model({ providerID: "opencode", modelID: "free-fast", family: "ff", cost: { input: 0, output: 0 }, free: true })
    const t = table()

    // Descending subscription scores. Intelligence 93 leaves the paid model
    // fourth once the -6 paid class preference is applied: it outranks sub-s4
    // but not sub-s3, so the free fallback must make room for it.
    const intel = [90, 85, 80, 75, 70]
    subs.forEach((entry, index) => {
      t.monthlyCaps[entry.id] = { go: 60, goPlus: 120 }
      t.models[entry.id] = { intelligence: intel[index]!, speed: 60 }
    })
    t.models[metered.id] = { intelligence: 93, speed: 60 }

    const chain = rankRole([...subs, metered, free], "build", t, cfgFor("go-plus"), emptyFeedScores())

    expect(chain).toHaveLength(4)
    expect(chain.some((entry) => entry.id === metered.id)).toBe(true)
    expect(chain.at(-1)?.id).toBe(free.id)
    expect(chain.filter((entry) => entry.class === "subscription")).toHaveLength(2)
  })
})

describe("rank robustness", () => {
  it("handles an empty catalog", () => {
    const chain = rankRole([] as CatalogModel[], "build", table(), cfgFor("go"), emptyFeedScores())
    expect(chain).toEqual([])
  })

  it("keeps family diversity when asked", () => {
    const catalog: CatalogModel[] = [
      model({ providerID: "opencode-go", modelID: "alpha-1", family: "alpha", cost: { input: 0.1, output: 0.5 } }),
      model({ providerID: "opencode-go", modelID: "alpha-2", family: "alpha", cost: { input: 0.1, output: 0.5 } }),
      model({ providerID: "opencode-go", modelID: "beta-1", family: "beta", cost: { input: 0.1, output: 0.5 } }),
    ]
    const t = table()
    for (const m of catalog) t.monthlyCaps[m.id] = { go: 60, goPlus: 120 }
    const chain = rankRole(catalog, "build", t, cfgFor("go"), emptyFeedScores())
    const families = chain.map((e) => catalog.find((c) => c.id === e.id)?.family)
    // Diversity means no two adjacent picks share a family; the backfill still fills the chain.
    expect(families).toHaveLength(3)
    for (let i = 1; i < families.length; i++) expect(families[i]).not.toBe(families[i - 1])
  })
})
