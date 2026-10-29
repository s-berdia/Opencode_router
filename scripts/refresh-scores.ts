#!/usr/bin/env node
/**
 * Regenerate the committed intelligence scores from public benchmarks.
 *
 *   npx tsx scripts/refresh-scores.ts --top     # dry run, show archetype winners
 *   npx tsx scripts/refresh-scores.ts --write   # update model-scores.json
 *   npm run build && node dist/bin.js scores --check
 *
 * The same logic is available as `opencode-router scores`; this wrapper exists
 * so the generator can be run from the repository without a global install.
 */
import { main } from "../src/cli.js"

main(["scores", ...process.argv.slice(2)]).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`scores failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)
