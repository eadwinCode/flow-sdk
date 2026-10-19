import { defineConfig } from "tsup";

// Builds the npm package into dist/. @clevix/protocol is private, so its code and
// types are bundled in. hono, express and react stay external (optional peer deps).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    cloudflare: "src/cloudflare.ts",
    express: "src/express.ts",
    hono: "src/hono.ts",
    next: "src/next.ts",
    realtime: "src/realtime.ts",
    react: "src/react.ts",
  },
  format: ["esm"],
  target: "es2023",
  platform: "neutral",
  dts: {
    compilerOptions: {
      // tsup sets baseUrl, which TypeScript 6 warns about.
      ignoreDeprecations: "6.0",
      // Point at the source, not node_modules, so the types get inlined.
      paths: { "@clevix/protocol": ["../protocol/src/index.ts"] },
    },
  },
  noExternal: ["@clevix/protocol"],
  external: ["hono", "express", "react", /^node:/],
  clean: true,
  sourcemap: true,
});
