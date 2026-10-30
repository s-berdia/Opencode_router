import fs from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { main } from "../src/cli.js"
import { LedgerStore } from "../src/ledger.js"
import { captureOutput, globalOpencodeDir, makeProject, readJsonFile, writeCatalog } from "./helpers.js"

let project = ""

beforeEach(() => {
  writeCatalog()
  project = makeProject()
  process.chdir(project)
})

function run(...argv: string[]) {
  return captureOutput(() => main(argv, project))
}

function writeProjectConfig(value: unknown): void {
  const file = path.join(project, ".opencode", "router.config.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), "utf8")
}

describe("cli refresh", () => {
  it("reads the project router.config.json", async () => {
    writeProjectConfig({ plan: "free" })
    const { stdout } = await run("refresh", "--dry-run", "--json")
    expect(JSON.parse(stdout).table.plan).toBe("free")
  })

  it("explains the shared Go allowance and the free fallback on a Go plan only", async () => {
    const { stdout: go } = await run("refresh", "--dry-run", "--plan", "go")
    const { stdout: free } = await run("refresh", "--dry-run", "--plan", "free")
    expect(go).toContain("All `go` models share one usage allowance")
    expect(free).not.toContain("usage allowance")
  })

  it("rejects an unknown plan", async () => {
    const { result, stderr } = await run("refresh", "--plan", "gold", "--dry-run")
    expect(result).toBe(2)
    expect(stderr).toMatch(/go \| go-plus \| go-teams \| free/)
  })

  it("prints help for --help and writes nothing", async () => {
    const { result, stdout } = await run("refresh", "--help")
    expect(result).toBe(0)
    expect(stdout).toMatch(/Usage:/)
    expect(fs.existsSync(path.join(project, "opencode.json"))).toBe(false)
  })
})

describe("cli status", () => {
  function ledger(): LedgerStore {
    return new LedgerStore(path.join(globalOpencodeDir(), "router", "ledger.json"))
  }

  it("reads the shared Go allowance from the ledger that the plugin writes", async () => {
    ledger().record("opencode-go/glm-5.3-flash", 6, 1000, 0.1)

    const { stdout } = await run("status", "--json")

    expect(JSON.parse(stdout).allowance.pct5h).toBeCloseTo(0.5, 5)
  })

  it("shows the allowance use and the free fallback", async () => {
    // 90% of the 5-hour allowance.
    ledger().record("opencode-go/glm-5.3-flash", 10.8, 1000, 0.18)

    const { stdout } = await run("status", "--scope", "global")

    expect(stdout).toContain("Go allowance used (estimate): rolling 5h 90%, weekly 36%, monthly 18%")
    expect(stdout).toMatch(/\| build \| `opencode\/[^`]+-free` \| \d \| free-fallback \|/)
  })

  it("shows an allowance cooldown", async () => {
    ledger().cooldownAllowance(60 * 60 * 1000, "Go usage limit")

    const { stdout } = await run("status", "--scope", "global")

    expect(stdout).toMatch(/Go allowance cooldown until \d\d:\d\d UTC \(Go usage limit\)/)
  })

  it("shows no allowance line on the free plan", async () => {
    const { stdout } = await run("status", "--plan", "free", "--scope", "global")
    expect(stdout).not.toContain("Go allowance")
  })
})

describe("cli plan", () => {
  it("saves the plan and prints the rebuilt scorecard", async () => {
    const { result, stdout } = await run("plan", "free", "--scope", "global")
    expect(result).toBe(0)
    expect(readJsonFile(path.join(globalOpencodeDir(), "router.config.json")).plan).toBe("free")
    expect(stdout).toMatch(/Plan: \*\*free\*\*/)
  })

  it("warns when the project file overrides the global plan", async () => {
    writeProjectConfig({ plan: "go" })
    const { stdout, stderr } = await run("plan", "free", "--scope", "global")
    expect(stdout + stderr).toMatch(/overrides/)
  })
})

describe("cli eval", () => {
  it("writes the report to the router state folder, not the current folder", async () => {
    const { result } = await run("eval")
    expect(result).toBe(0)
    expect(fs.existsSync(path.join(globalOpencodeDir(), "router", "eval-report.md"))).toBe(true)
    expect(fs.existsSync(path.join(project, "evals"))).toBe(false)
  })
})
