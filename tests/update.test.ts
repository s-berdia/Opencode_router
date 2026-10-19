import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { main } from "../src/cli.js"
import { checkForUpdate, clearOutdatedCopies, isNewerVersion } from "../src/update.js"
import { cachedCopy, captureOutput, globalOpencodeDir, makeProject, stubRegistry, writeCatalog } from "./helpers.js"

const HOUR_MS = 60 * 60 * 1000

afterEach(() => {
  vi.restoreAllMocks()
})

describe("isNewerVersion", () => {
  it("compares the major, minor, and patch numbers", () => {
    expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true)
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true)
    expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true)
    expect(isNewerVersion("1.0.1", "1.0.1")).toBe(false)
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false)
    expect(isNewerVersion("not-a-version", "1.0.0")).toBe(false)
  })
})

describe("update check", () => {
  it("reports a newer version on npm", async () => {
    stubRegistry("1.2.0")
    expect(await checkForUpdate({ current: "1.1.0" })).toEqual({ current: "1.1.0", latest: "1.2.0" })
  })

  it("reports nothing when this is the newest version", async () => {
    stubRegistry("1.1.0")
    expect(await checkForUpdate({ current: "1.1.0" })).toBeNull()
  })

  it("asks npm at most once in 24 hours", async () => {
    const calls = stubRegistry("1.2.0")
    const now = Date.UTC(2026, 9, 19)
    await checkForUpdate({ current: "1.1.0", now })
    expect(await checkForUpdate({ current: "1.1.0", now: now + 23 * HOUR_MS })).toEqual({ current: "1.1.0", latest: "1.2.0" })
    expect(calls).toHaveLength(1)

    await checkForUpdate({ current: "1.1.0", now: now + 25 * HOUR_MS })
    expect(calls).toHaveLength(2)
  })

  it("does not ask npm when updateCheck is false", async () => {
    const calls = stubRegistry("1.2.0")
    fs.mkdirSync(globalOpencodeDir(), { recursive: true })
    fs.writeFileSync(path.join(globalOpencodeDir(), "router.config.json"), JSON.stringify({ updateCheck: false }))

    expect(await checkForUpdate({ current: "1.1.0" })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("reports nothing when npm cannot be reached", async () => {
    expect(await checkForUpdate({ current: "1.1.0" })).toBeNull()
  })
})

describe("clearOutdatedCopies", () => {
  it("removes old copies without a version and reports old pinned versions", () => {
    const latest = cachedCopy("opencode-router@latest", "1.1.0")
    const bare = cachedCopy("opencode-router", "1.1.0")
    const pinned = cachedCopy("opencode-router@1.0.1", "1.0.1")

    const result = clearOutdatedCopies("1.2.0")

    expect(result.removed.toSorted()).toEqual([bare, latest].toSorted())
    expect(result.pinned).toEqual(["opencode-router@1.0.1"])
    expect(fs.existsSync(latest)).toBe(false)
    expect(fs.existsSync(bare)).toBe(false)
    expect(fs.existsSync(pinned)).toBe(true)
  })

  it("keeps a copy that has the newest version", () => {
    const latest = cachedCopy("opencode-router@latest", "1.2.0")

    expect(clearOutdatedCopies("1.2.0")).toEqual({ removed: [], pinned: [], current: [latest], failed: [] })
    expect(fs.existsSync(latest)).toBe(true)
  })

  it("finds nothing when OpenCode has no cached copy", () => {
    expect(clearOutdatedCopies("1.2.0")).toEqual({ removed: [], pinned: [], current: [], failed: [] })
  })
})

describe("cli update", () => {
  it("removes the cached copy when npm has a newer version", async () => {
    stubRegistry("99.0.0")
    const latest = cachedCopy("opencode-router@latest", "1.0.0")

    const { result, stdout } = await captureOutput(() => main(["update", "--scope", "global"]))

    expect(result).toBe(0)
    expect(stdout).toContain("99.0.0")
    expect(stdout).toContain("Restart OpenCode")
    expect(fs.existsSync(latest)).toBe(false)
  })

  it("tells the user to change a pinned version", async () => {
    stubRegistry("99.0.0")
    cachedCopy("opencode-router@1.0.1", "1.0.1")

    const { result, stdout } = await captureOutput(() => main(["update"]))

    expect(result).toBe(0)
    expect(stdout).toContain('"@s-berdia/opencode-router@99.0.0"')
  })

  it("keeps the cached copy when it has the newest version", async () => {
    stubRegistry("99.0.0")
    const latest = cachedCopy("opencode-router@latest", "99.0.0")

    const { result, stdout } = await captureOutput(() => main(["update"]))

    expect(result).toBe(0)
    expect(stdout).toContain("newest version")
    expect(fs.existsSync(latest)).toBe(true)
  })

  it("says so when OpenCode has no cached copy", async () => {
    stubRegistry("99.0.0")

    const { result, stdout } = await captureOutput(() => main(["update"]))

    expect(result).toBe(0)
    expect(stdout).toContain("no cached copy")
  })

  it("tells the user what to do when a cached copy cannot be removed", async () => {
    stubRegistry("99.0.0")
    const latest = cachedCopy("opencode-router@latest", "1.0.0")
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EBUSY: resource busy or locked")
    })

    const { result, stderr } = await captureOutput(() => main(["update"]))

    expect(result).toBe(1)
    expect(stderr).toContain(latest)
    expect(stderr).toContain("EBUSY")
    expect(stderr).toContain("npx --prefer-online @s-berdia/opencode-router@latest update")
  })

  it("fails when npm cannot be reached", async () => {
    const latest = cachedCopy("opencode-router@latest", "1.0.0")

    const { result, stderr } = await captureOutput(() => main(["update"]))

    expect(result).toBe(1)
    expect(stderr).toContain("npm")
    expect(fs.existsSync(latest)).toBe(true)
  })
})

describe("cli status update notice", () => {
  it("shows how to update when npm has a newer version", async () => {
    writeCatalog()
    stubRegistry("99.0.0")

    const { stdout } = await captureOutput(() => main(["status", "--scope", "global"], makeProject()))

    expect(stdout).toContain("99.0.0")
    expect(stdout).toContain("/routing-update")
  })

  it("shows no notice when npm cannot be reached", async () => {
    writeCatalog()

    const { stdout } = await captureOutput(() => main(["status", "--scope", "global"], makeProject()))

    expect(stdout).not.toContain("/routing-update")
  })
})
