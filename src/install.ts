import fs from "node:fs"
import path from "node:path"
import type { ConfigScope } from "./types.js"
import { SLASH_COMMANDS } from "./commands.js"
import { ensureDir, fileExists, globalConfigDir, writeJson } from "./paths.js"

export interface InstallResult {
  commandDir: string
  configPath: string
  /** False when a router.config.json already existed; it is never replaced. */
  configCreated: boolean
  files: string[]
}

/**
 * Prepare a location for the router: an empty `commands/` directory (the plugin
 * registers the router slash commands itself) plus an empty router.config.json
 * when there is none.
 */
export function installCommands(scope: ConfigScope, dir: string): InstallResult {
  const base = scope === "global" ? globalConfigDir() : path.join(dir, ".opencode")
  const commandDir = path.join(base, "commands")
  ensureDir(commandDir)

  const files: string[] = []
  for (const command of SLASH_COMMANDS) {
    const file = path.join(commandDir, `${command.name}.md`)
    // Clean up v1 command files: the plugin provides the commands now.
    if (fs.existsSync(file)) {
      fs.rmSync(file)
      files.push(file)
    }
  }

  const configPath = path.join(base, "router.config.json")
  const configCreated = !fileExists(configPath)
  if (configCreated) writeJson(configPath, {})

  return { commandDir, configPath, configCreated, files }
}
