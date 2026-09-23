import { describe, expect, it } from "vitest";
import { buildPluginPrompt } from "./prompt";
import type { LoadedWorkspace } from "./workspace";

describe("buildPluginPrompt(会话 Release 上下文注入)", () => {
  it("把指标平台在线状态传递给 Agent 路由协议", () => {
    const ws = {
      name: "x", semanticVersion: "x@d1", assets: { metrics: [], glossary: [], importWarnings: [] },
      ontology: { classes: [], relations: [] }, knowledge: [], playbooks: [], scope: null,
    } as unknown as LoadedWorkspace;
    expect(buildPluginPrompt(ws, false)).toContain("指标平台未配置");
    expect(buildPluginPrompt(ws, true)).toContain("指标平台在线");
  });

  it("在 core 路由协议之后追加版本固定声明与资产规模", () => {
    const ws = {
      name: "售后服务域",
      semanticVersion: "aftersale-service@194db59e",
      assets: { metrics: [{}, {}, {}], glossary: [{}], importWarnings: [] },
      ontology: { classes: [{}, {}], relations: [{}] },
      knowledge: [],
      playbooks: [],
      scope: null,
    } as unknown as LoadedWorkspace;
    const prompt = buildPluginPrompt(ws);
    // core 路由协议仍在
    expect(prompt).toContain("search_semantics");
    expect(prompt).toContain("路由协议");
    // Release 上下文(方案 §9.2/9.3)
    expect(prompt).toContain("空间:售后服务域");
    expect(prompt).toContain("资产版本:aftersale-service@194db59e");
    expect(prompt).toContain("本会话全程固定此版本");
    expect(prompt).toContain("指标 3 · 术语 1 · 本体类 2 · 本体关系 1");
    expect(prompt).not.toContain("已按空间 scope 过滤");
  });

  it("配置 scope 时追加范围声明", () => {
    const ws = {
      name: "x", semanticVersion: "x@d1", assets: { metrics: [], glossary: [], importWarnings: [] },
      ontology: { classes: [], relations: [] }, knowledge: [], playbooks: [],
      scope: { metricNames: ["a"] },
    } as unknown as LoadedWorkspace;
    expect(buildPluginPrompt(ws)).toContain("已按空间 scope 过滤");
  });
});
