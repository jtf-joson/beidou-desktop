/**
 * DSH 运行时管理器:Electron 壳内启动 beidou-web profile——DeepSeek Harness 为
 * 唯一 Agent Runtime(Claude Agent SDK 已按决策移除)。
 *
 * 审核七轮 P0 修复要点:
 * - P0-01 workspace 注入:启动参数携带 workspaceDir/openId(BEIDOU_WORKSPACE/
 *   BEIDOU_OPEN_ID 注入子进程),DSH_HOME 按空间隔离;配置变化 → 重启换新实例
 * - P0-04 环境变量 allowlist:不再透传全量 process.env
 * - P0-05 状态机 idle→starting→ready→crashed/stopping:启动失败杀子进程;
 *   ready 后 exit 监听清状态(拒绝假健康);stop 走 SIGTERM→超时→SIGKILL;
 *   stderr ring buffer 供诊断
 * - 端口:仍用预分配(回环+随机已大幅收窄 TOCTOU 窗口;DSH 绑定失败会退出并报错)
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";

export interface DshRuntimeConfig {
  apiKey?: string;
  /** 当前激活工作空间目录(P0-01:插件的数据源必须与壳一致) */
  workspaceDir: string;
  /** 统一身份 openId(P0-02:与 Electron 侧共用 token 文件) */
  openId: string;
}

export interface DshRuntimeState {
  url: string;
  port: number;
  workspaceDir: string;
}

type Phase = "idle" | "starting" | "ready" | "stopping" | "crashed";

const BIN_JS = require.resolve("@deepseek-ai/dsh/lib/bin.js");
const STOP_TIMEOUT_MS = 5_000;
const STDERR_RING_MAX = 40;

function repoRoot(): string {
  // dev:out/main → 仓库根(四级);打包:resources/app-resources(构建脚本物化)
  return app.isPackaged ? join(process.resourcesPath, "app-resources") : join(__dirname, "../../..", "..");
}

function pluginDistPath(): string {
  const packaged = join(process.resourcesPath, "app-resources", "beidou-plugin", "index.js");
  const dev = join(repoRoot(), "packages/dsh-plugin-beidou/dist/index.js");
  return app.isPackaged && existsSync(packaged) ? packaged : dev;
}

/** DSH 需要 Node ≥22.15(node:zlib zstd;Electron 33 内置 node 20 不满足)。 */
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

/** 物化 beidou-web profile;DSH_HOME 按空间隔离(P0-01:会话/缓存不跨空间)。 */
function ensureDshHome(dshHome: string, workspaceDir: string): void {
  const profileDir = join(dshHome, "profiles", "beidou-web");
  mkdirSync(profileDir, { recursive: true });
  const srcProfile = join(repoRoot(), "profiles", "beidou-web", "package.json");
  const commonPatch = join(repoRoot(), "profiles", "beidou-common", "cordis.patch.yml");
  if (!existsSync(srcProfile) || !existsSync(commonPatch)) {
    throw new Error(`beidou profile 源缺失:${srcProfile} / ${commonPatch}`);
  }
  writeFileSync(join(profileDir, "package.json"), readFileSync(srcProfile, "utf-8"));
  const patch = readFileSync(commonPatch, "utf-8").replaceAll("__BEIDOU_PLUGIN_ENTRY__", pluginDistPath());
  writeFileSync(join(profileDir, "cordis.patch.yml"), patch);
  // node_modules 不预建:DSH 官方 healProfilesModuleFallback 自管(外部预建会被拒)
  void workspaceDir;
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

/** 环境变量 allowlist(P0-04:不透传全量 process.env,防凭据/代理泄漏给子进程) */
function buildChildEnv(cfg: DshRuntimeConfig, dshHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "",
    TERM: process.env.TERM ?? "",
    DSH_HOME: dshHome,
    ...(cfg.apiKey ? { DEEPSEEK_API_KEY: cfg.apiKey } : {}),
    BEIDOU_WORKSPACE: cfg.workspaceDir,
    BEIDOU_OPEN_ID: cfg.openId,
  };
}

export class DshRuntime {
  private child: ChildProcess | null = null;
  private _state: DshRuntimeState | null = null;
  private starting: Promise<DshRuntimeState> | null = null;
  private phase: Phase = "idle";
  private stderrRing: string[] = [];
  /** 崩溃/停止通知(ChatPage 可据此提示重连) */
  onCrashed: (() => void) | null = null;

  get state(): DshRuntimeState | null {
    return this._state;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** 最近 stderr(结构化诊断用) */
  get recentStderr(): string[] {
    return [...this.stderrRing];
  }

  dshHomeFor(workspaceDir: string): string {
    // P0-01:DSH_HOME 按工作空间目录隔离(哈希后缀,防路径特殊字符)
    const crypto = require("node:crypto") as { createHash(algo: string): { update(s: string): { digest(fmt: string): string } } };
    const hash = crypto.createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    return join(app?.getPath?.("userData") ?? process.cwd(), "dsh-homes", hash);
  }

  /**
   * 启动(幂等;配置变化时自动重启):物化 profile → spawn → 解析带认证 URL → 探活。
   * 同配置且已 ready 直接返回;配置不同 → stop 后以新配置重启。
   */
  async start(cfg: DshRuntimeConfig): Promise<DshRuntimeState> {
    if (this._state && this._state.workspaceDir === cfg.workspaceDir) return this._state;
    if (this.starting) return this.starting;
    if (this._state || this.child) await this.stop();
    this.starting = (async () => {
      this.phase = "starting";
      const dshHome = this.dshHomeFor(cfg.workspaceDir);
      ensureDshHome(dshHome, cfg.workspaceDir);
      const port = await findFreePort();
      const nodeExe = resolveNodeExecutable();
      const child = spawn(nodeExe, [BIN_JS, "--profile", "beidou-web", "--no-open", "--port", String(port)], {
        cwd: dshHome,
        env: buildChildEnv(cfg, dshHome),
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.stderrRing = [];
      child.stderr?.on("data", (c: Buffer) => {
        this.stderrRing.push(c.toString().trim());
        if (this.stderrRing.length > STDERR_RING_MAX) this.stderrRing.shift();
      });

      // P0-05:启动失败必须清理子进程,不留残留
      const killOnFailure = (): void => {
        if (this.child === child) {
          child.kill("SIGKILL");
          this.child = null;
        }
      };

      try {
        const url = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`DSH 启动超时(30s 未输出访问 URL)。stderr 尾部:${this.stderrRing.slice(-3).join(" | ").slice(-300)}`)), 30_000);
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
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`DSH 进程提前退出(code=${code})。stderr 尾部:${this.stderrRing.slice(-3).join(" | ").slice(-300)}`));
          });
        });
        await this.waitReady(url, 20_000);
        this._state = { url, port, workspaceDir: cfg.workspaceDir };
        this.phase = "ready";
        // P0-05:ready 后监听退出 → 清状态通知上层(拒绝假健康)
        child.once("exit", () => {
          if (this.child === child) {
            this.child = null;
            this._state = null;
            this.starting = null;
            this.phase = "crashed";
            console.error(`[dsh-runtime] 进程意外退出。stderr 尾部:${this.stderrRing.slice(-3).join(" | ").slice(-300)}`);
            this.onCrashed?.();
          }
        });
        console.log(`[dsh-runtime] beidou-web ready (workspace=${cfg.workspaceDir.split("/").pop()}) at ${url.replace(/([?&]\S+=)\S+/g, "$1***")}`);
        return this._state;
      } catch (e) {
        killOnFailure();
        this.phase = "crashed";
        throw e;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private async waitReady(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(url, { redirect: "manual" });
        if (resp.status < 500) return;
      } catch { /* 未就绪继续等 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("DSH Web 就绪探活超时");
  }

  /** P0-05:优雅停止 —— SIGTERM → 超时 SIGKILL,等待真正退出 */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.phase = "idle";
      this._state = null;
      this.starting = null;
      return;
    }
    this.phase = "stopping";
    this.child = null;
    this._state = null;
    this.starting = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveSoon();
      }, STOP_TIMEOUT_MS);
      const resolveSoon = (): void => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", resolveSoon);
      child.kill("SIGTERM");
    });
    this.phase = "idle";
  }
}

export const dshRuntime = new DshRuntime();
