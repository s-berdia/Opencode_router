/** @jsxRuntime automatic */
/** @jsxImportSource @opentui/solid */
import fs from "node:fs"
import os from "node:os"
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  buildHudState,
  hudColor,
  hudLine,
  ledgerPath,
  parseJsonSafe,
  routingTablePath,
  routerConfigPath,
  stateDirPath,
  type HudState,
} from "./hud.js"

const REFRESH_MS = 15_000

/** OpenCode never atomically writes these files; tolerate missing and half-written files. */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function readState(now: number): HudState | null {
  try {
    const home = os.homedir()
    const dir = stateDirPath(process.env.XDG_CONFIG_HOME, home)
    const ledger = parseJsonSafe(readText(ledgerPath(dir))) ?? undefined
    const table = parseJsonSafe(readText(routingTablePath(dir))) ?? undefined
    const config = parseJsonSafe(readText(routerConfigPath(dir)))
    return buildHudState({ ledger, table, config, now })
  } catch {
    return null
  }
}

const tui: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<HudState | null>(null)

  const refresh = () => {
    try {
      setState(readState(Date.now()))
    } catch {
      /* never break the TUI */
    }
  }
  refresh()

  const timer = setInterval(refresh, REFRESH_MS)
  // Messages change the ledger immediately; a poll alone would lag a window.
  const off = api.event.on("message.updated", () => refresh())
  onCleanup(() => {
    clearInterval(timer)
    off()
  })

  api.slots.register({
    order: 50,
    slots: {
      session_prompt_right(ctx, value) {
        void ctx
        void value
        const current = state()
        if (!current) return <text fg="#808080"></text>
        const fg = hudColor(current)
        return <text fg={fg}>{hudLine(current, Date.now())}</text>
      },
      home_prompt_right() {
        const current = state()
        if (!current) return <text fg="#808080"></text>
        const fg = hudColor(current)
        return <text fg={fg}>{hudLine(current, Date.now())}</text>
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-router",
  tui,
}

export default plugin
