import type { PlanProfile, RankingEntry } from "./types.js"
import { buildRoutingTable } from "./engine.js"
import { authFile, writeTextAtomic } from "./paths.js"
import { storedKeys } from "./auth.js"
import { FIVE_HOUR_SHARE } from "./scoring.js"
import { fmtTokens } from "./format.js"
import { evalReportFile } from "./state.js"

export interface EvalOptions {
  plan?: PlanProfile
  catalog?: string
  json?: boolean
  projectDir?: string
}

const ROLE = "build"
const CHAIN_LIMIT = 4
/**
 * A model call must answer within this window; the plugin kills the whole CLI
 * child after a fixed budget, so one stalled call must not eat it all. Two
 * calls of 50 s fit inside that budget.
 */
const CALL_TIMEOUT_MS = 50_000
/**
 * Token budget per call, sized so a slow model can actually finish inside
 * CALL_TIMEOUT_MS. Measured generation rates are ~30-80 tok/s on the OpenCode
 * endpoints, so 2000 tokens needs roughly 25-70 s. An older 8000-token budget
 * could not finish in time and showed up as phantom "unreliable" timeouts.
 */
const MAX_TOKENS = 2000

/** A friendlier message for the DOMException that AbortSignal.timeout throws. */
function abortMessage(error: unknown): string | undefined {
  return error instanceof Error && error.name === "TimeoutError"
    ? `no response within ${CALL_TIMEOUT_MS / 1000} s`
    : undefined
}

const PROMPT = `In a fixture repo, build a CLI named \`todo\` with \`add\`, \`list\`, \`done <id>\`, and \`rm <id>\` subcommands backed by a JSON file. Include input validation, a \`--json\` output flag, and a test suite. Then fix any failing tests.`

const GO_URL = "https://opencode.ai/inference/go/openai/v1"
const ZEN_URL = "https://opencode.ai/inference/openai/v1"

export interface CallResult {
  ok: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  costUSD: number
  text: string
  error?: string
  /** Why the model stopped: "stop" (finished) or "length" (hit MAX_TOKENS). */
  finishReason?: string
}

export type EvalStatus = "PASS" | "WEAK" | "FAIL" | "SKIP"

export interface EvalRow {
  entry: RankingEntry
  result: CallResult
  pass: number
  status: EvalStatus
}

/**
 * Measured order: models that answered first (most checks, then quickest).
 * Failed calls come next. Skipped calls (no credentials) always come last:
 * they never ran, so they must not outrank a model that answered.
 */
export function orderMeasured(rows: EvalRow[]): EvalRow[] {
  const group = (row: EvalRow): number => (row.status === "SKIP" ? 3 : row.status === "FAIL" ? 2 : 1)
  return [...rows].sort(
    (a, b) =>
      group(a) - group(b) ||
      b.pass - a.pass ||
      a.result.latencyMs - b.result.latencyMs ||
      a.entry.rank - b.entry.rank,
  )
}

/**
 * The answer text of a completion message, whatever field the provider used.
 * OpenCode's own endpoints answer in `reasoning`, so reading only `content`
 * and `reasoning_content` grades a working model as silent.
 */
export function messageText(
  message: { content?: string; reasoning_content?: string; reasoning?: string } | undefined,
): string {
  return message?.content || message?.reasoning_content || message?.reasoning || ""
}

function staticGrade(text: string): { passed: number; checks: Record<string, boolean> } {
  const lower = text.toLowerCase()
  const checks: Record<string, boolean> = {
    add: /\badd\b/.test(lower),
    list: /\blist\b/.test(lower),
    done: /\bdone\b/.test(lower),
    rm: /\brm\b|\bremove\b|\bdelete\b/.test(lower),
    jsonFlag: /--json/.test(text),
    validation: /invalid|validat|error/.test(lower),
    tests: /\btest\b|\bdescribe\(|\bit\(|assert/.test(lower),
  }
  const passed = Object.values(checks).filter(Boolean).length
  return { passed, checks }
}

async function callModel(entry: RankingEntry, apiKey: string): Promise<CallResult> {
  const base = entry.providerID === "opencode-go" ? GO_URL : ZEN_URL
  const started = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        // The opencode.ai inference endpoints reject requests without a session
        // id (HTTP 400 "MissingSessionID"). This eval runs outside a real
        // session, so tag the calls as measurements instead.
        "x-opencode-session": `router-eval-${Math.random().toString(36).slice(2, 10)}`,
        "x-opencode-agent": "opencode-router",
      },
      body: JSON.stringify({
        model: entry.modelID,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: MAX_TOKENS,
      }),
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200)
      return {
        ok: false,
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        text: "",
        error: `HTTP ${res.status}${body ? `: ${body}` : ""}`,
      }
    }
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string
        message?: { content?: string; reasoning_content?: string; reasoning?: string }
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const message = json.choices?.[0]?.message
    // Reasoning models can spend the whole token budget thinking and still
    // return an empty `content`. Grade what they produced: fall back to the
    // reasoning trace when the answer never made it out.
    const text = messageText(message)
    return {
      ok: true,
      latencyMs,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUSD: estimateCost(entry, json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0),
      text,
      finishReason: json.choices?.[0]?.finish_reason,
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      text: "",
      error: abortMessage(error) ?? (error instanceof Error ? error.message : String(error)),
    }
  }
}

function estimateCost(entry: RankingEntry, inputTokens: number, outputTokens: number): number {
  // Rough: derived from the score table's blended cost when present.
  const per1M = entry.tokensPer5h && entry.monthlyCapUSD ? (entry.monthlyCapUSD * FIVE_HOUR_SHARE) / entry.tokensPer5h : 1
  return ((inputTokens + outputTokens) / 1_000_000) * per1M
}

export async function runEval(opts: EvalOptions = {}): Promise<number> {
  const { table } = await buildRoutingTable({ plan: opts.plan, catalogFile: opts.catalog, projectDir: opts.projectDir })
  const chain = (table.active[ROLE] ?? []).slice(0, CHAIN_LIMIT)

  if (chain.length === 0) {
    process.stderr.write(`error: no candidate models for role "${ROLE}"\n`)
    return 1
  }

  const envKey = process.env.OPENCODE_API_KEY
  const stored = storedKeys()
  const keyFor = (entry: RankingEntry): string | undefined => envKey ?? stored.get(entry.providerID)
  const liveReady = chain.some((entry) => keyFor(entry) !== undefined)
  const providers = [...new Set(chain.map((entry) => entry.providerID))]
  const readyProviders = providers.filter((provider) => envKey !== undefined || stored.has(provider))
  const missingProviders = providers.filter((provider) => envKey === undefined && !stored.has(provider))
  const providerList = (ids: string[]): string => ids.map((id) => `\`${id}\``).join(", ")
  const reportPath = evalReportFile()

  const lines: string[] = []
  lines.push(`# opencode-router eval report`)
  lines.push("")
  lines.push(`- Role: **${ROLE}**`)
  lines.push(`- Plan: **${table.plan}**`)
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push("")
  lines.push(`## Prompt`)
  lines.push("")
  lines.push("> " + PROMPT.replace(/\r?\n/g, " "))
  lines.push("")

  if (!liveReady) {
    lines.push("## Result")
    lines.push("")
    lines.push(`No credentials found for any routed provider (${providerList(providers)}). Nothing was called. The predicted ranking is below.`)
    lines.push("")
    lines.push("| Rank | Model | Score | Intel | Speed | Endur | Mtok/5h | Class |")
    lines.push("| --: | :-- | --: | --: | --: | --: | --: | :-- |")
    for (const e of chain) {
      lines.push(
        `| ${e.rank} | \`${e.id}\` | ${e.score} | ${e.intelligence} | ${e.speed} | ${e.endurance} | ${fmtTokens(e.tokensPer5h)} | ${e.class} |`,
      )
    }
    lines.push("")
    lines.push("`Mtok/5h` = millions of tokens of that model's monthly cap; what one 5-hour window could buy at its blended cost. A derived figure, not measured usage.")
    lines.push("")
    lines.push(
      "Live measurement reuses the OpenCode sign-in (`opencode auth login`). No separate `OPENCODE_API_KEY` is required; it remains an optional override.",
    )
    writeTextAtomic(reportPath, lines.join("\n") + "\n")
    if (opts.json) process.stdout.write(JSON.stringify({ role: ROLE, predicted: chain }, null, 2) + "\n")
    else process.stdout.write(`Wrote ${reportPath} (predicted only; no credentials for the routed providers)\n`)
    return 0
  }

  lines.push("## Result")
  lines.push("")
  lines.push(
    envKey
      ? "Calls used `OPENCODE_API_KEY` (set as an override)."
      : `Calls reused the OpenCode sign-in from \`${authFile()}\`.`,
  )
  lines.push("")
  lines.push(`Providers with credentials: ${providerList(readyProviders)}.`)
  if (missingProviders.length > 0) {
    lines.push(`Skipped (no credentials): ${providerList(missingProviders)}. Those models were not called and get no measured rank.`)
  }
  lines.push("")
  lines.push("| Predicted rank | Model | Latency (ms) | Tokens | Cost (USD) | Checks | Status | Error |")
  lines.push("| --: | :-- | --: | --: | --: | --: | --: | :-- |")

  const results: EvalRow[] = []
  for (const entry of chain) {
    const key = keyFor(entry)
    const result: CallResult = key
      ? await callModel(entry, key)
      : {
          ok: false,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUSD: 0,
          text: "",
          error: `no credentials for ${entry.providerID} (skipped)`,
        }
    const grade = staticGrade(result.text)
    const status: EvalStatus = key ? (result.ok ? (grade.passed >= 5 ? "PASS" : "WEAK") : "FAIL") : "SKIP"
    results.push({ entry, result, pass: grade.passed, status })
    // A truncated answer is not a broken model, but it does understate the
    // checks, so say so rather than let a WEAK row read as a quality verdict.
    const truncated = result.finishReason === "length" ? "hit MAX_TOKENS; answer truncated" : ""
    const detail = [result.error, truncated].filter(Boolean).join("; ")
    lines.push(
      `| ${entry.rank} | \`${entry.id}\` | ${result.latencyMs} | ${result.inputTokens + result.outputTokens} | ${result.costUSD.toFixed(5)} | ${grade.passed}/7 | ${status} | ${detail} |`,
    )
  }

  const measured = orderMeasured(results)
  lines.push("")
  lines.push("## Predicted vs measured")
  lines.push("")
  lines.push("| Predicted rank | Measured rank | Model |")
  lines.push("| --: | --: | :-- |")
  for (const { entry, status } of results) {
    const measuredRank = status === "SKIP" ? "—" : String(measured.findIndex((m) => m.entry.id === entry.id) + 1)
    lines.push(`| ${entry.rank} | ${measuredRank} | \`${entry.id}\` |`)
  }
  lines.push("")
  if (results.some((row) => row.status === "SKIP")) {
    lines.push("`—` = skipped because no credentials were stored; that model has no measured rank.")
    lines.push("")
  }
  lines.push("Measured rank: checks first, then latency. Failed calls rank below every answer; skipped calls rank last.")
  lines.push("")
  lines.push("Feed the measured ranks back into `model-scores.json` (or `router.config.json` -> `scores`) to tune accuracy.")

  writeTextAtomic(reportPath, lines.join("\n") + "\n")
  if (opts.json) process.stdout.write(JSON.stringify({ role: ROLE, results }, null, 2) + "\n")
  else process.stdout.write(`Wrote ${reportPath}\n`)
  return 0
}
