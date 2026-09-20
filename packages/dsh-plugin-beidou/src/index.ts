/**
 * 北斗work dsh 插件入口(Phase 3:8 业务工具全量接线;P1-3:协议单轨 BeidouToolResult)。
 * V1 空壳 + V2 语义检索 + V3 指标 + V4 下钻 + V5 诊断 + V6 审计 + P1 systemPrompt 注入。
 */
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerBusinessTools } from "./tools";
import { registerIdentityTools } from "./idaas-tool";
import { buildPluginContext } from "./context";
import { buildPluginPrompt } from "./prompt";
import type { ToolContext } from "@beidou-core/tools/tools";

export const name = "beidou-work";
export const inject = ["tools", "systemPrompt"];

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

  // P0-01 修复:真正读取 token 缓存文件(而非抛 "no cache")
  try {
    const { join: j } = await import("node:path");
    const { homedir: hd } = await import("node:os");
    const { readFile: rf } = await import("node:fs/promises");
    const appId = process.env.BEIDOU_IDAAS_APP_ID ?? "beidou-desktop";
    const tokenFile = j(hd(), ".beidou", "auth", "apps", appId, "users", "owner.json");
    const raw = await rf(tokenFile, "utf-8");
    const parsed = JSON.parse(raw) as { user_name?: string; expires_at?: string };
    // 简单过期检查(详细校验由 beidou_auth_status 工具做)
    if (parsed.expires_at && new Date(parsed.expires_at).getTime() > Date.now() - 5 * 60_000) {
      toolCtx.identity = { username: parsed.user_name ?? "owner", source: "idaas-token" };
    }
  } catch { /* 未登录/无缓存 = 无身份,正常 */ }

  // P1 systemPrompt:路由协议 + 空间资产清单注入 dsh 系统 prompt。
  // 位置:TOOLS_SDK(5000)之前——业务协议先于工具 schema 呈现给模型。
  ctx.systemPrompt.section({
    name: "beidou-work:protocol",
    order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK") - 500,
    text: buildPluginPrompt(built.workspace),
  });

  registerBusinessTools(ctx, toolCtx);
  registerIdentityTools(ctx); // Phase 4:身份工具 ×2

  console.log("[beidou-work] 8 business + 2 identity tools registered (BeidouToolResult 单轨), systemPrompt injected, mock:", built.isMock);
  })().catch((e) => {
    console.error("[beidou-work] FATAL: context build failed:", e);
    throw e; // 让插件启动失败(非静默)
  });
}
