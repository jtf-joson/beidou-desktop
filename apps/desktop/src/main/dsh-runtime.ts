/**
 * DSH SDK 运行时:Electron 壳 spawn beidou-sdk profile(stdio JSON-RPC,
 * 协议 @deepseek-ai/dsh-sdk-protocol),自研聊天窗口经此驱动 DSH Agent。
 * (取代 beidou-web 内嵌方案:不再嵌 DSH Web UI,避免双导航;0.17.2)
 *
 * 协议:换行分隔 JSON-RPC 2.0 —— initialize(cwd/provider/model)→
 * session/prompt(sessionId+contentBlocks)→ session.event/session.status 通知流。
 * stdout 只应有 JSON-RPC 帧(插件日志已全部改 stderr;解析层仍容错过滤非 JSON 行)。
 *
 * 复用审核七轮修复:env allowlist / DSH_HOME 按空间哈希隔离 / 状态机 /
 * 启动失败杀进程 / ready 后 exit 监听清状态 / SIGTERM→SIGKILL。
 */
import { app } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export interface DshRuntimeConfig {
  apiKey?: string;
  workspaceDir: string;
  openId: string;
}

export interface SdkEventFrame {
  kind: "session.event" | "session.status";
  sessionId?: string;
  status?: string;
  event?: { type: string; seq?: number; time?: number; data?: unknown };
}

interface SessionIndexEntry {
  id: string;
  title: string;
  lastTs: string;
}

const BIN_JS = require.resolve("@deepseek-ai/dsh/lib/bin.js");
const STOP_TIMEOUT_MS = 5_000;
const INIT_TIMEOUT_MS = 60_000; // initialize 会等插件树 settle(含工作区装载)

function repoRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, "app-resources") : join(__dirname, "../../..", "..");
}

function pluginDistPath(): string {
  const packaged = join(process.resourcesPath, "app-resources", "beidou-plugin", "index.js");
  const dev = join(repoRoot(), "packages/dsh-plugin-beidou/dist/index.js");
  return app.isPackaged && existsSync(packaged) ? packaged : dev;
}

/** DSH 需要 Node ≥22.15(node:zlib zstd;Electron 33 内置 node 20 不满足)。 */
export function resolveNodeExecutable(): string {
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
  throw new Error("未找到 Node ≥22.15(DSH 运行时要求 node:zlib zstd)。请安装 node 22+ 或设置 DAW_NODE_BIN。");
}

/** 物化 beidou-sdk profile;DSH_HOME 按空间隔离;node_modules 由 DSH 官方自管。 */
function ensureDshHome(dshHome: string): void {
  const profileDir = join(dshHome, "profiles", "beidou-sdk");
  mkdirSync(profileDir, { recursive: true });
  const srcProfile = join(repoRoot(), "profiles", "beidou-sdk", "package.json");
  const commonPatch = join(repoRoot(), "profiles", "beidou-common", "cordis.patch.yml");
  if (!existsSync(srcProfile) || !existsSync(commonPatch)) {
    throw new Error(`beidou profile 源缺失:${srcProfile} / ${commonPatch}`);
  }
  writeFileSync(join(profileDir, "package.json"), readFileSync(srcProfile, "utf-8"));
  const patch = readFileSync(commonPatch, "utf-8").replaceAll("__BEIDOU_PLUGIN_ENTRY__", pluginDistPath());
  writeFileSync(join(profileDir, "cordis.patch.yml"), patch);
}

/** 环境变量 allowlist(不透传全量 process.env) */
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

type Phase = "idle" | "starting" | "ready" | "stopping" | "crashed";

export class DshSdkRuntime {
  private child: ChildProcess | null = null;
  private phase: Phase = "idle";
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private cfg: DshRuntimeConfig | null = null;
  private stderrRing: string[] = [];
  /** 事件出口(主进程转发渲染层) */
  onEvent: ((frame: SdkEventFrame) => void) | null = null;
  onCrashed: (() => void) | null = null;

  get currentPhase(): Phase {
    return this.phase;
  }

  get ready(): boolean {
    return this.phase === "ready";
  }

  dshHomeFor(workspaceDir: string): string {
    const crypto = require("node:crypto") as { createHash(algo: string): { update(s: string): { digest(fmt: string): string } } };
    const hash = crypto.createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    return join(app?.getPath?.("userData") ?? process.cwd(), "dsh-homes", hash);
  }

  /** 会话索引文件(本地维护会话列表;DSH 侧另有完整持久化) */
  private indexFile(): string {
    return join(this.dshHomeFor(this.cfg?.workspaceDir ?? ""), "session-index.json");
  }

  listSessions(): SessionIndexEntry[] {
    try {
      return JSON.parse(readFileSync(this.indexFile(), "utf-8")) as SessionIndexEntry[];
    } catch {
      return [];
    }
  }

  private recordSession(entry: SessionIndexEntry): void {
    const list = this.listSessions().filter((s) => s.id !== entry.id);
    list.unshift(entry);
    try {
      writeFileSync(this.indexFile(), JSON.stringify(list.slice(0, 200), null, 2), "utf-8");
    } catch { /* 索引失败不阻塞 */ }
  }

  /** 启动(幂等;配置变化自动重启):spawn → initialize 握手 → 事件流监听 */
  async start(cfg: DshRuntimeConfig): Promise<void> {
    if (this.phase === "ready" && this.cfg && this.cfg.workspaceDir === cfg.workspaceDir) return;
    if (this.phase === "starting") return;
    await this.stop();
    this.phase = "starting";
    this.cfg = cfg;
    const dshHome = this.dshHomeFor(cfg.workspaceDir);
    ensureDshHome(dshHome);
    const nodeExe = resolveNodeExecutable();
    const child = spawn(nodeExe, [BIN_JS, "--profile", "beidou-sdk"], {
      cwd: cfg.workspaceDir,
      env: buildChildEnv(cfg, dshHome),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderrRing = [];
    child.stderr?.on("data", (c: Buffer) => {
      this.stderrRing.push(c.toString().trim());
      if (this.stderrRing.length > 40) this.stderrRing.shift();
      process.stderr.write("[dsh-sdk] " + c);
    });
    // stdout:换行分隔 JSON-RPC;容错过滤非 JSON 行(如上游库误打到 stdout 的日志)
    let buf = "";
    child.stdout!.on("data", (c: Buffer) => {
      buf += c.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          this.handleFrame(JSON.parse(line) as Record<string, unknown>);
        } catch { /* 非 JSON 行忽略 */ }
      }
    });

    try {
      await this.request("initialize", { cwd: cfg.workspaceDir, provider: "deepseek-official", model: "deepseek-chat" }, INIT_TIMEOUT_MS);
      this.phase = "ready";
      child.once("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.phase = "crashed";
          console.error(`[dsh-sdk] 进程退出。stderr 尾部:${this.stderrRing.slice(-3).join(" | ").slice(-300)}`);
          this.onCrashed?.();
        }
      });
      console.log(`[dsh-sdk] ready (workspace=${cfg.workspaceDir.split("/").pop()})`);
    } catch (e) {
      // 启动失败:杀进程不留残留
      if (this.child === child) {
        child.kill("SIGKILL");
        this.child = null;
      }
      this.phase = "crashed";
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** 发送一轮用户输入(返回 messageId;回复经事件流异步到达) */
  async prompt(sessionId: string, text: string): Promise<{ messageId: string }> {
    if (this.phase !== "ready") throw new Error(`DSH 运行时未就绪(当前 ${this.phase})`);
    const r = (await this.request("session/prompt", {
      sessionId,
      contentBlocks: [{ type: "text", text }],
    }, 30_000)) as { messageId: string };
    this.recordSession({ id: sessionId, title: text.slice(0, 50), lastTs: new Date().toISOString() });
    return r;
  }

  private handleFrame(frame: Record<string, unknown>): void {
    if (typeof frame.id === "number" && frame.method === undefined) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) {
        p.reject(new Error(String((frame.error as { message?: unknown }).message ?? JSON.stringify(frame.error))));
      } else {
        p.resolve(frame.result ?? {});
      }
      return;
    }
    if (typeof frame.method === "string") {
      const params = (frame.params ?? {}) as Record<string, unknown>;
      if (frame.method === "session.event") {
        // 会话标题事件 → 更新本地索引
        const ev = params.event as { type?: string; data?: { title?: string } } | undefined;
        if (ev?.type === "session/title" && ev.data?.title && typeof params.sessionId === "string") {
          this.recordSession({ id: params.sessionId, title: ev.data.title.slice(0, 50), lastTs: new Date().toISOString() });
        }
        this.onEvent?.({ kind: "session.event", sessionId: params.sessionId as string | undefined, event: params.event as SdkEventFrame["event"] });
      } else if (frame.method === "session.status") {
        this.onEvent?.({ kind: "session.status", sessionId: params.sessionId as string | undefined, status: params.status as string | undefined });
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error("DSH 进程不在"));
        return;
      }
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时(${timeoutMs}ms)。stderr 尾部:${this.stderrRing.slice(-3).join(" | ").slice(-200)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.phase = "idle";
      return;
    }
    this.phase = "stopping";
    // 先发 shutdown(request 依赖 this.child),再清引用
    void this.request("shutdown", undefined, 2_000).catch(() => undefined);
    this.child = null;
    this.pending.forEach((p) => p.reject(new Error("runtime stopping")));
    this.pending.clear();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolveSoon(); }, STOP_TIMEOUT_MS);
      const resolveSoon = (): void => { clearTimeout(timer); resolve(); };
      child.once("exit", resolveSoon);
    });
    this.phase = "idle";
  }
}

export const dshRuntime = new DshSdkRuntime();
