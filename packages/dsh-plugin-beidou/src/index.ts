/**
 * 北斗work dsh 插件入口(Phase 3:8 业务工具全量接线)。
 * V1 空壳 + V2 语义检索 + V3 指标 + V4 下钻 + V5 诊断 + V6 审计。
 */
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { registerBusinessTools } from "./tools";
import { buildPluginContext } from "./context";
import { buildPluginPrompt } from "./prompt";
import type { ToolContext } from "@beidou-core/tools/tools";

export const name = "beidou-work";
export const inject = ["tools"];

export function apply(ctx: Context) {
  const workspace = process.env.BEIDOU_WORKSPACE ?? join(homedir(), "Library/Application Support/北斗work/workspace");
  console.log("[beidou-work] plugin loaded (phase-3, workspace:", workspace, ")");

  void (async () => {
    try {
      const built = await buildPluginContext({ workspace });
      const toolCtx: ToolContext = {
        store: built.workspace.store,
        assets: built.workspace.assets,
        routerConfig: { metricScoreThreshold: 50 },
        guardPolicy: built.toolContextOverrides.guardPolicy,
        metricOnline: false,
        starrocksQuery: built.toolContextOverrides.starrocksQuery,
        audit: built.toolContextOverrides.auditSink,
        sessionId: "dsh-beidou",
        semanticVersion: built.workspace.semanticVersion,
        metricsByCode: built.workspace.metricsByCode,
        ontology: built.workspace.ontology,
        bindings: built.workspace.bindings,
        knowledge: built.workspace.knowledge,
        playbooks: built.workspace.playbooks,
        entities: built.workspace.entities,
        dataSource: built.toolContextOverrides.dataSource,
      };

      // 注册 8 个业务工具
      registerBusinessTools(ctx, toolCtx);

      // systemPrompt:Phase 3 暂跳(工具描述已含路由指引;后续接 ctx.systemPrompt 正确方法)
      void buildPluginPrompt;

      console.log("[beidou-work] 8 business tools registered, system prompt injected, mock:", built.isMock);
    } catch (e) {
      console.error("[beidou-work] context build failed:", e);
    }
  })();
}
