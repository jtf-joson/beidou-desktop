/**
 * DSH 运行时管理器:Electron 壳内启动 beidou-web profile——DeepSeek Harness 为
 * 唯一 Agent Runtime(Claude Agent SDK 已按决策移除)。
 *
 * - 独立 DSH_HOME(userData/dsh-home):与用户 ~/.dsh 隔离,settings 全新,
 *   避免用户保存的模型选择覆盖 beidou 行默认(deepseek-official,Phase A 实证)
 * - beidou-web profile 由 profiles/beidou-common(单一权威 patch)物化,
 *   插件路径解析为本机产物(dev=仓库 dist;打包=resources/beidou-plugin)
 * - 127.0.0.1 + 动态端口 + --no-open(官方限制不可绑全网卡);stdout 解析带认证 URL
 * - 子进程用 ELECTRON_RUN_AS_NODE 复用 Electron 自带 node(产品不自带 node)
 * - 退出时终止;启动失败 fail-fast 上报
 */
import { app } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export interface DshRuntimeState {
  url: string;
  port: number;
}

const BIN_JS = require.resolve("@deepseek-ai/dsh/lib/bin.js");

/**
 * DSH 需要 Node ≥22.15(node:zlib zstd API;Electron 33 内置 node 20 不满足,
 * 且其 ESM 无 import.meta.main 会让 bin.js 静默退出)。解析优先级:
 * DAW_NODE_BIN 注入 > PATH 上的 node > 常见安装路径;并校验版本。
 */
function resolveNodeExecutable(): string {
  const candidates = [
    process.env.DAW_NODE_BIN,
    "node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    join(homedir(), ".nvm/versions/node/v22.22.0/bin/node"),
  ].filter(Boolean) as string[];
  for (const cand of candidates) {
    try {
      const r = spawnSync(cand, ["-e", "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=15)?0:3)"], { encoding: "utf-8" });
      if (r.status === 0) return cand;
    } catch { /* 试下一个 */ }
  }
  throw new Error("未找到 Node ≥22.15(DSH 运行时要求 node:zlib zstd)。请安装 node 22+ 或设置 DAW_NODE_BIN 指向 node 可执行文件。");
}

function repoRoot(): string {
  // dev:out/main → 仓库根(四级);打包:resources/app-resources(构建脚本物化)
  return app.isPackaged ? join(process.resourcesPath, "app-resources") : join(__dirname, "../../..", "..");
}

function pluginDistPath(): string {
  const packaged = join(process.resourcesPath, "app-resources", "beidou-plugin", "index.js");
  const dev = join(repoRoot(), "packages/dsh-plugin-beidou/dist/index.js");
  return app.isPackaged && existsSync(packaged) ? packaged : dev;
}

/** 物化 beidou-web profile 到 DSH_HOME(profiles/node_modules 链接到本机 node_modules) */
function ensureDshHome(dshHome: string): { profileDir: string } {
  const profilesDir = join(dshHome, "profiles");
  const profileDir = join(profilesDir, "beidou-web");
  mkdirSync(profileDir, { recursive: true });

  const srcProfile = join(repoRoot(), "profiles", "beidou-web", "package.json");
  const commonPatch = join(repoRoot(), "profiles", "beidou-common", "cordis.patch.yml");
  if (!existsSync(srcProfile) || !existsSync(commonPatch)) {
    throw new Error(`beidou profile 源缺失:${srcProfile} / ${commonPatch}`);
  }
  writeFileSync(join(profileDir, "package.json"), readFileSync(srcProfile, "utf-8"));
  const patch = readFileSync(commonPatch, "utf-8").replaceAll("__BEIDOU_PLUGIN_ENTRY__", pluginDistPath());
  writeFileSync(join(profileDir, "cordis.patch.yml"), patch);

  // bundle 依赖不预建:DSH 官方 healProfilesModuleFallback 自管 profiles/node_modules
  // 与 .dsh-module-fallback(外部预建会被判定 "not a symlink or dsh-managed" 拒绝启动)。
  return { profileDir };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export class DshRuntime {
  private child: ChildProcess | null = null;
  private _state: DshRuntimeState | null = null;
  private starting: Promise<DshRuntimeState> | null = null;

  get state(): DshRuntimeState | null {
    return this._state;
  }

  get dshHome(): string {
    return join(app?.getPath?.("userData") ?? process.cwd(), "dsh-home");
  }

  /** 启动(幂等):物化 profile → spawn → 解析带认证 URL → 探活 */
  async start(env: { DEEPSEEK_API_KEY?: string }): Promise<DshRuntimeState> {
    if (this._state) return this._state;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      ensureDshHome(this.dshHome);
      const port = await findFreePort();
      const nodeExe = resolveNodeExecutable();
      const child = spawn(nodeExe, [BIN_JS, "--profile", "beidou-web", "--no-open", "--port", String(port)], {
        cwd: this.dshHome,
        env: {
          ...process.env,
          DSH_HOME: this.dshHome,
          ...(env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("DSH 启动超时(30s 未输出访问 URL)")), 30_000);
        let buf = "";
        const onData = (chunk: Buffer): void => {
          buf += chunk.toString();
          const m = /https?:\/\/127\.0\.0\.1:\d+\S*/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(m[0].replace(/[)\s"']+$/, ""));
          }
        };
        child.stdout!.on("data", onData);
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`DSH 进程提前退出(code=${code}):${buf.slice(-500)}`));
        });
      });

      await this.waitReady(url, 20_000);
      this._state = { url, port };
      console.log(`[dsh-runtime] beidou-web ready at ${url.replace(/([?&]\S+=)\S+/g, "$1***")}`);
      return this._state;
    })().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private async waitReady(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(url, { redirect: "manual" });
        if (resp.status < 500) return; // 200/3xx/401 均视为服务已监听
      } catch { /* 未就绪继续等 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("DSH Web 就绪探活超时");
  }

  stop(): void {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
      this._state = null;
      this.starting = null;
    }
  }
}

export const dshRuntime = new DshRuntime();
