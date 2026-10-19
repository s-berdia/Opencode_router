import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { allowanceShare, buildRoutingTable, statusRows } from "../src/engine.js"
import { formatStatus } from "../src/format.js"
import { LedgerStore } from "../src/ledger.js"
import { emptyFeedScores } from "../src/scoring.js"
import { installedVersion } from "../src/update.js"
import { globalOpencodeDir, routedCatalog } from "./helpers.js"

function build(plan: "go" | "free" = "go") {
  return buildRoutingTable({ catalog: routedCatalog(), plan, feeds: emptyFeedScores() })
}

function ledger(): LedgerStore {
  return new LedgerStore(path.join(process.env.XDG_CONFIG_HOME!, "ledger.json"))
}

describe("statusRows", () => {
  it("shows the failover model when the first model is in cooldown", async () => {
    const result = await build()
    const chain = result.table.active.build!
    const store = ledger()
    store.cooldown(chain[0]!.id, 60_000, "test")

    const row = statusRows(result, store).find((r) => r.role === "build")!

    expect(row.entry?.id).toBe(chain[1]!.id)
    expect(row.state).toBe("failover")
  })

  it("moves an agent to its free model when the shared allowance reaches the soft threshold", async () => {
    const result = await build()
    const store = ledger()
    // 0.18 of the month in 5 hours = 90% of the 5-hour allowance.
    store.record("opencode-go/glm-5.3-flash", 10.8, 1000, 0.18)

    const row = statusRows(result, store).find((r) => r.role === "build")!

    expect(row.entry?.class).toBe("free")
    expect(row.state).toBe("free-fallback")
  })

  it("moves an agent to its free model during an allowance cooldown", async () => {
    const result = await build()
    const store = ledger()
    store.cooldownAllowance(60_000, "usage limit")

    const row = statusRows(result, store).find((r) => r.role === "plan")!

    expect(row.entry?.class).toBe("free")
    expect(row.state).toBe("free-fallback")
  })

  it("shows the first model as limited when there is no free model to use", async () => {
    fs.mkdirSync(globalOpencodeDir(), { recursive: true })
    fs.writeFileSync(path.join(globalOpencodeDir(), "router.config.json"), JSON.stringify({ privacy: { freeModelsOk: false } }))
    const result = await build()
    const store = ledger()
    store.cooldownAllowance(60_000, "usage limit")

    const row = statusRows(result, store).find((r) => r.role === "build")!

    expect(row.entry?.id).toBe(result.table.active.build![0]!.id)
    expect(row.state).toBe("limited")
  })
})

describe("formatStatus", () => {
  it("shows the router version under the heading", async () => {
    const result = await build()
    const rows = statusRows(result, ledger())
    const text = formatStatus(result.table, rows)

    expect(text).toContain(`## opencode-router status\n\n- Version: ${installedVersion()}\n- Plan: **go**`)
  })
})

describe("allowanceShare", () => {
  it("divides the cost by the monthly limit of a subscription model", async () => {
    const result = await build()
    const cap = result.scoreTable.monthlyCaps["opencode-go/glm-5.3-flash"]!.go!
    expect(allowanceShare(result, "opencode-go/glm-5.3-flash", cap / 10)).toBeCloseTo(0.1, 5)
  })

  it("is 0 for a free model and on the free plan", async () => {
    expect(allowanceShare(await build(), "opencode/nemotron-3.5-lightning-free", 5)).toBe(0)
    expect(allowanceShare(await build("free"), "opencode-go/glm-5.3-flash", 5)).toBe(0)
  })
})
