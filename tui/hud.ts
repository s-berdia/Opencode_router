// Pure helpers for the opencode-router TUI widget.
// Self-contained on purpose: the widget runs as an OpenCode file plugin,
// so this module must not import anything from `src/`.

export const HOUR = 3_600_000
export const WINDOW_5H = 5 * HOUR
export const WINDOW_WEEK = 7 * HOUR * 24
export const WINDOW_MONTH = 30 * HOUR * 24

/** Share of the monthly allowance that one 5-hour window may use. */
export const FIVE_HOUR_SHARE = 0.2
/** Share of the monthly allowance that one 7-day window may use. */
export const WEEK_SHARE = 0.5

export const DEFAULT_SOFT_THRESHOLD = 0.85

/** `[score, weight]` pairs: an hour bucket of the shared Go allowance. */
export type LedgerBucket = [number, number]

export interface LedgerAllowanceData {
  buckets?: LedgerBucket[]
  cooldownUntil?: number
}

export interface LedgerData {
  version?: number
  updatedAt?: string
  models?: Record<string, unknown>
  allowance?: LedgerAllowanceData
}

export interface ChainEntryData {
  id?: string
  providerID?: string
  modelID?: string
  rank?: number
}

export interface RoutingTableData {
  version?: number
  plan?: string
  active?: Record<string, ChainEntryData[] | undefined>
}

/** `hud.json`, written by the server plugin for the widget. */
export interface HudFileData {
  version?: number
  mode?: string
  /** `sessionID:agent` -> the model the user picked. */
  manual?: Record<string, string>
  /** `sessionID` -> the model of the last message in that session. */
  last?: Record<string, string>
}

export interface AllowanceUsage {
  pct5h: number
  pctWeek: number
  pctMonth: number
  cooldown: boolean
}

/**
 * Sum of the shares in the last `windowMs`. The use in one hour is taken as
 * even, so an hour that is partly inside the window counts in part.
 * Mirrors `src/ledger.ts` windowShare.
 */
export function windowShare(buckets: LedgerBucket[], now: number, windowMs: number): number {
  if (!Array.isArray(buckets)) return 0
  const from = now - windowMs
  let sum = 0
  for (const entry of buckets) {
    if (!Array.isArray(entry)) continue
    const [start, share] = entry
    if (typeof start !== "number" || typeof share !== "number") continue
    const end = Math.min(start + HOUR, now)
    if (end <= from || start > now) continue
    const span = end - start
    sum += span <= 0 ? share : (share * (end - Math.max(start, from))) / span
  }
  return sum
}

export function allowanceUsage(ledger: LedgerData | undefined, now: number): AllowanceUsage {
  const buckets = ledger?.allowance?.buckets ?? []
  const cooldownUntil = ledger?.allowance?.cooldownUntil
  return {
    pct5h: windowShare(buckets, now, WINDOW_5H) / FIVE_HOUR_SHARE,
    pctWeek: windowShare(buckets, now, WINDOW_WEEK) / WEEK_SHARE,
    pctMonth: windowShare(buckets, now, WINDOW_MONTH),
    cooldown: cooldownUntil !== undefined && now < cooldownUntil,
  }
}

/** A fixed value is a share (0..1+); pct relative to the threshold, capped at 1 for display. */
export function progressRatio(pct: number, threshold: number): number {
  if (!(threshold > 0)) return pct > 0 ? 1 : 0
  return Math.min(pct / threshold, 1)
}

/** Text progress bar: filled blocks then low lines (renders cleanly in most terminal fonts). */
export function bar(ratio: number, width: number): string {
  const safe = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  const filled = Math.round(safe * width)
  return "█".repeat(filled) + "▁".repeat(Math.max(0, width - filled))
}

/** Short display name of `provider/model`: always the `model` part. */
export function shortModel(id: string | undefined): string {
  if (!id) return "none"
  const value = typeof id === "string" ? id : String(id)
  const slash = value.lastIndexOf("/")
  return value.slice(slash + 1)
}

/** `-free`-suffix models are the failover free tier; the widget marks them. */
export function tier(model: ChainEntryData | undefined): "free" | "active" {
  const id = typeof model?.id === "string" ? model.id.toLowerCase() : ""
  return id.includes("free") ? "free" : "active"
}

export interface HudState {
  activeModel: string
  nextModel: string
  nextIsFree: boolean
  usage: AllowanceUsage
  threshold: number
  plan: string
}

export interface HudState {
  activeModel: string
  nextModel: string
  nextIsFree: boolean
  usage: AllowanceUsage
  threshold: number
  plan: string
  /** Router mode from the server plugin; undefined when unknown. */
  mode?: string
  /** The model the user picked for this session; the router leaves it alone. */
  manualModel?: string
}

/**
 * ` 9% ██▁▁▁▁ → nemotron (free)` — one compact HUD line. A leading space keeps a gap from the host text.
 * A manual pick replaces the chain readout: ` 9% ██▁▁▁▁ in use glm (manual)`.
 */
export function hudLine(state: HudState, barWidth = 6): string {
  const ratio = progressRatio(state.usage.pct5h, state.threshold)
  const pct = `${Math.round(state.usage.pct5h * 100)}%`
  if (state.manualModel) {
    const using = shortModel(state.manualModel) || "none"
    return ` ${pct} ${bar(ratio, barWidth)} in use ${using} (manual)`
  }
  const next = shortModel(state.nextModel) || "none"
  const free = state.nextIsFree ? " (free)" : ""
  return ` ${pct} ${bar(ratio, barWidth)} → ${next}${free}`
}

/** Color by distance to the switch point, decided from the 5h share. */
export function hudColor(state: HudState): string {
  if (state.usage.cooldown) return "#ff5555"
  const ratio = progressRatio(state.usage.pct5h, state.threshold)
  if (ratio >= 1) return "#ffb03a"
  return "#4f9d55"
}

/** Parse strict JSON; a text with a BOM, an empty body, or a JSON error gives undefined. */
export function parseJsonSafe(text: string | undefined): unknown {
  if (typeof text !== "string") return undefined
  const clean = text.replace(/^\ufeff/, "").trim()
  if (!clean) return undefined
  try {
    return JSON.parse(clean)
  } catch {
    return undefined
  }
}

/** Global OpenCode router state dir, mirroring `src/paths.ts`. */
export function stateDirPath(xdgConfigHome: string | undefined, home: string): string {
  const base = typeof xdgConfigHome === "string" && xdgConfigHome.length > 0 ? xdgConfigHome : `${home}/.config`
  return `${base.replace(/[\\/]+$/, "")}/opencode/router`
}

export function ledgerPath(stateDir: string): string {
  return `${stateDir}/ledger.json`
}

export function routingTablePath(stateDir: string): string {
  return `${stateDir}/routing-table.json`
}

export function hudDataPath(stateDir: string): string {
  return `${stateDir}/hud.json`
}

export function routerConfigPath(stateDir: string): string {
  // stateDir is ".../opencode/router"; the config file lives beside it, not inside it.
  const clean = typeof stateDir === "string" ? stateDir.replace(/[\\/]+$/, "").replace(/[\\/]router$/, "") : ""
  return `${clean}/router.config.json`
}

export function readThreshold(config: unknown): number {
  if (!config || typeof config !== "object") return DEFAULT_SOFT_THRESHOLD
  const value = (config as Record<string, unknown>).softThreshold
  if (typeof value === "number" && value > 0 && value <= 1) return value
  return DEFAULT_SOFT_THRESHOLD
}

/** Build the widget state from raw files. Unknown/absent data becomes a hidden widget (null). */
export function buildHudState(input: {
  ledger: LedgerData | undefined
  table: RoutingTableData | undefined
  config: unknown
  hud: HudFileData | undefined
  sessionId?: string
  now: number
}): HudState | null {
  const chain = input.table?.active?.build
  const first = Array.isArray(chain) ? chain[0] : undefined
  if (!first || typeof first.id !== "string") return null
  const second = Array.isArray(chain) ? chain[1] : undefined
  // Any manual pick in the session hides the chain readout: the router is not deciding.
  const sessionKeys = input.sessionId
    ? Object.keys(input.hud?.manual ?? {}).filter((key) => key.startsWith(`${input.sessionId}:`))
    : []
  const manualKey = sessionKeys[0]
  return {
    activeModel: first.id,
    nextModel: second?.id ?? "none",
    nextIsFree: tier(second) === "free",
    usage: allowanceUsage(input.ledger, input.now),
    threshold: readThreshold(input.config),
    plan: typeof input.table?.plan === "string" ? input.table.plan : "",
    mode: typeof input.hud?.mode === "string" ? input.hud.mode : undefined,
    manualModel: manualKey !== undefined ? input.hud?.manual?.[manualKey] : undefined,
  }
}
