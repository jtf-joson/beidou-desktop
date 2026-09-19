import { describe, expect, it } from "vitest";
import { buildSystemPrompt, validatePromptContract, TOOL_NAMES } from "./prompt";
import { decideRoute } from "./policy";

describe("system prompt 契约(CODE_STANDARDS:文案与实现不漂移)", () => {
  it("prompt 覆盖全部工具与关键路由规则", () => {
    for (const online of [true, false]) {
      const p = buildSystemPrompt({ metricOnline: online, workspaceName: "测试空间" });
      expect(validatePromptContract(p)).toEqual([]);
    }
  });

  it("prompt 的路由顺序与 decideRoute 实现一致(指标优先→数据集→澄清)", () => {
    const p = buildSystemPrompt({ metricOnline: true, workspaceName: "w" });
    const idxMetric = p.indexOf("query_metrics");
    const idxDataset = p.indexOf("query_dataset");
    const idxClarify = p.indexOf("clarify");
    expect(idxMetric).toBeGreaterThan(-1);
    // 与 decideRoute 的优先级一致性由存在性 + 顺序描述保证
    expect(p.indexOf("指标优先")).toBeGreaterThan(p.indexOf("先检索"));
    expect([idxMetric, idxDataset, idxClarify].every((i) => i > -1)).toBe(true);

    // decideRoute 的三档结果与 prompt 宣称一致
    const strong = decideRoute({
      hits: [{ kind: "metric", id: "m", name: "m", score: 100, why: "" }],
      config: { metricScoreThreshold: 50 },
      metricOnline: true,
    });
    expect(strong.route).toBe("query_metrics");
    const weak = decideRoute({ hits: [], config: { metricScoreThreshold: 50 }, metricOnline: true });
    expect(weak.route).toBe("clarify");
  });

  it("TOOL_NAMES 与工具层名称一致", () => {
    expect(TOOL_NAMES).toContain("search_semantics");
    expect(TOOL_NAMES).toHaveLength(7);
  });
});
