import type {
  CatalogModel,
  MetricScores,
  ModelClass,
  PlanProfile,
  ResolvedConfig,
  RoleSpec,
  ScoreSource,
  ScoreTable,
  ScoredModel,
} from "./types.js"
import { uptimeScore, type HealthMap } from "./status.js"

/** Share of the monthly allowance that one 5-hour window may use. */
export const FIVE_HOUR_SHARE = 0.2
/** Share of the monthly allowance that one 7-day window may use. */
export const WEEK_SHARE = 0.5

/** Score bonus for a free model in a role that prefers free models. */
const FREE_ROLE_BONUS = 6

const DEFAULT_UNVETTED_PENALTY = 8

export function modelClass(model: CatalogModel): ModelClass {
  if (model.free) return "free"
  if (model.providerID === "opencode-go") return "subscription"
  return "paid"
}

export interface FeedScores {
  /** keyed by lowercased family or `provider/model`. */
  byFamily: Map<string, MetricScores>
  byId: Map<string, MetricScores>
}

export function emptyFeedScores(): FeedScores {
  return { byFamily: new Map(), byId: new Map() }
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * The two metrics the score table and the name-pattern heuristics carry.
 * `reliability` is deliberately not here: patterns can describe what a model is
 * like, not how often it answers, which only a status feed can tell you.
 */
export type TableMetric = "intelligence" | "speed"

/** Resolve one metric: explicit pin, generated table, feed, name pattern, then default. */
function resolveMetric(
  model: CatalogModel,
  table: ScoreTable,
  feeds: FeedScores,
  metric: TableMetric,
): { value: number; source: ScoreSource } {
  const pinned = table.overrides?.[model.id]?.[metric]
  if (pinned !== undefined) return { value: clamp(pinned), source: "override" }

  const generated = table.models[model.id]?.[metric]
  // `models` is the committed snapshot generated from public benchmarks. Speed
  // is not a benchmark metric, so a speed value there is still a table pin.
  if (generated !== undefined) {
    return { value: clamp(generated), source: metric === "intelligence" ? "benchmark" : "table" }
  }

  const fromId = feeds.byId.get(model.id.toLowerCase())?.[metric]
  if (fromId !== undefined) return { value: clamp(fromId), source: "feed" }
  const fromFamily = model.family ? feeds.byFamily.get(model.family.toLowerCase())?.[metric] : undefined
  if (fromFamily !== undefined) return { value: clamp(fromFamily), source: "feed" }

  const id = model.modelID.toLowerCase()
  const pattern = table.heuristics.patterns.find((p) => id.includes(p.match.toLowerCase()))
  if (pattern) return { value: clamp(pattern[metric]), source: "heuristic" }

  const fallback = metric === "intelligence" ? table.heuristics.defaultIntelligence : table.heuristics.defaultSpeed
  return { value: clamp(fallback), source: "default" }
}

export function resolveIntelligence(model: CatalogModel, table: ScoreTable, feeds: FeedScores) {
  return resolveMetric(model, table, feeds, "intelligence")
}

export function resolveSpeed(model: CatalogModel, table: ScoreTable, feeds: FeedScores) {
  return resolveMetric(model, table, feeds, "speed")
}

/**
 * How often the model actually works, 0-100.
 *
 * Resolved like the other metrics but sourced from OpenCode's status page
 * rather than a benchmark table: seven-day uptime, per model, with degraded
 * buckets counted as no uptime. A model the page does not follow gets
 * `unknownUptime`, which sits near the fleet median so that an unmeasured model
 * is neither rewarded nor punished for being unmeasured.
 */
export function resolveReliability(
  model: CatalogModel,
  table: ScoreTable,
  cfg: ResolvedConfig,
  health: HealthMap,
): { value: number; source: ScoreSource } {
  const pinned = table.overrides?.[model.id]?.reliability
  if (pinned !== undefined) return { value: clamp(pinned), source: "override" }

  const generated = table.models[model.id]?.reliability
  if (generated !== undefined) return { value: clamp(generated), source: "table" }

  const measured = health.get(model.id)
  if (measured) return { value: clamp(uptimeScore(measured)), source: "status" }

  return { value: clamp(cfg.status.unknownUptime), source: "default" }
}

/** Blended USD cost per 1M tokens for a typical coding turn. */
export function blendedCost(model: CatalogModel, cfg: ResolvedConfig): number {
  const { input, output, cacheRead } = cfg.blend
  const c = model.cost
  return c.input * input + c.output * output + (c.cacheRead ?? 0) * cacheRead
}

/** Monthly USD allowance of a model on a plan; null means unlimited or unknown. */
export function monthlyCapFor(modelId: string, table: ScoreTable, plan: PlanProfile): number | null {
  if (plan === "free") return null
  const entry = table.monthlyCaps[modelId]
  if (!entry) return null
  if (plan === "go-plus") return entry.goPlus
  if (plan === "go-teams") return entry.goTeams ?? (entry.go === null ? null : entry.go + 5)
  return entry.go
}

function logScale(value: number, min: number, max: number): number {
  const lo = Math.log10(Math.max(min, 1e-6))
  const hi = Math.log10(Math.max(max, min * 1.001))
  const v = Math.log10(Math.max(value, 1e-6))
  return clamp(((v - lo) / (hi - lo)) * 100)
}

export interface EnduranceResult {
  score: number
  source: ScoreSource
  tokensPer5h: number | null
  monthlyCapUSD: number | null
  blendedCost: number
}

export function resolveEndurance(model: CatalogModel, table: ScoreTable, cfg: ResolvedConfig): EnduranceResult {
  const bc = blendedCost(model, cfg)

  if (model.free) {
    return { score: 100, source: "cap", tokensPer5h: null, monthlyCapUSD: null, blendedCost: bc }
  }

  const cap = monthlyCapFor(model.id, table, cfg.plan)
  if (cap === null) {
    return { score: 100, source: "cap", tokensPer5h: null, monthlyCapUSD: null, blendedCost: bc }
  }

  if (bc <= 0) {
    return { score: 100, source: "cap", tokensPer5h: null, monthlyCapUSD: cap, blendedCost: bc }
  }

  const tokensPer5h = (cap * FIVE_HOUR_SHARE) / bc
  const score = logScale(tokensPer5h, cfg.enduranceScale.minTokensPer5h, cfg.enduranceScale.maxTokensPer5h)
  return { score, source: "cap", tokensPer5h, monthlyCapUSD: cap, blendedCost: bc }
}

export function scoreModel(
  model: CatalogModel,
  role: RoleSpec,
  table: ScoreTable,
  cfg: ResolvedConfig,
  feeds: FeedScores,
  health: HealthMap = new Map(),
): ScoredModel {
  const intel = resolveIntelligence(model, table, feeds)
  const speed = resolveSpeed(model, table, feeds)
  const end = resolveEndurance(model, table, cfg)
  const rel = resolveReliability(model, table, cfg, health)

  const w = role.weights
  const wRel = w.reliability ?? 0
  // Normalizing the weighted product keeps the score on the same 0-100 scale
  // whether or not the role sets a reliability weight, so adding the pillar
  // does not silently rescale every existing score. With the three legacy
  // weights summing to 1 and no reliability weight, this divides by 1.
  //
  // The flat bonuses and penalties below are added AFTER that division, so
  // they stay in points. Dividing them too would quietly shrink every
  // preference the score table encodes, which is how a `+6` free bonus ended
  // up worth 0.35 and free models fell out of the compaction chain.
  const total = w.intelligence + w.speed + w.endurance + wRel || 1
  let score =
    (w.intelligence * intel.value + w.speed * speed.value + w.endurance * end.score + wRel * rel.value) / total

  // Plan/class preference: on paid plans keep the subscription models ahead of
  // the $0 overflow; for free-preferring roles do the opposite.
  const klass = modelClass(model)
  if (role.preferFree) {
    if (klass === "free") score += FREE_ROLE_BONUS
  } else {
    score += table.classPreference?.[cfg.plan]?.[klass] ?? 0
  }
  // Models we have never vetted score lower than ones with an explicit entry.
  if (table.models[model.id] === undefined && table.overrides?.[model.id] === undefined) {
    score -= table.heuristics.unvettedPenalty ?? DEFAULT_UNVETTED_PENALTY
  }
  score = clamp(score)

  return {
    model,
    intelligence: intel.value,
    speed: speed.value,
    endurance: end.score,
    reliability: rel.value,
    score,
    intelligenceSource: intel.source,
    speedSource: speed.source,
    enduranceSource: end.source,
    reliabilitySource: rel.source,
    blendedCost: end.blendedCost,
    tokensPer5h: end.tokensPer5h,
    monthlyCapUSD: end.monthlyCapUSD,
  }
}
