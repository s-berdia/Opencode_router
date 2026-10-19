import { fileURLToPath } from "node:url"

export interface SlashCommand {
  name: string
  description: string
  /** CLI arguments; OpenCode replaces $1 with the first word the user types. */
  args: string
}

/** The slash commands, shared by the plugin and `opencode-router install`. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "refresh-routing", description: "Recompute and apply OpenCode model routing", args: "refresh" },
  { name: "routing-status", description: "Show the model in use per role and its 5-hour quota use", args: "status" },
  { name: "routing-plan", description: "Switch the routing plan (go | go-plus | free) and rebuild", args: "plan $1" },
  { name: "routing-eval", description: "Run the router scoring stress test", args: "eval" },
  { name: "routing-update", description: "Update opencode-router to the newest version", args: "update" },
]

const OUTPUT_BEGIN = "---BEGIN ROUTER OUTPUT---"
const OUTPUT_END = "---END ROUTER OUTPUT---"

/** True for the prompt of a router slash command. */
export function isRouterCommandPrompt(parts: readonly { type: string; text?: string }[]): boolean {
  return parts.some((part) => part.type === "text" && part.text?.includes(OUTPUT_BEGIN) === true)
}

/** Absolute path of the CLI script that ships next to this module in dist/. */
function cliScriptPath(): string {
  return fileURLToPath(new URL("./bin.js", import.meta.url)).replace(/\\/g, "/")
}

/** Command body. OpenCode runs the !`...` part and puts its output in the prompt. */
export function commandTemplate(args: string): string {
  return [
    "opencode-router already ran. Its output is between the markers below.",
    "",
    "Rules:",
    "1. Do not run any command, script, or tool. Do not search for opencode-router on PATH.",
    "2. Reply with only the text between the markers, exactly as written.",
    `3. Do not include the ${OUTPUT_BEGIN} or ${OUTPUT_END} marker lines in your reply, and do not add any text before or after.`,
    "4. Do not summarize, reformat, shorten, or reorganize it.",
    "",
    OUTPUT_BEGIN,
    `!\`node "${cliScriptPath()}" ${args} --scope global\``,
    OUTPUT_END,
  ].join("\n")
}
