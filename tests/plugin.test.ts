import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { globalOpencodeDir, makeProject, readJsonFile, setupRouter, writeCatalog, type StubRouter } from "./helpers.js"

interface LedgerFile {
  models: Record<string, { cooldownUntil?: number }>
  allowance?: { buckets: Array<[number, number]>; cooldownUntil?: number }
}

function ledgerFile(): string {
  return path.join(globalOpencodeDir(), "router", "ledger.json")
}

/** Send one prompt through the registered prompt hook, as OpenCode would. */
async function prompt(router: StubRouter, sessionID: string, agent = "build"): Promise<void> {
  const info = router.sessions.get(sessionID) ?? {}
  if (!("agent" in info)) info.agent = agent
  router.sessions.set(sessionID, info)
  await router.promptHook!({ sessionID, messageID: "m1", prompt: {}, metadata: {}, delivery: "steer" })
}

/** Let the plugin's event pump run what the test has queued. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/** Make `ctx.session.get` report the given model for the session. */
function setModel(router: StubRouter, sessionID: string, model: { providerID: string; id: string; variant?: string }) {
  const info = router.sessions.get(sessionID) ?? {}
  info.model = model
  router.sessions.set(sessionID, info)
}

describe("plugin agent and command transforms", () => {
  it("sets the routing model on every agent and the default model", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    const build = router.agents.get("build") as { model?: { providerID: string; id: string } }
    const title = router.agents.get("title") as { model?: { providerID: string; id: string } }
    expect(build.model).toBeDefined()
    expect(title.model).toBeDefined()
    expect(router.agents.get("__default__")?.model).toBe("opencode-go/deepseek-v4.1-flash")
  })

  it("keeps the user's other agent settings", async () => {
    writeCatalog()
    const agents = new Map<string, Record<string, unknown>>([
      ["build", { id: "build", prompt: "Be brief.", model: { providerID: "old", id: "model" } }],
    ])
    const router = await setupRouter(makeProject(), agents)
    const build = router.agents.get("build") as { prompt?: string; model?: unknown }
    expect(build.prompt).toBe("Be brief.")
    const model = build.model as { providerID: string }
    expect(model.providerID).toBe("opencode-go")
  })

  it("registers the slash commands that run the CLI", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    for (const name of ["refresh-routing", "routing-status", "routing-plan", "routing-eval", "routing-update"]) {
      expect(router.commands.has(name)).toBe(true)
    }
    const status = router.commands.get("routing-status")!
    expect(status.description).toMatch(/model in use/)
  })
})

describe("plugin commands", () => {
  it("applies the plan given to /routing-plan", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    setModel(router, "s1", { providerID: "opencode-go", id: "glm-5.3-flash" })

    await router.commands.get("routing-plan")!.execute({ sessionID: "s1", prompt: { text: "go-plus" }, delivery: "queue" })

    expect(router.synthetic[0]!.text).toMatch(/go-plus/i)
    const saved = readJsonFile<{ plan: string }>(path.join(globalOpencodeDir(), "router", "routing-table.json"))
    expect(saved.plan).toBe("go-plus")
  })

  it("posts the status output without a model turn", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    await router.commands.get("routing-status")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "queue" })
    expect(router.synthetic).toHaveLength(1)
    expect(router.synthetic[0]!.text).toContain("opencode-router status")
  })
})

describe("plugin failover", () => {
  it("switches a freshly created session onto the router's model", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    router.sessions.set("s1", { agent: "build" })

    await prompt(router, "s1")

    expect(router.switched).toEqual([{ sessionID: "s1", model: "opencode-go/deepseek-v4.1-flash" }])
  })

  it("keeps a session that already runs the router's model", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    setModel(router, "s1", { providerID: "opencode-go", id: "deepseek-v4.1-flash" })

    await prompt(router, "s1")

    expect(router.switched).toEqual([])
  })

  it("cools down only the model of the session that hit a rate limit", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    await prompt(router, "s1")
    const used = router.switched[0]!.model

    router.emit("session.execution.failed", {
      sessionID: "s1",
      error: { type: "APIError", message: "rate limit", status: 429 },
    })
    await drain()

    const ledger = readJsonFile<LedgerFile>(ledgerFile())
    const cooled = Object.entries(ledger.models)
      .filter(([, state]) => state.cooldownUntil)
      .map(([id]) => id)
    expect(cooled).toEqual([used])
  })

  it("adds the allowance share of a subscription model to the ledger", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    await prompt(router, "s1")
    const used = router.switched[0]!.model

    // glm-5.3-flash has a monthly limit of $60 on Go, so $6 is 10% of the allowance.
    router.emit("session.step.ended", {
      sessionID: "s1",
      assistantMessageID: "m1",
      finish: "stop",
      cost: 6,
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await drain()

    const ledger = readJsonFile<LedgerFile>(ledgerFile())
    expect(ledger.models[used]).toBeTruthy()
    expect(ledger.allowance?.buckets[0]?.[1]).toBeGreaterThan(0)
  })

  it("moves the session to its free model after a usage-limit error", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    await prompt(router, "s1")
    expect(router.switched[0]!.model).toBe("opencode-go/deepseek-v4.1-flash")

    router.emit("session.execution.failed", {
      sessionID: "s1",
      error: { type: "APIError", status: 429, message: "Usage limit reached" },
    })
    await drain()

    await prompt(router, "s1")
    expect(router.switched.at(-1)!.model).toMatch(/-free$/)
    expect(readJsonFile<LedgerFile>(ledgerFile()).allowance?.cooldownUntil).toBeGreaterThan(Date.now())
  })

  it("does not cool down a model after a plain bad-request error", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    await prompt(router, "s1")
    const used = router.switched[0]!.model

    // A completed step records the ledger, then a plain bad request must bench nothing.
    router.emit("session.step.ended", {
      sessionID: "s1",
      assistantMessageID: "m1",
      finish: "stop",
      cost: 0.01,
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await drain()

    setModel(router, "s1", { providerID: "opencode-go", id: "glm-5.3-flash" })
    router.emit("session.model.selected", { sessionID: "s1", model: { providerID: "opencode-go", id: "glm-5.3-flash" } })
    await drain()
    router.emit("session.execution.failed", {
      sessionID: "s1",
      error: { type: "APIError", status: 400, message: "context length exceeded" },
    })
    await drain()

    expect(fs.existsSync(ledgerFile())).toBe(true)
    const ledger = readJsonFile<LedgerFile>(ledgerFile())
    expect(ledger.models["opencode-go/glm-5.3-flash"]?.cooldownUntil).toBeUndefined()
    expect(ledger.models[used]?.cooldownUntil).toBeUndefined()
  })
})

describe("plugin mode", () => {
  it("marks a pick whose session switched models and keeps it", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    router.sessions.set("s1", { agent: "build" })
    // The user picked gpt-6 in the OpenCode UI: the select event marks the session.
    router.emit("session.model.selected", { sessionID: "s1", model: { providerID: "openai", id: "gpt-6" } })
    await drain()
    setModel(router, "s1", { providerID: "openai", id: "gpt-6" })

    await prompt(router, "s1")
    expect(router.switched).toEqual([])

    // The next message of the session keeps the pick.
    await prompt(router, "s1")
    expect(router.switched).toEqual([])

    const hud = readJsonFile<{ manual: Record<string, string>; mode: string }>(
      path.join(globalOpencodeDir(), "router", "hud.json"),
    )
    expect(hud.manual["s1:build"]).toBe("openai/gpt-6")
    expect(hud.mode).toBe("auto")
  })

  it("ignores its own switches and does not mark them as manual", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    router.sessions.set("s1", { agent: "build" })

    await prompt(router, "s1")
    expect(router.switched).toEqual([{ sessionID: "s1", model: "opencode-go/deepseek-v4.1-flash" }])

    // The stub records the switch in the session; the plugin saw its own event.
    router.emit("session.model.selected", {
      sessionID: "s1",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      previous: { providerID: "opencode-go", id: "glm-5.3-flash" },
    })
    await drain()

    const hud = readJsonFile<{ manual: Record<string, string>; last: Record<string, string> }>(
      path.join(globalOpencodeDir(), "router", "hud.json"),
    )
    expect(hud.manual["s1:build"]).toBeUndefined()
    expect(hud.last.s1).toBe("opencode-go/deepseek-v4.1-flash")
  })

  it("resumes the router when the user goes back to the router choice", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    router.sessions.set("s1", { agent: "build" })
    router.emit("session.model.selected", { sessionID: "s1", model: { providerID: "openai", id: "gpt-6" } })
    await drain()
    setModel(router, "s1", { providerID: "openai", id: "gpt-6" })
    await prompt(router, "s1")
    expect(router.switched).toEqual([])

    // The user picks the router's chain head again (tests fixture) in the UI.
    const saved = readJsonFile<{ active: { build: Array<{ id: string }> } }>(
      path.join(globalOpencodeDir(), "router", "routing-table.json"),
    )
    const head = saved.active.build[0]!.id.split("/")
    router.emit("session.model.selected", { sessionID: "s1", model: { providerID: head[0]!, id: head[1]! } })
    await drain()
    setModel(router, "s1", { providerID: head[0]!, id: head[1]! })
    await prompt(router, "s1")

    // The session is already on the router's model, so no switch happened, and
    // the manual flag is gone.
    expect(router.switched).toEqual([])
    const hud = readJsonFile<{ manual: Record<string, string> }>(
      path.join(globalOpencodeDir(), "router", "hud.json"),
    )
    expect(hud.manual["s1:build"]).toBeUndefined()
  })

  it("marks the pick through the model-selected event without a prompt", async () => {
    writeCatalog()
    const router = await setupRouter(makeProject())
    router.sessions.set("s1", { agent: "build" })

    router.emit("session.model.selected", {
      sessionID: "s1",
      model: { providerID: "openai", id: "gpt-6" },
    })
    await drain()

    const hud = readJsonFile<{ manual: Record<string, string> }>(
      path.join(globalOpencodeDir(), "router", "hud.json"),
    )
    expect(hud.manual["s1:build"]).toBe("openai/gpt-6")
  })

  it("never overrides the first message in failover mode, but still fails over after a limit error", async () => {
    writeCatalog()
    const configFile = path.join(globalOpencodeDir(), "router.config.json")
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify({ mode: "failover" }))
    try {
      const router = await setupRouter(makeProject())
      setModel(router, "s1", { providerID: "opencode-go", id: "glm-5.3-flash" })

      // The first message stays on the session's pick.
      await prompt(router, "s1")
      expect(router.switched).toEqual([])

      // Hit the usage limit: the shared allowance cools down and the session moves.
      router.emit("session.execution.failed", {
        sessionID: "s1",
        error: { type: "APIError", status: 429, message: "Usage limit reached" },
      })
      await drain()

      await prompt(router, "s1")
      expect(router.switched.at(-1)!.model).toMatch(/-free$/)
    } finally {
      fs.rmSync(configFile, { force: true })
    }
  })

  it("keeps the user pick untouched in failover mode even near the threshold", async () => {
    writeCatalog()
    const configFile = path.join(globalOpencodeDir(), "router.config.json")
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify({ mode: "failover" }))
    try {
      const router = await setupRouter(makeProject())
      setModel(router, "s1", { providerID: "openai", id: "gpt-6" })
      await prompt(router, "s1")
      expect(router.switched).toEqual([])
    } finally {
      fs.rmSync(configFile, { force: true })
    }
  })

  it("does not override messages in off mode", async () => {
    writeCatalog()
    const configFile = path.join(globalOpencodeDir(), "router.config.json")
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify({ mode: "off" }))
    try {
      const router = await setupRouter(makeProject())
      setModel(router, "s1", { providerID: "openai", id: "gpt-6" })
      await prompt(router, "s1")
      expect(router.switched).toEqual([])
      expect(readJsonFile<{ mode: string }>(path.join(globalOpencodeDir(), "router", "hud.json")).mode).toBe("off")
    } finally {
      fs.rmSync(configFile, { force: true })
    }
  })
})
