import {
  benchmarkIntelligence,
  indexBenchmarks,
  lookupBenchmark,
  matchBenchmark,
  type BenchmarkMetric,
  type BenchmarkTable,
  type MatchVia,
} from "./benchmarks.js"
import type { CatalogModel, MetricScores, ScoreTable, ScoreTableMeta } from "./types.js"

/**
 * Calibration range for benchmark percentiles.
 *
 * The committed table's hand-tuned intelligence values sit in a known range
 * (the heuristic patterns). Mapping a percentile onto that same range keeps
 * measured and unmeasured models comparable: a model in the 50th percentile
 * lands where a median hand-tuned model used to sit, not 30 points below every
 * model that has no public benchmark. The range comes from the committed table
 * rather than a constant, so it follows the table if the scale is ever changed.
 */
export function calibrationRange(table: ScoreTable): { min: number; max: number } {
  const values = table.heuristics.patterns.map((pattern) => pattern.intelligence)
  const all = [table.heuristics.defaultIntelligence, ...values]
  return { min: Math.min(...all), max: Math.max(...all) }
}

export function calibratePercentile(percentile: number, range: { min: number; max: number }): number {
  const clamped = Math.max(0, Math.min(100, percentile))
  return range.min + ((range.max - range.min) * clamped) / 100
}

export type RefreshAction = "updated" | "unchanged" | "unmeasured" | "unmatched" | "no-benchmark"

export interface ModelRefresh {
  id: string
  action: RefreshAction
  match?: { id: string; via: MatchVia }
  intelligence?: {
    /** Public percentile, 0-100. */
    percentile: number
    /** Value written to the table, on the table's calibrated scale. */
    score: number
    basis: BenchmarkMetric[]
  }
  note: string
}

export interface RefreshResult {
  table: ScoreTable
  models: ModelRefresh[]
  /** Catalog models with no benchmark record at all. They keep their prior. */
  unmatched: CatalogModel[]
  /** Models that matched a record which carries no Artificial Analysis index. */
  matchedWithoutBenchmark: CatalogModel[]
  /** Prior entries dropped because the model is no longer in the catalog. */
  stale: string[]
  /** Catalog ids that got a measured intelligence; used by the archetype gate. */
  measured: Set<string>
  calibration: { min: number; max: number }
}

export interface RefreshOptions {
  catalog: CatalogModel[]
  benchmarks: BenchmarkTable
  /** The committed table to update. Its `overrides` block is preserved verbatim. */
  base: ScoreTable
  /** `provider/model` -> OpenRouter id, for joins the matcher cannot make. */
  aliases?: Record<string, string>
  /** Keep entries for models that are no longer in the catalog. Default false. */
  keepStale?: boolean
  now?: Date
}

/**
 * Regenerate the `models` block from public benchmarks.
 *
 * Only models with a measured index are rewritten. An unmatched model keeps
 * whatever entry it had (or keeps falling through to the heuristics), and is
 * reported so an alias can be added deliberately. Nothing here guesses a score
 * from a model's name.
 */
export function refreshScores(opts: RefreshOptions): RefreshResult {
  if (opts.catalog.length === 0) {
    throw new Error("catalog is empty; start OpenCode once so it writes models.json, or pass --catalog")
  }

  const index = indexBenchmarks(opts.benchmarks)
  const range = calibrationRange(opts.base)
  const next = structuredClone(opts.base)
  const prior = opts.base.models
  const catalogIds = new Set(opts.catalog.map((model) => model.id))

  const models: Record<string, MetricScores> = {}
  const report: ModelRefresh[] = []
  const unmatched: CatalogModel[] = []
  const matchedWithoutBenchmark: CatalogModel[] = []
  const measured = new Set<string>()

  for (const model of opts.catalog) {
    const alias = opts.aliases?.[model.id]
    const match = alias ? lookupBenchmark(alias, index) : matchBenchmark(model, index)
    const found = match ? benchmarkIntelligence(match.record, opts.benchmarks) : undefined
    const before = prior[model.id]

    if (found && match) {
      const score = round(calibratePercentile(found.percentile, range), 1)
      measured.add(model.id)
      if (before) models[model.id] = { ...before, intelligence: score }
      else models[model.id] = { intelligence: score }
      const action: RefreshAction = before?.intelligence === score ? "unchanged" : "updated"
      report.push({
        id: model.id,
        action,
        match: { id: match.record.id, via: match.via },
        intelligence: { percentile: round(found.percentile), score, basis: found.basis },
        note: `${found.basis.join("+")} percentile ${round(found.percentile)} -> ${score}`,
      })
      continue
    }

    if (before) models[model.id] = before
    if (match) {
      matchedWithoutBenchmark.push(model)
      report.push({
        id: model.id,
        action: "no-benchmark",
        match: { id: match.record.id, via: match.via },
        note: "matched a benchmark record with no Artificial Analysis index; prior kept",
      })
    } else {
      unmatched.push(model)
      report.push({
        id: model.id,
        action: "unmatched",
        note: before ? "no benchmark match; prior kept" : "no benchmark match; heuristics apply",
      })
    }
  }

  const stale = Object.keys(prior).filter((id) => !catalogIds.has(id))
  if (opts.keepStale) {
    for (const id of stale) {
      const entry = prior[id]
      if (entry) models[id] = entry
    }
  }

  next.models = sortKeys(models)
  next.overrides = next.overrides ? sortKeys(next.overrides) : undefined
  next.updated = (opts.now ?? new Date()).toISOString().slice(0, 10)
  next._meta = metaFor(opts, range, {
    catalog: opts.catalog.length,
    matched: opts.catalog.length - unmatched.length,
    measured: measured.size,
    unmatched: unmatched.length,
    matchedWithoutBenchmark: matchedWithoutBenchmark.length,
  })

  report.sort((a, b) => compare(a.id, b.id))
  return { table: next, models: report, unmatched, matchedWithoutBenchmark, stale, measured, calibration: range }
}

function metaFor(
  opts: RefreshOptions,
  range: { min: number; max: number },
  counts: NonNullable<ScoreTableMeta["counts"]>,
): ScoreTableMeta {
  const meta: ScoreTableMeta = {
    generated: (opts.now ?? new Date()).toISOString().slice(0, 10),
    source: opts.benchmarks.source,
    fetchedAt: opts.benchmarks.fetchedAt,
    method:
      "Artificial Analysis indices from OpenRouter. intelligence_index when reported, otherwise 0.6*coding + 0.4*agentic; percentile among all reporting models, calibrated onto the table's heuristic range.",
    calibration: { min: round(range.min), max: round(range.max) },
    counts,
  }
  if (opts.aliases && Object.keys(opts.aliases).length > 0) meta.aliases = sortKeys(opts.aliases)
  return meta
}

function sortKeys<T>(value: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(value).sort(compare)) out[key] = value[key] as T
  return out
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function round(value: number, digits = 1): number {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

/** Deterministic JSON for the committed snapshot. */
export function serializeScoreTable(table: ScoreTable): string {
  return `${JSON.stringify(table, null, 2)}\n`
}

/**
 * Compare two snapshots while ignoring the fields that change on every run
 * (`updated`, `_meta.generated`, `_meta.fetchedAt`). `scores --check` uses this
 * so CI fails only when the scores actually drifted.
 */
export function scoreTablesMatch(a: ScoreTable, b: ScoreTable): boolean {
  return serializeScoreTable(withoutVolatile(a)) === serializeScoreTable(withoutVolatile(b))
}

function withoutVolatile(table: ScoreTable): ScoreTable {
  const copy = structuredClone(table)
  copy.updated = ""
  if (copy._meta) {
    copy._meta.generated = ""
    copy._meta.fetchedAt = ""
  }
  return copy
}
