import { parseArgs } from "node:util"
import fs from "node:fs"
import { buildRoutingTable, statusRows } from "./engine.js"
import { formatScorecard, formatStatus } from "./format.js"
import { patchServerConfig, routingConfigBody, writeRoutingConfig } from "./apply.js"
import { LedgerStore } from "./ledger.js"
import { catalogMeta } from "./catalog.js"
import { dedupeCatalog, loadCatalog } from "./catalog.js"
import { installCommands } from "./install.js"
import { runEval } from "./eval.js"
import { editJsonFile, globalRouterConfigFile, isProjectDir, projectRouterConfigFile, readJson, scoreTableFile } from "./paths.js"
import { ledgerFile, readApplyMarker } from "./state.js"
import { PACKAGE_NAME, checkForUpdate, clearOutdatedCopies, fetchLatestVersion, installedVersion, updateNotice } from "./update.js"
import { isPlan, PLAN_PROFILES, ROLE_NAMES } from "./types.js"
import type { ConfigScope, PlanProfile } from "./types.js"
import { fetchBenchmarks, parseBenchmarks, type BenchmarkTable } from "./benchmarks.js"
import { refreshScores, scoreTablesMatch, serializeScoreTable } from "./score-refresh.js"
import { selectArchetype } from "./archetype.js"
import { emptyFeedScores } from "./scoring.js"
import { loadUserConfig, resolveConfig } from "./config.js"
import { loadDefaultTable } from "./score-table.js"

const HELP = `opencode-router - dynamic model routing for OpenCode Go / Go Plus / Free

Usage:
  opencode-router refresh [options]     Recompute the routing table and apply it
  opencode-router status  [options]     Show the model in use per role and its 5-hour quota use
  opencode-router plan <profile>        Save the plan profile (go | go-plus | free) and rebuild
  opencode-router install [--scope]     Write slash-command files and a starter config
  opencode-router cat                   Show catalog metadata (path, date, model count)
  opencode-router eval                  Run the scoring stress test
  opencode-router scores [options]      Regenerate intelligence scores from public benchmarks
  opencode-router update                Look for a newer version and clear OpenCode's cached copy

Options:
  --plan <go|go-plus|free>   Plan profile for this run
  --scope <project|global>   Which config files to write (default: project in a project folder, else global)
  --catalog <file>           Path to an OpenCode models.json cache
  --dry-run                  Do not write opencode.json
  --no-apply                 Write opencode.json but do not send it to a running server
  --json                     Print machine-readable JSON
  --verbose                  Include score source tags
  -h, --help                 Show this help

Scores options:
  --write                    Write the regenerated table to model-scores.json
  --check                    Exit 1 when the committed table is out of date
  --top                      Show the winning model per archetype
  --from <file>              Read a saved OpenRouter models.json instead of fetching
  --url <url>                Benchmark source (default: OpenRouter)
  --band <n>                 Intelligence gate width, in percentile points
`

const PLAN_CHOICES = PLAN_PROFILES.join(" | ")

/** A mistake in the command line: exit code 2 with a short message, no stack trace. */
class UsageError extends Error {}

interface CommonOpts {
  plan?: PlanProfile
  scope: ConfigScope
  catalog?: string
  dryRun: boolean
  apply: boolean
  json: boolean
  verbose: boolean
  cwd: string
  write: boolean
  check: boolean
  top: boolean
  from?: string
  url?: string
  band?: number
}

/**
 * Resolve the config scope. When the caller did not pass --scope and the
 * directory is not a real project (for example OpenCode's shell runs from the
 * home directory), fall back to the global config.
 */
export function resolveScope(explicit: boolean, value: ConfigScope, dir: string): ConfigScope {
  if (explicit) return value
  return isProjectDir(dir) ? "project" : "global"
}

function parsePlan(value: string | undefined): PlanProfile | undefined {
  if (value === undefined) return undefined
  if (!isPlan(value)) throw new UsageError(`--plan must be one of ${PLAN_CHOICES}, not "${value}"`)
  return value
}

function parseScope(value: string | undefined): ConfigScope | undefined {
  if (value === undefined || value === "project" || value === "global") return value
  throw new UsageError(`--scope must be project or global, not "${value}"`)
}

function parseCommandLine(argv: string[], cwd: string) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        plan: { type: "string" },
        scope: { type: "string" },
        catalog: { type: "string" },
        "dry-run": { type: "boolean" },
        "no-apply": { type: "boolean" },
        json: { type: "boolean" },
        verbose: { type: "boolean" },
        write: { type: "boolean" },
        check: { type: "boolean" },
        top: { type: "boolean" },
        from: { type: "string" },
        url: { type: "string" },
        band: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals } = parsed
  const scope = parseScope(values.scope)
  let band: number | undefined
  if (values.band !== undefined) {
    band = Number(values.band)
    if (!Number.isFinite(band) || band < 0 || band > 100) {
      throw new UsageError(`--band must be a number from 0 to 100, not "${values.band}"`)
    }
  }
  const opts: CommonOpts = {
    plan: parsePlan(values.plan),
    scope: resolveScope(scope !== undefined, scope ?? "project", cwd),
    catalog: values.catalog,
    dryRun: values["dry-run"] === true,
    apply: values["no-apply"] !== true,
    json: values.json === true,
    verbose: values.verbose === true,
    cwd,
    write: values.write === true,
    check: values.check === true,
    top: values.top === true,
    from: values.from,
    url: values.url,
    band,
  }
  return { command: positionals[0], args: positionals.slice(1), help: values.help === true, opts }
}

function build(opts: CommonOpts) {
  return buildRoutingTable({ plan: opts.plan, catalogFile: opts.catalog, projectDir: opts.cwd })
}

async function writeUpdateNotice(opts: CommonOpts): Promise<void> {
  const update = await checkForUpdate({ projectDir: opts.cwd })
  if (update) process.stdout.write(`\n${updateNotice(update)}\n`)
}

async function cmdRefresh(opts: CommonOpts): Promise<number> {
  const { table } = await build(opts)

  if (opts.json) {
    process.stdout.write(JSON.stringify({ table, routing: routingConfigBody(table) }, null, 2) + "\n")
  } else {
    process.stdout.write(formatScorecard(table, { verbose: opts.verbose }) + "\n")
  }

  let detail = "dry-run: nothing written"
  let applied = false
  if (!opts.dryRun) {
    const written = writeRoutingConfig(table, opts.scope, opts.cwd)
    detail = `${written.created ? "created" : "updated"} ${written.path}`
    // A slash command's plugin hook may have hot-applied the table already.
    const marker = readApplyMarker()
    if (marker) {
      detail += ` | ${marker.detail}`
      applied = marker.ok
    } else if (opts.apply) {
      const patch = await patchServerConfig(table)
      detail += patch.applied ? ` | hot-applied (${patch.detail})` : ` | ${patch.detail}`
      applied = patch.applied
    }
  }

  if (!opts.json) {
    process.stdout.write(`\nApplied: ${detail}\n`)
    if (!opts.dryRun && !applied) {
      process.stdout.write(
        "A running OpenCode session recomputes routing on its next message (within 15 s). Restart to reload the UI display now.\n",
      )
    }
    await writeUpdateNotice(opts)
  }
  return 0
}

async function cmdStatus(opts: CommonOpts): Promise<number> {
  const result = await build(opts)
  const ledger = new LedgerStore(ledgerFile())
  const rows = statusRows(result, ledger)
  const version = installedVersion()

  // The free plan has no Go allowance.
  const allowance = result.cfg.plan === "free" ? undefined : ledger.allowance()

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ version, table: result.table, rows, allowance: allowance ?? null }, null, 2) + "\n",
    )
  } else {
    const status = allowance && { usage: allowance, softThreshold: result.cfg.softThreshold }
    process.stdout.write(formatStatus(result.table, rows, status, version, result.cfg.mode) + "\n")
    await writeUpdateNotice(opts)
  }
  return 0
}

async function cmdPlan(profile: string | undefined, opts: CommonOpts): Promise<number> {
  if (!isPlan(profile)) throw new UsageError(`plan must be one of ${PLAN_CHOICES}`)
  const file = opts.scope === "global" ? globalRouterConfigFile() : projectRouterConfigFile(opts.cwd)
  editJsonFile(file, [{ path: ["plan"], value: profile }])
  process.stdout.write(`Plan set to "${profile}" in ${file}\n`)

  if (opts.scope === "global") {
    const projectFile = projectRouterConfigFile(opts.cwd)
    const projectPlan = readJson<{ plan?: unknown }>(projectFile)?.plan
    if (projectPlan !== undefined && projectPlan !== profile) {
      process.stdout.write(
        `Note: ${projectFile} sets "plan": ${JSON.stringify(projectPlan)}, which overrides the global plan in this project.\n`,
      )
    }
  }

  process.stdout.write("\n")
  return cmdRefresh({ ...opts, plan: undefined })
}

async function cmdScores(opts: CommonOpts): Promise<number> {
  if (opts.write && opts.check) throw new UsageError("--write and --check cannot be combined")

  const raw = loadCatalog(opts.catalog)
  const { catalog, notes } = dedupeCatalog(raw)
  if (catalog.length === 0) {
    process.stderr.write(
      `error: no routed models in ${opts.catalog ?? "the OpenCode catalog"}. Start OpenCode once and sign in, or pass --catalog.\n`,
    )
    return 1
  }

  let benchmarks: BenchmarkTable
  try {
    if (opts.from) {
      const body = JSON.parse(fs.readFileSync(opts.from, "utf8")) as unknown
      benchmarks = parseBenchmarks(body, { source: opts.from, fetchedAt: new Date().toISOString() })
    } else {
      benchmarks = await fetchBenchmarks({ url: opts.url })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `error: could not read benchmarks (${message}). Use --from <saved-openrouter-models.json> to work offline.\n`,
    )
    return 1
  }

  const base = loadDefaultTable()
  let result
  try {
    // Score both provider namespaces even when the scorecard dedupes them: a
    // model sold as both `opencode-go` and `opencode` is only reachable through
    // one of them on a given plan, and the committed table must cover both.
    result = refreshScores({ catalog: raw, benchmarks, base, aliases: base._meta?.aliases })
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const archetypes = opts.top ? archetypeWinners(opts, raw, result.table, result.measured) : []

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          counts: result.table._meta?.counts,
          calibration: result.calibration,
          source: benchmarks.source,
          fetchedAt: benchmarks.fetchedAt,
          stale: result.stale,
          models: result.models,
          unmatched: result.unmatched.map((model) => model.id),
          matchedWithoutBenchmark: result.matchedWithoutBenchmark.map((model) => model.id),
          archetypes: archetypes.map((selection) => ({
            role: selection.role,
            gate: selection.gate,
            gated: selection.gated,
            excluded: selection.excluded,
            unmeasured: selection.unmeasured,
            ranked: selection.ranked.map((entry) => ({
              id: entry.model.id,
              score: round(entry.score),
              intelligence: round(entry.intelligence),
              speed: round(entry.speed),
              endurance: round(entry.endurance),
              reliability: round(entry.reliability),
              blendedCost: round(entry.blendedCost, 4),
              sources: {
                intelligence: entry.intelligenceSource,
                speed: entry.speedSource,
                endurance: entry.enduranceSource,
                reliability: entry.reliabilitySource,
              },
            })),
          })),
        },
        null,
        2,
      ) + "\n",
    )
  } else {
    printScoresSummary(result, benchmarks, raw.length, archetypes, opts.verbose)
    if (notes.length > 0 && opts.verbose) process.stdout.write(`\n${notes.join("\n")}\n`)
  }

  if (opts.check) {
    const file = scoreTableFile()
    let current: unknown
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      process.stderr.write(`error: cannot read ${file}\n`)
      return 1
    }
    if (scoreTablesMatch(current as typeof result.table, result.table)) {
      process.stdout.write(`\n${file} is up to date.\n`)
      return 0
    }
    process.stderr.write(`\n${file} is out of date. Run: opencode-router scores --write\n`)
    return 1
  }

  if (opts.write) {
    const file = scoreTableFile()
    fs.writeFileSync(file, serializeScoreTable(result.table), "utf8")
    process.stdout.write(`\nWrote ${file}\n`)
  }

  return 0
}

function archetypeWinners(
  opts: CommonOpts,
  catalog: ReturnType<typeof loadCatalog>,
  table: ReturnType<typeof loadDefaultTable>,
  measured: ReadonlySet<string>,
) {
  const user = loadUserConfig(opts.cwd)
  // Widest eligibility: the winner report should not hide a model merely
  // because the local machine is on a narrower plan.
  const cfg = resolveConfig(user.config, catalog, "go-plus")
  return ROLE_NAMES.map((role) => {
    const selection = selectArchetype({
      catalog,
      role,
      table,
      cfg,
      feeds: emptyFeedScores(),
      measured,
      band: opts.band,
    })
    // The raw catalog can carry the same model under both provider namespaces.
    // Keep the best-ranked copy so the report does not show a duplicate winner.
    const ranked = []
    const seen = new Set<string>()
    for (const entry of selection.ranked) {
      if (seen.has(entry.model.modelID)) continue
      seen.add(entry.model.modelID)
      ranked.push(entry)
      if (ranked.length >= 3) break
    }
    return { ...selection, ranked }
  })
}

function printScoresSummary(
  result: ReturnType<typeof refreshScores>,
  benchmarks: BenchmarkTable,
  catalogSize: number,
  archetypes: ReturnType<typeof archetypeWinners>,
  verbose: boolean,
): void {
  const counts = result.table._meta?.counts
  process.stdout.write(`Scores: ${catalogSize} routed models, ${counts?.measured ?? 0} measured\n`)
  process.stdout.write(`Source: ${benchmarks.source} (fetched ${benchmarks.fetchedAt})\n`)
  process.stdout.write(`Matched: ${counts?.matched ?? 0} | matched without an index: ${counts?.matchedWithoutBenchmark ?? 0} | unmatched: ${counts?.unmatched ?? 0}\n`)
  process.stdout.write(
    `Calibration: percentiles mapped onto ${round(result.calibration.min)}..${round(result.calibration.max)}\n`,
  )
  if (result.stale.length > 0) {
    process.stdout.write(`Stale entries dropped: ${result.stale.length}\n`)
    for (const id of result.stale.slice(0, 10)) process.stdout.write(`  ${id}\n`)
    if (result.stale.length > 10) process.stdout.write(`  ... and ${result.stale.length - 10} more\n`)
  }

  if (result.unmatched.length > 0) {
    process.stdout.write(`\nUnmatched models keep their prior. Add an alias in _meta.aliases to join deliberately:\n`)
    for (const model of result.unmatched.slice(0, 15)) {
      process.stdout.write(`  ${model.id}${model.canonicalModelID ? ` (canonical: ${model.canonicalModelID})` : ""}\n`)
    }
    if (result.unmatched.length > 15) process.stdout.write(`  ... and ${result.unmatched.length - 15} more\n`)
  }

  if (archetypes.length > 0) {
    process.stdout.write("\nArchetype winners (plan go-plus, intelligence is a gate):\n")
    for (const selection of archetypes) {
      const gate = selection.gate
      const gateText =
        gate.threshold === undefined
          ? `band ${gate.band}, no public benchmarks; priors only`
          : `band ${gate.band}, best ${gate.best}, gate >= ${gate.threshold}`
      const excluded = new Map<string, number>()
      for (const item of selection.excluded) excluded.set(item.reason, (excluded.get(item.reason) ?? 0) + 1)
      const excludedText =
        excluded.size === 0
          ? ""
          : ` | excluded: ${[...excluded.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => `${reason} ${count}`)
              .join(", ")}`
      process.stdout.write(`  ${selection.role.padEnd(12)} ${gateText}${excludedText}\n`)
      if (selection.ranked.length === 0) {
        process.stdout.write("    no eligible model\n")
        continue
      }
      for (const [index, entry] of selection.ranked.entries()) {
        const prior = result.measured.has(entry.model.id) ? "" : " [prior]"
        const sources = verbose
          ? `  [intel ${entry.intelligenceSource}, speed ${entry.speedSource}, end ${entry.enduranceSource}, rel ${entry.reliabilitySource}]`
          : ""
        process.stdout.write(
          `    ${index + 1}. ${entry.model.id.padEnd(44)} score ${round(entry.score).toFixed(1)}  intel ${round(entry.intelligence).toFixed(1)}  speed ${round(entry.speed).toFixed(1)}  end ${round(entry.endurance).toFixed(1)}  rel ${round(entry.reliability).toFixed(1)}  ${entry.model.free ? "free" : entry.model.providerID}${prior}${sources}\n`,
        )
      }
      if (selection.gated.length > 0) {
        process.stdout.write(`    gated out: ${selection.gated.map((item) => `${item.id} (${item.intelligence})`).join(", ")}\n`)
      }
    }
  }
}

function round(value: number, digits = 1): number {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

function cmdCat(catalog?: string): number {
  const meta = catalogMeta(catalog)
  process.stdout.write(`Catalog: ${meta.path}\n`)
  process.stdout.write(`Modified: ${meta.mtime ?? "missing"}\n`)
  process.stdout.write(`Routed models: ${meta.total}\n`)
  return 0
}

function cmdInstall(opts: CommonOpts): number {
  const result = installCommands(opts.scope, opts.cwd)
  process.stdout.write(`Wrote ${result.files.length} command files to ${result.commandDir}\n`)
  process.stdout.write(
    result.configCreated ? `Wrote starter config: ${result.configPath}\n` : `Kept existing config: ${result.configPath}\n`,
  )
  return 0
}

/** Compare OpenCode's cached copies, not this process: `npx --prefer-online ...@latest update` is always the newest. */
async function cmdUpdate(): Promise<number> {
  const latest = await fetchLatestVersion()
  if (!latest) {
    process.stderr.write("error: could not reach the npm registry. Try again later.\n")
    return 1
  }

  const { removed, pinned, current, failed } = clearOutdatedCopies(latest)
  if (failed.length > 0) {
    for (const { dir, error } of failed) process.stderr.write(`error: could not remove ${dir} (${error})\n`)
    process.stderr.write(`Close OpenCode, then run this command in a terminal: npx --prefer-online ${PACKAGE_NAME}@latest update\n`)
    return 1
  }
  for (const dir of removed) process.stdout.write(`Removed the cached copy: ${dir}\n`)
  if (removed.length > 0) {
    process.stdout.write(`Restart OpenCode (or run "opencode plugin update"). It then installs opencode-router ${latest}.\n`)
  }
  if (pinned.length > 0) {
    process.stdout.write(
      `opencode.json pins an older version (${pinned.join(", ")}). Change the plugin entry to "${PACKAGE_NAME}@${latest}", then restart OpenCode.\n`,
    )
  }
  if (removed.length > 0 || pinned.length > 0) return 0

  if (current.length > 0) {
    process.stdout.write(`OpenCode has opencode-router ${latest}, the newest version.\n`)
  } else {
    process.stdout.write(
      `OpenCode has no cached copy of opencode-router. The newest version is ${latest}. If you use a local build, run git pull and npm run build. If your OpenCode has the command "opencode plugin update", run it.\n`,
    )
  }
  return 0
}

function usageError(error: Error): number {
  process.stderr.write(`error: ${error.message}\n\nRun "opencode-router --help" for usage.\n`)
  return 2
}

/** Run one CLI command. Returns the exit code; never exits the process. */
export async function main(argv: string[], cwd: string = process.cwd()): Promise<number> {
  try {
    const { command, args, help, opts } = parseCommandLine(argv, cwd)
    if (!command || command === "help" || help) {
      process.stdout.write(HELP)
      return 0
    }
    switch (command) {
      case "refresh":
        return await cmdRefresh(opts)
      case "status":
        return await cmdStatus(opts)
      case "plan":
        return await cmdPlan(args[0], opts)
      case "cat":
        return cmdCat(opts.catalog)
      case "install":
        return cmdInstall(opts)
      case "eval":
        return await runEval({ plan: opts.plan, catalog: opts.catalog, json: opts.json, projectDir: opts.cwd })
      case "scores":
        return await cmdScores(opts)
      case "update":
        return await cmdUpdate()
      default:
        throw new UsageError(`unknown command "${command}"`)
    }
  } catch (error) {
    if (error instanceof UsageError) return usageError(error)
    throw error
  }
}
