import { describe, expect, it } from "vitest"
import { parseBenchmarks, type BenchmarkTable } from "../src/benchmarks.js"
import {
  calibratePercentile,
  calibrationRange,
  refreshScores,
  scoreTablesMatch,
  serializeScoreTable,
} from "../src/score-refresh.js"
import { loadDefaultTable } from "../src/score-table.js"
import { model } from "./helpers.js"
import type { CatalogModel, ScoreTable } from "../src/types.js"

function bench(rows: unknown[]): BenchmarkTable {
  return parseBenchmarks({ data: rows }, { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z" })
}

function row(id: string, intelligence: number | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    benchmarks: { artificial_analysis: { intelligence_index: intelligence, coding_index: null, agentic_index: null } },
    ...extra,
  }
}

function baseTable(): ScoreTable {
  const base = loadDefaultTable()
  base.heuristics = {
    patterns: [
      { match: "smart", intelligence: 90, speed: 20 },
      { match: "cheap", intelligence: 60, speed: 90 },
    ],
    defaultIntelligence: 60,
    defaultSpeed: 60,
    unvettedPenalty: 8,
  }
  base.models = {
    "opencode-go/smart": { intelligence: 10, speed: 20 },
    "opencode-go/unmatched": { intelligence: 55, speed: 70 },
    "opencode-go/old": { intelligence: 50, speed: 50 },
  }
  base.overrides = { "opencode-go/smart": { intelligence: 99 } }
  return base
}

function catalog(): CatalogModel[] {
  return [
    model({ providerID: "opencode-go", modelID: "smart", canonicalModelID: "vendor/smart" }),
    model({ providerID: "opencode-go", modelID: "cheap", canonicalModelID: "vendor/cheap" }),
    model({ providerID: "opencode-go", modelID: "unmatched" }),
  ]
}

const benchmarks = bench([row("vendor/low", 10), row("vendor/smart", 50), row("vendor/cheap", 90)])
const NOW = new Date("2026-10-28T12:00:00.000Z")

describe("calibration", () => {
  it("derives its range from the committed heuristic scale", () => {
    expect(calibrationRange(baseTable())).toEqual({ min: 60, max: 90 })
  })

  it("maps percentiles onto that range and clamps out-of-range input", () => {
    const range = { min: 60, max: 90 }
    expect(calibratePercentile(0, range)).toBe(60)
    expect(calibratePercentile(50, range)).toBe(75)
    expect(calibratePercentile(100, range)).toBe(90)
    expect(calibratePercentile(-10, range)).toBe(60)
    expect(calibratePercentile(140, range)).toBe(90)
  })
})

describe("refreshScores", () => {
  it("rewrites measured intelligence, keeps unmatched priors, and prunes stale entries", () => {
    const result = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW })

    expect(result.table.models["opencode-go/smart"]).toEqual({ intelligence: 75, speed: 20 })
    expect(result.table.models["opencode-go/cheap"]).toEqual({ intelligence: 85 })
    expect(result.table.models["opencode-go/unmatched"]).toEqual({ intelligence: 55, speed: 70 })
    expect(result.table.models["opencode-go/old"]).toBeUndefined()

    expect(result.measured).toEqual(new Set(["opencode-go/smart", "opencode-go/cheap"]))
    expect(result.unmatched.map((entry) => entry.id)).toEqual(["opencode-go/unmatched"])
    expect(result.stale).toEqual(["opencode-go/old"])
    expect(result.table._meta?.counts).toEqual({
      catalog: 3,
      matched: 2,
      measured: 2,
      unmatched: 1,
      matchedWithoutBenchmark: 0,
    })
  })

  it("never rewrites the explicit overrides block", () => {
    const result = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW })
    expect(result.table.overrides).toEqual({ "opencode-go/smart": { intelligence: 99 } })
  })

  it("records provenance and a date, not a moving clock", () => {
    const result = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW })
    expect(result.table.updated).toBe("2026-10-28")
    expect(result.table._meta?.generated).toBe("2026-10-28")
    expect(result.table._meta?.source).toBe("test")
    expect(result.table._meta?.fetchedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(result.table._meta?.calibration).toEqual({ min: 60, max: 90 })
  })

  it("keeps stale entries when asked", () => {
    const result = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW, keepStale: true })
    expect(result.table.models["opencode-go/old"]).toEqual({ intelligence: 50, speed: 50 })
    expect(result.stale).toEqual(["opencode-go/old"])
  })

  it("reports a matched record with no index separately from an unmatched model", () => {
    const rows = [...benchmarks.records.map((record) => row(record.id, record.intelligenceIndex)), row("vendor/empty", null)]
    const withEmpty = parseBenchmarks(
      {
        data: [...rows, { id: "vendor/empty", name: "Empty", benchmarks: { artificial_analysis: {} } }],
      },
      { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z" },
    )
    const models = [...catalog(), model({ providerID: "opencode-go", modelID: "empty", canonicalModelID: "vendor/empty" })]
    const result = refreshScores({ catalog: models, benchmarks: withEmpty, base: baseTable(), now: NOW })

    expect(result.matchedWithoutBenchmark.map((entry) => entry.id)).toEqual(["opencode-go/empty"])
    expect(result.unmatched.map((entry) => entry.id)).toEqual(["opencode-go/unmatched"])
    const report = result.models.find((entry) => entry.id === "opencode-go/empty")
    expect(report?.action).toBe("no-benchmark")
  })

  it("uses an explicit alias for a join the matcher cannot make", () => {
    const models = [...catalog(), model({ providerID: "opencode-go", modelID: "aliased", canonicalModelID: "vendor/none" })]
    const result = refreshScores({
      catalog: models,
      benchmarks,
      base: baseTable(),
      aliases: { "opencode-go/aliased": "vendor/cheap" },
      now: NOW,
    })
    expect(result.models.find((entry) => entry.id === "opencode-go/aliased")).toMatchObject({
      action: "updated",
      match: { id: "vendor/cheap", via: "alias" },
    })
    expect(result.table.models["opencode-go/aliased"]).toEqual({ intelligence: 85 })
  })

  it("refuses to wipe the table when the catalog is empty", () => {
    expect(() => refreshScores({ catalog: [], benchmarks, base: baseTable(), now: NOW })).toThrow(/catalog is empty/)
  })

  it("writes sorted, deterministic JSON", () => {
    const a = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW }).table
    const b = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW }).table
    const ids = Object.keys(a.models)
    expect(ids).toEqual([...ids].sort())
    expect(serializeScoreTable(a)).toBe(serializeScoreTable(b))
  })
})

describe("scoreTablesMatch", () => {
  it("ignores the fields that change on every run", () => {
    const a = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW }).table
    const b = structuredClone(a)
    b.updated = "1999-01-01"
    b._meta!.generated = "1999-01-01"
    b._meta!.fetchedAt = "1999-01-01T00:00:00.000Z"
    expect(scoreTablesMatch(a, b)).toBe(true)
  })

  it("notices a score change", () => {
    const a = refreshScores({ catalog: catalog(), benchmarks, base: baseTable(), now: NOW }).table
    const b = structuredClone(a)
    b.models["opencode-go/smart"]!.intelligence = 1
    expect(scoreTablesMatch(a, b)).toBe(false)
  })
})
