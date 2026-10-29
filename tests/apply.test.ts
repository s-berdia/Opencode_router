import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { writeRoutingConfig } from "../src/apply.js"
import { buildRoutingTable } from "../src/engine.js"
import { emptyFeedScores } from "../src/scoring.js"
import { emptyHealth, makeProject, routedCatalog } from "./helpers.js"

async function table() {
  const { table } = await buildRoutingTable({ catalog: routedCatalog(), plan: "go", feeds: emptyFeedScores(), health: emptyHealth() })
  return table
}

describe("writeRoutingConfig", () => {
  it("keeps comments, unrelated keys, and per-agent settings", async () => {
    const dir = makeProject()
    const file = path.join(dir, "opencode.jsonc")
    fs.writeFileSync(
      file,
      `{
  // my provider settings
  "provider": { "x": { "options": {} } },
  "agent": { "build": { "prompt": "Be brief.", "model": "old/model" } }
}
`,
      "utf8",
    )
    const t = await table()

    writeRoutingConfig(t, "project", dir)

    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain("// my provider settings")
    const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/m, "")) as {
      provider: unknown
      agent: { build: { prompt: string; model: string } }
    }
    expect(parsed.provider).toEqual({ x: { options: {} } })
    expect(parsed.agent.build.prompt).toBe("Be brief.")
    expect(parsed.agent.build.model).toBe(t.active.build![0]!.id)
  })

  it("refuses to change a file that has a JSON error", async () => {
    const dir = makeProject()
    const file = path.join(dir, "opencode.json")
    const broken = `{ "provider": { "x": 1 }, "model": }`
    fs.writeFileSync(file, broken, "utf8")
    const t = await table()

    expect(() => writeRoutingConfig(t, "project", dir)).toThrow(/JSON error/)
    expect(fs.readFileSync(file, "utf8")).toBe(broken)
  })
})
