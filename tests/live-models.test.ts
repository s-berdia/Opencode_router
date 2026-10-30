import { describe, expect, it } from "vitest"
import { buildRoutingTable } from "../src/engine.js"
import { emptyFeedScores } from "../src/scoring.js"
import { readLiveModels, writeLiveModels } from "../src/state.js"
import { ROLE_NAMES } from "../src/types.js"
import { emptyHealth, routedCatalog } from "./helpers.js"

function build(liveModelIDs?: ReadonlySet<string>) {
  return buildRoutingTable({
    catalog: routedCatalog(),
    feeds: emptyFeedScores(),
    health: emptyHealth(),
    liveModelIDs,
  })
}

describe("live model filtering", () => {
  it("drops cached models that OpenCode no longer lists", async () => {
    const cached = routedCatalog()
    const live = new Set(cached.map((model) => model.id).filter((id) => id !== "opencode-go/kimi-k3"))
    const { table, catalog } = await build(live)

    expect(catalog.map((model) => model.id)).not.toContain("opencode-go/kimi-k3")
    for (const role of ROLE_NAMES) {
      for (const entry of table.active[role] ?? []) expect(entry.id).not.toBe("opencode-go/kimi-k3")
    }
    expect(table.notes.join("\n")).toMatch(/no longer lists.*opencode-go\/kimi-k3/)
  })

  it("keeps the cached catalog when the live list shares no models", async () => {
    const { table, catalog } = await build(new Set(["some-other-provider/some-model"]))

    expect(catalog.length).toBeGreaterThan(0)
    expect(table.notes.join("\n")).toMatch(/did not match the cached catalog/)
  })
})

describe("live model snapshot", () => {
  it("dedupes and sorts the ids it saves", () => {
    writeLiveModels(["opencode/b", "opencode/a", "opencode/a"])
    expect([...readLiveModels()!]).toEqual(["opencode/a", "opencode/b"])
  })

  it("expires an old snapshot instead of trusting it", () => {
    writeLiveModels(["opencode/a"])
    expect(readLiveModels(-1)).toBeUndefined()
  })
})
