#!/usr/bin/env node
/**
 * 打包 dsh 插件为单文件 JS(esbuild bundle):解决 dsh ESM loader 不认 TS 源码的问题(P0-3:引用稳定产物)。
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [resolve(root, "packages/dsh-plugin-beidou/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(root, "packages/dsh-plugin-beidou/dist/index.js"),
  alias: {
    "@beidou-core": resolve(root, "packages/beidou-core/src"),
    "@beidou-ontology": resolve(root, "packages/ontology-schema/src/index.ts"),
  },
  external: ["@deepseek-ai/cordis", "@deepseek-ai/dsh-tools", "mysql2", "yaml"],
  sourcemap: "inline",
});

console.log("[build-plugin] bundled →", result.outputFiles?.[0]?.path ?? "dist/index.js");
