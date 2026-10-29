import fs from "node:fs"
import type { CatalogModel, CostTier } from "./types.js"
import { catalogCacheFile } from "./paths.js"

export interface RawModel {
  id: string
  name?: string
  family?: string
  canonical_model_id?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  open_weights?: boolean
  release_date?: string
  last_updated?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; input?: number; output?: number }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    tiers?: Array<{
      input?: number
      output?: number
      cache_read?: number
      cache_write?: number
      tier?: { type?: string; size?: number }
    }>
  }
}

export interface RawProvider {
  id: string
  name?: string
  models?: Record<string, RawModel>
}

export type RawCatalog = Record<string, RawProvider>

/** Providers this router understands. */
export const ROUTED_PROVIDERS = ["opencode-go", "opencode"] as const

export function readCatalogFile(file: string = catalogCacheFile()): RawCatalog | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(raw) as RawCatalog
  } catch {
    return undefined
  }
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function mapTiers(raw: RawModel): CostTier[] {
  const tiers = raw.cost?.tiers
  if (!Array.isArray(tiers)) return []
  const out: CostTier[] = []
  for (const t of tiers) {
    const size = t?.tier?.size
    if (typeof size !== "number") continue
    out.push({
      size,
      input: toNumber(t.input),
      output: toNumber(t.output),
      cacheRead: t.cache_read !== undefined ? toNumber(t.cache_read) : undefined,
      cacheWrite: t.cache_write !== undefined ? toNumber(t.cache_write) : undefined,
    })
  }
  return out.sort((a, b) => a.size - b.size)
}

export function isFreeModel(cost: { input: number; output: number }, tiers: CostTier[]): boolean {
  const baseFree = cost.input === 0 && cost.output === 0
  const tiersFree = tiers.every((t) => t.input === 0 && t.output === 0)
  return baseFree && tiersFree
}

export function mapModel(providerID: string, raw: RawModel): CatalogModel {
  const cost = {
    input: toNumber(raw.cost?.input),
    output: toNumber(raw.cost?.output),
    cacheRead: raw.cost?.cache_read !== undefined ? toNumber(raw.cost.cache_read) : undefined,
    cacheWrite: raw.cost?.cache_write !== undefined ? toNumber(raw.cost.cache_write) : undefined,
  }
  const tiers = mapTiers(raw)
  const rawInputs = raw.modalities?.input
  const inputModalities = Array.isArray(rawInputs) ? rawInputs.map(String) : ["text"]
  return {
    providerID,
    modelID: raw.id,
    id: `${providerID}/${raw.id}`,
    name: raw.name ?? raw.id,
    family: raw.family,
    canonicalModelID: raw.canonical_model_id,
    releaseDate: raw.release_date ?? raw.last_updated,
    reasoning: raw.reasoning === true,
    toolCall: raw.tool_call === true,
    attachment: raw.attachment === true,
    openWeights: raw.open_weights === true,
    limit: {
      context: toNumber(raw.limit?.context),
      input: raw.limit?.input !== undefined ? toNumber(raw.limit.input) : undefined,
      output: toNumber(raw.limit?.output),
    },
    cost,
    tiers,
    inputModalities,
    free: isFreeModel(cost, tiers),
  }
}

/**
 * Load every routed model from the OpenCode catalog cache.
 * Returns models from `opencode-go` and `opencode` only.
 */
export function loadCatalog(file: string = catalogCacheFile()): CatalogModel[] {
  const raw = readCatalogFile(file)
  if (!raw) return []
  const out: CatalogModel[] = []
  for (const providerID of ROUTED_PROVIDERS) {
    const provider = raw[providerID]
    if (!provider?.models) continue
    for (const rawModel of Object.values(provider.models)) {
      if (rawModel && typeof rawModel.id === "string") out.push(mapModel(providerID, rawModel))
    }
  }
  return out
}

export interface DedupeResult {
  catalog: CatalogModel[]
  /** Human-readable note lines: `dropped X == Y; kept Y`. */
  notes: string[]
}

/** The provider namespace kept when both twins exist and the classes tie. */
const PREFERRED_PROVIDER = "opencode"

function classOf(model: CatalogModel): "free" | "other" {
  return model.free ? "free" : "other"
}

/**
 * One model can appear under both routed providers (`opencode-go/beam-free` and
 * `opencode/beam-free` are the same model). They must not occupy two chain
 * slots. Preference: the free twin over a paid one, then the subscription twin
 * for a paid pair, then the Zen namespace for the remaining ties.
 *
 * Preferring the subscription twin matters on the `go` plan: a paid Zen model
 * is not eligible there, so keeping it would hide a model the subscription can
 * use. On `go-plus` the subscription twin is also the cheaper path while the
 * shared allowance lasts; when it runs out the chain falls through to its free
 * and paid fallbacks.
 */
export function dedupeCatalog(models: CatalogModel[]): DedupeResult {
  const notes: string[] = []
  const byModelID = new Map<string, CatalogModel>()
  for (const model of models) {
    const twin = byModelID.get(model.modelID)
    if (!twin) {
      byModelID.set(model.modelID, model)
      continue
    }
    // Pick the twin to keep; the loser is the drop note.
    let keep = model
    let drop = twin
    if (classOf(twin) !== classOf(model)) {
      // The free class wins over the paid one.
      if (classOf(twin) === "free") {
        keep = twin
        drop = model
      }
    } else if (classOf(twin) === "other" && (twin.providerID === "opencode-go" || model.providerID === "opencode-go")) {
      // Both paid: keep the Go subscription copy, which is included in the
      // plan while its allowance lasts.
      keep = twin.providerID === "opencode-go" ? twin : model
      drop = keep === twin ? model : twin
    } else if (twin.providerID === PREFERRED_PROVIDER) {
      keep = twin
      drop = model
    }
    byModelID.set(model.modelID, keep)
    notes.push(`Dropped duplicate ${drop.id} == ${keep.id}; kept ${keep.id}`)
  }
  return { catalog: [...byModelID.values()], notes }
}

export function catalogMeta(file: string = catalogCacheFile()): { path: string; mtime: string | null; total: number } {
  let mtime: string | null = null
  try {
    mtime = fs.statSync(file).mtime.toISOString()
  } catch {
    mtime = null
  }
  return { path: file, mtime, total: dedupeCatalog(loadCatalog(file)).catalog.length }
}
