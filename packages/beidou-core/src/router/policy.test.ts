import { describe, expect, it } from "vitest";
import { decideRoute } from "./policy";
import type { SearchHit } from "../types";

const metricHit = (id: string, score: number, dims: string[] = ["d1"]): SearchHit => ({
  kind: "metric",
  id,
  name: id,
  displayName: "指标" + id,
  score,
  why: "测试",
  dimensions: dims,
  physicalTables: ["a.b.c"],
});
const datasetHit = (id: string, score: number): SearchHit => ({
  kind: "dataset",
  id,
  name: id,
  score,
  why: "测试",
  physicalTables: ["a.b.c"],
});

const CFG = { metricScoreThreshold: 50 };

describe("decideRoute 路由策略", () => {
  it("高分指标命中 → query_metrics", () => {
    const r = decideRoute({ hits: [metricHit("m1", 100)], config: CFG, metricOnline: true });
    expect(r.route).toBe("query_metrics");
    expect(r.primaryHit?.id).toBe("m1");
    expect(r.reason).toBeTruthy();
  });

  it("指标离线(平台未配置)但有物理表 → 降级 query_dataset(走口径编译)", () => {
    const r = decideRoute({ hits: [metricHit("m1", 100)], config: CFG, metricOnline: false });
    expect(r.route).toBe("query_dataset");
    expect(r.reason).toContain("离线");
  });

  it("低分指标命中 + 数据集命中 → query_dataset", () => {
    const r = decideRoute({ hits: [metricHit("m1", 20), datasetHit("ds1", 80)], config: CFG, metricOnline: true });
    expect(r.route).toBe("query_dataset");
  });

  it("只有弱命中 → clarify,并给出结构化澄清问题(AUM 六判断风格)", () => {
    const r = decideRoute({ hits: [metricHit("m1", 10)], config: CFG, metricOnline: true });
    expect(r.route).toBe("clarify");
    expect(r.clarifyQuestions?.length).toBeGreaterThanOrEqual(2);
    expect(r.clarifyQuestions?.some((q) => q.includes("时间"))).toBe(true);
  });

  it("零命中 → clarify(不猜)", () => {
    const r = decideRoute({ hits: [], config: CFG, metricOnline: true });
    expect(r.route).toBe("clarify");
  });

  it("命中的指标无维度且用户要明细?——维度决策交给 Agent,策略只给主路径", () => {
    const r = decideRoute({ hits: [metricHit("m1", 100, [])], config: CFG, metricOnline: true });
    expect(r.route).toBe("query_metrics");
  });

  it("reject:命中指标为 OFFLINE 状态(检索层已过滤时不会发生,双保险)", () => {
    const offlineHit = { ...metricHit("m2", 100), displayName: "OFFLINE 指标" };
    const r = decideRoute({ hits: [offlineHit as SearchHit], config: CFG, metricOnline: true, metricStatus: { m2: "OFFLINE" } });
    expect(r.route).not.toBe("query_metrics");
  });
});
