// Shared types and the constant lists they are built from.

export const PLAN_PROFILES = ["go", "go-plus", "go-teams", "free"] as const

export type PlanProfile = (typeof PLAN_PROFILES)[number]

export function isPlan(value: unknown): value is PlanProfile {
  return typeof value === "string" && (PLAN_PROFILES as readonly string[]).includes(value)
}

/**
 * How the router decides the model per message.
 * `auto`: the router picks, but a manual pick in the OpenCode UI wins for the session.
 * `failover`: the router never picks first; it only moves the session on limit errors.
 * `off`: the router never overrides a message; it only writes the config at refresh.
 */
export const ROUTER_MODES = ["auto", "failover", "off"] as const

export type RouterMode = (typeof ROUTER_MODES)[number]

export function isRouterMode(value: unknown): value is RouterMode {
  return typeof value === "string" && (ROUTER_MODES as readonly string[]).includes(value)
}

/** Which config files a command reads and writes. */
export type ConfigScope = "global" | "project"

/** OpenCode agents that the router switches per message. */
export const AGENT_ROLES = ["plan", "build", "general", "explore"] as const

/** Helper models that OpenCode reads from the config only. */
export const INTERNAL_ROLES = ["small_model", "title", "summary", "compaction"] as const

export const ROLE_NAMES = [...AGENT_ROLES, ...INTERNAL_ROLES] as const

export type AgentRole = (typeof AGENT_ROLES)[number]

export type InternalRole = (typeof INTERNAL_ROLES)[number]

export type RoleName = AgentRole | InternalRole

export function isAgentRole(value: string | undefined): value is AgentRole {
  return value !== undefined && (AGENT_ROLES as readonly string[]).includes(value)
}

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value)
}

export type ScoreSource = "override" | "benchmark" | "table" | "cap" | "feed" | "heuristic" | "status" | "default"

export type ModelClass = "subscription" | "paid" | "free"

export interface Weights {
  intelligence: number
  speed: number
  endurance: number
  /**
   * Share of the score that comes from how often the model actually works.
   * Optional so a user config that predates the metric keeps its old weighting.
   */
  reliability?: number
}

/** Intelligence, speed, and reliability values from the score table, a feed, or the user. */
export interface MetricScores {
  intelligence?: number
  speed?: number
  reliability?: number
}

export interface RoleRequirement {
  toolCall?: boolean
  reasoning?: boolean
  minContext?: number
  minOutput?: number
  inputModalities?: string[]
}

export interface RoleSpec {
  weights: Weights
  variant?: string
  chainDepth?: number
  requires?: RoleRequirement
  /** Prefer $0 models; adds a bonus to the score of free models. */
  preferFree?: boolean
  /** Avoid two adjacent picks from the same model family. */
  diversifyFamily?: boolean
}

export interface ModelCost {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface CostTier {
  size: number
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface CatalogModel {
  providerID: string
  modelID: string
  /** Full `provider/model` identifier. */
  id: string
  name: string
  family?: string
  /**
   * OpenCode's stable identifier for the underlying model, e.g.
   * `anthropic/claude-sonnet-5.5`. The same model sold through `opencode` and
   * `opencode-go` carries the same value, which is what makes benchmark joins
   * possible across provider namespaces.
   */
  canonicalModelID?: string
  releaseDate?: string
  status?: string
  reasoning: boolean
  toolCall: boolean
  attachment: boolean
  openWeights: boolean
  limit: { context: number; input?: number; output: number }
  cost: ModelCost
  tiers: CostTier[]
  inputModalities: string[]
  free: boolean
}

export interface ScoredModel {
  model: CatalogModel
  intelligence: number
  speed: number
  endurance: number
  /** How often the model actually works, 0-100. */
  reliability: number
  score: number
  intelligenceSource: ScoreSource
  speedSource: ScoreSource
  enduranceSource: ScoreSource
  reliabilitySource: ScoreSource
  blendedCost: number
  /** Estimated millions of tokens per 5h window; null means unlimited. */
  tokensPer5h: number | null
  /** Monthly dollar allowance; null means unlimited. */
  monthlyCapUSD: number | null
}

export interface RankingEntry {
  rank: number
  providerID: string
  modelID: string
  id: string
  variant?: string
  score: number
  intelligence: number
  speed: number
  endurance: number
  /** Share of the score that came from model health; 0 when the role has no reliability weight. */
  reliability: number
  tokensPer5h: number | null
  monthlyCapUSD: number | null
  sources: { intelligence: ScoreSource; speed: ScoreSource; endurance: ScoreSource; reliability: ScoreSource }
  class: ModelClass
}

export type RoleChains = Partial<Record<RoleName, RankingEntry[]>>

export interface RoutingTable {
  version: number
  createdAt: string
  plan: PlanProfile
  /** role -> ranked chain for the active plan. */
  active: RoleChains
  /** plan -> role -> ranked chain (all computed plans). */
  profiles: Partial<Record<PlanProfile, RoleChains>>
  notes: string[]
}

export interface EnduranceScale {
  minTokensPer5h: number
  maxTokensPer5h: number
}

export interface CostBlend {
  input: number
  output: number
  cacheRead: number
}

export interface FeedConfig {
  enabled?: boolean
  url?: string
  timeoutMs?: number
}

/** How the router learns the current Go monthly caps. */
export interface GoCapsConfig {
  /** Fetch the cap table from the docs (default true). */
  fetch?: boolean
  /** Use a cached table for this many hours before fetching again. */
  ttlHours?: number
  /** The Go docs page or another page with the cap tables. */
  url?: string
}

/** ISO starts for the weekly/monthly windows, from the OpenCode Console. */
export interface AllowanceConfig {
  weekStart?: string
  monthStart?: string
}

/** What a model does with request data, from the Go docs. */
export interface ModelPrivacy {
  training: boolean
  retention?: string
  note?: string
}

/**
 * Live model health from OpenCode's public status page. Off by default, since
 * it is an external call during a routing rebuild.
 */
export interface StatusConfig {
  enabled?: boolean
  url?: string
  timeoutMs?: number
  /**
   * Reliability score for a model the status page does not follow. OpenCode
   * tracks six models per plan, so most catalog models get this value.
   */
  unknownUptime?: number
  /**
   * Below this seven-day uptime a model is benched rather than merely scored
   * lower. Undefined disables the floor.
   */
  minUptime?: number
}

export interface RouterUserConfig {
  plan?: PlanProfile
  /** How the router picks per-message models: `auto` (default), `failover`, or `off`. */
  mode?: RouterMode
  chainDepth?: number
  softThreshold?: number
  blend?: Partial<CostBlend>
  enduranceScale?: Partial<EnduranceScale>
  weights?: Partial<Record<RoleName, Partial<Weights>>>
  roles?: Partial<Record<RoleName, Partial<RoleSpec>>>
  denyModels?: string[]
  allowModels?: string[]
  privacy?: { freeModelsOk?: boolean; trainingOk?: boolean }
  /** Allow paid `opencode/*` Zen models. Go Plus is a Go tier, not Zen credit. */
  zenPaid?: boolean
  /** How to fetch and cache the Go monthly cap table. */
  caps?: GoCapsConfig
  /** The console's weekly/monthly reset starts, if you want exact boundaries. */
  allowance?: AllowanceConfig
  feeds?: FeedConfig
  /** Live model health from OpenCode's status page; off unless enabled. */
  status?: StatusConfig
  /** Ask npm for a newer router version once per 24 hours (default true). */
  updateCheck?: boolean
  /** Explicit score overrides, keyed by `provider/model`. */
  scores?: Partial<Record<string, MetricScores>>
}

export interface LedgerModelState {
  cost5h: number
  costWeek: number
  costMonth: number
  tokens5h: number
  tokensWeek: number
  tokensMonth: number
  window5hStart: number
  windowWeekStart: number
  windowMonthStart: number
  cooldownUntil?: number
  lastError?: string
  lastUsedAt?: number
}

/**
 * The Go usage allowance. All subscription models share it: a message adds its
 * cost divided by the monthly limit of its model.
 */
export interface LedgerAllowance {
  /** [step timestamp in ms, share of the monthly allowance that step used] */
  buckets: Array<[number, number]>
  /**
   * Start of the current Go windows. The docs anchor the 5-hour window at the
   * first request and reset it 5 hours later; weekly and monthly windows repeat
   * on the same day/time. These lets the ledger follow those boundaries instead
   * of a rolling "last N days" estimate.
   */
  window5hStart?: number
  windowWeekStart?: number
  windowMonthStart?: number
  cooldownUntil?: number
  lastError?: string
}

export interface Ledger {
  version: 2
  updatedAt: string
  models: Record<string, LedgerModelState>
  allowance?: LedgerAllowance
  /**
   * Recent `session.step.ended` ids. Several OpenCode hosts can share the
   * ledger file, and each has its own in-process dedupe; this list stops the
   * same step from being added once per host.
   */
  seen?: string[]
}

export interface MonthlyCap {
  go: number | null
  goPlus: number | null
  /** Go Teams is Go + $5 per model; absent falls back to `go + 5`. */
  goTeams?: number | null
}

export interface ScoreTable {
  version: number
  updated: string
  /** role -> weights/variant/requirements. */
  roles: Partial<Record<RoleName, RoleSpec>>
  /** `provider/model` -> fixed scores (wins over heuristics). */
  models: Record<string, MetricScores>
  /** Ordered family/substring patterns; first match wins. */
  heuristics: {
    patterns: Array<{ match: string; intelligence: number; speed: number }>
    defaultIntelligence: number
    defaultSpeed: number
    /** Penalty applied to models with no explicit entry in `models`. */
    unvettedPenalty?: number
  }
  /** Monthly USD allowance per model: { go, goPlus, goTeams }. null = unlimited. */
  monthlyCaps: Record<string, MonthlyCap>
  /** Provenance of the fetched Go cap table, when one was used. */
  goCaps?: { source: string; fetchedAt: string }
  /** Per-model data policies from the Go docs. */
  privacy?: Record<string, ModelPrivacy>
  /**
   * Score adjustment per plan and model class. On paid plans the subscription
   * models get an edge so the plan you pay for is used first and $0 models
   * remain the overflow fallback.
   */
  classPreference?: Partial<Record<PlanProfile, Partial<Record<ModelClass, number>>>>
  /**
   * Explicit pins that always win over `models`, feeds, and heuristics. The
   * score generator never rewrites this block; put a value here when a public
   * benchmark disagrees with what you know about a model.
   */
  overrides?: Record<string, MetricScores>
  /** Provenance for the generated `models` block. Written by `scores --write`. */
  _meta?: ScoreTableMeta
}

/** Where the generated scores came from, so a snapshot is auditable. */
export interface ScoreTableMeta {
  /** `YYYY-MM-DD` the generator wrote the table. */
  generated?: string
  /** Source URL for the benchmark data. */
  source?: string
  /** ISO timestamp of the fetch that produced the snapshot. */
  fetchedAt?: string
  /** One-line description of the scoring method. */
  method?: string
  /** `provider/model` -> benchmark id, for joins the matcher could not make alone. */
  aliases?: Record<string, string>
  /** Range the benchmark percentiles were mapped onto. */
  calibration?: { min: number; max: number }
  counts?: {
    catalog: number
    matched: number
    measured: number
    unmatched: number
    matchedWithoutBenchmark: number
  }
}

export interface ResolvedConfig extends RouterUserConfig {
  plan: PlanProfile
  mode: RouterMode
  chainDepth: number
  softThreshold: number
  blend: CostBlend
  enduranceScale: EnduranceScale
  denyModels: string[]
  allowModels: string[]
  zenPaid: boolean
  privacy: { freeModelsOk: boolean; trainingOk: boolean }
  caps: { fetch: boolean; ttlHours: number; url: string }
  allowance: AllowanceConfig
  /** Always present; `enabled` decides whether the status page is consulted. */
  status: Required<Pick<StatusConfig, "enabled" | "timeoutMs" | "unknownUptime">> & StatusConfig
}
