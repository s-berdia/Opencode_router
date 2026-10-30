import fs from "node:fs"
import type { Ledger, LedgerAllowance, LedgerModelState } from "./types.js"
import { isPlainObject, readJsonFile, writeJson } from "./paths.js"
import { FIVE_HOUR_SHARE, WEEK_SHARE } from "./scoring.js"

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Step ids kept for cross-host dedupe; enough to cover any in-flight step. */
const MAX_SEEN_STEPS = 1000
export const WINDOW_5H = 5 * HOUR
export const WINDOW_WEEK = 7 * DAY
export const WINDOW_MONTH = 30 * DAY

type AllowancePeriod = "5h" | "week" | "month"


function emptyState(now: number): LedgerModelState {
  return {
    cost5h: 0,
    costWeek: 0,
    costMonth: 0,
    tokens5h: 0,
    tokensWeek: 0,
    tokensMonth: 0,
    window5hStart: now,
    windowWeekStart: now,
    windowMonthStart: now,
  }
}

function emptyLedger(now: number): Ledger {
  return { version: 2, updatedAt: new Date(now).toISOString(), models: {}, seen: [] }
}

function isLedger(value: unknown): value is Ledger {
  return isPlainObject(value) && value.version === 2 && isPlainObject(value.models)
}

function isLegacyLedger(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && value.version === 1 && isPlainObject(value.models)
}

/**
 * Version 1 estimated each step with a blended per-million price on the total
 * token count. That overcharged cache-heavy turns by up to two orders of
 * magnitude, so those numbers cannot be kept. Cooldowns are real and survive.
 */
function migrateLegacy(value: Record<string, unknown>, now: number): Ledger {
  const models: Record<string, LedgerModelState> = {}
  const legacyModels = isPlainObject(value.models) ? value.models : {}
  for (const [id, raw] of Object.entries(legacyModels)) {
    if (!isPlainObject(raw)) continue
    const state = emptyState(now)
    if (typeof raw.cooldownUntil === "number" && raw.cooldownUntil > now) state.cooldownUntil = raw.cooldownUntil
    if (typeof raw.lastError === "string") state.lastError = raw.lastError
    models[id] = state
  }

  const allowance: LedgerAllowance = { buckets: [] }
  if (isPlainObject(value.allowance)) {
    if (typeof value.allowance.cooldownUntil === "number" && value.allowance.cooldownUntil > now) {
      allowance.cooldownUntil = value.allowance.cooldownUntil
    }
    if (typeof value.allowance.lastError === "string") allowance.lastError = value.allowance.lastError
  }

  return { version: 2, updatedAt: new Date(now).toISOString(), models, allowance, seen: [] }
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return -1
  }
}

/** Add calendar months in UTC, clamping Jan 31 + 1 month to the last day of February. */
function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, last))
  return date.getTime()
}

/** The current window start: the latest period boundary at or before `now`. */
function advanceWindow(start: number, now: number, period: AllowancePeriod): number {
  if (!Number.isFinite(start) || start > now) return now
  if (period === "5h") return start + Math.floor((now - start) / WINDOW_5H) * WINDOW_5H
  if (period === "week") return start + Math.floor((now - start) / WINDOW_WEEK) * WINDOW_WEEK
  let current = start
  for (let i = 0; i < 240 && addMonths(current, 1) <= now; i++) current = addMonths(current, 1)
  return current
}

/** The next reset after `now`. */
function nextWindow(start: number, now: number, period: AllowancePeriod): number {
  if (period === "5h") return advanceWindow(start, now, period) + WINDOW_5H
  if (period === "week") return advanceWindow(start, now, period) + WINDOW_WEEK
  let next = addMonths(advanceWindow(start, now, period), 1)
  for (let i = 0; i < 240 && next <= now; i++) next = addMonths(next, 1)
  return next
}

/** The earliest stored step at or after `from`, or `fallback`. */
function firstAtOrAfter(buckets: Array<[number, number]>, from: number, fallback: number): number {
  let first: number | undefined
  for (const [at] of buckets) {
    if (at >= from && (first === undefined || at < first)) first = at
  }
  return first ?? fallback
}

/**
 * Version 2 ledgers written before the fixed-window change have hourly buckets
 * and no starts. Anchor each window at the first step still visible in it, so
 * the upgrade does not throw the current cycle away.
 */
function ensureWindowAnchors(ledger: Ledger, now: number): void {
  if (!ledger.allowance || !Array.isArray(ledger.allowance.buckets)) ledger.allowance = { buckets: [] }
  const allowance = ledger.allowance
  allowance.buckets = allowance.buckets.filter(
    (bucket): bucket is [number, number] =>
      Array.isArray(bucket) && typeof bucket[0] === "number" && typeof bucket[1] === "number" && Number.isFinite(bucket[1]),
  )
  if (typeof allowance.window5hStart !== "number") {
    allowance.window5hStart = firstAtOrAfter(allowance.buckets, now - WINDOW_5H, now)
  }
  if (typeof allowance.windowWeekStart !== "number") {
    allowance.windowWeekStart = firstAtOrAfter(allowance.buckets, now - WINDOW_WEEK, now)
  }
  if (typeof allowance.windowMonthStart !== "number") {
    allowance.windowMonthStart = firstAtOrAfter(allowance.buckets, now - 40 * DAY, now)
  }
}

/** Current starts, advanced past any window that has ended. */
function currentStarts(allowance: LedgerAllowance, now: number): { w5: number; week: number; month: number } {
  const w5 = advanceWindow(allowance.window5hStart ?? now, now, "5h")
  const week = advanceWindow(allowance.windowWeekStart ?? now, now, "week")
  const month = advanceWindow(allowance.windowMonthStart ?? now, now, "month")
  allowance.window5hStart = w5
  allowance.windowWeekStart = week
  allowance.windowMonthStart = month
  return { w5, week, month }
}

/** Sum of the shares whose step time is inside [from, now]. */
function windowShareFrom(buckets: Array<[number, number]>, from: number, now: number): number {
  let sum = 0
  for (const [at, share] of buckets) {
    if (at >= from && at <= now) sum += share
  }
  return sum
}

/** One completed assistant step, as `session.step.ended` reports it. */
export interface StepRecord {
  /** `assistantMessageID`; when set, a step is counted once across hosts. */
  stepID?: string
  modelId: string
  /** USD the step cost, for the per-model spend stats. */
  costUSD: number
  tokens: number
  /** Part of the shared Go allowance the step used; 0 outside the allowance. */
  allowanceShare?: number
  /** When the step ran; defaults to now. Sets the allowance bucket. */
  at?: number
}

export interface ModelUsage {
  cost5h: number
  costMonth: number
  tokens5h: number
  tokensMonth: number
  cooldownUntil: number | null
}

/** Use of the shared Go allowance, as a part of each window's limit (1 = 100%). */
export interface AllowanceUsage {
  pct5h: number
  pctWeek: number
  pctMonth: number
  /** When each window next resets, in ms. */
  resets5h?: number
  resetsWeek?: number
  resetsMonth?: number
  cooldownUntil: number | null
  /** Why the cooldown started; null without a cooldown. */
  cooldownReason: string | null
}

/**
 * Rolling spend per model, stored in one JSON file. Several OpenCode sessions
 * can share the file: each call reloads it when another process changed it.
 */
export class LedgerStore {
  private data: Ledger
  private loadedMtime = -1

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    anchors?: { weekStart?: number | string; monthStart?: number | string },
  ) {
    this.data = this.load()
    this.applyAnchors(anchors)
  }

  /** Use the console's exact weekly/monthly starts when the user configured them. */
  private applyAnchors(anchors?: { weekStart?: number | string; monthStart?: number | string }): void {
    if (!anchors) return
    const allowance = this.sharedAllowance()
    const week = typeof anchors.weekStart === "number" ? anchors.weekStart : Date.parse(anchors.weekStart ?? "")
    const month = typeof anchors.monthStart === "number" ? anchors.monthStart : Date.parse(anchors.monthStart ?? "")
    if (Number.isFinite(week)) allowance.windowWeekStart = week
    if (Number.isFinite(month)) allowance.windowMonthStart = month
  }

  /** Read the file. A corrupt file is kept as `<file>.corrupt-<time>` and a new ledger starts. */
  private load(): Ledger {
    this.loadedMtime = mtimeOf(this.file)
    const result = readJsonFile(this.file)
    if (result.status === "ok") {
      if (isLedger(result.value)) {
        ensureWindowAnchors(result.value, this.now())
        return result.value
      }
      if (isLegacyLedger(result.value)) {
        const migrated = migrateLegacy(result.value, this.now())
        try {
          writeJson(this.file, migrated)
          this.loadedMtime = mtimeOf(this.file)
        } catch {
          /* keep the migrated copy in memory; the next save writes version 2 */
        }
        return migrated
      }
    }
    if (result.status !== "absent") {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`)
      } catch {
        /* keep going with an empty ledger */
      }
      this.loadedMtime = -1
    }
    return emptyLedger(this.now())
  }

  private sync(): void {
    if (mtimeOf(this.file) !== this.loadedMtime) this.data = this.load()
  }

  /** Reset each window that has ended. */
  private roll(state: LedgerModelState, now: number): LedgerModelState {
    if (now - state.window5hStart >= WINDOW_5H) {
      state.cost5h = 0
      state.tokens5h = 0
      state.window5hStart = now
    }
    if (now - state.windowWeekStart >= WINDOW_WEEK) {
      state.costWeek = 0
      state.tokensWeek = 0
      state.windowWeekStart = now
    }
    if (now - state.windowMonthStart >= WINDOW_MONTH) {
      state.costMonth = 0
      state.tokensMonth = 0
      state.windowMonthStart = now
    }
    return state
  }

  /** The stored state, without creating an entry for a model that has never run. */
  private existing(modelId: string): LedgerModelState | undefined {
    this.sync()
    const entry = this.data.models[modelId]
    return entry ? this.roll(entry, this.now()) : undefined
  }

  private stateFor(modelId: string, now = this.now()): LedgerModelState {
    this.sync()
    let entry = this.data.models[modelId]
    if (!entry) {
      entry = emptyState(now)
      this.data.models[modelId] = entry
    }
    return this.roll(entry, now)
  }

  /**
   * Record one completed step. Returns false when the step id was already
   * counted, either by this process or by another OpenCode host that shares
   * the ledger file.
   */
  recordStep(step: StepRecord): boolean {
    this.sync()
    if (step.stepID && this.hasStep(step.stepID)) return false

    const at = step.at ?? this.now()
    const state = this.stateFor(step.modelId)
    const cost = Number.isFinite(step.costUSD) ? step.costUSD : 0
    const tokens = Number.isFinite(step.tokens) ? Math.max(0, step.tokens) : 0
    state.cost5h += cost
    state.costWeek += cost
    state.costMonth += cost
    state.tokens5h += tokens
    state.tokensWeek += tokens
    state.tokensMonth += tokens
    state.lastUsedAt = this.now()

    const share = Number.isFinite(step.allowanceShare) ? (step.allowanceShare ?? 0) : 0
    if (share > 0) this.addShare(share, at)
    if (step.stepID) this.rememberStep(step.stepID)
    this.save()
    return true
  }

  /** `allowanceShare`: the cost divided by the model's monthly limit; 0 for a model outside the Go allowance. */
  record(modelId: string, costUSD: number, tokens: number, allowanceShare = 0, stepID?: string, at?: number): boolean {
    return this.recordStep({ modelId, costUSD, tokens, allowanceShare, stepID, at })
  }

  private hasStep(id: string): boolean {
    return Array.isArray(this.data.seen) && this.data.seen.includes(id)
  }

  private rememberStep(id: string): void {
    if (!Array.isArray(this.data.seen)) this.data.seen = []
    const seen = this.data.seen
    const index = seen.indexOf(id)
    if (index !== -1) seen.splice(index, 1)
    seen.push(id)
    if (seen.length > MAX_SEEN_STEPS) seen.splice(0, seen.length - MAX_SEEN_STEPS)
  }

  /** Call after a sync-triggering read, never before: a reload would drop changes to the old data. */
  private sharedAllowance(): LedgerAllowance {
    if (!this.data.allowance || !Array.isArray(this.data.allowance.buckets)) this.data.allowance = { buckets: [] }
    return this.data.allowance
  }

  private addShare(share: number, at: number): void {
    const allowance = this.sharedAllowance()
    const now = this.now()
    // On the first step, the window starts at that step. Later steps use the
    // wall clock so a delayed/old event cannot move the window backwards.
    const windowNow =
      typeof allowance.window5hStart === "number" && typeof allowance.windowWeekStart === "number" && typeof allowance.windowMonthStart === "number"
        ? Math.max(at, now)
        : at
    currentStarts(allowance, windowNow)
    // One entry per step, so a window boundary between two steps is exact.
    allowance.buckets.push([at, share])
    const keepFrom = Math.min(
      allowance.windowMonthStart ?? now,
      allowance.windowWeekStart ?? now,
      allowance.window5hStart ?? now,
    )
    allowance.buckets = allowance.buckets.filter(([timestamp]) => timestamp >= keepFrom - 2 * DAY)
  }

  cooldown(modelId: string, durationMs: number, reason?: string): void {
    const state = this.stateFor(modelId)
    state.cooldownUntil = this.now() + durationMs
    if (reason) state.lastError = reason
    this.save()
  }

  clearCooldown(modelId: string): void {
    const state = this.stateFor(modelId)
    state.cooldownUntil = undefined
    this.save()
  }

  inCooldown(modelId: string): boolean {
    const until = this.existing(modelId)?.cooldownUntil
    return until !== undefined && this.now() < until
  }

  /** After a usage-limit error: every model that uses the shared allowance is limited. */
  cooldownAllowance(durationMs: number, reason?: string): void {
    this.sync()
    const allowance = this.sharedAllowance()
    allowance.cooldownUntil = this.now() + durationMs
    if (reason) allowance.lastError = reason
    this.save()
  }

  usage(modelId: string): ModelUsage {
    const state = this.existing(modelId)
    return {
      cost5h: state?.cost5h ?? 0,
      costMonth: state?.costMonth ?? 0,
      tokens5h: state?.tokens5h ?? 0,
      tokensMonth: state?.tokensMonth ?? 0,
      cooldownUntil: state?.cooldownUntil ?? null,
    }
  }

  /** Use of the shared allowance in the current 5-hour, weekly, and monthly windows. */
  allowance(): AllowanceUsage {
    this.sync()
    const allowance = this.sharedAllowance()
    const now = this.now()
    const starts = currentStarts(allowance, now)
    const cooldownUntil =
      allowance.cooldownUntil !== undefined && now < allowance.cooldownUntil ? allowance.cooldownUntil : null
    return {
      pct5h: windowShareFrom(allowance.buckets, starts.w5, now) / FIVE_HOUR_SHARE,
      pctWeek: windowShareFrom(allowance.buckets, starts.week, now) / WEEK_SHARE,
      pctMonth: windowShareFrom(allowance.buckets, starts.month, now),
      resets5h: nextWindow(starts.w5, now, "5h"),
      resetsWeek: nextWindow(starts.week, now, "week"),
      resetsMonth: nextWindow(starts.month, now, "month"),
      cooldownUntil,
      cooldownReason: cooldownUntil === null ? null : (allowance.lastError ?? null),
    }
  }

  /** True when no window has reached `softThreshold` and no usage-limit cooldown is active. */
  allowanceAvailable(softThreshold: number): boolean {
    const u = this.allowance()
    return u.cooldownUntil === null && u.pct5h < softThreshold && u.pctWeek < softThreshold && u.pctMonth < softThreshold
  }

  snapshot(): Ledger {
    return structuredClone(this.data)
  }

  save(): void {
    this.data.updatedAt = new Date(this.now()).toISOString()
    writeJson(this.file, this.data)
    this.loadedMtime = mtimeOf(this.file)
  }
}
