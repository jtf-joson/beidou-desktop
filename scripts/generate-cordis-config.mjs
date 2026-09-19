#!/usr/bin/env node
/**
 * 生成 dsh 本地 patch 配置(P0-4 可移植:仓库只提交 example,绝对路径运行时生成)。
 * 用法:node scripts/generate-cordis-config.mjs → 写 .tmp/cordis.local.yml
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tpl = readFileSync(resolve(root, "packages/dsh-plugin-beidou/cordis.example.yml"), "utf-8");
const entry = resolve(root, "packages/dsh-plugin-beidou/dist/index.js");
const out = resolve(root, ".tmp/cordis.local.yml");
mkdirSync(resolve(root, ".tmp"), { recursive: true });
writeFileSync(out, tpl.replaceAll("__BEIDOU_PLUGIN_ENTRY__", entry), "utf-8");
console.log(`[generate-cordis-config] wrote ${out} (entry: ${entry})`);
