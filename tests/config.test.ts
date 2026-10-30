import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { mergeUserConfig, resolveConfig } from "../src/config.js"
import { buildRoutingTable } from "../src/engine.js"
import { resolveTable } from "../src/score-table.js"
import { emptyFeedScores } from "../src/scoring.js"
import type { RouterUserConfig } from "../src/types.js"
import { emptyHealth, globalOpencodeDir, routedCatalog } from "./helpers.js"

function writeGlobalConfig(text: string): void {
  const file = path.join(globalOpencodeDir(), "router.config.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, "utf8")
}

function build() {
  return buildRoutingTable({ catalog: routedCatalog(), feeds: emptyFeedScores(), health: emptyHealth() })
}

describe("resolveTable", () => {
  it("applies a top-level chainDepth to every role", () => {
    const t = resolveTable({ chainDepth: 2 })
    expect(t.roles.build?.chainDepth).toBe(2)
    expect(t.roles.compaction?.chainDepth).toBe(2)
  })

  it("lets a per-role chainDepth win over the top-level value", () => {
    const t = resolveTable({ chainDepth: 2, roles: { plan: { chainDepth: 3 } } })
    expect(t.roles.plan?.chainDepth).toBe(3)
  })

  it("ignores roles that the router does not know", () => {
    const user = { roles: { reviewer: { weights: { intelligence: 1 } } } } as unknown as RouterUserConfig
    expect(resolveTable(user).roles).not.toHaveProperty("reviewer")
  })
})

describe("mergeUserConfig", () => {
  it("merges per-role weights from the global and project files", () => {
    const merged = mergeUserConfig({ weights: { build: { intelligence: 0.5 } } }, { weights: { build: { speed: 0.1 } } })
    expect(merged.weights?.build).toEqual({ intelligence: 0.5, speed: 0.1 })
  })
})

describe("user config problems", () => {
  it("reports a router.config.json with a JSON error", async () => {
    writeGlobalConfig(`{ "plan": "go", `)
    const { table } = await build()
    expect(table.notes.join("\n")).toMatch(/router\.config\.json.*JSON error/)
  })

  it("ignores an unknown plan and says so", async () => {
    writeGlobalConfig(JSON.stringify({ plan: "gold" }))
    const { table } = await build()
    expect(["go", "go-plus", "go-teams", "free"]).toContain(table.plan)
    expect(table.notes.join("\n")).toMatch(/gold/)
  })

  it("ignores an updateCheck that is not true or false and says so", async () => {
    writeGlobalConfig(JSON.stringify({ updateCheck: "no" }))
    const { table } = await build()
    expect(table.notes.join("\n")).toMatch(/"updateCheck" must be true or false/)
  })

  it("ignores an unknown mode and says so", async () => {
    writeGlobalConfig(JSON.stringify({ mode: "turbo" }))
    const { table } = await buildRoutingTable({ feeds: emptyFeedScores(), health: emptyHealth() })
    expect(table.notes.join("\n")).toMatch(/"mode" must be one of auto \| failover \| off/)
  })

  it("resolves the mode with auto as the default", async () => {
    writeGlobalConfig(JSON.stringify({}))
    const resolved = resolveConfig({}, routedCatalog())
    expect(resolved.mode).toBe("auto")
    const explicit = resolveConfig({ mode: "failover" }, routedCatalog())
    expect(explicit.mode).toBe("failover")
  })

  it("names the real catalog path when no models are found", async () => {
    const file = path.join(process.env.XDG_CACHE_HOME!, "missing.json")
    const { table } = await buildRoutingTable({ catalogFile: file, feeds: emptyFeedScores(), health: emptyHealth() })
    expect(table.notes.join("\n")).toContain(file)
  })
})
