import { describe, expect, it } from "vitest"
import { canonicalModelKey, fetchGoCaps, mergeGoCaps, parseGoCaps } from "../src/go-caps.js"
import { loadDefaultTable } from "../src/score-table.js"
import { monthlyCapFor } from "../src/scoring.js"

const known = [
  { id: "opencode-go/glm-5.3-flash", free: false },
  { id: "opencode-go/deepseek-v4.1-flash", free: false },
  { id: "opencode-go/step-5-preview", free: false },
  { id: "opencode-go/gemini-4-argon", free: false },
  { id: "opencode-go/claude-haiku-5-5", free: false },
  { id: "opencode-go/muse-spark-1.2-contributor", free: false },
  { id: "opencode-go/beam-free", free: true },
]

function planPanel(plan: string, rows: string): string {
  return `<div role="tabpanel" id="go-pricing-panel-${plan}" data-plan-panel="${plan}"><div><table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
}

function row(name: string, cap: string): string {
  return `<tr><td>${name}</td><td>$1.00</td><td>$2.00</td><td>-</td><td>-</td><td><strong>${cap}</strong></td></tr>`
}

const html = `
${planPanel("go", [
  row("GLM-5.3-Flash", "$60"),
  row("DeepSeek V4.1 Flash (Off-Peak)", "$100"),
  row("DeepSeek V4.1 Flash (Peak)", "$100"),
  row("Step 5 Preview", "$15"),
  row("Gemini 4 Argon (50% off)", "$30"),
  row("Claude Haiku 5.5 (≤ 100K tokens)", "$15"),
  row("Beam Free", "Unlimited"),
].join(""))}
${planPanel("go-plus", [
  row("GLM-5.3-Flash", "$180"),
  row("DeepSeek V4.1 Flash (Off-Peak)", "$200"),
  row("Step 5 Preview", "$60"),
  row("Gemini 4 Argon (50% off)", "$120"),
  row("Claude Haiku 5.5 (≤ 100K tokens)", "$60"),
  row("Beam Free", "Unlimited"),
].join(""))}
${planPanel("go-teams", [
  row("GLM-5.3-Flash", "$65"),
  row("DeepSeek V4.1 Flash (Off-Peak)", "$105"),
  row("Step 5 Preview", "$20"),
  row("Gemini 4 Argon (50% off)", "$35"),
  row("Claude Haiku 5.5 (≤ 100K tokens)", "$20"),
  row("Beam Free", "Unlimited"),
].join(""))}
<table><thead><tr><th>Model</th><th>Model training</th><th>Data retention</th></tr></thead><tbody>
<tr><td>GLM-5.3-Flash</td><td>Not used</td><td>0 days</td></tr>
<tr><td>Muse Spark 1.2 Contributor</td><td>Yes</td><td>Not ZDR</td></tr>
<tr><td>Beam Free</td><td>Not used</td><td>30 days</td></tr>
</tbody></table>
`

describe("bundled Go caps", () => {
  it("keeps the documented fallback caps in sync", () => {
    const table = loadDefaultTable()
    expect(table.monthlyCaps["opencode-go/deepseek-v4.1-flash"]).toMatchObject({ go: 100, goPlus: 200, goTeams: 105 })
    expect(table.monthlyCaps["opencode-go/step-5-preview"]).toMatchObject({ go: 15, goPlus: 60, goTeams: 20 })
    expect(table.monthlyCaps["opencode-go/gemini-4-argon"]).toMatchObject({ go: 30, goPlus: 120, goTeams: 35 })
    expect(table.monthlyCaps["opencode-go/kimi-k3.1-pro"]).toMatchObject({ go: 15, goPlus: 60, goTeams: 20 })
    expect(table.monthlyCaps["opencode-go/minimax-m3.1-flash"]).toMatchObject({ go: 20, goPlus: 80, goTeams: 25 })
  })
})

describe("go-caps parsing", () => {
  it("reads all three plan tables and matches display names to model ids", () => {
    const caps = parseGoCaps(html, known)
    expect(caps.plans.go["opencode-go/glm-5.3-flash"]).toBe(60)
    expect(caps.plans["go-plus"]["opencode-go/glm-5.3-flash"]).toBe(180)
    expect(caps.plans["go-teams"]["opencode-go/glm-5.3-flash"]).toBe(65)
    expect(caps.plans.go["opencode-go/deepseek-v4.1-flash"]).toBe(100)
    expect(caps.plans.go["opencode-go/step-5-preview"]).toBe(15)
    expect(caps.plans.go["opencode-go/gemini-4-argon"]).toBe(30)
    expect(caps.plans.go["opencode-go/claude-haiku-5-5"]).toBe(15)
    expect(caps.plans.go["opencode-go/beam-free"]).toBeNull()
  })

  it("keeps the first cap when a model has peak and off-peak rows", () => {
    const caps = parseGoCaps(html, known)
    expect(caps.plans.go["opencode-go/deepseek-v4.1-flash"]).toBe(100)
  })

  it("reads the privacy table", () => {
    const caps = parseGoCaps(html, known)
    expect(caps.privacy["opencode-go/glm-5.3-flash"]).toMatchObject({ training: false, retention: "0 days" })
    expect(caps.privacy["opencode-go/muse-spark-1.2-contributor"]).toMatchObject({ training: true, retention: "Not ZDR" })
    expect(caps.privacy["opencode-go/beam-free"]).toMatchObject({ training: false, retention: "30 days" })
  })

  it("normalizes punctuation and tier suffixes", () => {
    expect(canonicalModelKey("Claude Haiku 5.5 (≤ 100K tokens)")).toBe("claudehaiku55")
    expect(canonicalModelKey("claude-haiku-5-5")).toBe("claudehaiku55")
    expect(canonicalModelKey("MiniMax M3 (> 512K tokens)")).toBe("minimaxm3")
  })

  it("reports live paid models that the docs no longer list", () => {
    const caps = parseGoCaps(planPanel("go", row("GLM-5.3-Flash", "$60")), known)
    expect(caps.missing).toContain("opencode-go/step-5-preview")
    expect(caps.missing).not.toContain("opencode-go/beam-free")
  })

  it("fetches a page with an injected fetch", async () => {
    const caps = await fetchGoCaps({
      known,
      fetchImpl: (async () => new Response(html, { status: 200 })) as typeof fetch,
    })
    expect(caps.plans.go["opencode-go/glm-5.3-flash"]).toBe(60)
  })

  it("overlays fetched caps and makes Go Teams use its own cap", () => {
    const caps = parseGoCaps(html, known)
    const table = loadDefaultTable()
    mergeGoCaps(table, caps)
    expect(table.goCaps?.source).toBe(caps.source)
    expect(monthlyCapFor("opencode-go/glm-5.3-flash", table, "go")).toBe(60)
    expect(monthlyCapFor("opencode-go/glm-5.3-flash", table, "go-plus")).toBe(180)
    expect(monthlyCapFor("opencode-go/glm-5.3-flash", table, "go-teams")).toBe(65)
  })
})
