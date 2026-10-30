import type { ModelPrivacy, ScoreTable } from "./types.js"

/**
 * Data policies that are known without a network fetch. The Go docs also
 * publish a "Model training" table, and `mergeGoCaps` overlays it; this static
 * map covers the common Zen free models and keeps the privacy filter useful
 * when the docs are unavailable.
 */
const STATIC: Record<string, ModelPrivacy> = {
  "opencode-go/beam-free": { training: false, retention: "30 days" },
  "opencode-go/iceman-contributor-free": { training: true, retention: "Not ZDR" },
  "opencode-go/muse-spark-1.2-contributor": { training: true, retention: "Not ZDR" },
  "opencode-go/muse-spark-1.3-contributor": { training: true, retention: "Not ZDR" },
  "opencode/deepseek-v4.1-flash-free": { training: false, retention: "0 days" },
  "opencode/glm-5.3-flash-free": { training: false, retention: "0 days" },
  "opencode/beam-free": { training: false, retention: "30 days" },
  "opencode/mimo-v2.6-flash-free": { training: true },
  "opencode/big-pickle": { training: true },
  "opencode/flint-40b-free": { training: true, retention: "30 days" },
  "opencode/nemotron-3.5-lightning-free": { training: true, note: "NVIDIA trial: logged" },
  "opencode/nemotron-3.5-super-vl-free": { training: true, note: "NVIDIA trial: logged" },
}

/** The policy for a model: a fetched Go table wins over the static fallback. */
export function privacyFor(modelId: string, table?: ScoreTable): ModelPrivacy | undefined {
  return table?.privacy?.[modelId] ?? STATIC[modelId]
}

/**
 * True when a model may train on request data. Unknown free models are treated
 * as collecting data; unknown paid models are not, matching the docs' default.
 */
export function modelTrains(modelId: string, table?: ScoreTable): boolean {
  const policy = privacyFor(modelId, table)
  if (policy) return policy.training
  return modelId.includes("-free")
}
