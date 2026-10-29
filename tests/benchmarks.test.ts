import { describe, expect, it } from "vitest"
import {
  benchmarkIntelligence,
  indexBenchmarks,
  matchBenchmark,
  normalizeModelName,
  parseBenchmarks,
  percentileRank,
  type BenchmarkTable,
} from "../src/benchmarks.js"
import { model } from "./helpers.js"

function table(rows: unknown[]): BenchmarkTable {
  return parseBenchmarks({ data: rows }, { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z" })
}

function row(
  id: string,
  aa: { intelligence?: number | null; coding?: number | null; agentic?: number | null },
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    benchmarks: {
      artificial_analysis: {
        intelligence_index: aa.intelligence ?? null,
        coding_index: aa.coding ?? null,
        agentic_index: aa.agentic ?? null,
      },
    },
    ...extra,
  }
}

describe("parseBenchmarks", () => {
  it("keeps records with a benchmark block and builds sorted distributions", () => {
    const parsed = table([
      row("vendor/a", { intelligence: 50, coding: 70 }),
      row("vendor/b", { intelligence: 10 }),
      row("vendor/c", { agentic: 40 }),
      { id: "vendor/unmeasured", name: "Unmeasured" },
    ])
    expect(parsed.records.map((record) => record.id)).toEqual(["vendor/a", "vendor/b", "vendor/c"])
    expect(parsed.distribution.intelligence).toEqual([10, 50])
    expect(parsed.distribution.coding).toEqual([70])
    expect(parsed.distribution.agentic).toEqual([40])
    expect(parsed.source).toBe("test")
    expect(parsed.fetchedAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("rejects a body that is not the OpenRouter model list", () => {
    expect(() => parseBenchmarks({ models: [] })).toThrow(/data array/)
  })
})

describe("normalizeModelName", () => {
  it("strips provider, display prefix, release decorations, and dates", () => {
    expect(normalizeModelName("Anthropic: Claude Opus 5.5")).toBe("claudeopus55")
    expect(normalizeModelName("opencode-go/glm-5.3-flash-free")).toBe("glm53flash")
    expect(normalizeModelName("vendor/kimi-k3.1-pro:batch")).toBe("kimik31pro")
    expect(normalizeModelName("vendor/gpt-6-2026-10-27")).toBe("gpt6")
  })
})

describe("matchBenchmark", () => {
  const parsed = table([
    row("anthropic/claude-opus-5.5", { intelligence: 58.4 }, { name: "Anthropic: Claude Opus 5.5" }),
    row("openai/gpt-6-astra", { coding: 76.9 }, { canonical_slug: "openai/gpt-6-astra-2026" }),
    row("z-ai/glm-5.3-flash", { coding: 71.5, agentic: 50.9 }),
    row("qwen/qwen3.8-flash", {}),
    row("vendor/kimi-k3", {}),
    row("other/kimi-k3", {}),
  ])
  const index = indexBenchmarks(parsed)

  it("joins on the catalog canonical id first", () => {
    const m = model({
      providerID: "opencode",
      modelID: "claude-opus-5-5",
      canonicalModelID: "anthropic/claude-opus-5.5",
    })
    expect(matchBenchmark(m, index)).toMatchObject({ via: "canonical-id", record: { id: "anthropic/claude-opus-5.5" } })
  })

  it("joins on a canonical slug when the canonical id is a publish date", () => {
    const m = model({ providerID: "opencode", modelID: "gpt-6-astra", canonicalModelID: "openai/gpt-6-astra-2026" })
    expect(matchBenchmark(m, index)?.via).toBe("canonical-slug")
  })

  it("falls back to a normalized model id", () => {
    const m = model({ providerID: "opencode-go", modelID: "glm-5.3-flash-free" })
    expect(matchBenchmark(m, index)).toMatchObject({ via: "normalized-id", record: { id: "z-ai/glm-5.3-flash" } })
  })

  it("uses a version-stripped key only as the last resort", () => {
    const loose = indexBenchmarks(table([row("vendor/claude-opus-5-6", { intelligence: 40 })]))
    const m = model({ providerID: "opencode", modelID: "claude-opus-5-5" })
    expect(matchBenchmark(m, loose)?.via).toBe("version-stripped")
  })

  it("refuses a normalization shared by two different records", () => {
    const m = model({ providerID: "opencode", modelID: "kimi-k3" })
    expect(matchBenchmark(m, index)).toBeUndefined()
  })

  it("matches a record that exists but has no index, so the report can tell the cases apart", () => {
    const matched = indexBenchmarks(table([row("qwen/qwen3.8-flash", {}, { name: "Qwen3.8 Flash" })]))
    const m = model({ providerID: "opencode-go", modelID: "qwen3.8-flash" })
    const match = matchBenchmark(m, matched)
    expect(match?.record.id).toBe("qwen/qwen3.8-flash")
    expect(benchmarkIntelligence(match!.record, matched.table)).toBeUndefined()
  })
})

describe("percentileRank", () => {
  it("uses the midrank for ties", () => {
    expect(percentileRank([10, 20, 30, 40], 20)).toBe(37.5)
    expect(percentileRank([10, 20, 20, 40], 20)).toBe(50)
    expect(percentileRank([10], 10)).toBe(50)
    expect(percentileRank([], 10)).toBe(0)
  })
})

describe("benchmarkIntelligence", () => {
  const parsed = table([
    row("vendor/a", { intelligence: 50, coding: 70, agentic: 40 }),
    row("vendor/b", { coding: 70, agentic: 40 }),
    row("vendor/c", { agentic: 40 }),
  ])

  it("prefers the overall intelligence index", () => {
    const result = benchmarkIntelligence(parsed.records[0]!, parsed)!
    expect(result.basis).toEqual(["intelligence"])
    expect(result.percentile).toBe(50)
  })

  it("blends coding and agentic when the overall index is missing", () => {
    const result = benchmarkIntelligence(parsed.records[1]!, parsed)!
    expect(result.basis).toEqual(["coding", "agentic"])
    expect(result.percentile).toBeCloseTo(result.percentiles.coding! * 0.6 + result.percentiles.agentic! * 0.4, 6)
  })

  it("falls back to a single available index", () => {
    expect(benchmarkIntelligence(parsed.records[2]!, parsed)!.basis).toEqual(["agentic"])
  })
})
