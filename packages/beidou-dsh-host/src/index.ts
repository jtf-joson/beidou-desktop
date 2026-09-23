/**
 * 北斗work dsh 插件入口(Phase 3:9 业务工具全量接线;P1-3:协议单轨 BeidouToolResult)。
 * V1 空壳 + V2 语义检索 + V3 指标 + V4 下钻 + V5 诊断 + V6 审计 + P1 systemPrompt 注入。
 */
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerBusinessTools } from "./tools";
import { registerIdentityTools, buildIdaasAuth, OPEN_ID, getLoginTask, settleLoginResult } from "./idaas-tool";
import { createIdentityProvider } from "./identity-provider";
import { ALLOWED_TOOLS } from "./policy";
import type { IdaasAuth } from "@beidou/core/src/auth/idaas.ts";
import { buildPluginContext } from "./context";
import { buildPluginPrompt } from "./prompt";
import type { ToolContext } from "@beidou/core/src/tools/tools.ts";

export const name = "beidou-work";
export const inject = ["tools", "systemPrompt", "connection"];

/** 工作空间引用:connection 路由注册必须在 apply 同步路径(FetchHandler 挂载时
 * 快照路由表,异步注册的路径会被 RPC envelope 通道吞成 400);built 异步就绪后赋值。 */
let builtRef: Awaited<ReturnType<typeof buildPluginContext>> | null = null;

type PreExecuteGate = (exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>;

/** DSH 全局工具门禁(tools/pre-execute waterfall):白名单外一律 deny。
 * 类型经双断言接入 cordis 事件签名(运行时形状=PreToolDecision waterfall) */
export function registerGlobalToolGate(ctx: Context): void {
  const gate: PreExecuteGate = async (exec, next) => {
    if (!ALLOWED_TOOLS.has(exec.name)) {
      return {
        kind: "deny",
        reason: `TOOL_NOT_ALLOWED: 工具 ${exec.name} 不在北斗白名单(9 业务 + 2 身份)。此拒绝意味着 profile 配置漂移或越权注册,请核对 beidou-common patch。`,
      };
    }
    return next();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx.on as any)("tools/pre-execute", gate);
}

export function apply(ctx: Context) {
  const derivedWorkspace = process.env.DSH_HOME
    ? join(dirname(process.env.DSH_HOME), "beidou-workspace")
    : undefined;
  const workspace = process.env.BEIDOU_WORKSPACE
    ?? (derivedWorkspace && existsSync(join(derivedWorkspace, "config.yaml")) ? derivedWorkspace : undefined)
    ?? join(homedir(), "Library/Application Support/北斗work/workspace");
  console.error("[beidou-work] plugin loading (workspace:", workspace, ")");

  // 资产概览 API(方案 §13 管理页数据源;client 插件同源 fetch)——同步注册
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).connection?.fetch?.register({
    path: "/api/beidou/assets",
    methods: ["GET", "HEAD"],
    requestBody: "buffered", // GET 路由必须显式 buffered:否则 bridge 走 stream 模式给 GET 挂 body 抛错
    fetch: async (request: unknown) => {
      try {
      console.error("[beidou-work] assets API hit:", (request as { method?: string }).method);
      const b = builtRef;
      if (!b) return new Response(JSON.stringify({ ok: false, error: "workspace not ready" }), { status: 503, headers: { "content-type": "application/json" } });
      const w = b.workspace;
      const body = {
        ok: true,
        counts: {
          metrics: w.assets.metrics.length,
          datasets: w.assets.datasets.length,
          glossary: w.assets.glossary.length,
          terms: w.assets.glossary.length,
          classes: w.ontology.classes.length,
          relations: w.ontology.relations.length,
          actions: w.ontology.actions.length,
          physicalTables: w.store.allPhysicalTables().length,
          columnBindings: w.assets.columnBindings.length,
          dimensionBindings: w.assets.dimensionBindings?.length ?? 0,
          bindings: w.bindings ? Object.values(w.bindings.datasets).length + Object.values(w.bindings.tables).length : 0,
          metricOnline: Boolean(builtRef?.toolContextOverrides.metricClient),
          knowledge: w.knowledge.length,
        playbooks: w.playbooks.length,
        assetSource: w.assetSource,
        assetBundleId: w.assetBundleId ?? null,
        },
        metrics: w.assets.metrics.slice(0, 200).map((m) => ({
          name: m.displayName ?? m.metricName, metricName: m.metricName,
          // 旧版北斗导入资产可能没有 datasetName，但通常仍保留物理表；
          // 管理页展示物理表作为可追溯降级，不把它冒充成语义数据集。
          dataset: m.datasetName ?? m.caliber?.datasetName ?? m.physicalTables[0] ?? "",
          dimensions: m.dimensions.length,
          semanticDimensions: m.dimensions,
          providerDimensions: m.providerDimensions ?? [],
          dimensionDetails: m.dimensionDetails ?? [],
        })),
        terms: w.assets.glossary.map((t) => ({ name: t.term, definition: t.definition, aliases: t.synonyms })),
        classes: w.ontology.classes.map((c) => ({ id: c.id, name: c.name, key: c.key, description: c.description, properties: c.properties })),
        relations: w.ontology.relations.map((r) => ({ id: r.id, name: r.name, domain: r.domain, range: r.range, cardinality: r.cardinality, via: r.via })),
        actions: w.ontology.actions.map((a) => ({ id: a.id, name: a.name, subject: a.subject, metrics: a.metrics })),
        datasets: w.assets.datasets.slice(0, 100).map((d) => ({
          name: d.displayName ?? d.datasetName, tables: d.physicalTables, metrics: d.metrics.length,
        })),
        knowledge: w.knowledge.map((k) => k.name),
        playbooks: w.playbooks.map((k) => k.name),
        semanticVersion: w.semanticVersion,
        assetHealth: {
          assetSource: w.assetSource,
          assetBundleId: w.assetBundleId ?? null,
          metricOnline: Boolean(builtRef?.toolContextOverrides.metricClient),
          knowledgeAvailable: w.knowledge.length > 0,
          playbookAvailable: w.playbooks.length > 0,
          metricDatasetCoverage: w.assets.metrics.length === 0 ? 1 : w.assets.metrics.filter((m) => !!m.datasetName || !!m.caliber?.datasetName).length / w.assets.metrics.length,
          metricPhysicalTableCoverage: w.assets.metrics.length === 0 ? 1 : w.assets.metrics.filter((m) => m.physicalTables.length > 0).length / w.assets.metrics.length,
          metricPlatformCoverage: w.assets.metrics.length === 0 ? 1 : w.assets.metrics.filter((m) => !!m.code && m.metricName !== m.code).length / w.assets.metrics.length,
          platformOnlyMetricCount: w.assets.metrics.filter((m) => m.type === "DERIVED" && !!m.code && m.metricName !== m.code).length,
          warningCount: w.warnings.length + (w.assets.importWarnings?.length ?? 0),
          warnings: [...w.warnings, ...(w.assets.importWarnings ?? [])].slice(0, 20),
        },
      };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      } catch (e) {
        console.error("[beidou-work] assets API handler error:", e instanceof Error ? e.stack : String(e));
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    },
  });

  // 最近审计事件 API：工作台只读展示，解析脏行时跳过，不影响工具链路。
  (ctx as any).connection?.fetch?.register({
    path: "/api/beidou/audit",
    methods: ["GET", "HEAD"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        const b = builtRef;
        if (!b) return new Response(JSON.stringify({ ok: false, error: "workspace not ready" }), { status: 503, headers: { "content-type": "application/json" } });
        const text = await readFile(join(b.workspace.dir, "audit", "audit.jsonl"), "utf-8").catch(() => "");
        const events = text.split("\n").filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        }).slice(-100).reverse();
        return new Response(JSON.stringify({ ok: true, events }), { headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    },
  });

  // ---- IDaaS 登录闭环(host API;client 插件侧栏按钮消费) ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).connection?.fetch?.register({
    path: "/api/beidou/auth/state",
    methods: ["GET", "HEAD"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        const auth = buildIdaasAuth();
        const r = await auth.cachedToken(OPEN_ID);
        const task = getLoginTask();
        const body = r.ok
          ? { ok: true, loggedIn: true, user: r.value.user_name ?? OPEN_ID, expiresAt: r.value.expires_at, task }
          : { ok: true, loggedIn: false, reason: r.error.code, task };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).connection?.fetch?.register({
    path: "/api/beidou/auth/login",
    methods: ["POST", "GET"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        const auth = buildIdaasAuth();
        const sessionR = await auth.createLoginSession({ openId: OPEN_ID, userName: OPEN_ID });
        if (!sessionR.ok) {
          return new Response(JSON.stringify({ ok: false, error: sessionR.error.message }), { status: 502, headers: { "content-type": "application/json" } });
        }
        const { loginUrl } = sessionR.value;
        // 后台轮询(P0-02:Result 显式分支,失败落 LoginTaskState)
        void auth.completeLogin({ sessionId: sessionR.value.sessionId, openId: OPEN_ID, poll: { intervalMs: 3000, maxAttempts: 100 } })
          .then((r) => {
            settleLoginResult(r);
            if (r.ok) console.error("[beidou-work] IDaaS login completed (UI flow)");
            else console.error("[beidou-work] IDaaS login failed:", r.error.code, r.error.message);
          })
          .catch((e) => {
            settleLoginResult({ ok: false, error: { message: e instanceof Error ? e.message : String(e) } });
          });
        return new Response(JSON.stringify({ ok: true, loginUrl }), { headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).connection?.fetch?.register({
    path: "/api/beidou/auth/logout",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        // token 文件删除(单用户 PoC:直接删 openId 文件)
        const { unlink } = await import("node:fs/promises");
        const { homedir: hd } = await import("node:os");
        const authDir = `${hd()}/.beidou/auth/apps/${process.env.BEIDOU_IDAAS_APP_ID ?? "beidou-desktop"}/users`;
        await unlink(`${authDir}/${OPEN_ID}.json`).catch(() => undefined);
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    },
  });

  // P1-1:同步 apply(Cordis 不 await async);异步初始化 + 错误传播(非静默)
  void (async () => {
  const built = await buildPluginContext({ workspace });
  builtRef = built;
  const sessionId = `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const toolCtx: ToolContext = {
    store: built.workspace.store,
    assets: built.workspace.assets,
    routerConfig: { metricScoreThreshold: 50 },
    guardPolicy: built.toolContextOverrides.guardPolicy,
    metricOnline: Boolean(built.toolContextOverrides.metricClient),
    queryMetricsOnline: built.toolContextOverrides.metricClient
      ? async ({ metricName, dims, timeRange }) => built.toolContextOverrides.metricClient!.queryMetrics({
          metricName,
          dimensions: dims,
          timeConstraint: timeRange ? `(['metric_time'] >= \"${timeRange.start}\") AND (['metric_time'] <= \"${timeRange.end}\")` : undefined,
        })
      : undefined,
    starrocksQuery: built.toolContextOverrides.starrocksQuery,
    audit: built.toolContextOverrides.auditSink,
    sessionId,
    semanticVersion: built.workspace.semanticVersion,
    metricsByCode: built.workspace.metricsByCode,
    ontology: built.workspace.ontology,
    graph: built.workspace.graph,
    bindings: built.workspace.bindings,
    knowledge: built.workspace.knowledge,
    playbooks: built.workspace.playbooks,
    entities: built.workspace.entities,
    dataSource: built.toolContextOverrides.dataSource,
  };

  // P0-01 修复:身份不再启动快照。业务工具每次调用经 createIdentityProvider 现读
  // token 缓存并校验(cachedToken fail-closed),beidou_login 成功落盘后即刻生效。
  // P0-05(审核八轮):AuthContext 与壳同源——优先读 workspace config 的 auth 段
  // (app_id/service_url/service_token),env 仅作裸跑覆盖;凭据不经过环境变量。
  const authCfg = built.workspace.config.auth ?? {};
  const auth: IdaasAuth = buildIdaasAuth({
    serviceUrl: process.env.BEIDOU_IDAAS_URL ?? authCfg.service_url,
    appId: process.env.BEIDOU_IDAAS_APP_ID ?? authCfg.app_id,
    serviceToken: authCfg.service_token,
  });
  const getIdentity = createIdentityProvider(auth, OPEN_ID);
  void getIdentity().then((id) =>
    console.error("[beidou-work] startup identity:", id ? id.username : "(not logged in)"),
  );

  // P1 systemPrompt:路由协议 + 空间资产清单注入 dsh 系统 prompt。
  // 位置:TOOLS_SDK(5000)之前——业务协议先于工具 schema 呈现给模型。
  ctx.systemPrompt.section({
    name: "beidou-work:protocol",
    order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK") - 500,
    text: buildPluginPrompt(built.workspace, Boolean(built.toolContextOverrides.metricClient)),
  });

  registerBusinessTools(ctx, toolCtx, getIdentity);
  registerIdentityTools(ctx, { auth }); // Phase 4:身份工具 ×2

  // P0-02(审核八轮):DSH 全局执行门禁——profile 禁用是配置层防线,本 waterfall
  // 是执行层兜底:即使配置漂移/升级误注册了内置工具,任何非北斗工具的调用在此拒绝。
  registerGlobalToolGate(ctx);

  console.error("[beidou-work] 9 business + 2 identity tools registered (BeidouToolResult 单轨, 动态身份), systemPrompt injected, mock:", built.isMock);
  })().catch((e) => {
    console.error("[beidou-work] FATAL: context build failed:", e);
    throw e; // 让插件启动失败(非静默)
  });
}
