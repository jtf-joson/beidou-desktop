import { describe, expect, it } from "vitest";
import { buildSemanticGraph, type GraphSource } from "./graph";

const src: GraphSource = {
  relations: [
    { id: "r1", domain: "class.store", range: "class.city" },
    { id: "r2", domain: "class.city", range: "class.region" },
  ],
  metrics: [
    { id: "metric.sales", subject: "class.store" },
    { id: "metric.orders", subject: "class.store" },
    { id: "metric.sales.yoy", subject: "class.store", derivation: { baseMetric: "metric.sales" } },
    { id: "metric.bare" },
  ],
  skills: [
    { id: "skill.diag", requires: { metrics: ["metric.sales", "metric.orders"], playbooks: ["pb.drop"], knowledge: ["k.grading"] } },
  ],
  actions: [{ id: "act.diag", subject: "class.store", relatedMetrics: ["metric.sales"], playbooks: ["pb.drop"] }],
  playbooks: [{ id: "pb.drop", steps: [{ metrics: ["metric.sales"], knowledge: ["k.grading"] }] }],
};

describe("buildSemanticGraph", () => {
  const g = buildSemanticGraph(src);

  it("物化六类边:relatesTo/measuredBy/derivedFrom/usesMetric/usesPlaybook/usesKnowledge", () => {
    const byType = (t: string) => g.edges.filter((e) => e.type === t).length;
    expect(byType("relatesTo")).toBe(2);
    expect(byType("measuredBy")).toBe(3); // 三个有 subject 的指标,bare 不出边
    expect(byType("derivedFrom")).toBe(1);
    expect(byType("usesMetric")).toBe(2 + 1 + 1); // skill + action + playbook step
    expect(byType("usesPlaybook")).toBe(2);
    expect(byType("usesKnowledge")).toBe(2);
  });

  it("邻居双向可见;direction/types 过滤", () => {
    const n = g.neighbors("class.store");
    expect(n.map((x) => x.other).sort()).toEqual(["class.city", "metric.sales", "metric.sales.yoy", "metric.orders"].sort());
    // 只看出边:measuredBy 方向
    const out = g.neighbors("class.store", { direction: "out", types: ["measuredBy"] });
    expect(out.map((x) => x.other).sort()).toEqual(["metric.orders", "metric.sales", "metric.sales.yoy"].sort());
    // 反向:指标看自己的主体
    expect(g.neighbors("metric.sales", { direction: "in", types: ["measuredBy"] })[0]?.other).toBe("class.store");
  });

  it("expand 多跳可达(BFS):store 两跳到 region,一跳不含", () => {
    const one = g.expand(["class.store"], 1, { types: ["relatesTo"] });
    expect(one).toEqual(["class.city"]);
    const two = g.expand(["class.store"], 2, { types: ["relatesTo"] });
    expect(two).toEqual(["class.city", "class.region"]);
  });

  it("影响面:指标变更 → 派生指标与使用它的 skill 反向可达", () => {
    const impacted = g.expand(["metric.sales"], 1);
    expect(impacted).toContain("metric.sales.yoy"); // derivedFrom
    expect(impacted).toContain("skill.diag"); // usesMetric 反向
    expect(impacted).toContain("pb.drop");
  });

  it("空来源与缺失字段容错", () => {
    const empty = buildSemanticGraph({});
    expect(empty.edges).toEqual([]);
    expect(empty.neighbors("x")).toEqual([]);
    expect(empty.expand(["x"], 2)).toEqual([]);
  });
});
