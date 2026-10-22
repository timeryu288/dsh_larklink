import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  outDir: "lib",
  outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  external: [/@deepseek-ai\//],
  platform: "node",
  target: "node20",
});
