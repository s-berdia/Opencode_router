/** @jsxRuntime automatic */
/** @jsxImportSource @opentui/solid */
import fs from "node:fs"
import os from "node:os"
import { createMemo, createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  buildHudState,
  hudColor,
  hudDataPath,
  hudLine,
  ledgerPath,
  parseJsonSafe,
  routingTablePath,
  routerConfigPath,
  stateDirPath,
  type HudFileData,
  type HudState,
  type LedgerData,
  type RoutingTableData,
} from "./hud.js"

const REFRESH_MS = 15_000

export interface RawSnapshot {
  ledger: LedgerData | undefined
  table: RoutingTableData | undefined
  config: unknown
  hud: HudFileData | undefined
}

/** OpenCode never atomically writes these files; tolerate missing and half-written files. */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function readSnapshot(): RawSnapshot {
  const home = os.homedir()
  const dir = stateDirPath(process.env.XDG_CONFIG_HOME, home)
  return {
    ledger: parseJsonSafe(readText(ledgerPath(dir))) ?? undefined,
    table: parseJsonSafe(readText(routingTablePath(dir))) ?? undefined,
    config: parseJsonSafe(readText(routerConfigPath(dir))),
    hud: parseJsonSafe(readText(hudDataPath(dir))) ?? undefined,
  }
}

const EMPTY: RawSnapshot = { ledger: undefined, table: undefined, config: undefined, hud: undefined }

const tui: TuiPlugin = async (api) => {
  const [snapshot, setSnapshot] = createSignal<RawSnapshot>(EMPTY)
  const [session, setSession] = createSignal<string | undefined>(undefined)

  const refresh = () => {
    try {
      setSnapshot(readSnapshot())
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
        if (typeof value?.session_id === "string" && value.session_id) setSession(value.session_id)
        const view = createMemo((): { fg: string; text: string } | null => {
          const state = buildHudState({ ...snapshot(), sessionId: session(), now: Date.now() })
          if (!state) return null
          return { fg: hudColor(state), text: hudLine(state) }
        })
        return <text fg={view()?.fg ?? "#808080"}>{view()?.text ?? ""}</text>
      },
      home_prompt_right(ctx) {
        void ctx
        const view = createMemo((): { fg: string; text: string } | null => {
          const state = buildHudState({ ...snapshot(), sessionId: undefined, now: Date.now() })
          if (!state) return null
          return { fg: hudColor(state), text: hudLine(state) }
        })
        return <text fg={view()?.fg ?? "#808080"}>{view()?.text ?? ""}</text>
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-router",
  tui,
}

export default plugin
