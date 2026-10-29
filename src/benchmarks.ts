import type { CatalogModel } from "./types.js"

/**
 * Public benchmark data, used to generate the committed intelligence scores.
 *
 * OpenRouter's model list publishes Artificial Analysis indices
 * (`intelligence_index`, `coding_index`, `agentic_index`) and needs no API key.
 * We read it at generation time only: routing never touches the network for
 * scores, because the generated snapshot ships with the package.
 */
export const DEFAULT_BENCHMARK_URL = "https://openrouter.ai/api/v1/models"

export type BenchmarkMetric = "intelligence" | "coding" | "agentic"

export interface BenchmarkRecord {
  /** OpenRouter model id, e.g. `anthropic/claude-opus-5.5`. */
  id: string
  name: string
  canonicalSlug?: string
  intelligenceIndex: number | null
  codingIndex: number | null
  agenticIndex: number | null
}

export interface BenchmarkTable {
  /** URL or file the payload came from. */
  source: string
  /** ISO timestamp of the fetch, not of the parse. */
  fetchedAt: string
  records: BenchmarkRecord[]
  /** Every reported value per metric, sorted, for percentile ranks. */
  distribution: Record<BenchmarkMetric, number[]>
}

export interface BenchmarkIndex {
  table: BenchmarkTable
  byId: ReadonlyMap<string, BenchmarkRecord>
  byCanonical: ReadonlyMap<string, BenchmarkRecord>
  byNormalized: ReadonlyMap<string, BenchmarkRecord>
  byVersionless: ReadonlyMap<string, BenchmarkRecord>
}

export type MatchVia = "canonical-id" | "canonical-slug" | "normalized-id" | "version-stripped" | "alias"

export interface BenchmarkMatch {
  record: BenchmarkRecord
  via: MatchVia
}

export interface BenchmarkIntelligence {
  /** Percentile among every model that reports the same metric, 0-100. */
  percentile: number
  /** Which public indices fed the percentile. */
  basis: BenchmarkMetric[]
  percentiles: Partial<Record<BenchmarkMetric, number>>
}

interface RawBenchmarkRow {
  id?: unknown
  name?: unknown
  canonical_slug?: unknown
  benchmarks?: {
    artificial_analysis?: {
      intelligence_index?: unknown
      coding_index?: unknown
      agentic_index?: unknown
    }
  }
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Reduce OpenRouter's model payload to the benchmark fields the router uses.
 * Only records that carry a `benchmarks` block are kept, so a model that is
 * listed but never measured does not look like a model with a score of zero.
 */
export function parseBenchmarks(
  body: unknown,
  opts: { source?: string; fetchedAt?: string } = {},
): BenchmarkTable {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error("benchmark body has no data array")

  const records: BenchmarkRecord[] = []
  for (const raw of data as RawBenchmarkRow[]) {
    if (!raw || typeof raw !== "object") continue
    const id = typeof raw.id === "string" ? raw.id : ""
    if (!id || !raw.benchmarks || typeof raw.benchmarks !== "object") continue
    const aa = raw.benchmarks.artificial_analysis
    const intelligenceIndex = finite(aa?.intelligence_index)
    const codingIndex = finite(aa?.coding_index)
    const agenticIndex = finite(aa?.agentic_index)
    records.push({
      id,
      name: typeof raw.name === "string" ? raw.name : id,
      canonicalSlug: typeof raw.canonical_slug === "string" ? raw.canonical_slug : undefined,
      intelligenceIndex,
      codingIndex,
      agenticIndex,
    })
  }

  const distribution: Record<BenchmarkMetric, number[]> = { intelligence: [], coding: [], agentic: [] }
  for (const record of records) {
    if (record.intelligenceIndex !== null) distribution.intelligence.push(record.intelligenceIndex)
    if (record.codingIndex !== null) distribution.coding.push(record.codingIndex)
    if (record.agenticIndex !== null) distribution.agentic.push(record.agenticIndex)
  }
  for (const values of Object.values(distribution)) values.sort((a, b) => a - b)

  return {
    source: opts.source ?? DEFAULT_BENCHMARK_URL,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    records,
    distribution,
  }
}

/**
 * A stable, punctuation-free key for model-name matching. Strips the provider
 * namespace, the `Vendor: ` prefix OpenRouter uses in display names, release
 * decorations (`-free`, `-preview`, `:batch`) and date stamps.
 */
export function normalizeModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[^:]+:\s+/, "")
    .replace(/^[a-z0-9._-]+\//, "")
    .replace(/(?:[-_. ]|:)(free|preview|contributor|batch|beta|latest|experimental|exp)$/g, "")
    .replace(/(?:[-_. ]|:)\d{4}-\d{2}-\d{2}$/g, "")
    .replace(/(?:[-_. ]|:)?\d{6,8}$/g, "")
    .replace(/[^a-z0-9]/g, "")
}

/** `claude-opus-5-5` -> `claudeopus`; used only as a last-resort match. */
function versionless(key: string): string {
  return key.replace(/\d+$/, "")
}

/**
 * Build the lookup maps once per payload. A key that two different records
 * normalize to is dropped as ambiguous: guessing which `kimi-k3` is meant is
 * worse than reporting the model as unmatched.
 */
export function indexBenchmarks(table: BenchmarkTable): BenchmarkIndex {
  const ids = uniqueMap()
  const canonicals = uniqueMap()
  const normalized = uniqueMap()
  const loose = uniqueMap()

  for (const record of table.records) {
    ids.add(record.id.toLowerCase(), record)
    if (record.canonicalSlug) canonicals.add(record.canonicalSlug.toLowerCase(), record)
    for (const value of [record.id, record.name]) {
      const key = normalizeModelName(value)
      normalized.add(key, record)
      loose.add(versionless(key), record)
    }
  }

  return {
    table,
    byId: ids.map,
    byCanonical: canonicals.map,
    byNormalized: normalized.map,
    byVersionless: loose.map,
  }
}

function uniqueMap(): { add: (key: string, record: BenchmarkRecord) => void; map: Map<string, BenchmarkRecord> } {
  const map = new Map<string, BenchmarkRecord>()
  const ambiguous = new Set<string>()
  return {
    map,
    add(key, record) {
      if (!key || ambiguous.has(key)) return
      const existing = map.get(key)
      if (existing === undefined) {
        map.set(key, record)
        return
      }
      if (existing.id !== record.id) {
        map.delete(key)
        ambiguous.add(key)
      }
    },
  }
}

/**
 * Join one catalog model to a benchmark record. The canonical id OpenCode
 * publishes is the reliable key; normalized names are the fallback for older
 * catalog entries that predate it.
 */
export function matchBenchmark(
  model: Pick<CatalogModel, "providerID" | "modelID" | "canonicalModelID">,
  index: BenchmarkIndex,
): BenchmarkMatch | undefined {
  const canonical = model.canonicalModelID?.toLowerCase()
  if (canonical) {
    const exact = index.byId.get(canonical)
    if (exact) return { record: exact, via: "canonical-id" }
    const slug = index.byCanonical.get(canonical)
    if (slug) return { record: slug, via: "canonical-slug" }
  }

  const normalized = normalizeModelName(model.modelID)
  const byName = index.byNormalized.get(normalized)
  if (byName) return { record: byName, via: "normalized-id" }
  const loose = index.byVersionless.get(versionless(normalized))
  if (loose) return { record: loose, via: "version-stripped" }
  return undefined
}

/** Look up a deliberate alias (a benchmark id written in `_meta.aliases`). */
export function lookupBenchmark(id: string, index: BenchmarkIndex): BenchmarkMatch | undefined {
  const direct = index.byId.get(id.toLowerCase())
  if (direct) return { record: direct, via: "alias" }
  const normalized = index.byNormalized.get(normalizeModelName(id))
  if (normalized) return { record: normalized, via: "alias" }
  return undefined
}

/**
 * Midrank percentile: ties share the average of the ranks they span. This is
 * the number the generated intelligence score is built from.
 */
export function percentileRank(distribution: readonly number[], value: number): number {
  if (distribution.length === 0) return 0
  let below = 0
  let equal = 0
  for (const candidate of distribution) {
    if (candidate < value) below += 1
    else if (candidate === value) equal += 1
  }
  return ((below + equal / 2) / distribution.length) * 100
}

/**
 * The capability score for one record.
 *
 * `intelligence_index` is Artificial Analysis's general measure and wins when
 * present. A model that only reports coding/agentic data gets the blended
 * coding percentile (60% coding, 40% agentic), because those are the closest
 * public proxies for the work this router routes. A model with no index at all
 * has no measured intelligence and keeps its prior.
 */
export function benchmarkIntelligence(record: BenchmarkRecord, table: BenchmarkTable): BenchmarkIntelligence | undefined {
  const percentiles: Partial<Record<BenchmarkMetric, number>> = {}
  if (record.intelligenceIndex !== null) {
    percentiles.intelligence = percentileRank(table.distribution.intelligence, record.intelligenceIndex)
  }
  if (record.codingIndex !== null) {
    percentiles.coding = percentileRank(table.distribution.coding, record.codingIndex)
  }
  if (record.agenticIndex !== null) {
    percentiles.agentic = percentileRank(table.distribution.agentic, record.agenticIndex)
  }

  if (percentiles.intelligence !== undefined) {
    return { percentile: percentiles.intelligence, basis: ["intelligence"], percentiles }
  }
  if (percentiles.coding !== undefined && percentiles.agentic !== undefined) {
    return {
      percentile: percentiles.coding * 0.6 + percentiles.agentic * 0.4,
      basis: ["coding", "agentic"],
      percentiles,
    }
  }
  if (percentiles.coding !== undefined) return { percentile: percentiles.coding, basis: ["coding"], percentiles }
  if (percentiles.agentic !== undefined) return { percentile: percentiles.agentic, basis: ["agentic"], percentiles }
  return undefined
}

/** Fetch the public model list. Generation-time only; never called by routing. */
export async function fetchBenchmarks(
  opts: { url?: string; timeoutMs?: number; fetchedAt?: Date } = {},
): Promise<BenchmarkTable> {
  const url = opts.url ?? DEFAULT_BENCHMARK_URL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "opencode-router" } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseBenchmarks(await res.json(), { source: url, fetchedAt: (opts.fetchedAt ?? new Date()).toISOString() })
  } finally {
    clearTimeout(timer)
  }
}
