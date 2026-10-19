import { defineConfig } from "tsup";

// Builds the release package into dist/: JS plus .d.ts.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "es2023",
  platform: "neutral",
  // tsup sets baseUrl, which TypeScript 6 warns about.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  sourcemap: true,
});
