import { readJson, writeJson } from "./paths.js"
import { goCapsFile } from "./state.js"
import type { CatalogModel, ModelPrivacy, MonthlyCap, ScoreTable } from "./types.js"

/** The page that publishes the Go plan tables. */
export const GO_DOCS_URL = "https://opencode.ai/v2/docs/console/go"

export type GoPlanKey = "go" | "go-plus" | "go-teams"

export interface GoModelRef {
  id: string
  free: boolean
}

/** A fetched snapshot of the Go monthly caps and data policies. */
export interface GoCaps {
  version: 1
  source: string
  fetchedAt: string
  /** `provider/model` -> monthly USD cap. null means unlimited. */
  plans: Record<GoPlanKey, Record<string, number | null>>
  /** `provider/model` -> training/retention policy from the docs. */
  privacy: Record<string, ModelPrivacy>
  /** Live paid models with no row in the docs. */
  missing: string[]
  /** Docs rows that do not match a model in the catalog. */
  unmatched: string[]
}

const PLAN_KEYS: GoPlanKey[] = ["go", "go-plus", "go-teams"]

/**
 * Normalize a docs display name and a model id the same way: drop
 * parenthetical tier text, punctuation, and case. This maps "Claude Haiku 5.5"
 * and "claude-haiku-5-5" to the same key, as well as "MiniMax M3 (≤ 512K
 * tokens)" and "minimax-m3".
 */
export function canonicalModelKey(value: string): string {
  return value
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-")
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function parseCap(value: string): number | null | undefined {
  if (/unlimited/i.test(value)) return null
  if (/\bfree\b/i.test(value) && !/\$/.test(value)) return null
  const match = /\$([\d,]+(?:\.\d+)?)/.exec(value)
  if (!match) return undefined
  const cap = Number((match[1] ?? "").replace(/,/g, ""))
  return Number.isFinite(cap) ? cap : undefined
}

interface TableRow {
  name: string
  cells: string[]
}

function tableRows(table: string): TableRow[] {
  const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []
  const out: TableRow[] = []
  for (const row of rows) {
    const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(textOf)
    if (cells.length === 0) continue
    if (/^model$/i.test(cells[0] ?? "")) continue
    out.push({ name: cells[0] ?? "", cells })
  }
  return out
}

function tablesWithHeader(section: string, header: string): string[] {
  const tables = section.match(/<table\b[\s\S]*?<\/table>/gi) ?? []
  return tables.filter((table) => textOf(table).toLowerCase().includes(header.toLowerCase()))
}

function findPricingTable(section: string): string | undefined {
  return tablesWithHeader(section, "monthly limit")[0]
}

function planSection(html: string, plan: GoPlanKey): string {
  const marker = `id="go-pricing-panel-${plan}"`
  const start = html.indexOf(marker)
  if (start === -1) return ""
  const next = html.indexOf('id="go-pricing-panel-', start + marker.length)
  return html.slice(start, next === -1 ? undefined : next)
}

function privacySection(html: string): string {
  const marker = "Model training"
  const index = html.indexOf(marker)
  if (index === -1) return ""
  const start = html.lastIndexOf("<table", index)
  if (start === -1) return ""
  const end = html.indexOf("</table>", index)
  return end === -1 ? html.slice(start) : html.slice(start, end + "</table>".length)
}

/**
 * Parse the Go docs page. The docs publish separate pricing tables for Go, Go
 * Plus, and Go Teams, plus a privacy table. The display names are matched to
 * catalog ids by `canonicalModelKey`, so a punctuation change in the docs does
 * not silently drop a cap.
 */
export function parseGoCaps(html: string, known: GoModelRef[]): GoCaps {
  const byKey = new Map<string, GoModelRef>()
  for (const model of known) {
    byKey.set(canonicalModelKey(model.id.replace(/^opencode-go\//, "")), model)
  }

  const plans = Object.fromEntries(PLAN_KEYS.map((plan) => [plan, {}])) as Record<
    GoPlanKey,
    Record<string, number | null>
  >
  const unmatched = new Set<string>()

  for (const plan of PLAN_KEYS) {
    const table = findPricingTable(planSection(html, plan))
    if (!table) continue
    for (const row of tableRows(table)) {
      const cap = parseCap(row.cells[row.cells.length - 1] ?? "")
      if (cap === undefined) continue
      const model = byKey.get(canonicalModelKey(row.name))
      if (!model) {
        unmatched.add(row.name)
        continue
      }
      // Tiered and peak rows repeat the same model with the same monthly cap.
      if (!(model.id in plans[plan])) plans[plan][model.id] = cap
    }
  }

  const privacy: Record<string, ModelPrivacy> = {}
  const privacyTable = tablesWithHeader(privacySection(html), "model training")[0]
  if (privacyTable) {
    for (const row of tableRows(privacyTable)) {
      if (row.cells.length < 3) continue
      const model = byKey.get(canonicalModelKey(row.name))
      if (!model) continue
      const trainingText = row.cells[1] ?? ""
      privacy[model.id] = {
        training: !/not used|no training|none/i.test(trainingText),
        retention: row.cells[2] || undefined,
      }
    }
  }

  const missing = known
    .filter((model) => !model.free && plans.go[model.id] === undefined)
    .map((model) => model.id)
    .sort()

  return {
    version: 1,
    source: GO_DOCS_URL,
    fetchedAt: new Date().toISOString(),
    plans,
    privacy,
    missing,
    unmatched: [...unmatched].sort(),
  }
}

export interface FetchGoCapsOptions {
  known: GoModelRef[]
  url?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Fetch and parse the docs page. Throws on a network or HTTP error. */
export async function fetchGoCaps(opts: FetchGoCapsOptions): Promise<GoCaps> {
  const url = opts.url ?? GO_DOCS_URL
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const fetchImpl = opts.fetchImpl ?? fetch
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "opencode-router (+https://github.com/s-berdia/Opencode_router)",
        accept: "text/html",
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
    const caps = parseGoCaps(await response.text(), opts.known)
    if (Object.keys(caps.plans.go).length === 0) throw new Error("no Go cap rows found in the page")
    caps.source = url
    return caps
  } finally {
    clearTimeout(timeout)
  }
}

export function readGoCaps(file: string = goCapsFile()): GoCaps | undefined {
  const value = readJson<GoCaps>(file)
  if (value?.version !== 1 || typeof value.fetchedAt !== "string" || !value.plans) return undefined
  if (!value.plans.go || Object.keys(value.plans.go).length === 0) return undefined
  return value
}

export function writeGoCaps(caps: GoCaps, file: string = goCapsFile()): void {
  writeJson(file, caps)
}

export interface LoadGoCapsOptions {
  /** Catalog models used to turn docs display names into ids. */
  known?: GoModelRef[]
  /** Fetch even when the cache is fresh. */
  force?: boolean
  /** false reads the cache only. */
  fetch?: boolean
  /** Cache lifetime; defaults to 24 hours. */
  ttlHours?: number
  url?: string
  file?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface LoadGoCapsResult {
  caps?: GoCaps
  /** A line for the scorecard/status notes. */
  note?: string
  fetched: boolean
}

let inflight: Promise<LoadGoCapsResult> | null = null

function offline(): boolean {
  return process.env.OPENCODE_ROUTER_OFFLINE === "1" || process.env.VITEST === "true"
}

/**
 * Read the cached cap table, refreshing it when stale. A failed fetch never
 * breaks a rebuild: the cached table (or the bundled fallback) still applies.
 */
export async function loadGoCaps(opts: LoadGoCapsOptions = {}): Promise<LoadGoCapsResult> {
  const file = opts.file ?? goCapsFile()
  const cached = readGoCaps(file)
  const ttlMs = (opts.ttlHours ?? 24) * 3_600_000
  const fresh = cached !== undefined && Date.now() - Date.parse(cached.fetchedAt) < ttlMs
  const allowFetch = opts.fetch !== false && !offline()
  if (cached && fresh && !opts.force) return { caps: cached, fetched: false }
  if (!allowFetch) {
    return {
      caps: cached,
      fetched: false,
      note: cached
        ? `Go caps: cached from ${cached.fetchedAt} (fetch disabled).`
        : "Go caps: fetch disabled and no cache; using the bundled table.",
    }
  }
  if (inflight) return inflight

  inflight = (async (): Promise<LoadGoCapsResult> => {
    try {
      const known = opts.known ?? []
      if (known.length === 0) {
        return {
          caps: cached,
          fetched: false,
          note: "Go caps: no OpenCode Go models in the catalog; kept the cached table.",
        }
      }
      const caps = await fetchGoCaps({
        known,
        url: opts.url,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
      })
      writeGoCaps(caps, file)
      return { caps, fetched: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        caps: cached,
        fetched: false,
        note: cached
          ? `Go caps: fetch failed (${message}); using the cache from ${cached.fetchedAt}.`
          : `Go caps: fetch failed (${message}); using the bundled table.`,
      }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Copy fetched caps and privacy policy over a score table. */
export function mergeGoCaps(table: ScoreTable, caps: GoCaps | undefined): void {
  if (!caps) return
  for (const plan of PLAN_KEYS) {
    const field: keyof MonthlyCap = plan === "go" ? "go" : plan === "go-plus" ? "goPlus" : "goTeams"
    for (const [id, cap] of Object.entries(caps.plans[plan] ?? {})) {
      const entry = table.monthlyCaps[id] ?? { go: null, goPlus: null, goTeams: null }
      entry[field] = cap
      table.monthlyCaps[id] = entry
    }
  }
  table.privacy = { ...table.privacy, ...caps.privacy }
  table.goCaps = { source: caps.source, fetchedAt: caps.fetchedAt }
}

/** The Go models a catalog can route to, for matching docs rows to ids. */
export function goModelsFromCatalog(catalog: CatalogModel[]): GoModelRef[] {
  return catalog.filter((model) => model.providerID === "opencode-go").map((model) => ({ id: model.id, free: model.free }))
}
