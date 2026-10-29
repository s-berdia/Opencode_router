import { execFile } from "node:child_process"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { allowanceShare, buildRoutingTable, healthCheck, pickForRole, usesAllowance, type BuildResult } from "./engine.js"
import { LedgerStore } from "./ledger.js"
import { blendedCost } from "./scoring.js"
import { routingConfigBody } from "./apply.js"
import { cliArgsFor, cliScriptPath, commandArguments, SLASH_COMMANDS } from "./commands.js"
import { writeJson } from "./paths.js"
import type { HudSnapshot } from "./state.js"
import { hudFile, ledgerFile, routingTableFile, writeApplyMarker, readApplyMarker } from "./state.js"
import { isAgentRole, type RankingEntry } from "./types.js"

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000
const AUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000
const MAX_TRACKED_STEPS = 500
// Short TTL: after /refresh-routing (or any change to the catalog or config),
// the running session recomputes the table on its next message without a
// restart. Do not depend on hooks that may not fire.
const TTL_MS = 15_000

/** v2 model reference: `id` is the model name; the router's own ids are `providerID/modelID`. */
type ModelRef = { id: string; providerID: string; variant?: string }

interface StructuredError {
  type?: string
  message?: string
  status?: number
  response?: { body?: string }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorData(error: unknown): { status: number; message: string } {
  if (!error || typeof error !== "object") return { status: 0, message: "" }
  const data = error as StructuredError
  return {
    status: Number(data.status ?? 0),
    message: String(data.message ?? data.response?.body ?? "").toLowerCase(),
  }
}

/** The Go usage allowance is used up. It is shared, so every subscription model is limited. */
function isUsageLimitError(error: unknown): boolean {
  const { status, message } = errorData(error)
  return status === 402 || /usage limit|limit (?:has been |was )?reached|quota|insufficient|exceeded your/.test(message)
}

/** Quota and rate-limit errors only. A plain bad request must not bench a model. */
function isRateLimitError(error: unknown): boolean {
  const { status, message } = errorData(error)
  return status === 429 || isUsageLimitError(error) || /rate.?limit|too many requests|capacity|overloaded/.test(message)
}

function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const data = error as StructuredError
  if (data.status === 401 || data.status === 403) return true
  return /auth|unauthor|credential|api.?key/i.test(String(data.type ?? ""))
}

/** Parse `providerID/modelID` into a v2 Model.Ref. */
function parseModelRef(id: string): ModelRef | undefined {
  const slash = id.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1) }
}

/** The router's own id for a model reference: `providerID/modelID`. */
function modelIdOf(ref: ModelRef | undefined): string | undefined {
  return ref ? `${ref.providerID}/${ref.id}` : undefined
}

/**
 * The JS runtime for the router CLI child process. When the plugin runs inside
 * the OpenCode binary (the desktop app or the 2.x CLI, a compiled Bun
 * executable), `process.execPath` is that binary — it would parse the router's
 * arguments as its own and print its help. Only a real JS runtime qualifies.
 */
function cliRuntime(): string | undefined {
  const base = path.basename(process.execPath).toLowerCase()
  if (/^(node|bun|deno)(\.exe)?$/.test(base)) return process.execPath
  return undefined
}

/** True when `node` is on PATH (spawn resolves it). Cached, one cheap probe. */
let nodeOnPath: boolean | undefined
function hasNodeOnPath(): Promise<boolean> {
  if (nodeOnPath !== undefined) return Promise.resolve(nodeOnPath)
  return new Promise((resolve) => {
    execFile("node", ["-v"], { timeout: 10_000 }, (error) => {
      nodeOnPath = !error
      resolve(nodeOnPath)
    })
  })
}

/** Run the router CLI that ships beside the plugin and return its output.
 * Slash commands run from the workspace the session opened, and they always
 * write the global config, like the v1 command templates did. */
async function runCli(args: string[], dir: string, timeoutMs = 120_000): Promise<string> {
  const candidates = [cliRuntime(), (await hasNodeOnPath()) ? "node" : undefined, process.execPath]
  for (const runtime of candidates) {
    if (!runtime) continue
    const output = await new Promise<string>((resolve) => {
      execFile(
        runtime,
        [cliScriptPath(), ...args, "--scope", "global"],
        { timeout: timeoutMs, cwd: dir },
        (error, stdout, stderr) => {
          const out = stdout?.trim() ?? ""
          if (out.length > 0) resolve(out)
          const killed = Boolean(error && (error as { killed?: boolean }).killed)
          resolve(
            stderr?.trim() ||
              (killed
                ? `the router CLI did not finish within ${Math.round(timeoutMs / 1000)} s; it still runs from a terminal: opencode-router ${args.join(" ")}`
                : error
                  ? errorMessage(error)
                  : "no output"),
          )
        },
      )
    })
    // A runtime that cannot execute the script (e.g. the OpenCode binary
    // prints its own help, or node is missing) only happens with known
    // signatures; anything else is the router CLI's output.
    if (!/OpenCode command line interface|ENOENT/.test(output)) return output
  }
  return "no runtime found to run the router CLI"
}


export const RouterPlugin = Plugin.define({
  id: "opencode-router",
  async setup(ctx) {
    const dir = ctx.location.directory
    const ledger = new LedgerStore(ledgerFile(), () => Date.now())
    /** Deduped assistant step ids, so the ledger counts a step once. */
    const recordedSteps = new Set<string>()
    /** Last tracked model per session: switches and, later, completed steps. */
    const usedBySession = new Map<string, string>()
    /** Sessions where the user picked a model (`sessionID:agent` -> picked model). */
    const manualPicks = new Map<string, string>()
    /** The model the router switched a session to itself: pick events with the same value are our own. */
    const selfSwitch = new Map<string, string>()
    /** The model the router moved away from in failover mode; cleared when the router resumes. */
    const failoverFrom = new Map<string, string>()

    // The routing output for the agent/model transforms; refreshed and reloaded live.
    let agentModels: Record<string, ModelRef> = {}
    let defaultModel: ModelRef | undefined

    let cached: BuildResult | null = null
    let cachedAt = 0
    /** Per-model blended USD cost per 1M tokens, for self-estimating spend. */
    let blendedById = new Map<string, number>()

    /** Publish state for the TUI widget. Best-effort and cheap: one small JSON file. */
    function writeHud(mode?: string): void {
      try {
        const manual: Record<string, string> = {}
        for (const [key, model] of manualPicks) manual[key] = model
        const last: Record<string, string> = {}
        for (const [key, model] of usedBySession) last[key] = model
        const snapshot: HudSnapshot = {
          version: 1,
          updatedAt: new Date().toISOString(),
          mode: mode ?? cached?.cfg.mode ?? "auto",
          manual,
          last,
        }
        writeJson(hudFile(), snapshot)
      } catch {
        /* state is best-effort */
      }
    }

    function rememberStep(id: string): void {
      recordedSteps.add(id)
      if (recordedSteps.size > MAX_TRACKED_STEPS) {
        const oldest = recordedSteps.values().next().value
        if (oldest !== undefined) recordedSteps.delete(oldest)
      }
    }

    async function ensure(force = false): Promise<BuildResult> {
      const now = Date.now()
      if (!force && cached && now - cachedAt < TTL_MS) return cached
      const result = await buildRoutingTable({ projectDir: dir })
      cached = result
      cachedAt = now
      blendedById = new Map(result.catalog.map((m) => [m.id, blendedCost(m, result.cfg)]))
      try {
        writeJson(routingTableFile(), result.table)
      } catch {
        /* state is best-effort */
      }
      return result
    }

    /** A usage-limit error on a subscription model limits the shared allowance; other limits bench one model. */
    async function coolDown(modelId: string, error: unknown, reason: string): Promise<void> {
      if (isUsageLimitError(error) && usesAllowance(await ensure(), modelId)) {
        ledger.cooldownAllowance(RATE_LIMIT_COOLDOWN_MS, "Go usage limit")
      } else if (isRateLimitError(error)) {
        ledger.cooldown(modelId, RATE_LIMIT_COOLDOWN_MS, reason)
      }
    }

    /** True when the model can still run despite cooldowns or the allowance window. */
    function usableForFailover(result: BuildResult, modelId: string | undefined): boolean {
      if (!modelId) return false
      if (ledger.inCooldown(modelId)) return false
      if (ledger.allowance().cooldownUntil !== null && usesAllowance(result, modelId)) return false
      return true
    }

    /** The model the session last used, or its current model when the plugin was not there for the switch. */
    async function usedModelOf(sessionID: string): Promise<string | undefined> {
      const tracked = usedBySession.get(sessionID)
      if (tracked) return tracked
      const info = await ctx.session.get({ sessionID }).catch(() => undefined)
      return modelIdOf(refOf(info?.model))
    }

    /**
     * Copy the current routing table into the captured agent map and default
     * model, replay the agent/model transforms, and mark the hot apply. The
     * apply marker is written only after the reloads it describes: on failure
     * it says the table applies on the next message instead.
     */
    async function applyRouting(): Promise<void> {
      const result = await ensure(true)
      const body = routingConfigBody(result.table)
      agentModels = {}
      for (const [agent, spec] of Object.entries(body.agent)) {
        const ref = parseModelRef(spec.model)
        if (!ref) continue
        agentModels[agent] = spec.variant && spec.variant !== "none" ? { ...ref, variant: spec.variant } : ref
      }
      defaultModel = body.model ? parseModelRef(body.model) : undefined
      let ok = true
      let detail = "applied to the running session (agent and model transforms reloaded)"
      try {
        await ctx.agent.reload()
      } catch {
        ok = false
        detail = "agent transform reload failed; the table applies on the next message"
      }
      try {
        await ctx.model.reload()
      } catch {
        /* Some hosts reload agents only; the default model picks up on the next session. */
      }
      try {
        writeApplyMarker({ ok, detail })
      } catch {
        /* state is best-effort */
      }
      writeHud(result.cfg.mode)
    }

    /** Accept a Model.Ref object or a `providerID/modelID` string. */
    function refOf(value: unknown): ModelRef | undefined {
      if (typeof value === "string") return parseModelRef(value)
      if (!value || typeof value !== "object") return undefined
      const data = value as { id?: unknown; providerID?: unknown }
      if (typeof data.id !== "string" || typeof data.providerID !== "string") return undefined
      return { id: data.id, providerID: data.providerID }
    }

    const mode = () => cached?.cfg.mode ?? "auto"

    await applyRouting()

    // Transform editors replay the captured routing output; the transforms must
    // stay cheap and synchronous, so they read local state only.
    await ctx.agent.transform((editor) => {
      for (const agent of editor.list()) {
        const model = agentModels[agent.id]
        if (!model) continue
        editor.update(agent.id, (draft) => {
          draft.model = { id: model.id as never, providerID: model.providerID as never, variant: model.variant as never }
        })
      }
    })

    if (defaultModel) {
      // The editor's default set applies at replay; refreshes mutate the
      // captured value and call reload().
      await ctx.model.transform((editor) => {
        if (defaultModel) editor.default.set(defaultModel.providerID, defaultModel.id)
      })
    }

    await ctx.command.transform((editor) => {
      for (const command of SLASH_COMMANDS) {
        editor.add({
          name: command.name,
          description: command.description,
          async execute(invocation) {
            const typed = commandArguments(invocation.prompt.text ?? "")
            // /routing-eval makes live model calls (up to four, tens of seconds
            // each), so it gets four times the standard child-process budget.
            const evalTimeout = command.name === "routing-eval" ? 240_000 : undefined
            const output = await runCli(cliArgsFor(command.name, typed), dir, evalTimeout)
            if (command.name === "refresh-routing" || command.name === "routing-plan") {
              manualPicks.clear()
              failoverFrom.clear()
              selfSwitch.clear()
              await applyRouting()
            }
            // With applyRouting done, the detail is the truth about this run:
            // what actually reloaded, or "applies on the next message".
            let lines = output
            if (command.name === "refresh-routing" || command.name === "routing-plan") {
              const fresh = readApplyMarker()
              if (fresh) lines = output.replace(/^Applied: .*$/m, `Applied: ... | ${fresh.detail}`)
            }
            try {
              await ctx.session.synthetic({ sessionID: invocation.sessionID, text: lines })
            } catch {
              /* showing the output is best-effort */
            }
          },
        })
      }
    })

    await ctx.session.hook("prompt", async (event) => {
      try {
        const sessionID = event.sessionID
        const info = await ctx.session.get({ sessionID }).catch(() => undefined)
        const agent = info?.agent ?? "build"
        if (!isAgentRole(agent)) return
        const result = await ensure()
        const picked = refOf(info?.model)
        const pickedId = modelIdOf(picked)
        const key = `${sessionID}:${agent}`
        const head = agentModels[agent]
        const headId = modelIdOf(head)

        if (mode() === "off") {
          // The model the session selected runs. Still track it, so an error cools it down.
          if (pickedId) usedBySession.set(sessionID, pickedId)
          writeHud(mode())
          return
        }

        if (manualPicks.has(key)) {
          if (pickedId && headId && pickedId === headId) {
            // The user went back to the router's own choice; the router resumes.
            manualPicks.delete(key)
            usedBySession.delete(sessionID)
            failoverFrom.delete(sessionID)
          } else {
            // The pick runs; still track it for the error cooldown and the HUD.
            if (pickedId) usedBySession.set(sessionID, pickedId)
            writeHud(mode())
            return
          }
        }

        const allowanceCooldown = ledger.allowance().cooldownUntil !== null
        let target: ModelRef | undefined

        if (mode() === "failover") {
          // The router never picks proactively; it only moves on cooldowns and back.
          if (usableForFailover(result, pickedId)) {
            const from = failoverFrom.get(sessionID)
            const backModel = from ? (from === headId ? undefined : head) : undefined
            if (from && backModel && !ledger.inCooldown(modelIdOf(backModel)!) && modelIdOf(backModel) !== pickedId) {
              target = backModel
              failoverFrom.delete(sessionID)
            } else {
              if (pickedId) usedBySession.set(sessionID, pickedId)
              failoverFrom.delete(sessionID)
              writeHud(mode())
              return
            }
          } else {
            const usable = (entry: RankingEntry) => {
              if (ledger.inCooldown(entry.id)) return false
              if (allowanceCooldown && usesAllowance(result, entry.id)) return false
              return true
            }
            const entry = pickForRole(result.table, agent, usable)
            if (!entry) return
            if (pickedId && pickedId !== entry.id) failoverFrom.set(sessionID, pickedId)
            target = { providerID: entry.providerID, id: entry.modelID }
          }
        } else {
          // Auto mode: the router applies the best usable model of the role. A
          // pick the user made through the OpenCode UI arrives as a
          // `session.model.selected` event and is honored there, not here.
          const entry = pickForRole(result.table, agent, healthCheck(result, ledger))
          if (!entry) return
          target = { providerID: entry.providerID, id: entry.modelID }
        }

        if (target && modelIdOf(target) !== pickedId) {
          const targetId = modelIdOf(target)!
          selfSwitch.set(sessionID, targetId)
          try {
            await ctx.session.switchModel({ sessionID, model: { providerID: target.providerID, id: target.id } })
          } catch {
            selfSwitch.delete(sessionID)
            return
          }
          usedBySession.set(sessionID, targetId)
        } else if (pickedId) {
          usedBySession.set(sessionID, pickedId)
        }
        writeHud(mode())
      } catch {
        /* never break a prompt */
      }
    })

    const abort = new AbortController()
    const pump = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.model.selected", "session.step.ended", "session.execution.failed"],
          signal: abort.signal,
        })) {
          try {
            await onEvent(event.type, (event as { data?: unknown }).data)
          } catch {
            /* events are best-effort */
          }
        }
      } catch {
        /* the event stream ended */
      }
    })()

    async function onEvent(type: string, raw: unknown): Promise<void> {
      const data = (raw ?? {}) as Record<string, unknown>
      if (type === "session.model.selected") {
        const sessionID = data.sessionID
        const picked = refOf(data.model)
        if (typeof sessionID !== "string" || !picked) return
        const pickedId = modelIdOf(picked)!
        const ours = selfSwitch.get(sessionID)
        if (ours === pickedId) {
          // Our own switch: the prompt hook already tracked the model.
          selfSwitch.delete(sessionID)
          return
        }
        const info = await ctx.session.get({ sessionID }).catch(() => undefined)
        const agent = info?.agent ?? "build"
        if (!isAgentRole(agent)) return
        const key = `${sessionID}:${agent}`
        await ensure()
        if (pickedId === modelIdOf(agentModels[agent])) manualPicks.delete(key)
        else manualPicks.set(key, pickedId)
        usedBySession.set(sessionID, pickedId)
        writeHud(mode())
        return
      }

      if (type === "session.step.ended") {
        const stepID = data.assistantMessageID
        if (typeof stepID !== "string" || recordedSteps.has(stepID)) return
        rememberStep(stepID)
        const sessionID = data.sessionID
        if (typeof sessionID !== "string") return
        const tokens = data.tokens as
          | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
          | undefined
        const used =
          usedBySession.get(sessionID) ??
          modelIdOf(refOf((await ctx.session.get({ sessionID }).catch(() => undefined))?.model))
        if (!used) return
        const result = await ensure()
        const count = (n?: number) => Number(n ?? 0)
        const total =
          count(tokens?.input) + count(tokens?.output) + count(tokens?.reasoning) +
          count(tokens?.cache?.read) + count(tokens?.cache?.write)
        // Subscription turns may report $0. Estimate from the catalog so the
        // rolling ledger stays meaningful and failover still triggers.
        let cost = Number(data.cost ?? 0)
        if (cost === 0 && total > 0) {
          const blended = blendedById.get(used) ?? 0
          if (blended > 0) cost = (total / 1_000_000) * blended
        }
        ledger.record(used, cost, total, allowanceShare(result, used, cost))
        writeHud(mode())
        return
      }

      if (type === "session.execution.failed") {
        const sessionID = data.sessionID
        if (typeof sessionID !== "string") return
        const used = await usedModelOf(sessionID)
        if (!used) return
        const error = data.error ?? {}
        if (isAuthError(error)) ledger.cooldown(used, AUTH_COOLDOWN_MS, "auth error")
        else await coolDown(used, error, "rate limit / quota")
        writeHud(mode())
      }
    }

    return () => {
      abort.abort()
      void pump
    }
  },
})

export default RouterPlugin
