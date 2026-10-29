import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { installCommands } from "../src/install.js"
import { SLASH_COMMANDS } from "../src/commands.js"
import { makeProject } from "./helpers.js"

describe("installCommands", () => {
  it("keeps an existing router.config.json", () => {
    const dir = makeProject()
    const file = path.join(dir, ".opencode", "router.config.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const original = JSON.stringify({ plan: "free", denyModels: ["x"] })
    fs.writeFileSync(file, original, "utf8")

    installCommands("project", dir)

    expect(fs.readFileSync(file, "utf8")).toBe(original)
  })

  it("writes no home folder path into the starter config", () => {
    const result = installCommands("project", makeProject())
    const parsed = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as Record<string, unknown>
    const withHome = Object.values(parsed).filter((v) => typeof v === "string" && v.includes(os.homedir()))
    expect(withHome).toEqual([])
  })

  it("prepares the commands folder the plugin registers into", () => {
    const dir = makeProject()
    const result = installCommands("project", dir)
    expect(fs.existsSync(result.commandDir)).toBe(true)
    expect(result.files).toEqual([])
    for (const command of SLASH_COMMANDS) {
      expect(fs.existsSync(path.join(result.commandDir, `${command.name}.md`))).toBe(false)
    }
  })
})
