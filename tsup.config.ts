import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    bin: "src/bin.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: false,
  external: ["@opencode/plugin"],
  // Bundle jsonc-parser so users install no runtime dependencies. Its ESM
  // build must win: esbuild cannot follow the require() calls in its UMD build.
  noExternal: ["jsonc-parser"],
  esbuildOptions(options) {
    options.mainFields = ["module", "main"]
  },
})
