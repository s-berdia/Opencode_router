import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser"

/** Global OpenCode config directory. Honors XDG_CONFIG_HOME like OpenCode does. */
export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

/** OpenCode cache directory. Honors XDG_CACHE_HOME like OpenCode does. */
export function opencodeCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache")
  return path.join(base, "opencode")
}

/** OpenCode model catalog cache written by the OpenCode CLI/desktop. */
export function catalogCacheFile(): string {
  return path.join(opencodeCacheDir(), "models.json")
}

/**
 * The committed score table that ships with the package. Resolved relative to
 * this module, which puts it at the package root both in `src/` (tests) and in
 * the bundled `dist/bin.js`.
 */
export function scoreTableFile(): string {
  return fileURLToPath(new URL("../model-scores.json", import.meta.url))
}

/** The credentials file `opencode auth login` writes. */
export function authFile(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
}

export function globalRouterConfigFile(): string {
  return path.join(globalConfigDir(), "router.config.json")
}

export function projectRouterConfigFile(dir: string): string {
  return path.join(dir, ".opencode", "router.config.json")
}

/** Candidate opencode.json paths, most specific first. */
export function opencodeConfigCandidates(dir: string): string[] {
  return [path.join(dir, ".opencode", "opencode.json"), path.join(dir, "opencode.jsonc"), path.join(dir, "opencode.json")]
}

export function globalOpencodeConfigCandidates(): string[] {
  return [path.join(globalConfigDir(), "opencode.jsonc"), path.join(globalConfigDir(), "opencode.json")]
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function pathExists(file: string): boolean {
  try {
    fs.statSync(file)
    return true
  } catch {
    return false
  }
}

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "opencode.json",
  "opencode.jsonc",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
]

/** True when `dir` looks like a real project (used to pick the config scope). */
export function isProjectDir(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => pathExists(path.join(dir, marker)))
}

export interface JsoncResult {
  value?: unknown
  /** The first parse problem and its line, when the text is not valid JSONC. */
  error?: string
}

/** Parse JSON that may contain comments and trailing commas. */
export function parseJsonc(text: string): JsoncResult {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first) return { error: `${printParseErrorCode(first.error)} at line ${lineAt(text, first.offset)}` }
  return { value }
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length
}

export type JsonFile<T> = { status: "absent" } | { status: "ok"; value: T } | { status: "invalid"; error: string }

function readText(file: string): string | undefined {
  try {
    // Strip a UTF-8 byte order mark: some Windows editors add one.
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "")
  } catch {
    return undefined
  }
}

/** Read a JSON(C) file. A missing or empty file is "absent"; a broken one is "invalid". */
export function readJsonFile<T = unknown>(file: string): JsonFile<T> {
  const text = readText(file)
  if (text === undefined || text.trim() === "") return { status: "absent" }
  const parsed = parseJsonc(text)
  if (parsed.error !== undefined) return { status: "invalid", error: parsed.error }
  return { status: "ok", value: parsed.value as T }
}

/** The parsed value of a JSON(C) file, or undefined when it is missing or broken. */
export function readJson<T = unknown>(file: string): T | undefined {
  const result = readJsonFile<T>(file)
  return result.status === "ok" ? result.value : undefined
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Write through a temp file and a rename, so a crash never leaves half a file. */
export function writeTextAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, text, "utf8")
  try {
    fs.renameSync(temp, file)
  } catch {
    // Windows can refuse the rename while another process has the file open.
    fs.writeFileSync(file, text, "utf8")
    fs.rmSync(temp, { force: true })
  }
}

export function writeJson(file: string, value: unknown): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + "\n")
}

/** jsonc-parser throws when asked to remove a key whose parent is missing. */
function hasPath(text: string, keyPath: string[]): boolean {
  const tree = parseTree(text)
  return tree !== undefined && findNodeAtLocation(tree, keyPath) !== undefined
}

export interface JsonEdit {
  path: string[]
  /** `undefined` removes the key. */
  value: unknown
}

/**
 * Change some keys of a JSON(C) file and keep everything else, including
 * comments and formatting. Throws when the file is not a valid JSON object,
 * so a broken file is never replaced.
 */
export function editJsonFile(file: string, edits: JsonEdit[], initialText = "{}\n"): { created: boolean } {
  const current = readJsonFile(file)
  if (current.status === "invalid") {
    throw new Error(`${file} has a JSON error (${current.error}). Fix the file and run the command again. The file was not changed.`)
  }
  if (current.status === "ok" && !isPlainObject(current.value)) {
    throw new Error(`${file} does not contain a JSON object. The file was not changed.`)
  }

  const created = !fileExists(file)
  let text = current.status === "ok" ? (readText(file) ?? initialText) : initialText
  const formattingOptions = {
    insertSpaces: !/^\t/m.test(text),
    tabSize: 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  }
  for (const edit of edits) {
    if (edit.value === undefined && !hasPath(text, edit.path)) continue
    text = applyEdits(text, modify(text, edit.path, edit.value, { formattingOptions }))
  }
  writeTextAtomic(file, text)
  return { created }
}
