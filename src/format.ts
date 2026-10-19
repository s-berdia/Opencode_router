import { ROLE_NAMES } from "./types.js"
import type { RankingEntry, RoutingTable } from "./types.js"
import type { StatusRow } from "./engine.js"
import type { AllowanceUsage } from "./ledger.js"
import { installedVersion } from "./update.js"

function fmtTokens(value: number | null): string {
  if (value === null) return "unlimited"
  if (value >= 1) return `${value.toFixed(1)}M`
  return `${(value * 1000).toFixed(0)}K`
}

function fmtCap(value: number | null): string {
  return value === null ? "inf" : `$${value}`
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
  lines.push(`- Plan: **${table.plan}**`)
  lines.push(`- Updated: ${when} (UTC)`)
  lines.push(`- Legend: go = Go subscription, free* = $0 (data may be collected), paid = Zen pay-as-you-go`)
  if (table.plan !== "free") {
    lines.push(
      "- All `go` models share one usage allowance. When it is near its limit, each agent uses the free model at the end of its list.",
    )
  }
  lines.push("")
  lines.push("| Role | # | Model | Var | Score | Intel | Speed | Endur | Tokens/5h | Cap/mo | Class |")
  lines.push("| :-- | --: | :-- | :-- | --: | --: | --: | --: | --: | --: | :-- |")

  for (const role of ROLE_NAMES) {
    const chain = table.active[role]
    if (!chain) continue
    if (chain.length === 0) {
      lines.push(`| ${role} | - | _no eligible model_ | | | | | | | | |`)
      continue
    }
    chain.forEach((entry, index) => {
      const roleCol = index === 0 ? role : ""
      const sources = opts.verbose
        ? ` (${entry.sources.intelligence}/${entry.sources.speed}/${entry.sources.endurance})`
        : ""
      lines.push(
        `| ${roleCol} | ${entry.rank} | \`${entry.id}\`${sources} | ${entry.variant ?? "-"} | ${entry.score} | ${entry.intelligence} | ${entry.speed} | ${entry.endurance} | ${fmtTokens(entry.tokensPer5h)} | ${fmtCap(entry.monthlyCapUSD)} | ${classTag(entry)} |`,
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
      ? `_Sources (intel/speed/endur): override = committed/user table, feed = external benchmark, cap = computed from quota, heuristic = name pattern, default = no match._`
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
): string {
  const lines: string[] = []
  lines.push(`## opencode-router status`)
  lines.push("")
  lines.push(`- Version: ${version}`)
  lines.push(`- Plan: **${table.plan}**`)
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
