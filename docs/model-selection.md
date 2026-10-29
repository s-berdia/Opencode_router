# How the router selects models

`model-scores.json` is a generated snapshot, not a hand-tuned opinion. This page
documents where its numbers come from, how a model is joined to a public
benchmark, and how to regenerate it.

The committed snapshot ships with the package. Routing never fetches scores at
runtime: installs and offline builds always use the committed table.

## The funnel

Each archetype (`plan`, `build`, `general`, `explore`, `small_model`, `title`,
`summary`, `compaction`) selects a winner through the same stages:

1. **Eligibility.** Plan availability, required tools/reasoning/context,
   known monthly cap, deny/allow globs, privacy, and the optional uptime floor.
   These are the same rules the router applies at runtime, in
   `ineligibilityReason()`.

   Plan availability follows three tiers:

   | Plan | Models |
   | :-- | :-- |
   | `free` | `opencode/*` $0 models |
   | `go` | every `opencode-go/*` model, plus `opencode/*` $0 models |
   | `go-plus` | the Go tier, plus paid `opencode/*` (pay-as-you-go) models |

   A paid `opencode/*` model is excluded on `go` and `free`, so the router
   cannot spend pay-as-you-go money on a plan that does not include it. On
   `go-plus` it is metered per token, not capped by the table's
   `monthlyCaps`, so the unknown-cap rule only applies to `opencode-go`
   subscription models.
2. **Intelligence gate.** Among models with a public benchmark, only models
   within a band of the role's best measured intelligence remain. The band is
   widest for roles that tolerate a cheaper model (`small_model`, `title`) and
   narrowest for `plan`. Models with no public benchmark are exempt and keep
   their prior, flagged as `[prior]` in the report: missing data must not
   silently disqualify a model the router still needs.
3. **Cost.** Blended USD per million tokens, from the OpenCode catalog. Cost
   enters the score through **endurance** (how many tokens the monthly
   allowance buys), so a cheap model still has to pass the gate before price
   can help it.
4. **Speed.** The committed speed value or the name-pattern heuristic. The
   status feed's measured TPS is a live signal; the generated table does not
   guess a speed for an unmeasured model.
5. **Reliability.** Seven-day uptime from `status.opencode.ai`, with a neutral
   prior for models the status page does not follow. See `src/status.ts`.
6. **Archetype weights.** The role's `weights` decide the final trade-off.
   `plan` leans intelligence; `small_model` and `title` lean speed and
   endurance; `compaction` leans endurance and reliability.

The first stage is a filter, the second is a gate, and the last four are the
weighted score. Intelligence is deliberately **not** a weighted term that a
cheap model can outbid: it decides which models are allowed to compete.

`selectArchetype()` returns the ranking plus the reason each excluded model was
removed, the models the gate removed, and the unmeasured models that were
exempted. `opencode-router scores --top` prints that evidence.

## Where the numbers come from

The source is [OpenRouter's public model list](https://openrouter.ai/api/v1/models).
It publishes Artificial Analysis indices under `benchmarks.artificial_analysis`
and needs no API key:

| Field | Meaning |
| :-- | :-- |
| `intelligence_index` | Artificial Analysis's general capability index |
| `coding_index` | Coding capability |
| `agentic_index` | Agentic/tool-use capability |

For each matched model:

- `intelligence_index` is used when reported.
- Otherwise the score is `0.6 * coding_percentile + 0.4 * agentic_percentile`,
  because coding and agentic work are what this router routes.
- Each index is converted to a **midrank percentile** among every model in the
  payload that reports the same index.
- The percentile is mapped onto the committed table's heuristic intelligence
  range (`60..95` at the time of writing). This keeps a measured model
  comparable to an unmeasured one: the 50th percentile lands where a median
  hand-tuned model sat, instead of 30 points below every model with no
  benchmark.

`model-scores.json._meta` records the source URL, fetch time, method,
calibration range, match counts, and any aliases. The fetch time is the only
field that changes between identical runs; `scores --check` ignores it.

## Joining a catalog model to a benchmark

OpenCode publishes `canonical_model_id` for each catalog model. The matcher tries,
in order:

1. `canonical_model_id` against the benchmark record id,
2. against `canonical_slug`,
3. a normalized model id (provider prefix, `-free`/`-preview`/`:batch`
   decorations, and date stamps removed),
4. a version-stripped normalized id.

If two different records normalize to the same key, that key is dropped as
ambiguous rather than picking one. An unmatched model keeps its prior or falls
through to the heuristics, and is listed in the generator output. To join one
deliberately, add an alias:

```json
"_meta": {
  "aliases": {
    "opencode-go/example-model": "vendor/example-model"
  }
}
```

Aliases are copied into the next generated `_meta` block and reported with
`via: "alias"`.

## Explicit overrides

`model-scores.json.overrides` always wins over the generated `models` block,
feeds, and heuristics. The generator never rewrites it. A user's
`router.config.json` `scores` block is merged into the same override layer at
runtime, so a local pin cannot be lost when the snapshot is regenerated.

```json
"overrides": {
  "opencode-go/some-model": { "intelligence": 91, "speed": 40 }
}
```

## Regenerating the snapshot

```bash
# Dry run: show the sources, unmatched models, and the winner per archetype
npx tsx scripts/refresh-scores.ts --top

# Write model-scores.json
npx tsx scripts/refresh-scores.ts --write

# After a build, the same command is available from the CLI
npm run build
node dist/bin.js scores --top
node dist/bin.js scores --write
```

Options:

| Option | Effect |
| :-- | :-- |
| `--top` | Print the archetype winners, the gate, and the models it removed |
| `--write` | Write the generated table to `model-scores.json` |
| `--check` | Exit 1 when the committed table differs from a fresh generation |
| `--from <file>` | Read a saved OpenRouter `models` payload instead of fetching |
| `--url <url>` | Use a different benchmark endpoint |
| `--band <n>` | Override the intelligence band for the winner report (0-100) |
| `--catalog <file>` | Read a different OpenCode `models.json` cache |
| `--json` | Machine-readable report |

The recommended workflow is: run `--top`, review the winners and the gated
models, compare a few scores with the current table, then `--write` and run the
test suite. The scores are data, but the calibration and the gate are policy;
review the policy output, not just the diff.

`--check` compares everything except `updated`, `_meta.generated`, and
`_meta.fetchedAt`. In CI without network access, save one payload and pass it
with `--from` so the check is deterministic.

## Current limits

- **Coverage is partial.** At the time of the first generation, 111 of 167
  routed rows matched a benchmark record and 87 had a usable index. The rest
  keep a prior. The unmatched list is the work queue for aliases.
- **Intelligence is one number per model.** It is not yet role-specific. The
  coding/agentic blend is a fallback for models with no overall index, not a
  separate coding score for coding roles.
- **Speed is not generated.** Measured TPS exists only for models the status
  page follows. The table keeps the committed value or the name heuristic and
  lets the live status signal do the rest.
- **The archetype report uses the raw catalog.** The scorecard dedupes a model
  sold under both `opencode-go` and `opencode`; the generator must keep both
  namespaces because plan eligibility differs between them. The winner report
  keeps the best-ranked copy of each model id.
