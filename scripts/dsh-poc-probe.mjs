#!/usr/bin/env node
/**
 * V1 无头冒烟(docs/acceptance/V1):起 dsh web --patch,验证插件装载与 beidou_ping 注册。
 * 通过标准:日志出现 [beidou-work] plugin loaded;HTTP 可达;无 beidou 相关 loader 错误;退出时进程组干净。
 */
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchFile = resolve(root, ".tmp/cordis.local.yml");
if (!existsSync(patchFile)) {
  console.error("V1 FAIL: .tmp/cordis.local.yml 不存在;先运行 node scripts/generate-cordis-config.mjs");
  process.exit(1);
}

// 杀掉残留的 dsh(上次 probe 泄漏)
try { execSync('pkill -f "dsh web.*cordis.local" 2>/dev/null || true', { shell: "/bin/bash" }); } catch {}
await sleep(1000);

const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(npxBin, ["dsh", "web", "--patch", patchFile, "--no-open"], {
  cwd: root,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // 进程组(SIGTERM 能到达 dsh 孙进程)
});
let out = "";
const stamp = (d) => { out += d.toString(); };
proc.stdout.on("data", stamp);
proc.stderr.on("data", stamp);

let httpOk = false;
const deadline = Date.now() + 60_000;
try {
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const r = await fetch("http://127.0.0.1:3080/");
      if (r.ok || r.status < 500) { httpOk = true; break; }
    } catch { /* server not up yet */ }
  }
  await sleep(3000);
} finally {
  try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
  await sleep(1000);
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already dead */ }
}

// 判定:beidou 行的 loader 错误(不误报无关 loader 字样)
const beidouLoaderError = out.split("\n").some((line) =>
  /loader|Failed to resolve|Cannot find module/i.test(line) && /beidou/i.test(line),
);
const loaded = out.includes("[beidou-work] plugin loaded");

console.log("\n--- V1 判定 ---");
console.log("plugin loaded:", loaded);
console.log("http 3080 reachable:", httpOk);
console.log("beidou loader error:", beidouLoaderError);
if (!loaded || !httpOk || beidouLoaderError) { console.log("V1 FAIL"); process.exit(1); }
console.log("V1 PASS");
process.exit(0); // 显式退出(防管道 FD 挂起)
