import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join, dirname } from "node:path";
import { appendFile, readFile, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadWorkspace, modelConfigured, type LoadedWorkspace } from "./workspace";
import { AgentService, type AgentEvent } from "./agent/service";
import { runSdkAgent } from "./agent/sdk-runner";
import { queryStarRocks } from "@beidou/core/src/services/starrocks";
import { createMockStarRocks } from "@beidou/core/src/services/mock-starrocks";
import { mysqlConnector } from "./starrocks-connector";
import { createAuditLog } from "@beidou/core/src/audit/log";
import { SessionStore } from "@beidou/core/src/session/store";
import { bubblesToEvents, agentEventToSessionEvent } from "@beidou/core/src/session/replay";
import { redactSecrets } from "@beidou/core/src/evidence/pack";
import { identityFromEptSession, isExpired, type Identity } from "@beidou/core/src/identity/identity";
import { createIdaasAuth, type IdaasTokenFile, type IdaasAuth } from "@beidou/core/src/auth/idaas";
import { DEFAULT_POLICY, can, menusFor, resolveRole, type Role } from "@beidou/core/src/rbac/rbac";
import {
  loadSpaces, saveSpaces, createSpace, switchSpace, removeSpace, activeSpace,
  type SpacesRegistry, type SpaceEntry,
} from "./spaces";

let mainWindow: BrowserWindow | null = null;
let workspace: LoadedWorkspace | null = null;
let agentService: AgentService | null = null;
let registry: SpacesRegistry = { spaces: [] };
let identity: Identity | null = null;
let idaasToken: IdaasTokenFile | null = null;
const aborters = new Map<string, AbortController>();

const USER_DATA = app?.getPath?.("userData") ?? process.cwd();
const REGISTRY_FILE = join(USER_DATA, "spaces.json");
const EPT_SESSION_FILE = join(homedir(), ".config", "ept", "auth_session.json");
const AUTH_CACHE_DIR = join(homedir(), ".beidou", "auth"); // P0-6:统一路径(与 DSH 插件共用)

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// 身份与认证(优先级:IDaaS token > ept IDaaS 会话 > 未登录)
// 协议:~/.codex/skills/idaas-auth-protocol(SKILL.md v1.0.4)
// ---------------------------------------------------------------------------

function osUsername(): string {
  return process.env.USER ?? homedir().split("/").pop() ?? "unknown";
}

function currentOpenId(): string {
  return identity?.username ?? osUsername();
}

function idaasAuthOf(ws: LoadedWorkspace | null): IdaasAuth | null {
  const appId = ws?.config.auth?.app_id ?? process.env.IDAAS_AUTH_APP_ID ?? "";
  if (!appId) return null;
  const openId = currentOpenId();
  const tokenFile = join(AUTH_CACHE_DIR, "apps", appId, "users", `${encodeURIComponent(openId)}.json`);
  return createIdaasAuth(
    {
      serviceUrl: ws?.config.auth?.service_url ?? "https://idaas-auth-service.example.com",
      appId,
      serviceToken: ws?.config.auth?.service_token,
    },
    {
      fetchFn: fetch,
      writeFileAtomic: async (path, content) => {
        const { rename, writeFile: wf, chmod, mkdir, unlink } = await import("node:fs/promises");
        const abs = path.startsWith("auth/") ? join(AUTH_CACHE_DIR, path) : path;
        const tmp = `${abs}.tmp`;
        await mkdir(dirname(abs), { recursive: true }).catch(() => undefined);
        await wf(tmp, content, "utf-8");
        // P0-05: rename 失败必须抛错 + 清理 tmp(不能静默吞掉)
        try {
          await rename(tmp, abs);
        } catch (e) {
          await unlink(tmp).catch(() => undefined);
          throw new Error(`token 写入失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        await chmod(abs, 0o600).catch(() => undefined);
      },
      readFile: async () => readFile(tokenFile, "utf-8"),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
    },
  );
}

function refreshIdentity(): Identity | null {
  // 1) IDaaS token(北斗系正统)
  const auth = idaasAuthOf(workspace);
  if (auth) {
    void auth.cachedToken(currentOpenId()).then((r) => {
      if (r.ok) {
        idaasToken = r.value;
      }
    });
  }
  // 2) ept 会话兜底
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(EPT_SESSION_FILE, "utf-8"));
  } catch {
    raw = null;
  }
  const r = identityFromEptSession(raw);
  if (!r.ok) return null;
  if (isExpired(r.value)) return { ...r.value, expiresAt: r.value.expiresAt };
  return r.value;
}

function effectiveIdentity(): { identity: Identity | null; source: string } {
  // P0-2 修复:统一过期检查,过期身份等同匿名
  if (idaasToken?.authorization) {
    const idaasId: Identity = {
      username: idaasToken.user_name || idaasToken.open_id,
      name: idaasToken.user_name,
      expiresAt: idaasToken.expires_at,
      source: "idaas-token",
    };
    if (!isExpired(idaasId)) {
      return { identity: idaasId, source: "idaas-token" };
    }
    console.warn("[identity] IDaaS token expired, falling through");
  }
  if (identity && !isExpired(identity)) {
    return { identity, source: "ept-session" };
  }
  if (identity) {
    console.warn("[identity] ept identity expired, treating as anonymous");
  }
  return { identity: null, source: "none" };
}

// ---------------------------------------------------------------------------
// 空间与工作区
// ---------------------------------------------------------------------------

async function ensureWorkspace(dir: string, firstUsername?: string): Promise<void> {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tpl = join(__dirname, "../resources/workspace-default");
  if (existsSync(tpl)) {
    await mkdir(join(dir, "semantics", "import"), { recursive: true });
    await mkdir(join(dir, "audit"), { recursive: true });
    const configDst = join(dir, "config.yaml");
    if (!existsSync(configDst)) await copyFile(join(tpl, "config.example.yaml"), configDst).catch(() => undefined);
    // glossary 种到 semantics/(与 loadWorkspace 读取路径一致)
    const glossaryDst = join(dir, "semantics", "glossary.yaml");
    if (!existsSync(glossaryDst)) await copyFile(join(tpl, "glossary.yaml"), glossaryDst).catch(() => undefined);
    const skillsSrc = join(tpl, "skills");
    const skillsDst = join(dir, ".claude", "skills");
    if (existsSync(skillsSrc) && !existsSync(skillsDst)) {
      await mkdir(skillsDst, { recursive: true });
      for (const name of await readdir(skillsSrc)) {
        await mkdir(join(skillsDst, name), { recursive: true });
        await copyFile(join(skillsSrc, name, "SKILL.md"), join(skillsDst, name, "SKILL.md")).catch(() => undefined);
      }
    }
    // 演示语义包:语义本体是 mock 的(数据也是 mock),但产品能力全真实
    const demoPkg = join(tpl, "..", "demo-semantics");
    const importDir = join(dir, "semantics", "import");
    if (existsSync(demoPkg)) {
      const existing = await readdir(importDir).catch(() => [] as string[]);
      if (existing.length === 0) {
        for (const f of await readdir(demoPkg)) {
          if (f.endsWith(".json")) await copyFile(join(demoPkg, f), join(importDir, f)).catch(() => undefined);
        }
      }
    }
    for (const sub of ["knowledge", "playbooks"]) {
      const src = join(tpl, sub);
      const dst = join(dir, sub);
      if (existsSync(src) && !existsSync(dst)) {
        await mkdir(dst, { recursive: true });
        for (const f of await readdir(src)) await copyFile(join(src, f), join(dst, f)).catch(() => undefined);
      }
    }
    const entTpl = join(tpl, "semantics", "entities.yaml");
    if (existsSync(entTpl) && !existsSync(join(dir, "semantics", "entities.yaml"))) {
      await copyFile(entTpl, join(dir, "semantics", "entities.yaml")).catch(() => undefined);
    }
    const membersFile = join(dir, "members.yaml");
    if (!existsSync(membersFile)) {
      const tplText = (await readFile(join(tpl, "members.yaml"), "utf-8").catch(() => "")).toString();
      await writeFile(membersFile, tplText.replace("{{username}}", firstUsername ?? "admin"), "utf-8");
    }
  }
}

/** mock 演示数据模式:未配置 StarRocks 且未显式关闭(starrocks.mock: false)时启用 */
function mockDataActive(ws: LoadedWorkspace | null): boolean {
  const sr = ws?.config.starrocks;
  return !sr?.host && sr?.mock !== false;
}

function buildAgentService(ws: LoadedWorkspace): AgentService {
  const sr = ws.config.starrocks;
  const mock = mockDataActive(ws);
  const connector = mock ? createMockStarRocks() : mysqlConnector();
  const auditSink = createAuditLog({
    appendFile: async (line) => {
      await appendFile(join(ws.dir, "audit", "audit.jsonl"), line, "utf-8");
    },
    readFile: async () => readFile(join(ws.dir, "audit", "audit.jsonl"), "utf-8"),
  });
  const { identity: currentId } = effectiveIdentity();
  return new AgentService(ws, {
    dataSource: mock ? "mock" : "real",
    identity: currentId ? { username: currentId.username, source: effectiveIdentity().source as "idaas-token" | "ept-session" | "none" } : undefined,
    auditSink: {
      append: async (e) => {
        await auditSink.append(e as never);
      },
    },
    starrocksQuery: async (sql) => {
      if (!sr?.host && !mock) {
        return { ok: false, error: { code: "SR_NOT_CONFIGURED", message: "未配置 StarRocks 连接(插件页配置后可用;或在 config.yaml 设 starrocks.mock: true 开启演示数据)" } };
      }
      return queryStarRocks(connector, {
        host: sr?.host ?? "",
        port: sr?.port ?? 9030,
        user: sr?.user ?? "",
        password: sr?.password ?? "",
        database: sr?.database,
        timeoutSec: sr?.timeout_sec,
        maxRows: ws.config.guard?.max_row ?? 200,
      }, sql);
    },
    runSdkAgent: modelConfigured(ws) ? runSdkAgent : undefined,
  });
}

function auditLogOf(ws: LoadedWorkspace) {
  const file = join(ws.dir, "audit", "audit.jsonl");
  return createAuditLog({
    appendFile: async (line) => {
      await appendFile(file, line, "utf-8");
    },
    readFile: async () => readFile(file, "utf-8"),
  });
}

let registryWriteQueue: Promise<void> = Promise.resolve();
function persistRegistry(): void {
  // 串行化写(防并发 O_TRUNC 交错损坏 spaces.json)
  registryWriteQueue = registryWriteQueue
    .then(() => writeFile(REGISTRY_FILE, saveSpaces(registry), "utf-8"))
    .catch(() => undefined);
}

function loadRegistry(): void {
  let text: string | null = null;
  try {
    text = readFileSync(REGISTRY_FILE, "utf-8");
  } catch {
    text = null;
  }
  registry = loadSpaces(() => text);
}

function currentRole(): Role {
  if (!workspace) return "viewer";
  const { identity: id } = effectiveIdentity();
  return resolveRole(id?.username, workspace.members, { defaultRole: workspace.defaultRole });
}

async function activateSpace(entry: SpaceEntry): Promise<void> {
  await ensureWorkspace(entry.dir, identity?.username);
  workspace = loadWorkspace(entry.dir);
  agentService = buildAgentService(workspace);
}

async function bootstrapSpaces(): Promise<void> {
  loadRegistry();
  identity = refreshIdentity();
  if (registry.spaces.length === 0) {
    const first = createSpace(registry, { name: "默认空间", dir: join(USER_DATA, "workspace") }, () => new Date().toISOString());
    registry = first.registry;
    persistRegistry();
    await activateSpace(first.entry);
  } else {
    const active = activeSpace(registry);
    if (active) await activateSpace(active);
  }
}

function workspaceState(): Record<string, unknown> {
  const role = currentRole();
  if (!workspace) return { ok: false, error: "no workspace" };
  return {
    ok: true,
    dir: workspace.dir,
    name: workspace.name,
    warnings: workspace.warnings,
    modelConfigured: modelConfigured(workspace),
    starrocksConfigured: Boolean(workspace.config.starrocks?.host),
    mockData: mockDataActive(workspace),
    counts: {
      metrics: workspace.assets.metrics.length,
      datasets: workspace.assets.datasets.length,
      glossary: workspace.assets.glossary.length,
      physicalTables: workspace.store.allPhysicalTables().length,
      columnBindings: workspace.assets.columnBindings.length,
    },
    identity: (() => {
      const { identity: id, source } = effectiveIdentity();
      return id ? { username: id.username, name: id.name, email: id.email, expired: isExpired(id), source } : null;
    })(),
    role,
    menus: menusFor(role, DEFAULT_POLICY),
    space: {
      id: registry.activeId,
      name: activeSpace(registry)?.name ?? workspace.name,
      spaces: registry.spaces.map((s) => ({ id: s.id, name: s.name, dir: s.dir })),
    },
  };
}

function registerIpc(): void {
  ipcMain.handle("workspace:state", async () => workspaceState());

  ipcMain.handle("identity:whoami", async () => {
    identity = refreshIdentity();
    return { identity: workspaceState().identity };
  });

  ipcMain.handle("auth:state", async () => {
    const auth = idaasAuthOf(workspace);
    if (!auth) return { configured: false };
    const r = await auth.cachedToken(currentOpenId());
    return {
      configured: true,
      appId: workspace?.config.auth?.app_id ?? process.env.IDAAS_AUTH_APP_ID,
      openId: currentOpenId(),
      token: r.ok
        ? { userName: r.value.user_name, expiresAt: r.value.expires_at, valid: true }
        : { valid: false, reason: r.error.code },
    };
  });

  ipcMain.handle("auth:login", async () => {
    const auth = idaasAuthOf(workspace);
    if (!auth) {
      return { ok: false, error: "未配置 auth.app_id(需飞书机器人 app_id,见 config.yaml auth 段)" };
    }
    const openId = currentOpenId();
    const created = await auth.createLoginSession({ openId, userName: identity?.name ?? openId });
    if (!created.ok) return { ok: false, error: created.error.message };
    // 先把登录链接交给用户(系统浏览器打开 + 返回给 UI 展示),再轮询
    const { shell } = await import("electron");
    await shell.openExternal(created.value.loginUrl).catch(() => undefined);
    const token = await auth.completeLogin({ sessionId: created.value.sessionId, openId, poll: { intervalMs: 2000, maxAttempts: 150 } });
    if (!token.ok) return { ok: false, error: token.error.message, loginUrl: created.value.loginUrl };
    idaasToken = token.value;
    return { ok: true, userName: token.value.user_name ?? openId };
  });

  ipcMain.handle("auth:refresh", async () => {
    const auth = idaasAuthOf(workspace);
    if (!auth) return { ok: false, error: "未配置 auth.app_id" };
    const r = await auth.refresh({ openId: currentOpenId() });
    if (!r.ok) return { ok: false, error: r.error.message };
    idaasToken = r.value;
    return { ok: true };
  });

  ipcMain.handle("spaces:list", async () => registry.spaces);
  ipcMain.handle("spaces:switch", async (_e, id: string) => {
    registry = switchSpace(registry, id);
    persistRegistry();
    const active = activeSpace(registry);
    if (active) await activateSpace(active);
    return workspaceState();
  });
  ipcMain.handle("spaces:create", async (_e, name: string) => {
    const slug = (name || "space").replace(/[^\w一-龥-]+/g, "-").slice(0, 40);
    const dir = join(USER_DATA, "spaces", `${slug}-${Date.now().toString(36)}`);
    const r = createSpace(registry, { name, dir }, () => new Date().toISOString());
    registry = r.registry;
    persistRegistry();
    await activateSpace(r.entry);
    return workspaceState();
  });
  ipcMain.handle("spaces:remove", async (_e, id: string) => {
    if (registry.spaces.length <= 1) {
      return { ok: false, error: "无法移除最后一个空间(至少保留一个)" };
    }
    registry = removeSpace(registry, id);
    persistRegistry();
    const active = activeSpace(registry);
    if (active) await activateSpace(active);
    return workspaceState();
  });
  ipcMain.handle("spaces:import", async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
    if (r.canceled || r.filePaths.length === 0) return { ok: false };
    const dir = r.filePaths[0]!;
    const name = dir.split("/").pop() ?? "导入空间";
    const created = createSpace(registry, { name, dir }, () => new Date().toISOString());
    registry = created.registry;
    persistRegistry();
    await activateSpace(created.entry);
    return workspaceState();
  });

  ipcMain.handle("semantics:search", async (_e, q: string) => {
    if (!workspace) return { hits: [] };
    return { hits: workspace.store.search(q, { limit: 20 }) };
  });

  ipcMain.handle("semantics:list", async (_e, kind: string) => {
    if (!workspace) return { items: [] };
    if (kind === "metrics") return { items: workspace.assets.metrics };
    if (kind === "datasets") return { items: workspace.assets.datasets };
    if (kind === "glossary") return { items: workspace.assets.glossary };
    return { items: [] };
  });

  ipcMain.handle("members:read", async () => {
    if (!workspace) return { ok: false, text: "" };
    try {
      return { ok: true, text: await readFile(join(workspace.dir, "members.yaml"), "utf-8") };
    } catch {
      return { ok: true, text: "" };
    }
  });

  ipcMain.handle("members:save", async (_e, text: string) => {
    // 双层防线:UI 菜单隐藏之外,写操作在主进程再校验角色
    if (!can(currentRole(), "space:admin", DEFAULT_POLICY)) {
      return { ok: false, error: "仅空间管理员可编辑成员" };
    }
    if (!workspace) return { ok: false, error: "no workspace" };
    await writeFile(join(workspace.dir, "members.yaml"), text, "utf-8");
    workspace = loadWorkspace(workspace.dir);
    agentService = buildAgentService(workspace);
    return { ok: true };
  });

  // ---- 语义资产:导入(目录/演示包)与术语 CRUD(真实产品能力) ----
  ipcMain.handle("semantics:import", async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
    if (r.canceled || r.filePaths.length === 0) return { ok: false, error: "cancel" };
    if (!workspace) return { ok: false, error: "no workspace" };
    const canonical = ["metrics.json", "details.json", "dimensions.json", "tree.json", "lineage_summary.json", "physical_tables.json"];
    let copied = 0;
    for (const f of canonical) {
      const src = join(r.filePaths[0]!, f);
      if (existsSync(src)) {
        await copyFile(src, join(workspace.dir, "semantics", "import", f));
        copied++;
      }
    }
    if (copied === 0) return { ok: false, error: "所选目录无北斗导出文件(需 metrics.json 等 6 个文件)" };
    await activateSpace(activeSpace(registry)!);
    return { ok: true, copied };
  });

  ipcMain.handle("semantics:loadDemo", async () => {
    if (!workspace) return { ok: false, error: "no workspace" };
    const demoPkg = join(__dirname, "../resources/demo-semantics");
    if (!existsSync(demoPkg)) return { ok: false, error: "演示语义包缺失" };
    let copied = 0;
    for (const f of await readdir(demoPkg)) {
      if (f.endsWith(".json")) {
        await copyFile(join(demoPkg, f), join(workspace.dir, "semantics", "import", f));
        copied++;
      }
    }
    await activateSpace(activeSpace(registry)!);
    return { ok: true, copied };
  });

  ipcMain.handle("glossary:read", async () => {
    if (!workspace) return { ok: false, text: "" };
    try {
      return { ok: true, text: await readFile(join(workspace.dir, "semantics", "glossary.yaml"), "utf-8") };
    } catch {
      return { ok: true, text: "" };
    }
  });

  // 轻量重载:只重读单类资产,不做 8.6MB 全量 reparse(修复保存冻结主进程)
  async function lightReload(target: "glossary" | "knowledge" | "playbooks" | "entities"): Promise<void> {
    if (!workspace) return;
    const dir = workspace.dir;
    const ws2 = loadWorkspace(dir); // TODO Phase 2 拆为增量装载;当前先异步化避免阻塞渲染
    workspace = ws2;
    agentService = buildAgentService(ws2);
  }

  ipcMain.handle("glossary:save", async (_e, text: string) => {
    if (!can(currentRole(), "semantics:edit", DEFAULT_POLICY)) {
      return { ok: false, error: "当前角色无术语编辑权限(analyst 及以上)" };
    }
    if (!workspace) return { ok: false, error: "no workspace" };
    const { parse: parseYaml } = await import("yaml");
    const { parseMembers } = await import("@beidou/core/src/rbac/rbac");
    try {
      const parsed = parseYaml(text || "terms: []") as { terms?: unknown } | null;
      const terms = Array.isArray(parsed?.terms) ? parsed!.terms : [];
      // 结构校验:term 必须字符串、synonyms 数组(与 workspace 装载规则一致)
      for (const t of terms) {
        if (!t || typeof (t as { term?: unknown }).term !== "string") throw new Error("存在缺 term 的条目");
        if (!Array.isArray((t as { synonyms?: unknown }).synonyms)) throw new Error(`术语 ${(t as { term: string }).term} 的 synonyms 必须是数组`);
      }
    } catch (e) {
      return { ok: false, error: `校验失败:${e instanceof Error ? e.message : String(e)}` };
    }
    await writeFile(join(workspace.dir, "semantics", "glossary.yaml"), text, "utf-8");
    await lightReload("glossary");
    return { ok: true };
  });

  // ---- 技能:启停/编辑(目录改名 .disabled 实现) ----
  ipcMain.handle("skills:save", async (_e, name: string, content: string) => {
    if (!can(currentRole(), "skills:manage", DEFAULT_POLICY)) {
      return { ok: false, error: "当前角色无技能管理权限(engineer 及以上)" };
    }
    if (!workspace || !/^[A-Za-z0-9_-]+$/.test(name)) return { ok: false, error: "非法技能名" };
    const dir = join(workspace.dir, ".claude", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), content, "utf-8");
    return { ok: true };
  });

  ipcMain.handle("skills:toggle", async (_e, name: string, enabled: boolean) => {
    if (!can(currentRole(), "skills:manage", DEFAULT_POLICY)) {
      return { ok: false, error: "当前角色无技能管理权限" };
    }
    // 路径穿越防护(P0-4):复用 skills:save 的名称校验
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return { ok: false, error: "非法技能名" };
    }
    if (!workspace) return { ok: false, error: "no workspace" };
    const base = join(workspace.dir, ".claude", "skills");
    const on = join(base, name);
    const off = join(base, `${name}.disabled`);
    if (enabled) {
      if (existsSync(off)) await (await import("node:fs/promises")).rename(off, on);
    } else {
      if (existsSync(on)) await (await import("node:fs/promises")).rename(on, off);
    }
    return { ok: true };
  });

  // ---- 知识库 / Playbook / 实体模型(空间业务资产) ----
  ipcMain.handle("knowledge:list", async () => workspace?.knowledge ?? []);
  ipcMain.handle("knowledge:save", async (_e, name: string, content: string) => {
    if (!can(currentRole(), "semantics:edit", DEFAULT_POLICY)) return { ok: false, error: "无编辑权限(engineer+)" };
    if (!workspace || !/^[\w\u4e00-\u9fa5.-]+$/.test(name)) return { ok: false, error: "非法文件名" };
    await mkdir(join(workspace.dir, "knowledge"), { recursive: true });
    await writeFile(join(workspace.dir, "knowledge", `${name}.md`), content, "utf-8");
    await activateSpace(activeSpace(registry)!);
    return { ok: true };
  });
  ipcMain.handle("playbook:list", async () => workspace?.playbooks ?? []);
  ipcMain.handle("playbook:save", async (_e, name: string, content: string) => {
    if (!can(currentRole(), "skills:manage", DEFAULT_POLICY)) return { ok: false, error: "无管理权限(engineer+)" };
    if (!workspace || !/^[\w\u4e00-\u9fa5.-]+$/.test(name)) return { ok: false, error: "非法文件名" };
    await mkdir(join(workspace.dir, "playbooks"), { recursive: true });
    await writeFile(join(workspace.dir, "playbooks", `${name}.md`), content, "utf-8");
    await activateSpace(activeSpace(registry)!);
    return { ok: true };
  });
  ipcMain.handle("entities:read", async () => ({ ok: true, text: workspace?.entitiesYaml ?? "" }));
  ipcMain.handle("entities:save", async (_e, text: string) => {
    if (!can(currentRole(), "semantics:edit", DEFAULT_POLICY)) return { ok: false, error: "无编辑权限" };
    if (!workspace) return { ok: false, error: "no workspace" };
    await writeFile(join(workspace.dir, "semantics", "entities.yaml"), text, "utf-8");
    await activateSpace(activeSpace(registry)!);
    return { ok: true };
  });

  // ---- 会话持久化(JSONL 追加式,文件即权威源;恢复=回放) ----
  // 惰性取路径:registerIpc 早于 bootstrapSpaces,构造时 workspace 尚未激活;
  // 且会话按空间隔离,必须跟随当前激活空间。
  const sessionStore = () => new SessionStore(join(workspace?.dir ?? USER_DATA, "sessions"));

  ipcMain.handle("session:list", async () => await sessionStore().list());
  ipcMain.handle("session:read", async (_e, sessionId: string) => await sessionStore().read(sessionId));
  ipcMain.handle("session:delete", async (_e, sessionId: string) => {
    await sessionStore().delete(sessionId);
    return { ok: true };
  });
  ipcMain.handle("session:import", async (_e, sessionId: string, bubbles: unknown) => {
    // 一次性迁移:renderer 旧 localStorage 会话 → JSONL(bubblesToEvents 保证回放同构)
    const events = bubblesToEvents(sessionId, bubbles as Parameters<typeof bubblesToEvents>[1]);
    for (const ev of events) await sessionStore().append(ev);
    return { ok: true, count: events.length };
  });

  ipcMain.handle("report:export", async (_e, markdown: string) => {
    if (!workspace) return { ok: false, error: "no workspace" };
    const dir = join(workspace.dir, "reports");
    await mkdir(dir, { recursive: true });
    const now = new Date();
    const file = join(dir, `报告-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
    await writeFile(file, markdown, "utf-8");
    return { ok: true, file };
  });

  ipcMain.handle("audit:tail", async (_e, n: number) => {
    if (!workspace) return [];
    return auditLogOf(workspace).tail(n);
  });

  ipcMain.handle("skills:list", async () => {
    if (!workspace) return { skills: [] };
    const dir = join(workspace.dir, ".claude", "skills");
    if (!existsSync(dir)) return { skills: [] };
    const out: Array<{ name: string; content: string; enabled: boolean }> = [];
    for (const name of await readdir(dir)) {
      const enabled = !name.endsWith(".disabled");
      const real = enabled ? name : name.replace(/\.disabled$/, "");
      try {
        out.push({ name: real, enabled, content: await readFile(join(dir, name, "SKILL.md"), "utf-8") });
      } catch {
        // 无 SKILL.md 的目录跳过
      }
    }
    return { skills: out.sort((a, b) => a.name.localeCompare(b.name)) };
  });

  ipcMain.handle("config:read", async () => {
    if (!can(currentRole(), "config:save", DEFAULT_POLICY)) {
      return { ok: false, error: "当前角色无配置读取权限" };
    }
    if (!workspace) return { ok: false };
    try {
      const raw = await readFile(join(workspace.dir, "config.yaml"), "utf-8");
      // 凭据脱敏:渲染层不接触明文密钥(P0-2)
      const masked = raw
        .replace(/(auth_token:\s*)(\S+)/g, "$1***")
        .replace(/(password:\s*)(\S+)/g, "$1***")
        .replace(/(auth_value:\s*)(\S+)/g, "$1***")
        .replace(/(service_token:\s*)(\S+)/g, "$1***");
      return { ok: true, text: masked };
    } catch {
      return { ok: true, text: "" };
    }
  });

  ipcMain.handle("config:save", async (_e, text: string) => {
    if (!can(currentRole(), "config:save", DEFAULT_POLICY)) {
      return { ok: false, error: "当前角色无数据源配置权限" };
    }
    if (!workspace) return { ok: false, error: "no workspace" };
    await writeFile(join(workspace.dir, "config.yaml"), text, "utf-8");
    await activateSpace(activeSpace(registry)!);
    return { ok: true };
  });

  ipcMain.handle("config:test", async () => {
    if (!workspace) return { ok: false };
    const sr = workspace.config.starrocks;
    const results: Record<string, unknown> = {
      model: modelConfigured(workspace) ? "已配置" : "未配置(演示模式)",
      starrocks: "未配置",
      anymetrics: workspace.config.anymetrics?.host ? "已配置(元数据已本地化)" : "未配置",
      identity: identity ? `已登录:${identity.username}` : "未登录(功能可用,权限按 viewer)",
    };
    if (sr?.host) {
      const r = await queryStarRocks(mysqlConnector(), {
        host: sr.host,
        port: sr.port ?? 9030,
        user: sr.user ?? "",
        password: sr.password ?? "",
        timeoutSec: 10,
        maxRows: 1,
      }, "SELECT 1 AS ok");
      results.starrocks = r.ok ? "连接成功" : `失败:${r.error.message}`;
    }
    return { ok: true, results };
  });

  ipcMain.handle("agent:send", async (_e, sessionId: string, text: string) => {
    if (!agentService) return { ok: false, error: "no workspace" };
    if (!can(currentRole(), "tool:query", DEFAULT_POLICY)) {
      return { ok: false, error: "当前角色无查询权限" };
    }
    const audit = workspace ? auditLogOf(workspace) : null;
    const ac = new AbortController();
    aborters.set(sessionId, ac);
    const persist = (ev: AgentEvent): void => {
      // 会话事件落 JSONL(权威源;失败不阻塞问答,仅记录)
      sessionStore().append(agentEventToSessionEvent(sessionId, ev))
        .catch((e) => console.error("[session] persist failed:", e instanceof Error ? e.message : e));
    };
    try {
      await agentService.ask(sessionId, text, (ev: AgentEvent) => {
        send("agent:event", { sessionId, ev });
        persist(ev);
        if (audit && (ev.type === "user" || ev.type === "tool_result" || ev.type === "assistant")) {
          void audit.append({
            ts: new Date().toISOString(),
            kind: ev.type === "user" ? "user_message" : ev.type === "assistant" ? "agent_reply" : "tool_result",
            sessionId,
            summary: ev.type === "assistant" ? (ev.text ?? "").slice(0, 200) : ev.type === "user" ? text.slice(0, 200) : "tool_result",
            detail: redactSecrets(ev),
          });
        }
      });
      return { ok: true };
    } catch (e) {
      const errEv: AgentEvent = { type: "error", message: e instanceof Error ? e.message : String(e) };
      send("agent:event", { sessionId, ev: errEv });
      persist(errEv);
      return { ok: false, error: String(e) };
    } finally {
      aborters.delete(sessionId);
    }
  });
}

app?.whenReady?.().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    title: "北斗work",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  registerIpc();
  await bootstrapSpaces();
  // DEBUG-SCREENSHOT:仅手动验证 UI(DDAW_SCREENSHOT=1 npx electron .)
  if (process.env.DDAW_SCREENSHOT) {
    setTimeout(async () => {
      try {
        if (process.env.DDAW_THEME) {
          await mainWindow!.webContents.executeJavaScript(`localStorage.setItem("daw.theme", ${JSON.stringify(process.env.DDAW_THEME)}); true`);
          await mainWindow!.webContents.reload();
          await new Promise((r) => setTimeout(r, 4000));
        }
        const topbar = await mainWindow!.webContents.executeJavaScript(`document.querySelector(".daw-topbar")?.innerText ?? "(no topbar)"`);
        console.log("[topbar]", topbar);
        const img = await mainWindow!.webContents.capturePage();
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(process.env.DDAW_SCREENSHOT!, img.toPNG());
        console.log("[screenshot] saved");
      } catch (e) {
        console.log("[screenshot] failed", e);
      }
      app.quit();
    }, 6000);
  }
});

app?.on?.("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
