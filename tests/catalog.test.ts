import { describe, expect, it } from "vitest"
import { mapModel } from "../src/catalog.js"

describe("mapModel", () => {
  it("keeps the canonical model id used for benchmark joins", () => {
    const mapped = mapModel("opencode-go", {
      id: "glm-5.3-flash",
      canonical_model_id: "zhipuai/glm-5.3-flash",
      cost: { input: 0.3, output: 1.2 },
    })
    expect(mapped.canonicalModelID).toBe("zhipuai/glm-5.3-flash")
  })

  it("leaves the canonical id undefined for older catalog entries", () => {
    expect(mapModel("opencode-go", { id: "legacy" }).canonicalModelID).toBeUndefined()
  })
})
