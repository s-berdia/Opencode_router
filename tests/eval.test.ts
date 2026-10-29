import { describe, expect, it } from "vitest"
import { messageText, orderMeasured } from "../src/eval.js"
import type { EvalRow, EvalStatus } from "../src/eval.js"
import type { RankingEntry } from "../src/types.js"

function entry(rank: number, id: string): RankingEntry {
  return {
    rank,
    providerID: id.split("/")[0]!,
    modelID: id.split("/")[1]!,
    id,
    variant: "medium",
    score: 80,
    intelligence: 70,
    speed: 70,
    endurance: 100,
    reliability: 85,
    tokensPer5h: null,
    monthlyCapUSD: null,
    sources: { intelligence: "override", speed: "override", endurance: "cap", reliability: "default" },
    class: "subscription",
  }
}

function row(rank: number, id: string, status: EvalStatus, pass: number, latencyMs: number): EvalRow {
  return {
    entry: entry(rank, id),
    result: {
      ok: status !== "FAIL" && status !== "SKIP",
      latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      text: "",
    },
    pass,
    status,
  }
}

describe("orderMeasured", () => {
  it("ranks answers above failed and skipped calls", () => {
    const rows = [
      row(1, "opencode-go/weak", "WEAK", 2, 10),
      row(2, "opencode-go/pass", "PASS", 7, 30_000),
      row(3, "opencode-go/fail", "FAIL", 0, 0),
      row(4, "opencode/skip", "SKIP", 0, 0),
    ]

    expect(orderMeasured(rows).map((r) => r.entry.id)).toEqual([
      "opencode-go/pass",
      "opencode-go/weak",
      "opencode-go/fail",
      "opencode/skip",
    ])
  })

  it("breaks ties by latency, then predicted rank", () => {
    const rows = [
      row(3, "opencode-go/slow", "PASS", 7, 900),
      row(1, "opencode-go/fast-b", "PASS", 7, 500),
      row(2, "opencode-go/fast-a", "PASS", 7, 500),
    ]

    expect(orderMeasured(rows).map((r) => r.entry.id)).toEqual([
      "opencode-go/fast-b",
      "opencode-go/fast-a",
      "opencode-go/slow",
    ])
  })

  it("does not mutate the input", () => {
    const rows = [row(1, "opencode-go/slow", "PASS", 7, 900), row(2, "opencode-go/fast", "PASS", 7, 500)]
    const before = rows.map((r) => r.entry.id)

    orderMeasured(rows)

    expect(rows.map((r) => r.entry.id)).toEqual(before)
  })
})

describe("messageText", () => {
  it("prefers content when the model wrote an answer", () => {
    expect(messageText({ content: "answer", reasoning: "thought" })).toBe("answer")
  })

  // OpenCode's own Go endpoints answer in `reasoning`, not `reasoning_content`.
  it("falls back to `reasoning` when content is empty", () => {
    expect(messageText({ content: "", reasoning: "from reasoning" })).toBe("from reasoning")
  })

  it("keeps the older `reasoning_content` name working", () => {
    expect(messageText({ content: "", reasoning_content: "from reasoning_content" })).toBe("from reasoning_content")
  })

  it("treats a message with no text as empty, not undefined", () => {
    expect(messageText({ content: "" })).toBe("")
    expect(messageText(undefined)).toBe("")
  })
})
