import type { ResolvedConfig } from "./types.js"

/**
 * Live model health from OpenCode's public status endpoint.
 *
 * The router's own ledger only learns about a model after it fails on this
 * machine. This is the prior for models that have not been tried yet, and the
 * only signal at all for the many catalog models the status page follows.
 *
 * The endpoint needs no authentication and returns current state, open
 * incidents, and seven days of three-hour buckets per model.
 */
export const DEFAULT_STATUS_URL = "https://status.opencode.ai/api/status"

/** How long a fetched status stays usable; the routing table rebuilds every 15 s. */
const CACHE_TTL_MS = 5 * 60_000

/** A model bucket in the history: how far the model was from working. */
type BucketState = "operational" | "degraded" | "outage"

/** The services the status page reports, which map onto OpenCode's tiers. */
export type StatusService = "go" | "payg" | "free"

export interface ModelHealth {
  /** 0-100 over the last seven days, counting a degraded bucket as no uptime. */
  uptime: number
  /** How many three-hour buckets back that uptime covers; 0 for an unknown model. */
  buckets: number
  /** Median milliseconds until the first token, over the last five minutes. */
  ttftMs: number | null
  /** Median tokens per second while streaming, over the last five minutes. */
  tps: number | null
  /** Live state right now. */
  live: "operational" | "degraded" | "unknown"
}

export type HealthMap = Map<string, ModelHealth>

interface RawBreakdown {
  id?: string
  status?: string
  reason?: string
  speed?: { ttft?: number; tps?: number }
}

interface RawHistoryBucket {
  start?: number
  models?: Partial<Record<StatusService, Record<string, string>>>
}

interface RawStatusPayload {
  stale?: boolean
  components?: Array<{
    service?: string
    status?: string
    breakdown?: RawBreakdown[]
  }>
  history?: RawHistoryBucket[]
}

/**
 * Which status service a model is reported under. The free models appear under
 * `free` on both providers; `opencode/*` paid models are the pay-as-you-go tier.
 */
export function statusServiceFor(providerID: string, free: boolean): StatusService {
  if (free) return "free"
  return providerID === "opencode-go" ? "go" : "payg"
}

/** Map one history bucket value onto the three-state vocabulary. */
function bucketState(value: unknown): BucketState | null {
  if (value === "operational") return "operational"
  if (value === "degraded" || value === "outage") return value
  return null
}

/**
 * Seven-day uptime per model, per service. A degraded bucket counts as no
 * uptime: the router picks a model to use right now, so a model that was
 * noticeably broken for three hours should read as broken for those three hours.
 */
export function parseUptime(payload: RawStatusPayload, now: number): Map<StatusService, Record<string, ModelHealth>> {
  const out: Map<StatusService, Record<string, ModelHealth>> = new Map()
  for (const service of ["go", "payg", "free"] as const) out.set(service, {})

  for (const bucket of payload.history ?? []) {
    const start = typeof bucket.start === "number" ? bucket.start : 0
    // A bucket that ends in the future is not evidence of anything.
    if (start > now) continue
    for (const [service, models] of Object.entries(bucket.models ?? {})) {
      // `service in out` would be wrong here: `out` is a Map, and `in` reads
      // object properties, so it never sees the keys and every bucket is dropped.
      const row = out.get(service as StatusService)
      if (!row) continue
      for (const [id, value] of Object.entries(models ?? {})) {
        const state = bucketState(value)
        if (state === null) continue
        const entry = (row[id] ??= { uptime: 0, buckets: 0, ttftMs: null, tps: null, live: "unknown" })
        entry.buckets += 1
        if (state === "operational") entry.uptime += 1
      }
    }
  }

  for (const row of out.values()) {
    for (const entry of Object.values(row)) {
      if (entry.buckets > 0) entry.uptime = (entry.uptime / entry.buckets) * 100
    }
  }
  return out
}

/** Live status and speed from the current components; mutates the uptime rows. */
export function applyLiveState(payload: RawStatusPayload, uptime: Map<StatusService, Record<string, ModelHealth>>): void {
  for (const component of payload.components ?? []) {
    const service = component.service as StatusService | undefined
    if (!service || !uptime.has(service)) continue
    const row = uptime.get(service)!
    for (const item of component.breakdown ?? []) {
      if (!item.id) continue
      const entry = (row[item.id] ??= { uptime: 0, buckets: 0, ttftMs: null, tps: null, live: "unknown" })
      if (item.status === "operational") entry.live = "operational"
      else if (item.status === "degraded") entry.live = "degraded"
      // The page only reports speed once it has measured enough responses.
      if (typeof item.speed?.ttft === "number") entry.ttftMs = item.speed.ttft
      if (typeof item.speed?.tps === "number") entry.tps = item.speed.tps
    }
  }
}

/**
 * Turn the uptime into a 0-100 score. An outage bucket hurts more than a
 * degraded one, because an outage is a call that definitely did not happen.
 */
export function uptimeScore(health: ModelHealth | undefined): number {
  if (!health || health.buckets === 0) return 0
  // Bucket share is already the fraction that was fully operational, so the
  // score is that fraction. Kept as a function so the weighting can change
  // without touching the callers.
  return health.uptime
}

/** Parse a response body; throws on a shape this router cannot read. */
export function parseStatus(body: unknown): RawStatusPayload {
  const payload = body as RawStatusPayload
  if (!payload || typeof payload !== "object") throw new Error("status body is not an object")
  if (!Array.isArray(payload.history) && !Array.isArray(payload.components)) {
    throw new Error("status body has neither history nor components")
  }
  return payload
}

export function emptyHealth(): HealthMap {
  return new Map()
}

/** Health by full `provider/model` id, for the models of one catalog. */
export function healthForCatalog(
  uptime: Map<StatusService, Record<string, ModelHealth>>,
  models: Array<{ providerID: string; modelID: string; free: boolean }>,
): HealthMap {
  const out: HealthMap = new Map()
  for (const model of models) {
    const row = uptime.get(statusServiceFor(model.providerID, model.free))
    const entry = row?.[model.modelID]
    if (entry) out.set(`${model.providerID}/${model.modelID}`, entry)
  }
  return out
}

let cache: { at: number; uptime: Map<StatusService, Record<string, ModelHealth>>; note: string | null } | null = null

/**
 * Fetch model health, cached for CACHE_TTL_MS so the 15 s rebuild loop does not
 * hammer the status page. Any failure returns an empty map with a note: the
 * router falls back to the committed table, exactly like the benchmark feed.
 */
export async function loadStatusHealth(
  cfg: ResolvedConfig,
): Promise<{ uptime: Map<StatusService, Record<string, ModelHealth>>; note: string | null }> {
  if (!cfg.status?.enabled) return { uptime: new Map(), note: null }

  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return { uptime: cache.uptime, note: cache.note }

  const url = cfg.status.url ?? DEFAULT_STATUS_URL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.status.timeoutMs ?? 5000)
  let uptime: Map<StatusService, Record<string, ModelHealth>> = new Map()
  let note: string | null
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = parseStatus(await res.json())
    uptime = parseUptime(payload, Date.now())
    applyLiveState(payload, uptime)
    const tracked = [...uptime.values()].reduce((sum, row) => sum + Object.keys(row).length, 0)
    note = payload.stale ? `status ${url} is stale; using last known health` : null
    if (!note && tracked === 0) note = `status ${url} listed no models; reliability unavailable`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note = `status ${url} unavailable (${message}); models keep the neutral reliability prior`
    uptime = new Map()
  } finally {
    clearTimeout(timer)
  }

  cache = { at: now, uptime, note }
  return { uptime, note }
}

/** Drop the cached status, for tests and for a forced refresh. */
export function clearStatusCache(): void {
  cache = null
}
