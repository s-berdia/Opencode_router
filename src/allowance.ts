import type { CatalogModel, ModelCost } from "./types.js"

/** Token counts of one completed assistant step, in the shape OpenCode reports them. */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

const PER_MILLION = 1_000_000
// OpenCode reports allowance in dollars rounded to eight decimals.
const ALLOWANCE_SCALE = 1e8

/**
 * The price that applies to one request. A tier is a context threshold: the
 * base price covers the prompt up to and including `size`, and the tier price
 * applies above it. Tiers from the catalog are sorted by size.
 */
function priceFor(model: CatalogModel, usage: TokenUsage): ModelCost {
  const context = usage.input + usage.cacheRead + usage.cacheWrite
  let price = model.cost
  for (const tier of model.tiers) {
    if (context <= tier.size) continue
    price = {
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead ?? price.cacheRead,
      cacheWrite: tier.cacheWrite ?? price.cacheWrite,
    }
  }
  return price
}

/**
 * DeepSeek's Go prices double in its published peak windows: 01:00-04:00 and
 * 06:00-10:00 UTC, Monday through Friday. The catalog stores the off-peak price.
 */
function isDeepSeekPeak(modelID: string, at: number): boolean {
  if (!modelID.startsWith("deepseek-v4.1-flash") && !modelID.startsWith("deepseek-v4-pro")) return false
  const date = new Date(at)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/**
 * The part of the shared Go allowance that one step used, in USD.
 *
 * This is the same arithmetic the Go API uses for `opencode.allowance`: each
 * token kind has its own catalog price, reasoning counts as output, and a
 * cache read is not priced like fresh input. Using a blended per-million price
 * on the total token count overstates cache-heavy steps by an order of
 * magnitude, which is what made the old ledger reach its limit too early.
 */
export function allowanceCost(model: CatalogModel, usage: TokenUsage, at = Date.now()): number {
  const price = priceFor(model, usage)
  const input = Math.max(0, usage.input)
  const output = Math.max(0, usage.output + usage.reasoning)
  const cacheRead = Math.max(0, usage.cacheRead)
  const cacheWrite = Math.max(0, usage.cacheWrite)
  // A model without a separate cache-read price charges cached input as input.
  const cacheReadPrice = price.cacheRead ?? price.input
  // A missing cache-write price means the model does not charge for cache writes.
  const cacheWritePrice = price.cacheWrite ?? 0

  let cost =
    (input * price.input +
      output * price.output +
      cacheRead * cacheReadPrice +
      cacheWrite * cacheWritePrice) /
    PER_MILLION
  if (isDeepSeekPeak(model.modelID, at)) cost *= 2
  return Math.round(cost * ALLOWANCE_SCALE) / ALLOWANCE_SCALE
}
