import { parseArgs } from "node:util"
import { buildRoutingTable, statusRows } from "./engine.js"
import { formatScorecard, formatStatus } from "./format.js"
import { patchServerConfig, routingConfigBody, writeRoutingConfig } from "./apply.js"
import { LedgerStore } from "./ledger.js"
import { catalogMeta } from "./catalog.js"
import { installCommands } from "./install.js"
import { runEval } from "./eval.js"
import { editJsonFile, globalRouterConfigFile, isProjectDir, projectRouterConfigFile, readJson } from "./paths.js"
import { ledgerFile, readApplyMarker } from "./state.js"
import { PACKAGE_NAME, checkForUpdate, clearOutdatedCopies, fetchLatestVersion, installedVersion, updateNotice } from "./update.js"
import { isPlan, PLAN_PROFILES } from "./types.js"
import type { ConfigScope, PlanProfile } from "./types.js"

const HELP = `opencode-router - dynamic model routing for OpenCode Go / Go Plus / Free

Usage:
  opencode-router refresh [options]     Recompute the routing table and apply it
  opencode-router status  [options]     Show the model in use per role and its 5-hour quota use
  opencode-router plan <profile>        Save the plan profile (go | go-plus | free) and rebuild
  opencode-router install [--scope]     Write slash-command files and a starter config
  opencode-router cat                   Show catalog metadata (path, date, model count)
  opencode-router eval                  Run the scoring stress test
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
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals } = parsed
  const scope = parseScope(values.scope)
  const opts: CommonOpts = {
    plan: parsePlan(values.plan),
    scope: resolveScope(scope !== undefined, scope ?? "project", cwd),
    catalog: values.catalog,
    dryRun: values["dry-run"] === true,
    apply: values["no-apply"] !== true,
    json: values.json === true,
    verbose: values.verbose === true,
    cwd,
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
    process.stdout.write(formatStatus(result.table, rows, status, version) + "\n")
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

/** Compare OpenCode's cached copies, not this process: `npx ...@latest update` is always the newest. */
async function cmdUpdate(): Promise<number> {
  const latest = await fetchLatestVersion()
  if (!latest) {
    process.stderr.write("error: could not reach the npm registry. Try again later.\n")
    return 1
  }

  const { removed, pinned, current, failed } = clearOutdatedCopies(latest)
  if (failed.length > 0) {
    for (const { dir, error } of failed) process.stderr.write(`error: could not remove ${dir} (${error})\n`)
    process.stderr.write(`Close OpenCode, then run this command in a terminal: npx ${PACKAGE_NAME}@latest update\n`)
    return 1
  }
  for (const dir of removed) process.stdout.write(`Removed the cached copy: ${dir}\n`)
  if (removed.length > 0) {
    process.stdout.write(`Restart OpenCode. It then installs opencode-router ${latest}.\n`)
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
