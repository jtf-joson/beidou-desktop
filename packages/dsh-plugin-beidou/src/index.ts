/**
 * 北斗work dsh 插件入口(Phase 3:8 业务工具全量接线)。
 * V1 空壳 + V2 语义检索 + V3 指标 + V4 下钻 + V5 诊断 + V6 审计。
 */
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { registerBusinessTools } from "./tools";
import { registerIdentityTools } from "./idaas-tool";
import { buildPluginContext } from "./context";
import { buildPluginPrompt } from "./prompt";
import type { ToolContext } from "@beidou-core/tools/tools";

export const name = "beidou-work";
export const inject = ["tools"];

export function apply(ctx: Context) {
  const workspace = process.env.BEIDOU_WORKSPACE ?? join(homedir(), "Library/Application Support/北斗work/workspace");
  console.log("[beidou-work] plugin loading (workspace:", workspace, ")");

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

  registerBusinessTools(ctx, toolCtx);
  registerIdentityTools(ctx); // Phase 4:身份工具 ×2
  void buildPluginPrompt;

  console.log("[beidou-work] 8 business + 2 identity tools registered, mock:", built.isMock);
  })().catch((e) => {
    console.error("[beidou-work] FATAL: context build failed:", e);
    throw e; // 让插件启动失败(非静默)
  });
}
