import fs from "node:fs"
import path from "node:path"
import { vi } from "vitest"
import type { CatalogModel } from "../src/types.js"

export function model(partial: Partial<CatalogModel> & { providerID: string; modelID: string }): CatalogModel {
  const { providerID, modelID } = partial
  return {
    providerID,
    modelID,
    id: `${providerID}/${modelID}`,
    name: partial.name ?? modelID,
    family: partial.family,
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

/** Minimal PluginInput for the plugin factory; `updates` and `toasts` collect client calls. */
export function stubInput(dir: string, updates: unknown[] = [], toasts: unknown[] = []) {
  return {
    client: {
      config: {
        update: async (arg: unknown) => {
          updates.push(arg)
          return { data: {} }
        },
      },
      tui: {
        showToast: async (arg: unknown) => {
          toasts.push(arg)
          return { data: true }
        },
      },
    },
    project: { id: "p", worktree: dir, time: { created: 0 } },
    directory: dir,
    worktree: dir,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:0"),
    $: (async () => ({})) as unknown,
  } as never
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
