/**
 * systemPrompt 注入:路由协议 + 子域/技能/知识库清单。
 */
import { buildSystemPrompt } from "@beidou-core/router/prompt";
import type { LoadedWorkspace } from "../../../apps/desktop/src/main/workspace";

export function buildPluginPrompt(ws: LoadedWorkspace): string {
  return buildSystemPrompt({
    metricOnline: false,
    workspaceName: ws.name,
    knowledgeNames: ws.knowledge.map((k) => k.name),
    playbookNames: ws.playbooks.map((p) => p.name),
  });
}
