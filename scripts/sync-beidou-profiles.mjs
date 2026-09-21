#!/usr/bin/env node
/**
 * 物化并安装北斗 DSH profiles。
 * 单一权威:profiles/beidou-common/cordis.patch.yml(工具边界 + 插件插入 + 模型固定)。
 * 生成 beidou-web(base+web-app)与 beidou-headless(base+dsh-headless)两个 profile,
 * 安装到 $DSH_HOME/profiles/<name>(默认 ~/.dsh;--home 指定隔离 home,如 ~/.dsh-beidou,
 * 审核六轮 OS 边界层:不依赖用户 ~/.dsh 的 settings/sessions 状态)。
 * 防漂移(审核六轮 P0-03):两个 profile 的 patch 都由同一份 common 生成,不手抄。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIST = join(root, "packages/dsh-plugin-beidou/dist/index.js");

const homeIdx = process.argv.indexOf("--home");
const targetHome = homeIdx > -1 ? resolve(process.argv[homeIdx + 1] ?? "") : join(homedir(), ".dsh");
const DSH_PROFILES = join(targetHome, "profiles");

const PROFILES = ["beidou-web", "beidou-headless", "beidou-sdk"];
const patch = readFileSync(join(root, "profiles/beidou-common/cordis.patch.yml"), "utf-8");
const materialized = patch.replaceAll("__BEIDOU_PLUGIN_ENTRY__", PLUGIN_DIST);

mkdirSync(DSH_PROFILES, { recursive: true });
// 隔离 home 复用本机已有 bundle 依赖(~/.dsh/profiles/node_modules,自身多为指向安装源的链接)
if (!existsSync(join(DSH_PROFILES, "node_modules")) && existsSync(join(homedir(), ".dsh/profiles/node_modules"))) {
  symlinkSync(join(homedir(), ".dsh/profiles/node_modules"), join(DSH_PROFILES, "node_modules"), "dir");
  console.log("[sync-beidou-profiles] symlinked node_modules from ~/.dsh");
}

for (const name of PROFILES) {
  const src = join(root, "profiles", name);
  const dst = join(DSH_PROFILES, name);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, "package.json"), readFileSync(join(src, "package.json"), "utf-8"));
  writeFileSync(join(dst, "cordis.patch.yml"), materialized);
  console.log(`[sync-beidou-profiles] ${name} → ${dst}`);
}
console.log(`[sync-beidou-profiles] done(home: ${targetHome};patch 来源:profiles/beidou-common/cordis.patch.yml)`);
