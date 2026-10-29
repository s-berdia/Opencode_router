import { ROLE_NAMES } from "./types.js"
import type { PlanProfile, RankingEntry, RoutingTable } from "./types.js"
import type { StatusRow } from "./engine.js"
import type { AllowanceUsage } from "./ledger.js"
import { installedVersion } from "./update.js"

/** What each plan may route to, in one phrase for the scorecard header. */
export const PLAN_TIERS: Record<PlanProfile, string> = {
  free: "Zen $0 only",
  go: "Go subscription + Zen $0",
  "go-plus": "Go subscription + Zen $0 + Zen paid",
}

/** Tokens in millions: `49.9` renders as "49.9M", `0.05` as "50K". */
export function fmtTokens(value: number | null): string {
  if (value === null) return "unlimited"
  if (value >= 1) return `${value.toFixed(1)}M`
  return `${Math.round(value * 1000).toLocaleString()}K`
}

function fmtCap(value: number | null): string {
  return value === null ? "inf" : `$${value}`
}

function fmtEntryTokens(entry: RankingEntry): string {
  // A metered Zen model has no monthly cap, so "unlimited" would imply free.
  if (entry.class === "paid" && entry.tokensPer5h === null) return "metered"
  return fmtTokens(entry.tokensPer5h)
}

function fmtEntryCap(entry: RankingEntry): string {
  if (entry.class === "paid" && entry.monthlyCapUSD === null) return "metered"
  return fmtCap(entry.monthlyCapUSD)
}

function classTag(entry: RankingEntry): string {
  if (entry.class === "free") return "free*"
  if (entry.class === "subscription") return "go"
  return "paid"
}

export function formatScorecard(table: RoutingTable, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = []
  const when = table.createdAt.replace("T", " ").replace(/\..*$/, "")
  lines.push(`## opencode-router scorecard`)
  lines.push("")
  lines.push(`- Plan: **${table.plan}** (${PLAN_TIERS[table.plan]})`)
  lines.push(`- Updated: ${when} (UTC)`)
  lines.push(
    `- Legend: go = Go subscription${table.plan === "free" ? "" : " (included in the Go allowance)"}, free* = $0 (data may be collected), paid = Zen pay-as-you-go (go-plus only, billed per token)`,
  )
  lines.push(
    "- Mtok/5h = what one 5-hour window could buy of that model's monthly cap at its blended $/Mtok (cap x 20% / blended cost). A derived endurance figure, not measured usage.",
  )
  lines.push(
    "- Rel = how often that model actually works, from OpenCode's seven-day status history. Untracked models show the neutral prior.",
  )
  if (table.plan === "free") {
    lines.push("- Free plan: only `opencode` $0 models are eligible. Go subscription and Zen paid models are excluded.")
  } else if (table.plan === "go") {
    lines.push(
      "- Go plan: `opencode-go` subscription models and `opencode` $0 models. Zen paid models are excluded; they need Go Plus.",
    )
  } else {
    lines.push(
      "- Go Plus plan: `opencode-go` subscription models, `opencode` $0 models, and metered Zen paid models. Paid use is billed per token, not taken from the Go allowance.",
    )
  }
  if (table.plan !== "free") {
    lines.push(
      "- All `go` models share one usage allowance. When it is near its limit, each agent uses the free model at the end of its list.",
    )
  }
  lines.push("")
  lines.push("| Role | # | Model | Var | Score | Intel | Speed | Endur | Rel | Mtok/5h | Cap/mo | Tier |")
  lines.push("| :-- | --: | :-- | :-- | --: | --: | --: | --: | --: | --: | --: | :-- |")

  for (const role of ROLE_NAMES) {
    const chain = table.active[role]
    if (!chain) continue
    if (chain.length === 0) {
      lines.push(`| ${role} | - | _no eligible model_ | | | | | | | | | |`)
      continue
    }
    chain.forEach((entry, index) => {
      const roleCol = index === 0 ? role : ""
      const sources = opts.verbose
        ? ` (${entry.sources.intelligence}/${entry.sources.speed}/${entry.sources.endurance}/${entry.sources.reliability})`
        : ""
      lines.push(
        `| ${roleCol} | ${entry.rank} | \`${entry.id}\`${sources} | ${entry.variant ?? "-"} | ${entry.score} | ${entry.intelligence} | ${entry.speed} | ${entry.endurance} | ${entry.reliability} | ${fmtEntryTokens(entry)} | ${fmtEntryCap(entry)} | ${classTag(entry)} |`,
      )
    })
  }

  if (table.notes.length > 0) {
    lines.push("")
    lines.push("**Notes**")
    for (const note of table.notes) lines.push(`- ${note}`)
  }

  lines.push("")
  lines.push(
    opts.verbose
      ? `_Sources (intel/speed/endur/rel): override = user pin or explicit override, benchmark = generated intelligence, table = committed speed/reliability, feed = external benchmark, cap = computed from quota, status = OpenCode status history, heuristic = name pattern, default = no match._`
      : `_Run \`opencode-router refresh --dry-run --verbose\` in a terminal to see the source of each score._`,
  )
  return lines.join("\n")
}

function percent(part: number): string {
  return `${(part * 100).toFixed(0)}%`
}

/** The shared Go allowance; omitted on the free plan. */
export interface AllowanceStatus {
  usage: AllowanceUsage
  softThreshold: number
}

export function formatStatus(
  table: RoutingTable,
  rows: StatusRow[],
  allowance?: AllowanceStatus,
  version: string = installedVersion(),
  mode?: string,
): string {
  const lines: string[] = []
  lines.push(`## opencode-router status`)
  lines.push("")
  lines.push(`- Version: ${version}`)
  lines.push(`- Plan: **${table.plan}** (${PLAN_TIERS[table.plan]})`)
  if (mode) {
    const how =
      mode === "auto"
        ? "the router picks, a manual pick wins for the session"
        : mode === "failover"
          ? "the router moves a session only on limit errors"
          : "the router does not override messages"
    lines.push(`- Mode: **${mode}** (${how})`)
  }
  if (allowance) {
    const { usage } = allowance
    lines.push(
      `- Go allowance used (estimate): 5 hours ${percent(usage.pct5h)}, 7 days ${percent(usage.pctWeek)}, 30 days ${percent(usage.pctMonth)}`,
    )
    if (usage.cooldownUntil !== null) {
      const until = new Date(usage.cooldownUntil).toISOString().slice(11, 16)
      lines.push(`- Go allowance cooldown until ${until} UTC (${usage.cooldownReason ?? "usage limit"})`)
    }
  }
  const freeFallback = allowance
    ? `free-fallback = a free model, because the Go allowance is at ${percent(allowance.softThreshold)} or more or in cooldown; `
    : ""
  lines.push(
    `- State: healthy = first model; failover = a later model, because an earlier model is in cooldown; ${freeFallback}limited = no usable model`,
  )
  lines.push("")
  lines.push("| Role | Model in use | Rank | State |")
  lines.push("| :-- | :-- | --: | :-- |")
  for (const row of rows) {
    if (!row.entry) {
      lines.push(`| ${row.role} | _none_ | - | - |`)
      continue
    }
    lines.push(`| ${row.role} | \`${row.entry.id}\` | ${row.entry.rank} | ${row.state} |`)
  }
  return lines.join("\n")
}
