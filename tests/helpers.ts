import fs from "node:fs"
import path from "node:path"
import { vi } from "vitest"
import RouterPlugin from "../src/index.js"
import type { HealthMap } from "../src/status.js"
import type { CatalogModel } from "../src/types.js"

export function model(partial: Partial<CatalogModel> & { providerID: string; modelID: string }): CatalogModel {
  const { providerID, modelID } = partial
  return {
    providerID,
    modelID,
    id: `${providerID}/${modelID}`,
    name: partial.name ?? modelID,
    family: partial.family,
    canonicalModelID: partial.canonicalModelID,
    reasoning: partial.reasoning ?? true,
    toolCall: partial.toolCall ?? true,
    attachment: partial.attachment ?? false,
    openWeights: partial.openWeights ?? true,
    limit: partial.limit ?? { context: 200000, output: 32000 },
    cost: partial.cost ?? { input: 0.1, output: 0.5, cacheRead: 0 },
    tiers: partial.tiers ?? [],
    inputModalities: partial.inputModalities ?? ["text"],
    free: partial.free ?? false,
  }
}

export const sampleCatalog: CatalogModel[] = [
  model({
    providerID: "opencode-go",
    modelID: "smart-big",
    family: "smart",
    limit: { context: 1000000, output: 128000 },
    cost: { input: 4, output: 20, cacheRead: 0 },
  }),
  model({
    providerID: "opencode-go",
    modelID: "workhorse",
    family: "wh",
    limit: { context: 1000000, output: 384000 },
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
  }),
  model({
    providerID: "opencode",
    modelID: "free-fast",
    family: "ff",
    cost: { input: 0, output: 0, cacheRead: 0 },
    free: true,
  }),
  model({
    providerID: "opencode",
    modelID: "zen-paid",
    family: "zp",
    cost: { input: 2, output: 6, cacheRead: 0.25 },
  }),
  model({
    providerID: "opencode-go",
    modelID: "no-tool",
    family: "nt",
    toolCall: false,
  }),
  model({
    providerID: "opencode-go",
    modelID: "tiny-context",
    family: "tc",
    limit: { context: 8000, output: 2000 },
  }),
]

interface RawSpec {
  family: string
  cost: [input: number, output: number]
  context?: number
}

/** Real model ids from model-scores.json, so every role gets an eligible chain. */
const RAW_MODELS: Record<string, Record<string, RawSpec>> = {
  "opencode-go": {
    "glm-5.3-flash": { family: "glm-flash", cost: [0.3, 1.2], context: 1000000 },
    "deepseek-v4.1-flash": { family: "deepseek-flash", cost: [0.2, 0.8], context: 1000000 },
    "kimi-k3": { family: "kimi", cost: [2, 8], context: 256000 },
    "qwen3.8-flash": { family: "qwen-flash", cost: [0.4, 1.6], context: 256000 },
    // Same model as opencode/beam-free: the router must keep one entry only.
    "beam-free": { family: "beam", cost: [0, 0], context: 262144 },
  },
  opencode: {
    "nemotron-3.5-lightning-free": { family: "nemotron", cost: [0, 0], context: 1000000 },
    "beam-free": { family: "beam", cost: [0, 0], context: 262144 },
  },
}

function rawCatalog(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [providerID, models] of Object.entries(RAW_MODELS)) {
    const rawModels: Record<string, unknown> = {}
    for (const [id, spec] of Object.entries(models)) {
      rawModels[id] = {
        id,
        name: id,
        family: spec.family,
        reasoning: true,
        tool_call: true,
        attachment: false,
        open_weights: true,
        limit: { context: spec.context ?? 200000, output: 64000 },
        cost: { input: spec.cost[0], output: spec.cost[1], cache_read: 0 },
        modalities: { input: ["text"], output: ["text"] },
      }
    }
    out[providerID] = { id: providerID, name: providerID, models: rawModels }
  }
  return out
}

/** Write the fixture catalog where OpenCode keeps it (XDG_CACHE_HOME is a temp dir in tests). */
export function writeCatalog(): string {
  const file = path.join(process.env.XDG_CACHE_HOME!, "opencode", "models.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(rawCatalog()), "utf8")
  return file
}

/** The fixture catalog as mapped models, for tests that call the engine directly. */
/**
 * An empty health map: no model is measured, so every one keeps the neutral
 * prior. Tests pass this so a ranking never waits on the live status page.
 */
export function emptyHealth(): HealthMap {
  return new Map()
}

export function routedCatalog(): CatalogModel[] {
  const out: CatalogModel[] = []
  for (const [providerID, models] of Object.entries(RAW_MODELS)) {
    for (const [modelID, spec] of Object.entries(models)) {
      out.push(
        model({
          providerID,
          modelID,
          family: spec.family,
          limit: { context: spec.context ?? 200000, output: 64000 },
          cost: { input: spec.cost[0], output: spec.cost[1], cacheRead: 0 },
          free: spec.cost[0] === 0 && spec.cost[1] === 0,
        }),
      )
    }
  }
  return out
}

/** A temp folder that looks like a project (has a .git marker). */
export function makeProject(): string {
  const dir = path.join(process.env.XDG_CONFIG_HOME!, "..", "project")
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
  return path.resolve(dir)
}

export function globalOpencodeDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME!, "opencode")
}

export function readJsonFile<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T
}

/** Agent/editor shapes the plugin's transform editors work on in tests. */
type AnyRecord = Record<string, unknown>

export interface StubRouter {
  /** The stub v2 plugin context (cast when passed to setup). */
  ctx: AnyRecord
  directory: string
  /** Registered transform/editor state: agent definitions by id. */
  agents: Map<string, AnyRecord>
  /** Registered commands of the command editor, by name. */
  commands: Map<string, { name: string; description?: string; execute: (input: unknown) => Promise<void> }>
  /** The registered prompt hook (the plugin's `chat.message` port). */
  promptHook: ((event: unknown) => Promise<void>) | undefined
  /** Sessions the plugin itself switched (`sessionID` -> `providerID/id`). */
  switched: Array<{ sessionID: string; model: string }>
  /** Synthetic messages the plugin posted (command output). */
  synthetic: Array<{ sessionID: string; text: string }>
  /** Session info the stub `ctx.session.get` returns from. */
  sessions: Map<string, { agent?: string; model?: unknown }>
  queued: Array<{ type: string; data?: unknown }>
  /** Deliver one event to the plugin's subscriber. */
  emit: (type: string, data?: unknown) => void
  /** Replay the agent transforms (what `ctx.agent.reload()` does in OpenCode). */
  agentReload: () => Promise<void>
  dispose: () => Promise<void> | void
}

/** The default v2 agent list the router changes (build chain heads + internal helpers). */
function defaultAgents(): Map<string, AnyRecord> {
  const entries: Array<[string, AnyRecord]> = [
    ["plan", { id: "plan" }],
    ["build", { id: "build" }],
    ["general", { id: "general" }],
    ["explore", { id: "explore" }],
    ["compaction", { id: "compaction" }],
    ["title", { id: "title" }],
    ["summary", { id: "summary" }],
  ]
  return new Map(entries)
}

function modelDefaultOf(map: Map<string, AnyRecord>): unknown {
  const value = map.get("__default__")
  return value?.model
}

/** Build the v2 plugin context the router registers against, and run setup. */
export async function setupRouter(dir: string, agents = defaultAgents()): Promise<StubRouter> {
  const agentEdits: Array<(editor: unknown) => void> = []
  const modelEdits: Array<(editor: unknown) => void> = []
  const router: StubRouter = {
    ctx: {},
    directory: dir,
    agents,
    commands: new Map(),
    promptHook: undefined,
    switched: [],
    synthetic: [],
    sessions: new Map(),
    queued: [],
    emit: (type, data) => {
      router.queued.push({ type, data })
    },
    agentReload: async () => {
      for (const callback of agentEdits) {
        callback({
          list: () => [...agents.values()],
          get: (id: string) => agents.get(id),
          default: (_id: string) => undefined,
          update: (id: string, update: (agent: AnyRecord) => void) => {
            update(hydrate(agents, id))
          },
          remove: (id: string) => agents.delete(id),
        })
      }
    },
    dispose: () => undefined,
  }

  const subscriber = {
    next: async (): Promise<IteratorResult<unknown>> => {
      while (router.queued.length === 0) {
        if (aborted) return { value: undefined, done: true }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      const event = router.queued.shift()
      return { value: event, done: false }
    },
    [Symbol.asyncIterator]() {
      return subscriber
    },
  } as AsyncIterableIterator<unknown>
  let aborted = false

  function hydrate(map: Map<string, AnyRecord>, id: string): AnyRecord {
    let entry = map.get(id)
    if (!entry) {
      entry = { id }
      map.set(id, entry)
    }
    return entry
  }

  router.ctx = {
    app: { name: "opencode", version: "2.2.0", channel: "latest" },
    location: { directory: dir },
    options: {},
    agent: {
      transform: async (callback: (editor: unknown) => void) => {
        agentEdits.push(callback)
        await router.agentReload()
        return { dispose: async () => undefined }
      },
      reload: () => router.agentReload(),
      list: async () => [...agents.values()],
    },
    model: {
      transform: async (callback: (editor: unknown) => void) => {
        modelEdits.push(callback)
        callback({
          list: () => [],
          get: () => undefined,
          update: () => undefined,
          remove: () => undefined,
          default: {
            get: () => modelDefaultOf(agents),
            set: (providerID: string, id: string) => {
              agents.set("__default__", { model: `${providerID}/${id}` })
            },
          },
          provider: { list: () => [], get: () => undefined },
        })
        return { dispose: async () => undefined }
      },
      reload: async () => undefined,
      default: async () => modelDefaultOf(agents),
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (definition: { name: string; description?: string; execute: (input: unknown) => Promise<void> }) => {
            router.commands.set(definition.name, definition)
          },
        })
        return { dispose: async () => undefined }
      },
      reload: async () => undefined,
      list: async () => [...router.commands.keys()],
    },
    session: {
      hook: async (name: string, callback: (event: unknown) => Promise<void>) => {
        if (name === "prompt") router.promptHook = callback
        return { dispose: async () => undefined }
      },
      get: async (input: { sessionID: string }) => router.sessions.get(input.sessionID),
      switchModel: async (input: { sessionID: string; model: { id: string; providerID: string } }) => {
        router.switched.push({ sessionID: input.sessionID, model: `${input.model.providerID}/${input.model.id}` })
        const info = router.sessions.get(input.sessionID) ?? {}
        info.model = { id: input.model.id, providerID: input.model.providerID }
        router.sessions.set(input.sessionID, info)
      },
      synthetic: async (input: { sessionID: string; text: string }) => {
        router.synthetic.push(input)
      },
    },
    event: {
      subscribe: (options: { signal?: AbortSignal }) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            aborted = true
          })
        }
        return subscriber
      },
    },
  }

  const cleanup = await RouterPlugin.setup(router.ctx as never)
  router.dispose = cleanup as () => Promise<void> | void
  return router
}


/** Make the npm registry report `version` as the newest version. Returns the requested URLs. */
export function stubRegistry(version: string): string[] {
  const calls: string[] = []
  vi.stubGlobal("fetch", async (url: string | URL) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ name: "@s-berdia/opencode-router", version }), { status: 200 })
  })
  return calls
}

export interface CachedCopyOptions {
  layout?: "packages" | "npm"
  generation?: string
}

/** A copy of the package in the OpenCode plugin cache, in the folder for `spec`. */
export function cachedCopy(spec: string, version = "1.0.0", opts: CachedCopyOptions = {}): string {
  const layout = opts.layout ?? "packages"
  const dir = path.join(process.env.XDG_CACHE_HOME!, "opencode", layout, "@s-berdia", spec)
  const root = layout === "npm" ? path.join(dir, opts.generation ?? "1710000000") : dir
  const packageDir = path.join(root, "node_modules", "@s-berdia", "opencode-router")
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@s-berdia/opencode-router", version }))
  return dir
}

/** Capture stdout and stderr writes while `fn` runs. */
export async function captureOutput(fn: () => Promise<unknown>): Promise<{ stdout: string; stderr: string; result: unknown }> {
  let stdout = ""
  let stderr = ""
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const result = await fn()
    return { stdout, stderr, result }
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
}
