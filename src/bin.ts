#!/usr/bin/env node
import { main } from "./cli.js"

/**
 * Force the exit: a CLI that only sets `process.exitCode` can sit on the event
 * loop for minutes after its work, because fetch's keep-alive sockets stay
 * open. The plugin runs this CLI under a fixed time budget, so a hang here
 * turns a finished command into "Command failed: ...".
 */
main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code)
  },
  (error: unknown) => {
    process.stderr.write(
      `opencode-router failed: ${error instanceof Error ? error.message : String(error)}${
        error instanceof Error && error.stack ? `\n${error.stack}` : ""
      }\n`,
    )
    process.exit(1)
  },
)
