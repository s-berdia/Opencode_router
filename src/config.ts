import { isPlan, isRoleName, isRouterMode, PLAN_PROFILES, ROUTER_MODES } from "./types.js"
import type { CatalogModel, PlanProfile, ResolvedConfig, RouterUserConfig } from "./types.js"
import { globalRouterConfigFile, isPlainObject, projectRouterConfigFile, readJsonFile } from "./paths.js"

const DEFAULT_SOFT_THRESHOLD = 0.85
const DEFAULT_CHAIN_DEPTH = 4
/**
 * Reliability score for a model OpenCode's status page does not follow. It
 * tracks six models per plan, so most of the catalog gets this value. Sitting
 * near the fleet median keeps it neutral: an unmeasured model is not a broken
 * model, just an unproven one.
 */
const DEFAULT_UNKNOWN_UPTIME = 85

export interface LoadedUserConfig {
  config: RouterUserConfig
  /** Problems found in the files, shown in the scorecard notes. */
  notes: string[]
}

/** Read the global and project router.config.json. A bad file or value becomes a note, never a crash. */
export function loadUserConfig(projectDir?: string): LoadedUserConfig {
  const notes: string[] = []
  const global = readUserConfigFile(globalRouterConfigFile(), notes)
  const project = projectDir ? readUserConfigFile(projectRouterConfigFile(projectDir), notes) : {}
  return { config: mergeUserConfig(global, project), notes }
}

function readUserConfigFile(file: string, notes: string[]): RouterUserConfig {
  const result = readJsonFile(file)
  if (result.status === "absent") return {}
  if (result.status === "invalid") {
    notes.push(`${file} has a JSON error (${result.error}); it was ignored.`)
    return {}
  }
  if (!isPlainObject(result.value)) {
    notes.push(`${file} does not contain a JSON object; it was ignored.`)
    return {}
  }
  return sanitizeUserConfig(result.value, file, notes)
}

/** Remove values the router cannot use, with a note for each one. */
function sanitizeUserConfig(raw: Record<string, unknown>, file: string, notes: string[]): RouterUserConfig {
  const config = { ...raw }
  const drop = (key: string, rule: string) => {
    notes.push(`${file}: "${key}" ${rule}, not ${JSON.stringify(config[key])}; it was ignored.`)
    delete config[key]
  }

  if (config.plan !== undefined && !isPlan(config.plan)) drop("plan", `must be one of ${PLAN_PROFILES.join(" | ")}`)
  if (config.mode !== undefined && !isRouterMode(config.mode)) drop("mode", `must be one of ${ROUTER_MODES.join(" | ")}`)
  const depth = config.chainDepth
  if (depth !== undefined && !(typeof depth === "number" && Number.isInteger(depth) && depth >= 1)) {
    drop("chainDepth", "must be a whole number of 1 or more")
  }
  const threshold = config.softThreshold
  if (threshold !== undefined && !(typeof threshold === "number" && threshold > 0 && threshold <= 1)) {
    drop("softThreshold", "must be a number above 0 and at most 1")
  }
  if (config.updateCheck !== undefined && typeof config.updateCheck !== "boolean") drop("updateCheck", "must be true or false")
  for (const key of ["denyModels", "allowModels"]) {
    const list = config[key]
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      drop(key, "must be a list of model IDs")
    }
  }
  for (const key of ["roles", "weights"]) {
    const perRole = config[key]
    if (perRole === undefined) continue
    if (!isPlainObject(perRole)) {
      drop(key, "must be an object keyed by role")
      continue
    }
    const known: Record<string, unknown> = {}
    for (const [role, value] of Object.entries(perRole)) {
      if (isRoleName(role)) known[role] = value
      else notes.push(`${file}: unknown role "${role}" in "${key}"; it was ignored.`)
    }
    config[key] = known
  }
  sanitizeStatus(config, file, notes)
  return config as RouterUserConfig
}

/** The `status` block: only values this router can act on survive. */
function sanitizeStatus(config: Record<string, unknown>, file: string, notes: string[]): void {
  const raw = config.status
  if (raw === undefined) return
  if (!isPlainObject(raw)) {
    notes.push(`${file}: "status" must be an object; it was ignored.`)
    delete config.status
    return
  }
  const status: Record<string, unknown> = { ...raw }
  const drop = (key: string, rule: string) => {
    notes.push(`${file}: "status.${key}" ${rule}, not ${JSON.stringify(status[key])}; it was ignored.`)
    delete status[key]
  }
  if (status.enabled !== undefined && typeof status.enabled !== "boolean") drop("enabled", "must be true or false")
  if (status.url !== undefined && typeof status.url !== "string") drop("url", "must be a URL string")
  if (status.timeoutMs !== undefined && !(typeof status.timeoutMs === "number" && status.timeoutMs > 0)) {
    drop("timeoutMs", "must be a positive number of milliseconds")
  }
  // A percentage the router scores: 0-100.
  for (const key of ["unknownUptime", "minUptime"]) {
    const value = status[key]
    if (value !== undefined && !(typeof value === "number" && value >= 0 && value <= 100)) {
      drop(key, "must be a number from 0 to 100")
    }
  }
  config.status = status
}

/** Merge two `key -> object` maps one level deep, so project values add to global ones. */
function mergeByKey<K extends string, V extends object>(
  base: Partial<Record<K, V>> = {},
  override: Partial<Record<K, V>> = {},
): Partial<Record<K, V>> {
  const out: Partial<Record<K, V>> = { ...base }
  for (const key of Object.keys(override) as K[]) {
    out[key] = { ...base[key], ...override[key] } as V
  }
  return out
}

export function mergeUserConfig(base: RouterUserConfig, override: RouterUserConfig): RouterUserConfig {
  return {
    ...base,
    ...override,
    blend: { ...base.blend, ...override.blend },
    enduranceScale: { ...base.enduranceScale, ...override.enduranceScale },
    weights: mergeByKey(base.weights, override.weights),
    roles: mergeByKey(base.roles, override.roles),
    scores: mergeByKey(base.scores, override.scores),
    privacy: { ...base.privacy, ...override.privacy },
    feeds: { ...base.feeds, ...override.feeds },
    status: { ...base.status, ...override.status },
    denyModels: override.denyModels ?? base.denyModels,
    allowModels: override.allowModels ?? base.allowModels,
  }
}

/** Detect the best-matching plan profile from the models actually available. */
export function detectPlan(catalog: CatalogModel[]): PlanProfile {
  const hasGo = catalog.some((m) => m.providerID === "opencode-go" && !m.free)
  if (hasGo) return "go"
  const hasFree = catalog.some((m) => m.free)
  if (hasFree) return "free"
  return "go"
}

export function resolveConfig(user: RouterUserConfig, catalog: CatalogModel[], cliPlan?: PlanProfile): ResolvedConfig {
  const plan = cliPlan ?? user.plan ?? detectPlan(catalog)
  return {
    ...user,
    plan,
    mode: user.mode ?? "auto",
    chainDepth: user.chainDepth ?? DEFAULT_CHAIN_DEPTH,
    softThreshold: user.softThreshold ?? DEFAULT_SOFT_THRESHOLD,
    blend: {
      input: user.blend?.input ?? 0.75,
      output: user.blend?.output ?? 0.25,
      cacheRead: user.blend?.cacheRead ?? 0.1,
    },
    enduranceScale: {
      minTokensPer5h: user.enduranceScale?.minTokensPer5h ?? 0.25,
      maxTokensPer5h: user.enduranceScale?.maxTokensPer5h ?? 40,
    },
    denyModels: user.denyModels ?? [],
    allowModels: user.allowModels ?? [],
    privacy: { freeModelsOk: user.privacy?.freeModelsOk ?? true },
    status: {
      ...user.status,
      // On by default: the endpoint is public, cached for five minutes, and a
      // failure degrades to the neutral prior instead of breaking the rebuild.
      enabled: user.status?.enabled ?? true,
      timeoutMs: user.status?.timeoutMs ?? 5000,
      unknownUptime: user.status?.unknownUptime ?? DEFAULT_UNKNOWN_UPTIME,
    },
  }
}
