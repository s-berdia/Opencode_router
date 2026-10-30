import fs from "node:fs"
import path from "node:path"
import { globalConfigDir, readJson, writeJson } from "./paths.js"

// Usage caps are per OpenCode account, not per project, so all runtime state
// lives in one global folder that the plugin and the CLI share.

export function stateDir(): string {
  return path.join(globalConfigDir(), "router")
}

export function ledgerFile(): string {
  return path.join(stateDir(), "ledger.json")
}

export function routingTableFile(): string {
  return path.join(stateDir(), "routing-table.json")
}

export function evalReportFile(): string {
  return path.join(stateDir(), "eval-report.md")
}

export function updateCheckFile(): string {
  return path.join(stateDir(), "update-check.json")
}

/** The fetched Go monthly caps and data policies, shared by the CLI and plugin. */
export function goCapsFile(): string {
  return path.join(stateDir(), "go-caps.json")
}

/** Small state file the TUI widget reads: active mode, per-session manual picks, last model in use. */
export function hudFile(): string {
  return path.join(stateDir(), "hud.json")
}

/** The live model ids the running OpenCode server reports, written by the plugin for the CLI. */
export function liveModelsFile(): string {
  return path.join(stateDir(), "live-models.json")
}

interface LiveModelsSnapshot {
  version: 1
  updatedAt: string
  models: string[]
}

/**
 * Save the provider/model ids that OpenCode actually lists. The CLI reads this
 * snapshot so it does not route to a model that was removed from the account
 * since the last `models.json` cache refresh.
 */
export function writeLiveModels(ids: Iterable<string>): void {
  const models = [...new Set(ids)].sort()
  writeJson(liveModelsFile(), { version: 1, updatedAt: new Date().toISOString(), models } satisfies LiveModelsSnapshot)
}

/**
 * The last live model snapshot, or undefined when it is missing, malformed, or
 * older than `maxAgeMs`. A stale snapshot is worse than the catalog cache.
 */
export function readLiveModels(maxAgeMs = 10 * 60_000): Set<string> | undefined {
  const snapshot = readJson<LiveModelsSnapshot>(liveModelsFile())
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.models)) return undefined
  const at = Date.parse(snapshot.updatedAt)
  if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return undefined
  const models = snapshot.models.filter((id): id is string => typeof id === "string" && id.includes("/"))
  return models.length > 0 ? new Set(models) : undefined
}

export interface HudSnapshot {
  version: 1
  updatedAt: string
  mode: string
  /** `sessionID:agent` -> the model the user picked; the router leaves these alone. */
  manual: Record<string, string>
  /** `sessionID` -> the model of the last message in that session. */
  last: Record<string, string>
}

export function writeHudSnapshot(snapshot: Omit<HudSnapshot, "version" | "updatedAt">): void {
  writeJson(hudFile(), { version: 1, updatedAt: new Date().toISOString(), ...snapshot } satisfies HudSnapshot)
}

function applyMarkerFile(): string {
  return path.join(stateDir(), "last-apply.json")
}

/** The plugin's hot-apply and the CLI it starts run within milliseconds of each other. */
const MARKER_MAX_AGE_MS = 10_000

export interface ApplyMarker {
  ok: boolean
  detail: string
}

/** Record the result of the plugin's last hot-apply, for the CLI to report. */
export function writeApplyMarker(marker: ApplyMarker): void {
  writeJson(applyMarkerFile(), { at: new Date().toISOString(), ...marker })
}

export function readApplyMarker(maxAgeMs = MARKER_MAX_AGE_MS): ApplyMarker | null {
  const marker = readJson<{ at?: string; ok?: boolean; detail?: string }>(applyMarkerFile())
  if (!marker?.at || !marker.detail) return null
  const at = Date.parse(marker.at)
  if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null
  return { ok: marker.ok === true, detail: marker.detail }
}

export function clearApplyMarker(): void {
  fs.rmSync(applyMarkerFile(), { force: true })
}
