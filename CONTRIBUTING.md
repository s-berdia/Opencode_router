# Contributing to opencode-router

> **Early development.** opencode-router is alpha software with known gaps and bugs.
> Contributions are not just welcome; they are how this project improves. Bug reports,
> model-score corrections, documentation fixes, and code changes are all useful.

Thank you for your help. This guide tells you how to report a problem, add a model
score, and send a code change.

## Ways to help

| Task | Where to start |
| :-- | :-- |
| Report a bug | [Open a bug report](https://github.com/s-berdia/Opencode_router/issues/new?template=bug_report.yml) |
| Add or correct a model score | [Model score request](https://github.com/s-berdia/Opencode_router/issues/new?template=model_score.yml), or send a pull request (see below) |
| Ask a question or share an idea | [Discussions](https://github.com/s-berdia/Opencode_router/discussions) |
| Fix a small, known problem | [Issues with the label `good first issue`](https://github.com/s-berdia/Opencode_router/labels/good%20first%20issue) |

## Set up the project

You need Node.js 20 or later and Git.

```bash
git clone https://github.com/s-berdia/Opencode_router.git
cd Opencode_router
npm install
npm run typecheck   # check the types
npm test            # run the tests
npm run build       # compile to dist/
```

These commands work in PowerShell, CMD, Git Bash, macOS, and Linux.

To use your local build in OpenCode, follow
[Option C: from source](./USAGE.md#option-c-from-source) in the usage guide. Remove the
npm entry `"@s-berdia/opencode-router"` from your `plugin` list first. If you do not
remove it, OpenCode loads the router two times.

## Add or correct a model score

New models arrive in OpenCode often. A model without an entry in
[`model-scores.json`](./model-scores.json) gets its scores from a name pattern and a
small penalty. A checked entry gives better routing.

1. Find a model without an entry. The `--verbose` scorecard shows the source of the
   scores of each model in the routing lists. `heuristic` or `default` means that the
   model has no entry:

   ```bash
   npx @s-berdia/opencode-router refresh --dry-run --verbose
   ```

   The full list of models is in the OpenCode catalog, `~/.cache/opencode/models.json`.

2. In `model-scores.json`, add the model to `models`. Use the full model ID
   (`provider/model`). Give each value from 0 to 100:

   ```json
   "opencode-go/glm-5.3-flash": { "intelligence": 78, "speed": 72 }
   ```

   - `intelligence`: the coding quality of the model, compared to the other models in
     the file.
   - `speed`: the output speed, compared to the other models in the file.
3. If the model is a subscription model on Go or Go Plus, add its monthly allowance in
   US dollars to `monthlyCaps`. Use `null` for a model with no limit:

   ```json
   "opencode-go/glm-5.3-flash": { "go": 60, "goPlus": 180 }
   ```

4. Change `updated` at the top of the file to the date of today (`YYYY-MM-DD`).
5. Run the scorecard again. The source must now show `override`.
6. In the pull request, give the source of your values, for example a benchmark page.

## Send a code change

1. Fork the repository and make a branch from `main`.
2. For a change in behavior, write a test first. Make sure that it fails before your
   change and passes after it. The tests are in `tests/`.
3. Keep these rules:
   - The plugin hooks must never stop OpenCode. Catch errors in each hook.
   - Tests cannot use the network. `tests/setup.ts` blocks `fetch`. Use `stubRegistry`
     in `tests/helpers.ts`, or stub `fetch` in the test.
   - Do not add runtime dependencies. Users install the plugin with no dependencies.
   - Write the docs in simple English: short sentences, one instruction in each step.
4. Run `npm run typecheck`, `npm test`, and `npm run build`. All must pass.
5. If you change a command, a setting, or a file that the router writes, update
   `README.md` and `USAGE.md`.
6. Open a pull request. Fill in the template. CI runs the tests on Windows, macOS, and
   Linux with Node.js 20, 22, and 24.

## Release (maintainers only)

1. Set the new version: `npm version <patch|minor|major> --no-git-tag-version`.
2. Change the version in [Known limits](./USAGE.md#11-known-limits) in `USAGE.md`.
3. Commit, push, and wait for CI to pass.
4. Run `npm publish` in a terminal. Confirm the two-factor authentication in the browser.
5. Make a tag and a GitHub release:

   ```bash
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   gh release create v<version> --title "v<version>" --notes "<what changed>"
   ```

## License

When you send a contribution, you agree that it uses the [MIT License](./LICENSE) of
this project.
