import { authFile, readJson } from "./paths.js"

export interface AuthEntry {
  type: string
  key: string
}

/**
 * The API keys `opencode auth login` stored, keyed by provider id. Empty when
 * nothing is signed in or the file is broken: eval treats that as "no key".
 */
export function storedKeys(file: string = authFile()): Map<string, string> {
  const out = new Map<string, string>()
  const value = readJson<Record<string, unknown>>(file)
  if (!value || typeof value !== "object") return out
  for (const [providerID, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue
    const key = (entry as AuthEntry).key
    if (typeof key === "string" && key.length > 0) out.set(providerID, key)
  }
  return out
}
