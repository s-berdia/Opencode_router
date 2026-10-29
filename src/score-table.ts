import bundled from "../model-scores.json" with { type: "json" }
import { ROLE_NAMES } from "./types.js"
import type { RoleSpec, RouterUserConfig, ScoreTable } from "./types.js"

const DEFAULT_TABLE: ScoreTable = bundled

/** A fresh copy of the committed default table (model-scores.json, bundled at build time). */
export function loadDefaultTable(): ScoreTable {
  return structuredClone(DEFAULT_TABLE)
}

function mergeRole(base: RoleSpec, override: Partial<RoleSpec>): RoleSpec {
  return {
    ...base,
    ...override,
    weights: { ...base.weights, ...override.weights },
    requires: { ...base.requires, ...override.requires },
  }
}

/**
 * Build the effective score table: committed defaults, then user overrides from
 * router.config.json. A top-level `chainDepth` applies to every role, and a
 * per-role value wins over it. Roles the router does not know are ignored.
 */
export function resolveTable(user: RouterUserConfig): ScoreTable {
  const table = loadDefaultTable()

  for (const role of ROLE_NAMES) {
    let spec = table.roles[role]
    if (!spec) continue
    if (user.chainDepth !== undefined) spec = { ...spec, chainDepth: user.chainDepth }
    const override = user.roles?.[role]
    if (override) spec = mergeRole(spec, override)
    const weights = user.weights?.[role]
    if (weights) spec = { ...spec, weights: { ...spec.weights, ...weights } }
    table.roles[role] = spec
  }

  for (const [id, score] of Object.entries(user.scores ?? {})) {
    // User scores are pins, not generated data: keep them out of `models` so a
    // regenerated benchmark snapshot can never overwrite them.
    table.overrides = table.overrides ?? {}
    table.overrides[id] = { ...table.overrides[id], ...score }
  }

  return table
}
