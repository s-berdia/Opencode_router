import { expect, test } from "vitest"
import {
  allowanceUsage,
  bar,
  buildHudState,
  hudColor,
  hudLine,
  progressRatio,
  readThreshold,
  routerConfigPath,
  routingTablePath,
  shortModel,
  stateDirPath,
  tier,
  windowShare,
  parseJsonSafe,
  type LedgerData,
  type RoutingTableData,
} from "../tui/hud.js"

const HOUR = 3_600_000

test("windowShare sums only the buckets in the window", () => {
  const now = 1000 * HOUR
  const buckets: Array<[number, number]> = [
    [now - HOUR, 0.1], // ends at now: whole share counts
    [now - 10 * HOUR, 0.99], // ends before the 5h window starts
    [now - 0.5 * HOUR, 0.05], // ends at now: whole share counts
  ]
  expect(windowShare(buckets, now, 5 * HOUR)).toBeCloseTo(0.15)
  expect(windowShare(buckets, now, 30 * 24 * HOUR)).toBeCloseTo(0.1 + 0.99 + 0.05)
})

test("windowShare counts a partly out-of-window hour in part", () => {
  const now = 1000 * HOUR
  // starts at now - 1h, so only 1h of the 2h bucket is inside the 5h window? No:
  // hour buckets are 1h wide; start 4h before `now` keeps all of it inside.
  const buckets: Array<[number, number]> = [[now - 4 * HOUR, 0.05]]
  expect(windowShare(buckets, now, 5 * HOUR)).toBeCloseTo(0.05)
  // a bucket that began before `from` shares only its overlap
  const old: Array<[number, number]> = [[now - 5.5 * HOUR, 0.06]]
  expect(windowShare(old, now, 5 * HOUR)).toBeCloseTo(0.03)
})

test("windowShare tolerates malformed buckets", () => {
  const now = 1000 * HOUR
  const buckets = [[now - HOUR, 2]] as unknown as Array<[number, number]>
  expect(windowShare(buckets, now, 5 * HOUR)).toBe(2)
  const broken = [[5], "x"] as unknown as Array<[number, number]>
  expect(windowShare(broken, now, 5 * HOUR)).toBe(0)
})

test("allowanceUsage divides by the window shares and reads the cooldown", () => {
  const now = 10 * HOUR
  const ledger: LedgerData = { allowance: { buckets: [[now - HOUR, 0.1]], cooldownUntil: now + 1000 } }
  expect(allowanceUsage(ledger, now).pct5h).toBeCloseTo(0.1 / 0.2)
  expect(allowanceUsage(ledger, now).pctWeek).toBeCloseTo(0.1 / 0.5)
  expect(allowanceUsage(ledger, now).pctMonth).toBeCloseTo(0.1)
  expect(allowanceUsage(ledger, now).cooldown).toBe(true)
  expect(allowanceUsage({}, now).pct5h).toBe(0)
})

test("allowanceUsage ignores expired cooldowns", () => {
  const now = 10 * HOUR
  const ledger: LedgerData = { allowance: { buckets: [], cooldownUntil: now - 1000 } }
  expect(allowanceUsage(ledger, now).cooldown).toBe(false)
})

test("progressRatio is capped at 1 and safe at a zero threshold", () => {
  expect(progressRatio(0.17, 0.85)).toBeCloseTo(0.2)
  expect(progressRatio(2, 0.85)).toBe(1)
  expect(progressRatio(0.5, 0)).toBe(1)
})

test("bar fills from the left", () => {
  expect(bar(0, 4)).toBe("▁▁▁▁")
  expect(bar(1, 4)).toBe("████")
  expect(bar(0.5, 4)).toBe("██▁▁")
  expect(bar(Number.NaN, 4)).toBe("▁▁▁▁")
})

test("shortModel keeps the model part", () => {
  expect(shortModel("opencode-go/deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash")
  expect(shortModel(undefined)).toBe("none")
})

test("tier marks free failover models", () => {
  expect(tier({ id: "opencode/whatever-free" })).toBe("free")
  expect(tier({ id: "opencode-go/glm-5.3-flash" })).toBe("active")
  expect(tier(undefined)).toBe("active")
})

test("hudLine renders a compact one-line HUD with a leading gap", () => {
  const state = {
    activeModel: "opencode-go/glm-5.3-flash",
    nextModel: "opencode/nemotron-3.5-lightning-free",
    nextIsFree: true,
    usage: { pct5h: 0.17, pctWeek: 0, pctMonth: 0, cooldown: false },
    threshold: 0.85,
    plan: "go",
  }
  expect(hudLine(state, Date.now())).toBe(" 17% █▁▁▁▁▁ → nemotron-3.5-lightning-free (free)")
  expect(hudLine(state, Date.now(), 4)).toBe(" 17% █▁▁▁ → nemotron-3.5-lightning-free (free)")
  const paid = { ...state, nextIsFree: false, nextModel: "opencode-go/deepseek-v4.1-flash", usage: { pct5h: 0.85, pctWeek: 0, pctMonth: 0, cooldown: false } }
  expect(hudLine(paid, Date.now())).toBe(" 85% ██████ → deepseek-v4.1-flash")
})

test("hudColor turns red on cooldown and amber at the threshold", () => {
  const base = {
    activeModel: "a/b",
    nextModel: "c/d",
    nextIsFree: true,
    usage: { pct5h: 0.1, pctWeek: 0, pctMonth: 0, cooldown: false },
    threshold: 0.85,
    plan: "",
  }
  expect(hudColor({ ...base })).toBe("#4f9d55")
  expect(hudColor({ ...base, usage: { pct5h: 0.85, pctWeek: 0, pctMonth: 0, cooldown: false } })).toBe("#ffb03a")
  expect(hudColor({ ...base, usage: { pct5h: 0.1, pctWeek: 0, pctMonth: 0, cooldown: true } })).toBe("#ff5555")
})

test("stateDirPath honors XDG_CONFIG_HOME and tolerates separators", () => {
  expect(stateDirPath(undefined, "C:/Users/me")).toBe("C:/Users/me/.config/opencode/router")
  expect(stateDirPath("D:/xdg/", "C:/Users/me")).toBe("D:/xdg/opencode/router")
})

test("routerConfigPath resolves to the router config file", () => {
  expect(routerConfigPath("C:/Users/me/.config/opencode/router")).toBe("C:/Users/me/.config/opencode/router.config.json")
  expect(routerConfigPath("C:/Users/me/.config/opencode/router/")).toBe("C:/Users/me/.config/opencode/router.config.json")
})

test("routingTablePath appends the file name", () => {
  expect(routingTablePath("/home/me/.config/opencode/router")).toBe("/home/me/.config/opencode/router/routing-table.json")
})

test("readThreshold keeps a valid value and falls back to the default", () => {
  expect(readThreshold({ softThreshold: 0.7 })).toBe(0.7)
  expect(readThreshold({ softThreshold: 1.2 })).toBe(0.85)
  expect(readThreshold(null)).toBe(0.85)
})

test("buildHudState hides the widget without a build chain", () => {
  const table: RoutingTableData = {
    plan: "go",
    active: {
      build: [
        { id: "opencode-go/glm-5.3-flash", rank: 1 },
        { id: "opencode/nemotron-3.5-lightning-free", rank: 2 },
      ],
    },
  }
  const ledger: LedgerData = { allowance: { buckets: [[Date.now() - HOUR, 0.05]] } }
  const state = buildHudState({ ledger, table, config: undefined, now: Date.now() })
  expect(state?.activeModel).toBe("opencode-go/glm-5.3-flash")
  expect(state?.nextModel).toBe("opencode/nemotron-3.5-lightning-free")
  expect(state?.nextIsFree).toBe(true)
  expect(state?.plan).toBe("go")

  expect(buildHudState({ ledger, table: { active: {} }, config: undefined, now: 0 })).toBeNull()
  expect(buildHudState({ ledger, table: undefined, config: undefined, now: 0 })).toBeNull()
  expect(
    buildHudState({ ledger: undefined, table: { active: { build: [{ rank: 1 }] } }, config: undefined, now: 0 }),
  ).toBeNull()
})

test("parseJsonSafe survives BOM, noise, and absence", () => {
  expect(parseJsonSafe("﻿{\"a\":1}")).toEqual({ a: 1 })
  expect(parseJsonSafe("nope")).toBeUndefined()
  expect(parseJsonSafe("")).toBeUndefined()
  expect(parseJsonSafe(undefined)).toBeUndefined()
})
