/**
 * 北斗work dsh 插件入口(Phase 3:8 业务工具全量接线;P1-3:协议单轨 BeidouToolResult)。
 * V1 空壳 + V2 语义检索 + V3 指标 + V4 下钻 + V5 诊断 + V6 审计 + P1 systemPrompt 注入。
 */
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerBusinessTools } from "./tools";
import { registerIdentityTools, buildIdaasAuth, OPEN_ID } from "./idaas-tool";
import { createIdentityProvider } from "./identity-provider";
import { buildPluginContext } from "./context";
import { buildPluginPrompt } from "./prompt";
import type { ToolContext } from "@beidou-core/tools/tools";

export const name = "beidou-work";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx: Context) {
  const workspace = process.env.BEIDOU_WORKSPACE ?? join(homedir(), "Library/Application Support/北斗work/workspace");
  console.error("[beidou-work] plugin loading (workspace:", workspace, ")");

  // P1-1:同步 apply(Cordis 不 await async);异步初始化 + 错误传播(非静默)
  void (async () => {
  const built = await buildPluginContext({ workspace });
  const sessionId = `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const toolCtx: ToolContext = {
    store: built.workspace.store,
    assets: built.workspace.assets,
    routerConfig: { metricScoreThreshold: 50 },
    guardPolicy: built.toolContextOverrides.guardPolicy,
    metricOnline: false,
    starrocksQuery: built.toolContextOverrides.starrocksQuery,
    audit: built.toolContextOverrides.auditSink,
    sessionId,
    semanticVersion: built.workspace.semanticVersion,
    metricsByCode: built.workspace.metricsByCode,
    ontology: built.workspace.ontology,
    bindings: built.workspace.bindings,
    knowledge: built.workspace.knowledge,
    playbooks: built.workspace.playbooks,
    entities: built.workspace.entities,
    dataSource: built.toolContextOverrides.dataSource,
  };

  // P0-01 修复:身份不再启动快照。业务工具每次调用经 createIdentityProvider 现读
  // token 缓存并校验(cachedToken fail-closed),beidou_login 成功落盘后即刻生效。
  const auth = buildIdaasAuth();
  const getIdentity = createIdentityProvider(auth, OPEN_ID);
  void getIdentity().then((id) =>
    console.error("[beidou-work] startup identity:", id ? id.username : "(not logged in)"),
  );

  // P1 systemPrompt:路由协议 + 空间资产清单注入 dsh 系统 prompt。
  // 位置:TOOLS_SDK(5000)之前——业务协议先于工具 schema 呈现给模型。
  ctx.systemPrompt.section({
    name: "beidou-work:protocol",
    order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK") - 500,
    text: buildPluginPrompt(built.workspace),
  });

  registerBusinessTools(ctx, toolCtx, getIdentity);
  registerIdentityTools(ctx, { auth }); // Phase 4:身份工具 ×2

  console.error("[beidou-work] 8 business + 2 identity tools registered (BeidouToolResult 单轨, 动态身份), systemPrompt injected, mock:", built.isMock);
  })().catch((e) => {
    console.error("[beidou-work] FATAL: context build failed:", e);
    throw e; // 让插件启动失败(非静默)
  });
}
