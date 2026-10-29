import { fileURLToPath } from "node:url"
import fs from "node:fs"

export interface SlashCommand {
  name: string
  description: string
  /** CLI arguments; the router passes the words the user typed after the command. */
  args: string
}

/** The slash commands, shared by the plugin and `opencode-router install`. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "refresh-routing", description: "Recompute and apply OpenCode model routing", args: "refresh" },
  { name: "routing-status", description: "Show the model in use per role and its 5-hour quota use", args: "status" },
  { name: "routing-plan", description: "Switch the routing plan (go | go-plus | free) and rebuild", args: "plan $ARGUMENTS" },
  { name: "routing-eval", description: "Run the router scoring stress test", args: "eval" },
  { name: "routing-update", description: "Update opencode-router to the newest version", args: "update" },
]

/** Absolute path of the CLI script that ships next to this module in dist/. */
export function cliScriptPath(): string {
  const beside = fileURLToPath(new URL("./bin.js", import.meta.url))
  if (fs.existsSync(beside)) return beside.replace(/\\/g, "/")
  // Source mode (the repo build has not stepped in): the compiled CLI lives in dist/.
  return fileURLToPath(new URL("../dist/bin.js", import.meta.url)).replace(/\\/g, "/")
}

/** Split the words a user typed after the slash command into CLI arguments. */
export function commandArguments(prompt: string): string[] {
  return prompt.trim().split(/\s+/).filter((word) => word.length > 0)
}

/** The CLI invocation for a router command: `/refresh-routing` runs `refresh`, `/routing-plan go` runs `plan go`. */
export function cliArgsFor(name: string, typed: string[]): string[] {
  const slash = SLASH_COMMANDS.find((command) => command.name === name)
  if (!slash) return []
  const base = commandArguments(slash.args.replace("$ARGUMENTS", ""))
  return [...base, ...typed]
}
