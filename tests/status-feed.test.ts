import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyLiveState,
  clearStatusCache,
  healthForCatalog,
  loadStatusHealth,
  parseStatus,
  parseUptime,
  statusServiceFor,
  uptimeScore,
} from "../src/status.js"
import { resolveConfig } from "../src/config.js"
import { emptyFeedScores } from "../src/scoring.js"
import { rankRole } from "../src/rank.js"
import { resolveTable } from "../src/score-table.js"
import type { HealthMap, ModelHealth, StatusService } from "../src/status.js"
import type { CatalogModel } from "../src/types.js"
import { model } from "./helpers.js"

/** Mirrors the live payload: `breakdown[]` per component, `models` per history bucket. */
const payload = {
  stale: false,
  components: [
    {
      service: "go",
      status: "operational",
      breakdown: [{ id: "mimo-v2.6-flash", status: "operational", reason: "none", speed: { ttft: 4302, tps: 67 } }],
    },
  ],
  history: [
    { start: 1_792_627_200_000, models: { go: { "mimo-v2.6-flash": "operational", "gpt-6-luna": "degraded" } } },
    { start: 1_792_638_000_000, models: { go: { "mimo-v2.6-flash": "operational", "gpt-6-luna": "outage" } } },
    { start: 1_792_648_800_000, models: { go: { "mimo-v2.6-flash": "degraded", "gpt-6-luna": "operational" } } },
  ],
}

const NOW = 1_793_231_777_736

function goRow(payloadLike: unknown = payload) {
  const uptime = parseUptime(parseStatus(payloadLike), NOW)
  return { uptime, go: uptime.get("go")! }
}

afterEach(() => {
  clearStatusCache()
  vi.unstubAllGlobals()
})

describe("statusServiceFor", () => {
  it("sends free models to the free service on either provider", () => {
    expect(statusServiceFor("opencode", true)).toBe("free")
    expect(statusServiceFor("opencode-go", true)).toBe("free")
  })

  it("separates Go subscription models from pay-as-you-go", () => {
    expect(statusServiceFor("opencode-go", false)).toBe("go")
    expect(statusServiceFor("opencode", false)).toBe("payg")
  })
})

describe("parseUptime", () => {
  it("counts a degraded bucket as no uptime, since the model was not usable", () => {
    const { go } = goRow()
    // Two operational of three, not "100% because it always answered".
    expect(go["mimo-v2.6-flash"]!.uptime).toBeCloseTo(66.7, 1)
    expect(go["mimo-v2.6-flash"]!.buckets).toBe(3)
  })

  it("treats an outage like a degradation for scoring", () => {
    const { go } = goRow()
    expect(go["gpt-6-luna"]!.uptime).toBeCloseTo(33.3, 1)
  })

  it("skips buckets that end in the future", () => {
    const future = {
      ...payload,
      history: [...payload.history, { start: NOW + 1_000_000, models: { go: { "mimo-v2.6-flash": "outage" } } }],
    }
    const { go } = goRow(future)
    expect(go["mimo-v2.6-flash"]!.buckets).toBe(3)
    expect(go["mimo-v2.6-flash"]!.uptime).toBeCloseTo(66.7, 1)
  })

  it("ignores a service the router does not map to a tier", () => {
    const odd = { history: [{ start: NOW - 1000, models: { console: { "mimo-v2.6-flash": "outage" } } }] }
    const uptime = parseUptime(parseStatus(odd), NOW)
    expect([...uptime.keys()]).toEqual(["go", "payg", "free"])
  })
})

describe("applyLiveState", () => {
  it("records time to first token and throughput per model", () => {
    const { uptime } = goRow()
    applyLiveState(parseStatus(payload), uptime)
    const mimo = uptime.get("go")!["mimo-v2.6-flash"]!
    expect(mimo.ttftMs).toBe(4302)
    expect(mimo.tps).toBe(67)
    expect(mimo.live).toBe("operational")
  })

  it("marks a degraded model without erasing its seven-day uptime", () => {
    const degraded = {
      ...payload,
      components: [{ service: "go", breakdown: [{ id: "mimo-v2.6-flash", status: "degraded" }] }],
    }
    const { uptime } = goRow()
    applyLiveState(parseStatus(degraded), uptime)
    const mimo = uptime.get("go")!["mimo-v2.6-flash"]!
    expect(mimo.live).toBe("degraded")
    expect(mimo.uptime).toBeCloseTo(66.7, 1)
  })
})

describe("uptimeScore", () => {
  it("is the uptime share, so a model that is broken most of the week scores low", () => {
    const health: ModelHealth = { uptime: 31, buckets: 56, ttftMs: null, tps: null, live: "unknown" }
    expect(uptimeScore(health)).toBe(31)
  })

  it("returns 0 rather than NaN for an unmeasured model", () => {
    expect(uptimeScore(undefined)).toBe(0)
    expect(uptimeScore({ uptime: 0, buckets: 0, ttftMs: null, tps: null, live: "unknown" })).toBe(0)
  })
})

describe("parseStatus", () => {
  it("rejects a body that is not a status payload", () => {
    expect(() => parseStatus("nope")).toThrow()
    expect(() => parseStatus({ foo: 1 })).toThrow(/neither history nor components/)
  })

  it("accepts a payload carrying only live components", () => {
    expect(() => parseStatus({ components: [] })).not.toThrow()
  })
})

describe("healthForCatalog", () => {
  it("keys health by provider/model and skips models the feed does not follow", () => {
    const { uptime } = goRow()
    const catalog = [
      model({ providerID: "opencode-go", modelID: "mimo-v2.6-flash" }),
      model({ providerID: "opencode-go", modelID: "never-heard-of-it" }),
    ]
    const health = healthForCatalog(uptime, catalog)
    expect([...health.keys()]).toEqual(["opencode-go/mimo-v2.6-flash"])
  })
})

describe("loadStatusHealth", () => {
  it("stays silent when the config turns it off", async () => {
    const cfg = resolveConfig({ status: { enabled: false } }, [], "go")
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)

    const { uptime, note } = await loadStatusHealth(cfg)

    expect(spy).not.toHaveBeenCalled()
    expect(uptime.size).toBe(0)
    expect(note).toBeNull()
  })

  it("returns an empty map and a note when the endpoint fails, so routing survives", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    const cfg = resolveConfig({ status: { enabled: true } }, [], "go")

    const { uptime, note } = await loadStatusHealth(cfg)

    expect(uptime.size).toBe(0)
    expect(note).toMatch(/unavailable \(network down\)/)
  })

  it("does not call the endpoint again inside the cache window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const cfg = resolveConfig({ status: { enabled: true } }, [], "go")

    await loadStatusHealth(cfg)
    await loadStatusHealth(cfg)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reports a stale feed rather than pretending the data is current", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...payload, stale: true }), { status: 200 })),
    )
    const cfg = resolveConfig({ status: { enabled: true } }, [], "go")

    const { note } = await loadStatusHealth(cfg)

    expect(note).toMatch(/stale/)
  })
})

/** A health map shaped like the live feed's, for the ranking tests. */
function healthFor(ids: Record<string, Partial<ModelHealth>>): HealthMap {
  const out: HealthMap = new Map()
  for (const [id, partial] of Object.entries(ids)) {
    out.set(id, { uptime: 50, buckets: 56, ttftMs: null, tps: null, live: "unknown", ...partial })
  }
  return out
}

describe("reliability in the ranking", () => {
  const catalog: CatalogModel[] = [
    model({ providerID: "opencode", modelID: "flaky-free", family: "flaky", free: true, limit: { context: 400_000, output: 32_000 } }),
    model({ providerID: "opencode", modelID: "steady-free", family: "steady", free: true, limit: { context: 400_000, output: 32_000 } }),
  ]

  function rank(health: HealthMap, minUptime?: number) {
    const table = resolveTable({})
    const cfg = resolveConfig(minUptime === undefined ? {} : { status: { minUptime } }, catalog, "free")
    return rankRole(catalog, "explore", table, cfg, emptyFeedScores(), health).map((e) => e.modelID)
  }

  it("ranks the steady model above an equally fast but flaky one", () => {
    const chain = rank(healthFor({ "opencode/flaky-free": { uptime: 31 }, "opencode/steady-free": { uptime: 93 } }))
    expect(chain[0]).toBe("steady-free")
  })

  it("lets an override win over the measured uptime", () => {
    const table = resolveTable({ scores: { "opencode/flaky-free": { reliability: 99 } } })
    const cfg = resolveConfig({}, catalog, "free")
    const chain = rankRole(catalog, "explore", table, cfg, emptyFeedScores(), healthFor({
      "opencode/flaky-free": { uptime: 5 },
      "opencode/steady-free": { uptime: 93 },
    }))
    expect(chain[0]!.modelID).toBe("flaky-free")
    expect(chain[0]!.sources.reliability).toBe("override")
  })

  it("benches a model below the uptime floor, but keeps one the feed does not follow", () => {
    // steady-free is absent from the health map: unmeasured is not unreliable.
    const chain = rank(healthFor({ "opencode/flaky-free": { uptime: 31 } }), 50)
    expect(chain).toEqual(["steady-free"])
  })

  it("keeps the neutral prior for an untracked model", () => {
    const table = resolveTable({})
    const cfg = resolveConfig({}, catalog, "free")
    const entry = rankRole(catalog, "explore", table, cfg, emptyFeedScores(), new Map())[0]!
    expect(entry.reliability).toBe(85)
    expect(entry.sources.reliability).toBe("default")
  })
})
