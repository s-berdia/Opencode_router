import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildRoutingTable } from "../src/engine.js"
import { dedupeCatalog, loadCatalog } from "../src/catalog.js"
import { formatScorecard, fmtTokens } from "../src/format.js"
import { emptyHealth, model, writeCatalog } from "./helpers.js"

/** The fixture catalog file path (tests run with an isolated XDG cache). */
function fixtureCatalog(): string {
  return path.join(process.env.XDG_CACHE_HOME!, "opencode", "models.json")
}

describe("provider-namespace dedupe (issue #14)", () => {
  it("keeps the Zen twin of a model that exists under both providers", () => {
    writeCatalog()
    const models = loadCatalog(fixtureCatalog())
    const clean = dedupeCatalog(models)
    const beams = clean.catalog.filter((m) => m.modelID === "beam-free")
    expect(beams).toHaveLength(1)
    expect(beams[0]!.providerID).toBe("opencode")
    expect(clean.notes.some((n) => n.includes("Dropped duplicate opencode-go/beam-free"))).toBe(true)
  })

  it("keeps a free twin over a paid one, whatever the provider order", () => {
    const clean = dedupeCatalog([
      {
        providerID: "opencode",
        modelID: "twin-x",
        id: "opencode/twin-x",
        name: "twin-x",
        reasoning: true,
        toolCall: true,
        attachment: false,
        openWeights: true,
        limit: { context: 100000, output: 32000 },
        cost: { input: 5, output: 9 },
        tiers: [],
        inputModalities: ["text"],
        free: false,
      },
      {
        providerID: "opencode-go",
        modelID: "twin-x",
        id: "opencode-go/twin-x",
        name: "twin-x",
        reasoning: true,
        toolCall: true,
        attachment: false,
        openWeights: true,
        limit: { context: 100000, output: 32000 },
        cost: { input: 0, output: 0 },
        tiers: [],
        inputModalities: ["text"],
        free: true,
      },
    ])
    expect(clean.catalog).toHaveLength(1)
    expect(clean.catalog[0]!.id).toBe("opencode-go/twin-x")
  })

  it("keeps the subscription twin of a paid model so the go plan can still use it", () => {
    const zen = model({ providerID: "opencode", modelID: "shared-paid", cost: { input: 2, output: 6 } })
    const go = model({ providerID: "opencode-go", modelID: "shared-paid", cost: { input: 2, output: 6 } })

    for (const pair of [
      [zen, go],
      [go, zen],
    ]) {
      const clean = dedupeCatalog(pair)
      expect(clean.catalog.map((entry) => entry.id)).toEqual(["opencode-go/shared-paid"])
    }
  })

  it("every chain lists a modelID at most once and the table notes the drop", async () => {
    writeCatalog()
    const result = await buildRoutingTable({ health: emptyHealth() })
    // Rows only: the note text itself mentions both twins.
    const rows = formatScorecard(result.table)
      .split("\n")
      .filter((line) => line.startsWith("|"))
    for (const line of rows) {
      if (line.includes("opencode-go/beam-free")) {
        throw new Error(`deduped twin still rendered: ${line}`)
      }
    }
    // Re-anchored off any specific role or column: beam-free is minContext 1M
    // so it never reaches build or compaction. What issue #14 is about is that
    // exactly one of the two twins survives dedupe, which is checkable on the
    // catalog without depending on which chain it lands in or how it renders.
    const beamIds = result.catalog.filter((m) => m.id.endsWith("/beam-free")).map((m) => m.id)
    expect(beamIds).toEqual(["opencode/beam-free"])
    expect(result.table.notes.some((n) => n.includes("Dropped duplicate opencode-go/beam-free"))).toBe(true)
    for (const chains of Object.values(result.table.profiles)) {
      for (const chain of Object.values(chains)) {
        const ids = chain.map((entry) => entry.modelID)
        expect(new Set(ids).size).toBe(ids.length)
      }
    }
  })
})

describe("derive/endurance labels (issue #15)", () => {
  it("fmtTokens renders millions and thousands consistently", () => {
    expect(fmtTokens(49.9)).toBe("49.9M")
    expect(fmtTokens(0.05)).toBe("50K")
    expect(fmtTokens(null)).toBe("unlimited")
  })

  it("the scorecard trains the column as Mtok/5h and says how the figure is derived", async () => {
    writeCatalog()
    const { table } = await buildRoutingTable({})
    const rendered = formatScorecard(table)
    expect(rendered).toContain("Mtok/5h")
    expect(rendered).toMatch(/derived endurance figure/)
  })
})
