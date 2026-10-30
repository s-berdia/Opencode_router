# opencode-router usage guide

> **Early development.** This project is alpha software and has known issues. Behavior,
> configuration, and the cap table can change. Please report bugs and contribute fixes:
> [CONTRIBUTING.md](./CONTRIBUTING.md). Do not use it for production-critical work yet.

This guide gives the full procedure to install, use, change, and remove opencode-router.
Do the steps in sequence. Each command has a label that tells you which shell to use.

## Contents

1. [Before you start](#1-before-you-start)
2. [Install the plugin](#2-install-the-plugin)
3. [Do the first refresh](#3-do-the-first-refresh)
4. [Read the scorecard](#4-read-the-scorecard)
5. [Select your plan](#5-select-your-plan)
6. [Change the router settings](#6-change-the-router-settings)
7. [Use the terminal tool](#7-use-the-terminal-tool)
8. [Test the models](#8-test-the-models)
9. [Files and folders](#9-files-and-folders)
10. [Troubleshooting](#10-troubleshooting)
11. [Known limits](#11-known-limits)
12. [Update the router](#12-update-the-router)
13. [Remove the router](#13-remove-the-router)

## 1. Before you start

Make sure that you have these items:

1. **OpenCode**, installed and signed in. Start it one time, then close it. This step
   makes the model catalog file `~/.cache/opencode/models.json`.
2. **Node.js 20 or later.** Do this check:

   PowerShell, CMD, Git Bash, macOS, or Linux:

   ```bash
   node --version
   ```

   The result must be `v20` or higher. If the command fails, install Node.js from
   <https://nodejs.org> (use the LTS version), then open a new terminal.
3. **An OpenCode plan:** Go, Go Plus, Go Teams, or no subscription. With no subscription,
   the router uses only free models.

`~` means your home folder. On Windows, this is `C:\Users\<your-user-name>`.

## 2. Install the plugin

### Option A: with the OpenCode command-line tool (fastest)

1. Run this command. It works in PowerShell, CMD, Git Bash, macOS, and Linux:

   ```bash
   opencode plugin @s-berdia/opencode-router --global
   ```

   The command downloads the plugin and adds `"@s-berdia/opencode-router"` to the
   `plugins` list of your global config file.
2. Close OpenCode. Start OpenCode again.

If the `opencode` command is not found, use Option B. Or install the command-line tool
with `npm install -g @opencode/cli`, and then do step 1 again.

### Option B: from npm, by hand

1. Open the global OpenCode config file.

   PowerShell (Windows):

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode" | Out-Null
   notepad "$env:USERPROFILE\.config\opencode\opencode.json"
   ```

   Git Bash, macOS, or Linux:

   ```bash
   mkdir -p ~/.config/opencode
   nano ~/.config/opencode/opencode.json
   ```

   If you already have `opencode.jsonc` in that folder, open that file. If Notepad asks
   to make a new file, click **Yes**.
2. Make a backup copy of the file before you continue. The router writes the model keys
   in this file. It keeps your comments and all other settings.
3. Add `"@s-berdia/opencode-router"` to the `plugins` list. If the file is empty, use all
   of this text:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["@s-berdia/opencode-router"]
   }
   ```

   If the file already has a `plugins` list (OpenCode also accepts the older `plugin`
   spelling), add the name to the list. Put a comma between the items.
4. Save the file. Close the editor.
5. Close OpenCode. Start OpenCode again. OpenCode downloads the plugin when it starts.

To use the router in one project only, put the `plugins` entry in `opencode.json` in the
root folder of that project, not in the global file.

### Option C: from source

Use this option to test changes to the code.

1. Clone and build the project.

   PowerShell, Git Bash, macOS, or Linux:

   ```bash
   git clone https://github.com/s-berdia/Opencode_router.git
   cd Opencode_router
   npm install
   npm run build
   ```

2. Get the absolute path of the folder.

   PowerShell:

   ```powershell
   (Get-Location).Path
   ```

   Git Bash, macOS, or Linux:

   ```bash
   pwd
   ```

3. In `opencode.json`, add the path as a `file:///` URL. Use forward slashes (`/`).
   - Windows example: `"plugins": ["file:///C:/code/Opencode_router"]`
   - macOS or Linux example: `"plugins": ["file:///home/alex/Opencode_router"]`
4. Restart OpenCode. After each code change, run `npm run build` and restart OpenCode.

## 3. Do the first refresh

1. In the OpenCode prompt, type `/` and look at the list of commands. Make sure that
   these commands are in the list: `/refresh-routing`, `/routing-status`,
   `/routing-plan`, `/routing-eval`, and `/routing-update`. If they are not in the list,
   go to [Troubleshooting](#10-troubleshooting).
2. Type this command and push Enter:

   ```text
   /refresh-routing
   ```

3. The router does these steps:
   1. It reads the model catalog and your settings.
   2. It gives a score to each model for each agent.
   3. It writes the best models to the global `opencode.json`. It changes only the
      `model`, `small_model`, and `agent.<role>.model` and `variant` keys.
   4. It applies the models to the running session.
   5. It shows the scorecard.

You do not have to restart OpenCode. From now on, the router selects the model for each
message automatically.

## 4. Read the scorecard

The scorecard has one block of rows for each role. The first row of a block is the model
that the role uses. The other rows are the failover models, in sequence. On Go, Go Plus,
and Go Teams, the last row of each agent is usually a free model (see
[How the router changes models](#how-the-router-changes-models)).

| Column | Meaning |
| :-- | :-- |
| Role | The agent: `plan`, `build`, `general`, `explore`, `small_model`, `title`, `summary`, `compaction` |
| # | Position in the failover list. 1 is the first model |
| Model | The model ID, in the form `provider/model` |
| Var | The reasoning level (`high`, `medium`, `low`). `none` means the model default |
| Score | The total score, 0 to 100 |
| Intel | Intelligence score, 0 to 100 |
| Speed | Speed score, 0 to 100 |
| Endur | Endurance score, 0 to 100. A high value means that the model uses the Go allowance slowly |
| Tokens/5h | The estimated number of tokens in 5 hours if the agent uses only this model. `unlimited` means no limit |
| Cap/mo | The monthly limit of the model on your plan. `inf` means no limit |
| Class | `go` = included in your Go subscription. `free*` = $0 (check the model's data policy). `paid` = Zen pay-as-you-go |

The **Notes** section under the table shows problems, for example a missing catalog.

### How the router changes models

- All `go` models share one usage allowance. Each message uses a part of it: the token
  cost of the message, priced per token kind (input, output, reasoning as output, cache
  read, and cache write) with the prices in your OpenCode model catalog, divided by the
  monthly limit of its model (`Cap/mo`). A model with a low limit uses the allowance
  faster. This matches the `opencode.allowance` that the Go API reports; a blended
  per-million-token estimate overstates cache-heavy turns by an order of magnitude.
- The monthly caps and data policies are fetched from the
  [Go documentation](https://opencode.ai/v2/docs/console/go) during `refresh`, `status`,
  `plan`, and `eval`, and once per day by the plugin. The fetched table is cached in
  `router/go-caps.json`; use `--offline` or `"caps": { "fetch": false }` to keep the
  cached/bundled copy. New or changed models are scored with the new caps immediately.
- The allowance has 3 windows: rolling 5 hours (20% of the monthly allowance), weekly
  (50%), and monthly (100%). The 5-hour window starts with the first Go request and
  resets 5 hours later. The weekly and monthly windows repeat on the same day/time. Set
  `allowance.weekStart` and `allowance.monthStart` to the console's reset timestamps for
  exact boundaries. Without them, the router anchors the current window at the first
  recorded step.
- When the use in a window reaches `softThreshold` (default 85%), the `plan`, `build`,
  `general`, and `explore` agents use the free model at the end of their list. When the
  use falls under the threshold again, they go back to their first model.
- After a usage-limit error from a `go` model, the router stops all `go` models until the
  reset named in the error (`Resets in 40min`, or the weekly/monthly window). The agents
  use their free models in that time.
- After a different rate-limit or overload error, the router stops only that model for
  1 hour. The agent uses the next model in its list.
- The estimate counts the messages that this OpenCode installation records. The Go
  meter is workspace-wide: the same API key in another client or computer is not
  included. The console usage page is authoritative.

`/routing-status` shows the estimated use of the allowance and the state of each agent:

| State | Meaning |
| :-- | :-- |
| `healthy` | The agent uses its first model |
| `failover` | The agent uses a later model, because an earlier model is in cooldown |
| `free-fallback` | The agent uses its free model, because the Go allowance is near its limit or in cooldown |
| `limited` | The agent has no usable model. The router keeps the first model |

## 5. Select your plan

The router can tell whether you have Go models, but it cannot tell a Go subscription
from Go Plus or Go Teams. It uses `go` by default. Set the plan if you subscribe to Plus
or Teams:

| Plan | Models the router may use |
| :-- | :-- |
| `free` | `opencode/*` models with `free: true` only |
| `go` | every `opencode-go/*` model, plus `opencode/*` $0 models |
| `go-plus` | Go Plus caps, plus `opencode/*` $0 models |
| `go-teams` | Go Teams caps, plus `opencode/*` $0 models |

Paid `opencode/*` models are **not** part of Go Plus or Go Teams. They are Zen
pay-as-you-go and need `"zenPaid": true` plus a Console balance; their use is metered per
token, not taken from the shared Go allowance.

In OpenCode, type the command with your plan (`go`, `go-plus`, `go-teams`, or `free`):

```text
/routing-plan go-teams
```

The router saves the plan in `~/.config/opencode/router.config.json`, calculates the
routing table again, and applies it. It then shows the new scorecard.

If the `router.config.json` file of the current project also sets `plan`, that value wins
in that project. The command shows a note when this occurs.

## 6. Change the router settings

The router works with no settings. To change its behavior, make or edit
`router.config.json`.

| File | Applies to |
| :-- | :-- |
| `~/.config/opencode/router.config.json` | All projects |
| `<project>/.opencode/router.config.json` | One project. Its values replace the global values |

After each change, run `/refresh-routing`. If a file has a JSON error, or a value that is
not valid, the router ignores it and shows a note under the scorecard.

Each example below is a complete file. To use more than one example, put all the keys in
one JSON object.

### Keep your main work off free models

Free models can collect your data. This setting keeps the `plan`, `build`, and `general`
agents on models that you pay for. The `explore` agent and the internal helpers can still
use free models.

```json
{
  "privacy": { "freeModelsOk": false }
}
```

With this setting, these agents have no free model at the end of their list. When the
Go allowance runs out, they stop until it resets.

### Keep your work off models that train on it

Some models are paid but still train on request data, for example the Muse Spark
Contributor models. `trainingOk` is separate from `freeModelsOk` and covers paid and free
models:

```json
{
  "privacy": { "trainingOk": false }
}
```

The default is `true` to preserve the normal routing behavior. The status and scorecard
add a **Data policy** note when an active model trains on request data.

### Never use some models

`*` matches any text. `?` matches one character.

```json
{
  "denyModels": ["*-free", "*-preview", "opencode-go/kimi-k3"]
}
```

### Use only some models

If `allowModels` is not empty, the router uses only the models in the list.

```json
{
  "allowModels": ["opencode-go/glm-*", "opencode-go/deepseek-*", "opencode/*-free"]
}
```

### Change models earlier or later

`softThreshold` sets when the agents change to their free model. `0.7` changes when the
use of the shared Go allowance reaches 70% in one of its windows (rolling 5 hours,
weekly, or monthly). The default is `0.85`; the real Go limit is 100%, so the default
leaves a 15% safety margin.

```json
{
  "softThreshold": 0.7
}
```

### Keep control of the model choice

`mode` sets how much the router decides per message:

| `mode` | What happens |
| :-- | :-- |
| `auto` (default) | The router picks the model for each agent. When you pick a model in the OpenCode UI, your pick wins for that session: the router records its use and still handles limit errors, but it does not send you back. Run `/refresh-routing` to give control back to the router. |
| `failover` | The router never picks a model for you. It only moves an agent to the next model in its chain after a rate-limit, quota, or authorization error, and moves it back when the cooldown ends. |
| `off` | The router does not change models per message. It writes the config at install and `/refresh-routing` only. |

```json
{
  "mode": "failover"
}
```

A pick that differs from the model the router applied counts as a manual pick. The
widget in the terminal shows ` in use <model> (manual)` for such sessions, and
`/routing-status` shows the active mode.

### Change what is important for one agent

Each role has three weights. Use values that add up to 1.

```json
{
  "weights": {
    "plan": { "intelligence": 0.8, "speed": 0.05, "endurance": 0.15 },
    "build": { "intelligence": 0.5, "speed": 0.2, "endurance": 0.3 }
  }
}
```

### Correct the score of a model

Use this setting when you know that a model is better or worse than its score.

```json
{
  "scores": {
    "opencode-go/deepseek-v4.1-flash": { "intelligence": 82, "speed": 70 }
  }
}
```

### Change the number of failover models or the reasoning level

`chainDepth` sets the number of models in each failover list. The default is 4 for the
agents and 3 for the internal helpers. A value under `roles.<role>` wins over the
top-level value. On Go, Go Plus, and Go Teams, the last model of each list is usually a
free model, if your privacy setting permits free models.

```json
{
  "chainDepth": 3,
  "roles": {
    "build": { "chainDepth": 2 },
    "plan": { "variant": "medium" }
  }
}
```

The `roles.<role>` key also accepts:

| Key | Meaning |
| :-- | :-- |
| `requires.toolCall` | `true` = use only models that can call tools |
| `requires.reasoning` | `true` = use only reasoning models |
| `requires.minContext` | Minimum context window, in tokens |
| `requires.minOutput` | Minimum output limit, in tokens |
| `preferFree` | `true` = put free models first |
| `diversifyFamily` | `true` = do not put two models of the same family in sequence |

### Use a benchmark feed

The router can get intelligence and speed scores from a JSON file on the web. If the
download fails, the router uses its normal scores.

```json
{
  "feeds": { "enabled": true, "url": "https://example.com/scores.json", "timeoutMs": 5000 }
}
```

The file at the URL must have this format. `id` matches one model. `family` matches all
models of that family.

```json
{
  "version": 1,
  "models": [
    { "id": "opencode-go/glm-5.3", "intelligence": 90, "speed": 45 },
    { "family": "qwen", "intelligence": 80 }
  ]
}
```

### Stop the network checks

The router fetches the public Go docs page during `refresh`, `status`, `plan`, and
`eval`, and once per day from the plugin. It sends no prompts or account data. To use
only the cached/bundled cap table, set:

```json
{
  "caps": { "fetch": false }
}
```

Once each 24 hours, the router also asks npm for the newest version number. It sends one
request to `registry.npmjs.org` and no other data. When a newer version is available, the
router shows a toast in OpenCode and a line under the status and the scorecard. To stop
the check:

```json
{
  "updateCheck": false
}
```

### Cap fetching and window boundaries

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `caps.fetch` | `true` | Fetch the Go monthly caps and data policies from the docs |
| `caps.ttlHours` | `24` | Use the cached cap table for this many hours |
| `caps.url` | Go docs URL | A different page with the same pricing tables |
| `allowance.weekStart` | first recorded step | ISO start of the current weekly window; repeats every 7 days |
| `allowance.monthStart` | first recorded step | ISO start of the current monthly window; repeats on the same day/time |

The router fetches the docs during `refresh`, `status`, `plan`, and `eval`, and once per
day from the plugin. The cache is `~/.config/opencode/router/go-caps.json`. If a model
appears in the docs but not in the local catalog it is still scored once the catalog
updates; a live paid model with no cap is reported in the notes and is not routed.

To match the console exactly, copy its window start timestamps:

```json
{
  "allowance": {
    "weekStart": "2026-10-25T23:57:00Z",
    "monthStart": "2026-10-26T19:57:00Z"
  }
}
```

### Advanced cost settings

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `blend.input` | `0.75` | Part of the tokens that are input |
| `blend.output` | `0.25` | Part of the tokens that are output |
| `blend.cacheRead` | `0.1` | Weight of the cache-read price |
| `enduranceScale.minTokensPer5h` | `0.25` | Millions of tokens per 5 hours that give endurance 0 |
| `enduranceScale.maxTokensPer5h` | `40` | Millions of tokens per 5 hours that give endurance 100 |

The default scores, weights, and fallback monthly caps are in
[`model-scores.json`](./model-scores.json). The fetched `go-caps.json` overrides those
caps at runtime.

## 7. Use the terminal tool

The terminal tool does the same calculation as the slash commands. Use it for scripts,
CI, or scheduled jobs.

You can run it with `npx` and no install:

```bash
npx @s-berdia/opencode-router --help
```

Or install it one time:

```bash
npm install -g @s-berdia/opencode-router
opencode-router --help
```

These commands work in PowerShell, CMD, Git Bash, macOS, and Linux.

| Command | What it does |
| :-- | :-- |
| `opencode-router refresh --dry-run` | Show the scorecard. Do not write `opencode.json` |
| `opencode-router refresh --dry-run --verbose` | Also show the source of each score |
| `opencode-router refresh --scope global` | Write the routing table to the global `opencode.json` |
| `opencode-router refresh --scope project` | Write the routing table to `opencode.json` in the current folder |
| `opencode-router refresh --plan free` | Use the `free` profile for this run only |
| `opencode-router refresh --offline` | Use the cached/bundled Go cap table; fetch nothing |
| `opencode-router refresh --json` | Print the result as JSON |
| `opencode-router status` | Show the model in use for each role (after failover) and the estimated use of the Go allowance; refreshes stale caps |
| `opencode-router scores --top` | Show where the committed scores come from and the winning model per archetype |
| `opencode-router scores --write` | Regenerate `model-scores.json` from public benchmarks |
| `opencode-router scores --check` | Exit 1 when the committed scores are out of date |
| `opencode-router plan go-plus --scope global` | Save the plan in the global settings, then calculate and write the routing table |
| `opencode-router cat` | Show the catalog path, its date, and the number of models |
| `opencode-router install --scope global` | Write the slash commands as files in `~/.config/opencode/command/`. If `router.config.json` does not exist, it also writes an empty one |
| `opencode-router update` | Ask npm for the newest version. If the copy that OpenCode keeps is older, remove it. See [Update the router](#12-update-the-router) |

The terminal tool reads the global `router.config.json` and the project file of the
current folder, in the same way as the plugin.

If you do not give `--scope`, the tool uses `project` in a project folder (a folder with
`.git`, `package.json`, `opencode.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`) and
`global` in other folders.

### Apply to a running OpenCode server

When OpenCode runs as a server (`opencode serve`), the terminal tool can send the new
models to it. Set these environment variables before you run `refresh`:

| Variable | Value |
| :-- | :-- |
| `OPENCODE_SERVER_URL` | The server URL, for example `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` | Optional. The basic-auth user name |
| `OPENCODE_SERVER_PASSWORD` | Optional. The basic-auth password |

PowerShell:

```powershell
$env:OPENCODE_SERVER_URL = "http://127.0.0.1:4096"
npx @s-berdia/opencode-router refresh --scope global
```

Git Bash, macOS, or Linux:

```bash
OPENCODE_SERVER_URL="http://127.0.0.1:4096" npx @s-berdia/opencode-router refresh --scope global
```

If you do not set the URL, a running OpenCode session calculates the routing again on
its next message (in 15 seconds or less).

## 8. Test the models

`/routing-eval` sends one coding prompt to each model in the `build` list. It then
writes a report that compares the predicted ranks with the measured results. The prompt
is in [`evals/prompt.md`](./evals/prompt.md).

**You do not need a separate API key.** The test reuses the sign-in that OpenCode
already knows (`~/.local/share/opencode/auth.json`, written when you run
`opencode auth login` or sign in inside the app). If you signed in for the router to
work, the test can already run.

1. Make sure you are signed in at least for your plan's provider.

   ```bash
   opencode auth login
   ```

2. Run the test:

   ```bash
   npx @s-berdia/opencode-router eval --plan go
   ```

3. Open the report: `~/.config/opencode/router/eval-report.md`.

**Caution:** The test sends up to 4 real requests. Each request can use up to 2000
output tokens of your quota.

`OPENCODE_API_KEY` stays an optional override for a key that is not in the sign-in
file. With no credential at all, the test sends no requests and writes only the
predicted ranks. The predicted ranking is useful on its own and needs no key.

## 9. Files and folders

The router writes these files:

| File | Written by | Contents |
| :-- | :-- | :-- |
| `~/.config/opencode/router/ledger.json` | Plugin | Spend and tokens per model, the shared Go allowance buckets and window starts, and cooldowns |
| `~/.config/opencode/router/go-caps.json` | `refresh`, `status`, `plan`, `eval`, plugin | The fetched Go monthly caps and data policies |
| `~/.config/opencode/router/routing-table.json` | Plugin | The last routing table |
| `~/.config/opencode/router/last-apply.json` | Plugin | What the last apply did: what reloaded, or "applies on the next message" |
| `~/.config/opencode/router/eval-report.md` | `/routing-eval` | The test report |
| `~/.config/opencode/router/update-check.json` | Plugin, `status`, `refresh` | The time of the last update check and the newest version on npm |
| `~/.config/opencode/router/live-models.json` | Plugin | The model ids the running OpenCode server last reported, so CLI commands do not route to a removed model |
| `~/.config/opencode/opencode.json` | `/refresh-routing`, `/routing-plan` | `model`, `small_model`, and `agent.<role>.model` and `variant` |
| `~/.config/opencode/router.config.json` | `/routing-plan`, `install` (only if missing) | Your router settings |

The router writes each file through a temporary file, so a crash cannot leave half a
file. If `ledger.json` is damaged, the router keeps it as `ledger.json.corrupt-<time>`
and starts a new one.

If `XDG_CONFIG_HOME` is set, the router uses `$XDG_CONFIG_HOME/opencode` in place of
`~/.config/opencode`. If `XDG_CACHE_HOME` is set, the router reads the catalog from
`$XDG_CACHE_HOME/opencode/models.json`.

Do not commit the `router/` folder. It contains your usage data.

## 10. Troubleshooting

| Problem | Cause | Action |
| :-- | :-- | :-- |
| The `/refresh-routing` command is not in the list | OpenCode did not load the plugin | Make sure that the name in `plugin` is `@s-berdia/opencode-router` and the JSON is valid. Restart OpenCode |
| The scorecard says "No models found" | The catalog file is missing | Start OpenCode and sign in. Then run `npx @s-berdia/opencode-router cat`. "Routed models" must be more than 0 |
| A role shows `_no eligible model_` | Your settings removed all models for that role | Make `denyModels` and `allowModels` less strict. With `privacy.freeModelsOk: false` on the `free` plan, `plan` and `build` have no models |
| A slash command shows an error that `node` is not found | Node.js is not on the `PATH` of OpenCode | Install Node.js 20 or later. Restart the computer or the terminal, then OpenCode |
| "... has a JSON error (... at line N) ... The file was not changed." | Your `opencode.json` has a syntax error | Open the file, correct the line given, save, and run the command again |
| A note says "router.config.json has a JSON error" | Your router settings file has a syntax error | Correct the line given. Until then, the router uses its default settings |
| "live PATCH not attempted (no OPENCODE_SERVER_URL set)" | Normal when you run `refresh` in a terminal | No action. Or see [Apply to a running OpenCode server](#apply-to-a-running-opencode-server) |
| "hot-apply failed: ..." | OpenCode did not accept the change | Restart OpenCode. The file `opencode.json` has the new models |
| A model that you selected by hand changes back | The router selects the model at each message | See [Known limits](#11-known-limits) |
| An agent uses a free model (`free-fallback` in `/routing-status`) | The Go allowance is near its limit, or a usage-limit error occurred | No action. The agent goes back to its first model when the use falls or the cooldown ends. To change the limit, set [`softThreshold`](#change-models-earlier-or-later) |
| The scores look wrong | A model has no entry in `model-scores.json` | Run `npx @s-berdia/opencode-router refresh --dry-run --verbose`. If the source is `heuristic` or `default`, add the model to `scores`. For a benchmark-wide correction, run `opencode-router scores --top` and read [how models are selected](./model-selection.md) |

## 11. Known limits

These are the limits of version 1.4.1.

1. The router sets the model of the `plan`, `build`, `general`, and `explore` agents at
   each message. If you select a different model by hand, the router replaces it. To
   stop this, remove the plugin.
2. The internal helpers (`small_model`, `title`, `summary`, `compaction`) do not change
   to a failover model. They use the first model of their list.
3. The slash commands always write the global files (`~/.config/opencode/`). To write the
   files of one project, use the terminal tool with `--scope project`.
4. The slash commands need Node.js 20 or later on the `PATH`.
5. Use numbers are estimates. The router counts only the messages that this OpenCode
   installation records. The Go meter is workspace-wide, so use from another computer or
   another client (Claude Code, Codex, etc.) is not included. The console usage page is
   authoritative. A ledger written before version 1.3.1 is reset once: those versions
   used a blended per-million price, which overstated cache-heavy turns; cooldowns
   survive the reset. If two OpenCode windows write at the same moment, one record can be
   lost.
6. The 5-hour window is anchored at the first Go request; weekly and monthly repeat on
   the same day/time. Set `allowance.weekStart` and `allowance.monthStart` to the
   console's timestamps for exact boundaries. Without them, the router anchors the
   current window at the first recorded step, so the reset can differ by the time between
   your subscription and your first Go message.
7. The monthly caps are fetched from the Go docs. If the docs are unreachable, the
   bundled `model-scores.json` caps apply. A live paid model with no cap is reported in
   the notes and is not routed. Use `--offline` to skip the fetch.
8. After a usage-limit error, all `go` models go into a cooldown until the reset named in
   the error (or the weekly/monthly window). After a different rate-limit or overload
   error, only that model goes into a cooldown.
9. With `"privacy": { "freeModelsOk": false }`, the `plan`, `build`, and `general` agents
   have no free model. When the Go allowance runs out, they stop until it resets.
10. `"privacy": { "trainingOk": false }` also excludes paid models that train on request
    data, such as the Muse Spark Contributor models. The default is `true`, so read each
    model's data policy before you use it for confidential work.
11. The router does not know about **Extra usage** in the OpenCode console. It moves the
    agents to free models at the threshold, also when Extra usage is on. If Extra usage
    is on, Go can bill your Console balance after the shared meter is exhausted.

## 12. Update the router

OpenCode downloads the plugin one time and then uses its own copy. It does not download
a newer version automatically. The router looks for a newer version once each 24 hours
and tells you when one is available.

### With the slash command

1. In the OpenCode prompt, type this command and push Enter:

   ```text
   /routing-update
   ```

2. Read the result:
   - `OpenCode has opencode-router <version>, the newest version.`: you do not have to
     do more.
   - `Removed the cached copy: ...`: go to step 3.
   - `opencode.json pins an older version ...`: do the steps in
     [With a fixed version](#with-a-fixed-version).
3. Close OpenCode. Start OpenCode again. OpenCode downloads the newest version when it
   starts.
4. Type `/routing-status`. If the line `opencode-router <version> is available` does not
   show, the update is complete.

Between steps 2 and 3, the router slash commands do not work, because the files that they
use are removed. Restart OpenCode immediately.

### From a terminal

If the slash commands do not work, close OpenCode and run this command. Then start
OpenCode again.

```bash
npx --prefer-online @s-berdia/opencode-router@latest update
```

This command works in PowerShell, CMD, Git Bash, macOS, and Linux.

### With a fixed version

To select the version yourself, write it in the `plugin` list:

```json
{
  "plugin": ["@s-berdia/opencode-router@1.3.0"]
}
```

To update, change the number to the new version and restart OpenCode. The newest version
is on <https://www.npmjs.com/package/@s-berdia/opencode-router>.

## 13. Remove the router

1. Open `opencode.json` (see [step 2](#2-install-the-plugin)).
2. Remove `"@s-berdia/opencode-router"` from the `plugin` list.
3. Remove the keys that the router wrote: `model`, `small_model`, and the `model` and
   `variant` keys under `agent.plan`, `agent.build`, `agent.general`, `agent.explore`,
   `agent.title`, `agent.summary`, and `agent.compaction`. If you do not remove them,
   OpenCode continues to use those models.
4. Save the file.
5. Delete the router data.

   PowerShell:

   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\router"
   Remove-Item -Force "$env:USERPROFILE\.config\opencode\router.config.json" -ErrorAction SilentlyContinue
   ```

   Git Bash, macOS, or Linux:

   ```bash
   rm -rf ~/.config/opencode/router
   rm -f ~/.config/opencode/router.config.json
   ```

6. If you ran `install`, delete these files from `~/.config/opencode/command/`:
   `refresh-routing.md`, `routing-status.md`, `routing-plan.md`, `routing-eval.md`, and
   `routing-update.md`.
7. Restart OpenCode.
