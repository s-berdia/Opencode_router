import type { CatalogModel, PlanProfile, RankingEntry, ResolvedConfig, RoleName, RoleSpec, ScoreTable, ScoredModel } from "./types.js"
import { modelClass, scoreModel, type FeedScores } from "./scoring.js"
import { uptimeScore, type HealthMap } from "./status.js"

export function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i")
}

export function matchesAny(id: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(id))
}

/**
 * Which models each plan can reach:
 *
 *   free     -> `opencode/*` $0 models only
 *   go       -> every `opencode-go/*` model, plus `opencode/*` $0 models
 *   go-plus  -> the Go tier, plus paid `opencode/*` (pay-as-you-go) models
 *
 * The paid Zen tier is deliberately unreachable below go-plus: a routing
 * mistake there would spend real pay-as-you-go money on a plan that does not
 * include it. `opencode-go/*` free models still require a Go subscription, so
 * they are not part of the free plan.
 */
export function providerAllowed(model: CatalogModel, plan: PlanProfile): boolean {
  if (model.providerID === "opencode") {
    // Zen carries both the $0 tier (every plan) and the paid tier (Go Plus).
    return model.free || plan === "go-plus"
  }
  if (model.providerID === "opencode-go") {
    return plan === "go" || plan === "go-plus"
  }
  return false
}

/** Why a model cannot serve a role, or null when it can. */
export type IneligibilityReason =
  | "plan"
  | "tool-call"
  | "reasoning"
  | "min-context"
  | "min-output"
  | "modalities"
  | "unknown-cap"
  | "denied"
  | "not-allowed"
  | "privacy"
  | "uptime"

function requirementFailure(model: CatalogModel, role: RoleSpec): IneligibilityReason | null {
  const req = role.requires
  if (!req) return null
  if (req.toolCall && !model.toolCall) return "tool-call"
  if (req.reasoning && !model.reasoning) return "reasoning"
  if (req.minContext !== undefined && model.limit.context < req.minContext) return "min-context"
  if (req.minOutput !== undefined && model.limit.output < req.minOutput) return "min-output"
  if (req.inputModalities && req.inputModalities.length > 0) {
    const ok = req.inputModalities.every((m) => model.inputModalities.includes(m))
    if (!ok) return "modalities"
  }
  return null
}

/**
 * The eligibility funnel, one reason at a time. Keeping the reason next to the
 * rule is what lets the archetype report explain an elimination instead of
 * silently returning a shorter list.
 */
export function ineligibilityReason(
  model: CatalogModel,
  role: RoleSpec,
  table: ScoreTable,
  cfg: ResolvedConfig,
  health: HealthMap = new Map(),
): IneligibilityReason | null {
  if (!providerAllowed(model, cfg.plan)) return "plan"
  const requirement = requirementFailure(model, role)
  if (requirement) return requirement
  // A subscription model is only usable when the table knows its allowance;
  // a retired id with no entry would otherwise look unlimited. Paid Zen models
  // are metered per token, not capped, so they need no allowance entry.
  if (modelClass(model) === "subscription" && !table.monthlyCaps[model.id]) return "unknown-cap"
  if (cfg.denyModels.length > 0 && matchesAny(model.id, cfg.denyModels)) return "denied"
  if (cfg.allowModels.length > 0 && !matchesAny(model.id, cfg.allowModels)) return "not-allowed"
  // Privacy: paid plans must not silently use data-collecting free models for real work.
  if (!cfg.privacy.freeModelsOk && model.free && !role.preferFree) return "privacy"
  // A model that spends most of its week broken is not a candidate at all.
  // Untracked models keep their score: "unmeasured" is not "unreliable".
  const floor = cfg.status.minUptime
  if (floor !== undefined) {
    const measured = health.get(model.id)
    if (measured && measured.buckets > 0 && uptimeScore(measured) < floor) return "uptime"
  }
  return null
}

export function eligibleModels(
  catalog: CatalogModel[],
  role: RoleSpec,
  table: ScoreTable,
  cfg: ResolvedConfig,
  health: HealthMap = new Map(),
): CatalogModel[] {
  return catalog.filter((model) => ineligibilityReason(model, role, table, cfg, health) === null)
}

export function rankRole(
  catalog: CatalogModel[],
  roleName: RoleName,
  table: ScoreTable,
  cfg: ResolvedConfig,
  feeds: FeedScores,
  health: HealthMap = new Map(),
): RankingEntry[] {
  const role = table.roles[roleName]
  if (!role) return []

  const scored: ScoredModel[] = eligibleModels(catalog, role, table, cfg, health)
    .map((model) => scoreModel(model, role, table, cfg, feeds, health))
    .sort((a, b) => b.score - a.score || a.blendedCost - b.blendedCost)

  const depth = role.chainDepth ?? cfg.chainDepth
  const diversify = role.diversifyFamily ?? false

  const chosen: ScoredModel[] = []
  const seenFamilies = new Set<string>()

  for (const entry of scored) {
    if (chosen.length >= depth) break
    const family = (entry.model.family ?? entry.model.modelID).toLowerCase()
    if (diversify && seenFamilies.has(family) && chosen.length < depth) continue
    chosen.push(entry)
    seenFamilies.add(family)
  }
  // Backfill if diversification starved the chain.
  if (chosen.length < depth) {
    for (const entry of scored) {
      if (chosen.length >= depth) break
      if (chosen.includes(entry)) continue
      chosen.push(entry)
    }
  }
  // All Go subscription models share one usage allowance, so another
  // subscription model does not help when it runs out. End the chain with the
  // best free model (if the privacy setting allows one).
  if (cfg.plan !== "free" && !chosen.some((entry) => entry.model.free)) {
    const free = scored.find((entry) => entry.model.free)
    if (free) {
      if (chosen.length >= depth) {
        // The free model is the $0 overflow for the shared allowance. On Go
        // Plus, a paid Zen model is a separate metered tier: it must keep its
        // slot, so give up the weakest subscription pick instead of popping
        // the last entry.
        let dropped = false
        if (chosen.some((entry) => modelClass(entry.model) === "paid")) {
          for (let i = chosen.length - 1; i >= 0; i--) {
            if (modelClass(chosen[i]!.model) === "subscription") {
              chosen.splice(i, 1)
              dropped = true
              break
            }
          }
        }
        if (!dropped && chosen.length > 1) chosen.pop()
      }
      chosen.push(free)
    }
  }

  return chosen.map((entry, index) => ({
    rank: index + 1,
    providerID: entry.model.providerID,
    modelID: entry.model.modelID,
    id: entry.model.id,
    variant: role.variant,
    score: round(entry.score),
    intelligence: round(entry.intelligence),
    speed: round(entry.speed),
    endurance: round(entry.endurance),
    // Raw 0-100 like the metrics above, not the weighted share, so every
    // number in `sources` and the table means the same kind of thing.
    reliability: round(entry.reliability),
    tokensPer5h: entry.tokensPer5h === null ? null : round(entry.tokensPer5h, 3),
    monthlyCapUSD: entry.monthlyCapUSD,
    sources: {
      intelligence: entry.intelligenceSource,
      speed: entry.speedSource,
      endurance: entry.enduranceSource,
      reliability: entry.reliabilitySource,
    },
    class: modelClass(entry.model),
  }))
}

function round(value: number, digits = 1): number {
  const f = Math.pow(10, digits)
  return Math.round(value * f) / f
}
