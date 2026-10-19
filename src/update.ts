import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadUserConfig } from "./config.js"
import { opencodeCacheDir, readJson, writeJson } from "./paths.js"
import { updateCheckFile } from "./state.js"

// OpenCode 1.19 installs an npm plugin one time and then reuses its cached
// copy. It does not look for a newer version, so the router does.

export const PACKAGE_NAME = "@s-berdia/opencode-router"
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}/latest`
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 3000

export interface UpdateInfo {
  current: string
  latest: string
}

interface UpdateCheckState {
  checkedAt: number
  latest?: string
}

function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

/** True when version `a` is higher than version `b`. Compares major.minor.patch only. */
export function isNewerVersion(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return false
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]!
  }
  return false
}

/** The version in this package's package.json, one folder above dist/ (or src/ in tests). */
export function installedVersion(): string {
  const file = fileURLToPath(new URL("../package.json", import.meta.url))
  return readJson<{ version?: string }>(file)?.version ?? "0.0.0"
}

/** The `latest` version on npm, or undefined when npm cannot be reached. */
export async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(LATEST_URL, { signal: controller.signal, headers: { accept: "application/json" } })
    if (!res.ok) return undefined
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

export interface UpdateCheckOptions {
  projectDir?: string
  /** Installed version; default: this package's version. */
  current?: string
  now?: number
}

/**
 * The newer version on npm, or null. Asks npm at most once per 24 hours and
 * never when `updateCheck` is false. Never throws.
 */
export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<UpdateInfo | null> {
  try {
    if (loadUserConfig(opts.projectDir).config.updateCheck === false) return null
    const current = opts.current ?? installedVersion()
    const now = opts.now ?? Date.now()
    const state = readJson<UpdateCheckState>(updateCheckFile())
    let latest = state?.latest
    const fresh = state !== undefined && now >= state.checkedAt && now - state.checkedAt < CHECK_INTERVAL_MS
    if (!fresh) {
      // Record failed checks too, so an offline machine asks once per day, not at each start.
      latest = (await fetchLatestVersion()) ?? latest
      writeJson(updateCheckFile(), { checkedAt: now, latest })
    }
    return latest && isNewerVersion(latest, current) ? { current, latest } : null
  } catch {
    return null
  }
}

/** One line for the end of the status and the scorecard. */
export function updateNotice(update: UpdateInfo): string {
  return `opencode-router ${update.latest} is available (installed: ${update.current}). To update, type /routing-update in OpenCode.`
}

export interface ClearResult {
  /** Removed cache folders. OpenCode installs the newest version into them at its next start. */
  removed: string[]
  /** Cache folders of an older version that opencode.json pins, for example `opencode-router@1.0.1`. */
  pinned: string[]
  /** Cache folders that already have the newest version. */
  current: string[]
  /** Old cache folders that could not be removed, for example because Windows locks a file. */
  failed: Array<{ dir: string; error: string }>
}

function readCachedVersion(dir: string, scope: string, name: string, generational: boolean): string {
  if (generational) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return "0.0.0"
    }
    const numeric = entries.filter((entry) => /^\d+$/.test(entry)).toSorted((a, b) => Number(a) - Number(b))
    const fallbackDirs = entries.filter((entry) => !entry.startsWith(".") && entry !== "node_modules").toSorted()
    const latestGeneration = numeric.at(-1) ?? fallbackDirs.at(-1)
    if (latestGeneration) {
      const genManifest = path.join(dir, latestGeneration, "node_modules", scope, name, "package.json")
      const genVersion = readJson<{ version?: string }>(genManifest)?.version
      if (genVersion) return genVersion
    }
  }
  const manifest = path.join(dir, "node_modules", scope, name, "package.json")
  return readJson<{ version?: string }>(manifest)?.version ?? "0.0.0"
}

/**
 * Remove OpenCode's cached copies of this package that are older than `latest`.
 * Supports both OpenCode 1.19 (`<cache>/packages/@s-berdia/<spec>/node_modules/`)
 * and the generational npm cache (`<cache>/npm/@s-berdia/<spec>/<generation>/node_modules/`).
 */
export function clearOutdatedCopies(latest: string): ClearResult {
  const [scope, name] = PACKAGE_NAME.split("/") as [string, string]
  const cacheRoot = opencodeCacheDir()
  const layouts = [
    { scopeDir: path.join(cacheRoot, "packages", scope), generational: false },
    { scopeDir: path.join(cacheRoot, "npm", scope), generational: true },
  ]
  const result: ClearResult = { removed: [], pinned: [], current: [], failed: [] }

  for (const { scopeDir, generational } of layouts) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(scopeDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = path.join(scopeDir, entry)
      if (entry === name || entry === `${name}@latest`) {
        const version = readCachedVersion(dir, scope, name, generational)
        if (!isNewerVersion(latest, version)) {
          result.current.push(dir)
          continue
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
          result.removed.push(dir)
        } catch (error) {
          result.failed.push({ dir, error: error instanceof Error ? error.message : String(error) })
        }
      } else if (entry.startsWith(`${name}@`) && isNewerVersion(latest, entry.slice(name.length + 1))) {
        if (!result.pinned.includes(entry)) result.pinned.push(entry)
      }
    }
  }
  return result
}

