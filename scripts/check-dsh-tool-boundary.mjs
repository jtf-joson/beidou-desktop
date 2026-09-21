#!/usr/bin/env node
/**
 * 工具边界 CI 断言(审核七轮 P0-08 配置层常驻门禁):
 * 对 beidou-web profile 跑 --dump-config,断言 15 个内置工具行在后写胜出终态全部禁用、
 * beidou-work 插件存在、模型固定 deepseek-official。任一不满足 → 退出码 1。
 * 用法:node scripts/check-dsh-tool-boundary.mjs [--home ~/.dsh-beidou]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeIdx = process.argv.indexOf("--home");
const targetHome = homeIdx > -1 ? resolve(process.argv[homeIdx + 1] ?? "") : join(homedir(), ".dsh-beidou");
const BIN = resolve(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");

// 物化 profile(与 sync-beidou-profiles.mjs 同源)
const profiles = join(targetHome, "profiles");
for (const name of ["beidou-web"]) {
  const dst = join(profiles, name);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, "package.json"), readFileSync(join(root, "profiles", name, "package.json"), "utf-8"));
  const patch = readFileSync(join(root, "profiles/beidou-common/cordis.patch.yml"), "utf-8")
    .replaceAll("__BEIDOU_PLUGIN_ENTRY__", resolve(root, "packages/dsh-plugin-beidou/dist/index.js"));
  writeFileSync(join(dst, "cordis.patch.yml"), patch);
}

const out = execFileSync("node", [BIN, "--profile", "beidou-web", "--dump-config"], {
  cwd: targetHome,
  env: { ...process.env, DSH_HOME: targetHome },
  encoding: "utf-8",
});

// 后写胜出终态:每个 id 取最后一次出现的块
const blocks = out.split(/(?=- id: )/);
const final = {};
for (const b of blocks) {
  const id = b.match(/- id: ([\w/-]+)/)?.[1];
  if (id) final[id] = b;
}
const REQUIRED_DISABLED = [
  "tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search", "tool-skill",
  "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent", "tool-subagent-fork",
  "tool-workflow", "tool-todo", "tool-goal", "tool-ralph", "tool-web",
];
let failed = false;
for (const id of REQUIRED_DISABLED) {
  const disabled = final[id]?.includes("disabled: true");
  console.log(`  ${id.padEnd(26)} ${disabled ? "✓ disabled" : "✗ 仍启用或行缺失"}`);
  if (!disabled) failed = true;
}
const hasPlugin = Object.keys(final).includes("beidou-work");
const modelPinned = final["agent-default-model"]?.includes("deepseek-official");
console.log(`  beidou-work 插件            ${hasPlugin ? "✓" : "✗ 缺失"}`);
console.log(`  模型固定 deepseek-official  ${modelPinned ? "✓" : "✗"}`);
if (!hasPlugin || !modelPinned) failed = true;
if (failed) { console.error("工具边界断言失败"); process.exit(1); }
console.log("工具边界断言通过(15 行全禁 + 插件在 + 模型固定)");
