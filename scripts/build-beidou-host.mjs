#!/usr/bin/env node
/** 北斗 Host 插件打包(TS→单文件 ESM dist/index.js;dsh 系包 external 由宿主提供) */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/beidou-dsh-host");
const result = await build({
  entryPoints: [resolve(pkgRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(pkgRoot, "dist/index.js"),
  external: ["@deepseek-ai/cordis", "@deepseek-ai/dsh-tools", "mysql2", "yaml"],
  sourcemap: "inline",
});
console.log("[build-beidou-host] bundled →", result.outputFiles?.[0]?.path ?? "dist/index.js");
