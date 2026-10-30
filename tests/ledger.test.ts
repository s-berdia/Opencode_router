import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LedgerStore } from "../src/ledger.js"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const files: string[] = []

function tmpFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "router-")), "ledger.json")
  files.push(path.dirname(file))
  return file
}

afterEach(() => {
  for (const dir of files.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("LedgerStore spend", () => {
  it("tracks spend and tokens per model", () => {
    const store = new LedgerStore(tmpFile(), () => 1_000_000)
    store.record("opencode-go/x", 3, 1_000_000)
    expect(store.usage("opencode-go/x")).toMatchObject({ cost5h: 3, costMonth: 3, tokens5h: 1_000_000 })
  })

  it("persists across instances", () => {
    const file = tmpFile()
    const now = 10 * DAY
    new LedgerStore(file, () => now).record("opencode-go/x", 1, 100, 0.1)
    const reopened = new LedgerStore(file, () => now)
    expect(reopened.usage("opencode-go/x").cost5h).toBeCloseTo(1, 5)
    expect(reopened.allowance().pct5h).toBeCloseTo(0.5, 5)
  })

  it("keeps the records of two stores that share one file", () => {
    const file = tmpFile()
    const now = 10 * DAY
    const first = new LedgerStore(file, () => now)
    const second = new LedgerStore(file, () => now)
    first.record("opencode-go/x", 1, 10, 0.02)
    second.record("opencode-go/x", 2, 20, 0.04)
    const reopened = new LedgerStore(file, () => now)
    expect(reopened.usage("opencode-go/x").cost5h).toBeCloseTo(3, 5)
    expect(reopened.allowance().pct5h).toBeCloseTo(0.3, 5)
  })

  it("keeps a copy of a corrupt ledger file", () => {
    const file = tmpFile()
    fs.writeFileSync(file, "{ not json", "utf8")
    new LedgerStore(file, () => 1_000_000).record("opencode-go/x", 1, 10)
    const copies = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("ledger.json.corrupt"))
    expect(copies).toHaveLength(1)
  })
})

describe("LedgerStore shared Go allowance", () => {
  it("adds the share of every model to one allowance", () => {
    const store = new LedgerStore(tmpFile(), () => 10 * DAY)
    store.record("opencode-go/x", 6, 10, 0.1)
    store.record("opencode-go/y", 1, 10, 0.05)

    const allowance = store.allowance()

    // 5 hours = 20% of the month, 7 days = 50%.
    expect(allowance.pct5h).toBeCloseTo(0.75, 5)
    expect(allowance.pctWeek).toBeCloseTo(0.3, 5)
    expect(allowance.pctMonth).toBeCloseTo(0.15, 5)
  })

  it("is not available once the 5-hour use reaches the soft threshold", () => {
    const store = new LedgerStore(tmpFile(), () => 10 * DAY)
    store.record("opencode-go/x", 1, 10, 0.16)
    expect(store.allowanceAvailable(0.85)).toBe(true)
    store.record("opencode-go/x", 1, 10, 0.01)
    expect(store.allowanceAvailable(0.85)).toBe(false)
  })

  it("is not available once the 7-day use reaches the soft threshold", () => {
    let now = 10 * DAY
    const store = new LedgerStore(tmpFile(), () => now)
    for (let i = 0; i < 3; i++) {
      store.record("opencode-go/x", 1, 10, 0.15)
      now += 6 * HOUR
    }
    // 0.45 of the month in 18 hours: 90% of the 7-day allowance, 0% of the last 5 hours.
    expect(store.allowance().pct5h).toBe(0)
    expect(store.allowanceAvailable(0.85)).toBe(false)
  })

  it("drops use older than 5 hours from the 5-hour window only", () => {
    let now = 10 * DAY
    const store = new LedgerStore(tmpFile(), () => now)
    store.record("opencode-go/x", 1, 10, 0.1)
    now += 6 * HOUR

    const allowance = store.allowance()

    expect(allowance.pct5h).toBe(0)
    expect(allowance.pctWeek).toBeCloseTo(0.2, 5)
    expect(allowance.pctMonth).toBeCloseTo(0.1, 5)
  })

  it("anchors the 5-hour window at the first step and resets it five hours later", () => {
    let now = 10 * DAY
    const store = new LedgerStore(tmpFile(), () => now)
    store.record("opencode-go/x", 1, 10, 0.1)
    now += 4 * HOUR
    expect(store.allowance().pct5h).toBeCloseTo(0.5, 5)

    now += 1.5 * HOUR
    // The first step is outside the reset window, so the current one is empty.
    expect(store.allowance().pct5h).toBe(0)
    expect(store.allowance().resets5h).toBe(10 * DAY + 10 * HOUR)
  })

  it("uses configured weekly and monthly starts from the console", () => {
    const now = Date.parse("2026-10-30T18:00:00Z")
    const store = new LedgerStore(tmpFile(), () => now, {
      weekStart: "2026-10-25T23:57:00Z",
      monthStart: "2026-10-26T19:57:00Z",
    })
    store.record("opencode-go/x", 1, 10, 0.1)
    const allowance = store.allowance()
    expect(allowance.resetsWeek).toBe(Date.parse("2026-11-01T23:57:00Z"))
    expect(allowance.resetsMonth).toBe(Date.parse("2026-11-26T19:57:00Z"))
  })

  it("ignores records without a share", () => {
    const store = new LedgerStore(tmpFile(), () => 10 * DAY)
    store.record("opencode/free-fast", 0, 10)
    expect(store.allowance()).toMatchObject({ pct5h: 0, pctWeek: 0, pctMonth: 0 })
  })

  it("keeps 30 days of records", () => {
    let now = 10 * DAY
    const file = tmpFile()
    const store = new LedgerStore(file, () => now)
    store.record("opencode-go/x", 1, 10, 0.1)
    now += 31 * DAY
    store.record("opencode-go/x", 1, 10, 0.1)
    expect(store.allowance().pctMonth).toBeCloseTo(0.1, 5)
    expect(store.snapshot().allowance?.buckets).toHaveLength(1)
  })

  it("applies and clears an allowance cooldown", () => {
    let now = 10 * DAY
    const store = new LedgerStore(tmpFile(), () => now)
    store.cooldownAllowance(60_000, "usage limit")
    expect(store.allowanceAvailable(0.85)).toBe(false)
    expect(store.allowance().cooldownUntil).toBe(now + 60_000)
    now += 61_000
    expect(store.allowanceAvailable(0.85)).toBe(true)
  })
})

describe("LedgerStore model cooldowns", () => {
  it("applies and clears a cooldown for one model", () => {
    let now = 1_000_000
    const store = new LedgerStore(tmpFile(), () => now)
    store.cooldown("opencode-go/x", 60_000, "rate limit")
    expect(store.inCooldown("opencode-go/x")).toBe(true)
    expect(store.inCooldown("opencode-go/y")).toBe(false)
    now += 61_000
    expect(store.inCooldown("opencode-go/x")).toBe(false)
  })

  it("does not create an entry for a model that is only checked", () => {
    const store = new LedgerStore(tmpFile(), () => 10 * DAY)
    expect(store.inCooldown("opencode-go/x")).toBe(false)
    expect(store.usage("opencode-go/x")).toMatchObject({ cost5h: 0, tokens5h: 0, cooldownUntil: null })
    expect(store.snapshot().models).toEqual({})
  })
})

describe("LedgerStore step dedupe", () => {
  it("counts one step id once when several stores share the file", () => {
    const file = tmpFile()
    const now = 10 * DAY
    const first = new LedgerStore(file, () => now)
    expect(first.record("opencode-go/x", 6, 10, 0.1, "step-1")).toBe(true)

    const second = new LedgerStore(file, () => now)
    expect(second.record("opencode-go/x", 6, 10, 0.1, "step-1")).toBe(false)

    expect(second.usage("opencode-go/x").costMonth).toBeCloseTo(6, 5)
    expect(second.allowance().pctMonth).toBeCloseTo(0.1, 5)
    expect(second.snapshot().seen).toEqual(["step-1"])
  })

  it("keeps the newest step ids only", () => {
    const store = new LedgerStore(tmpFile(), () => 10 * DAY)
    for (let i = 0; i < 1100; i++) store.record("opencode-go/x", 0, 1, 0, `step-${i}`)
    const seen = store.snapshot().seen ?? []
    expect(seen).toHaveLength(1000)
    expect(seen[0]).toBe("step-100")
    expect(seen.at(-1)).toBe("step-1099")
  })
})

describe("LedgerStore version 1 migration", () => {
  it("drops blended-cost totals but keeps cooldowns", () => {
    const file = tmpFile()
    const now = 10 * DAY
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: new Date(now).toISOString(),
        models: {
          "opencode-go/x": {
            cost5h: 99,
            costWeek: 99,
            costMonth: 99,
            tokens5h: 1,
            tokensWeek: 1,
            tokensMonth: 1,
            window5hStart: now,
            windowWeekStart: now,
            windowMonthStart: now,
            cooldownUntil: now + HOUR,
            lastError: "rate limit",
          },
          "opencode-go/y": { costMonth: 5 },
        },
        allowance: {
          buckets: [[now, 1]],
          cooldownUntil: now + HOUR,
          lastError: "Go usage limit",
        },
      }),
      "utf8",
    )

    const store = new LedgerStore(file, () => now)
    expect(store.usage("opencode-go/x")).toMatchObject({ costMonth: 0, cooldownUntil: now + HOUR })
    expect(store.inCooldown("opencode-go/x")).toBe(true)
    expect(store.allowance()).toMatchObject({ pctMonth: 0, cooldownUntil: now + HOUR, cooldownReason: "Go usage limit" })
    expect(store.snapshot().models["opencode-go/y"]?.costMonth).toBe(0)

    // The migrated file is written back as version 2, with the old buckets gone.
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
      version: number
      allowance: { buckets: unknown[] }
    }
    expect(saved.version).toBe(2)
    expect(saved.allowance.buckets).toEqual([])
  })
})
