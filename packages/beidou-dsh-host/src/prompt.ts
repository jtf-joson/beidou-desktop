/**
 * systemPrompt 注入:路由协议 + 子域/技能/知识库清单 + 会话 Release 上下文(方案 §9.2/9.3)。
 */
import { buildSystemPrompt } from "@beidou/core/src/router/prompt.ts";
import type { LoadedWorkspace } from "./workspace";

export function buildPluginPrompt(ws: LoadedWorkspace, metricOnline = false): string {
  const base = buildSystemPrompt({
    metricOnline,
    workspaceName: ws.name,
    knowledgeNames: ws.knowledge.map((k) => k.name),
    playbookNames: ws.playbooks.map((p) => p.name),
  });
  // 会话固定版本声明:Release/资产计数来自装载快照,回答证据需引用该版本
  const release = [
    "## 当前会话上下文(版本已固定)",
    `- 空间:${ws.name}`,
    `- 资产版本:${ws.semanticVersion}。本会话全程固定此版本,不随资产仓更新切换;回答证据中的 semanticVersion 应与之一致。`,
    `- 资产来源:${ws.assetSource}${ws.assetBundleId ? ` (Bundle ${ws.assetBundleId})` : ""}。若来源为 asset-repo,说明当前未锁定发布快照。`,
    `- 资产规模:指标 ${ws.assets.metrics.length} · 术语 ${ws.assets.glossary.length} · 本体类 ${ws.ontology.classes.length} · 本体关系 ${ws.ontology.relations.length}`,
  ];
  if (ws.scope) release.push("- 资产范围:已按空间 scope 过滤,范围外资产检索不到属正常。");
  return `${base}\n${release.join("\n")}\n`;
}
