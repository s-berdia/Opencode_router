import type { HealthMap } from "./status.js"
import type {
  CatalogModel,
  PlanProfile,
  ResolvedConfig,
  RoleName,
  ScoreTable,
  ScoredModel,
} from "./types.js"
import { ineligibilityReason, type IneligibilityReason } from "./rank.js"
import { scoreModel, type FeedScores } from "./scoring.js"

/**
 * How far below the best measured model an archetype will still consider, in
 * intelligence percentile points. Intelligence is a gate, not a weight: a cheap
 * model outside the band cannot win a role by being cheap, and a model inside
 * the band still competes on cost, speed, and reliability.
 *
 * Plan work needs the strongest model; title and small-model work needs a model
 * that is good enough and fast. The bands encode that difference.
 */
export const DEFAULT_INTELLIGENCE_BANDS: Record<RoleName, number> = {
  plan: 15,
  build: 20,
  general: 25,
  explore: 25,
  small_model: 40,
  title: 40,
  summary: 30,
  compaction: 30,
}

export interface ArchetypeOptions {
  catalog: CatalogModel[]
  role: RoleName
  table: ScoreTable
  cfg: ResolvedConfig
  feeds: FeedScores
  health?: HealthMap
  /**
   * `provider/model` ids with a public benchmark intelligence. Models outside
   * this set keep their committed prior and are exempt from the gate: missing
   * data must not silently disqualify a model that the router still needs.
   */
  measured?: ReadonlySet<string>
  /** Override the role's default band. */
  band?: number
  /** Return only the top N survivors. */
  limit?: number
}

export interface ArchetypeExclusion {
  id: string
  reason: IneligibilityReason
}

export interface ArchetypeSelection {
  role: RoleName
  plan: PlanProfile
  /** Survivors of every stage, best first. */
  ranked: ScoredModel[]
  /** Models removed by the eligibility stage, with the rule that removed them. */
  excluded: ArchetypeExclusion[]
  /** Measured models removed by the intelligence gate. */
  gated: Array<{ id: string; intelligence: number; threshold: number }>
  /** Eligible models with no public benchmark; they keep their prior. */
  unmeasured: string[]
  gate: {
    band: number
    /** Best measured intelligence among eligible models. */
    best?: number
    bestID?: string
    /** Survivors must be at or above this intelligence; undefined with no measured models. */
    threshold?: number
  }
}

/**
 * Run the archetype funnel over one role:
 *
 *   eligibility -> intelligence gate -> weighted cost/speed/reliability ordering
 *
 * Eligibility and the weighted ordering are the same functions the router uses
 * at runtime, so a selection reported here cannot disagree with a ranking the
 * router produces from the same table.
 */
export function selectArchetype(opts: ArchetypeOptions): ArchetypeSelection {
  const role = opts.table.roles[opts.role]
  const band = opts.band ?? DEFAULT_INTELLIGENCE_BANDS[opts.role]
  const health = opts.health ?? new Map()
  const measured = opts.measured ?? new Set<string>()

  if (!role) {
    return {
      role: opts.role,
      plan: opts.cfg.plan,
      ranked: [],
      excluded: [],
      gated: [],
      unmeasured: [],
      gate: { band },
    }
  }

  const excluded: ArchetypeExclusion[] = []
  const candidates: ScoredModel[] = []
  for (const model of opts.catalog) {
    const reason = ineligibilityReason(model, role, opts.table, opts.cfg, health)
    if (reason) {
      excluded.push({ id: model.id, reason })
      continue
    }
    candidates.push(scoreModel(model, role, opts.table, opts.cfg, opts.feeds, health))
  }

  let best: ScoredModel | undefined
  for (const candidate of candidates) {
    if (!measured.has(candidate.model.id)) continue
    if (!best || candidate.intelligence > best.intelligence) best = candidate
  }
  const threshold = best ? Math.max(0, best.intelligence - band) : undefined

  const survivors: ScoredModel[] = []
  const gated: ArchetypeSelection["gated"] = []
  const unmeasured: string[] = []
  for (const candidate of candidates) {
    if (!measured.has(candidate.model.id)) {
      unmeasured.push(candidate.model.id)
      survivors.push(candidate)
      continue
    }
    if (threshold !== undefined && candidate.intelligence < threshold) {
      gated.push({ id: candidate.model.id, intelligence: round(candidate.intelligence), threshold: round(threshold) })
      continue
    }
    survivors.push(candidate)
  }

  survivors.sort((a, b) => b.score - a.score || a.blendedCost - b.blendedCost || a.model.id.localeCompare(b.model.id))

  return {
    role: opts.role,
    plan: opts.cfg.plan,
    ranked: opts.limit === undefined ? survivors : survivors.slice(0, opts.limit),
    excluded,
    gated,
    unmeasured,
    gate: {
      band,
      best: best ? round(best.intelligence) : undefined,
      bestID: best?.model.id,
      threshold: threshold === undefined ? undefined : round(threshold),
    },
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
