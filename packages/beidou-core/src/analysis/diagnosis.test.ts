import { describe, expect, it } from "vitest";
import { diagnoseMetric, detectAnomaly } from "./diagnosis";

describe("detectAnomaly 异常检测", () => {
  it("同比变化超阈值 → 标记异常(含方向)", () => {
    const r = detectAnomaly({ current: 120, prior: 100, thresholdPct: 10 });
    expect(r.anomaly).toBe(true);
    expect(r.direction).toBe("up");
    expect(r.pctChange).toBeCloseTo(0.2, 5);
  });

  it("变化在阈值内 → 不异常", () => {
    expect(detectAnomaly({ current: 105, prior: 100, thresholdPct: 10 }).anomaly).toBe(false);
    expect(detectAnomaly({ current: 95, prior: 100, thresholdPct: 10 }).anomaly).toBe(false);
  });

  it("下降方向;基线为 0 时视为异常(fail-open 到人工)", () => {
    const r = detectAnomaly({ current: 80, prior: 100, thresholdPct: 10 });
    expect(r.anomaly).toBe(true);
    expect(r.direction).toBe("down");
    const zero = detectAnomaly({ current: 5, prior: 0, thresholdPct: 10 });
    expect(zero.anomaly).toBe(true);
    expect(zero.pctChange).toBeNull();
  });
});

/** 注入式查询:按 (dims, timeRange) 返回分组行 */
const runQuery = (
  scenarios: Array<{ dims: string[]; range: { start: string; end: string }; rows: Array<Record<string, unknown>> }>,
) =>
  async (dims: string[], range: { start: string; end: string }) => {
    const hit = scenarios.find((s) => s.dims.join("|") === dims.join("|") && s.range.start === range.start);
    return hit ? { ok: true as const, rows: hit.rows } : { ok: false as const, error: "no scenario" };
  };

const CUR = { start: "2026-08-01", end: "2026-08-31" };
const PRIOR = { start: "2026-07-01", end: "2026-07-31" };

describe("diagnoseMetric 指标异动归因(DataBuddy 贡献拆解算法)", () => {
  const scenarios = [
    // 总量
    { dims: [] as string[], range: CUR, rows: [{ metric_value: 120 }] },
    { dims: [] as string[], range: PRIOR, rows: [{ metric_value: 100 }] },
    // 车型维度:Pro 涨、Max 跌
    {
      dims: ["config_level"], range: CUR,
      rows: [
        { config_level: "Pro", metric_value: 80 },
        { config_level: "Max", metric_value: 40 },
      ],
    },
    {
      dims: ["config_level"], range: PRIOR,
      rows: [
        { config_level: "Pro", metric_value: 50 },
        { config_level: "Max", metric_value: 50 },
      ],
    },
  ];

  it("全流程:总量对比→异常→维度贡献拆解→Top 贡献者", async () => {
    const r = await diagnoseMetric({
      dims: ["config_level"],
      current: CUR,
      prior: PRIOR,
      thresholdPct: 10,
    }, runQuery(scenarios));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totals.current).toBe(120);
    expect(r.value.totals.prior).toBe(100);
    expect(r.value.totals.delta).toBe(20);
    expect(r.value.anomaly.anomaly).toBe(true);
    expect(r.value.anomaly.direction).toBe("up");
    const dim = r.value.attributions[0]!;
    expect(dim.dim).toBe("config_level");
    // Pro 贡献 (80-50)/100 = +30%;Max 贡献 (40-50)/100 = -10%;合计 = 总变化 20%
    const pro = dim.top.find((c) => c.value === "Pro")!;
    expect(pro.contribution).toBeCloseTo(0.3, 5);
    const max = dim.top.find((c) => c.value === "Max")!;
    expect(max.contribution).toBeCloseTo(-0.1, 5);
    // Top 排序按绝对贡献
    expect(dim.top[0]!.value).toBe("Pro");
    // 贡献闭合校验
    expect(dim.contributionSum).toBeCloseTo(0.2, 5);
  });

  it("查询失败 → 结构化错误(fail-closed,不猜)", async () => {
    const r = await diagnoseMetric({ dims: ["x"], current: CUR, prior: PRIOR }, async () => ({ ok: false as const, error: "boom" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("boom");
  });

  it("无异常时仍输出归因(attribution 供参考),anomaly=false", async () => {
    const mild = [
      { dims: [] as string[], range: CUR, rows: [{ metric_value: 104 }] },
      { dims: [] as string[], range: PRIOR, rows: [{ metric_value: 100 }] },
      { dims: ["d"] as string[], range: CUR, rows: [{ d: "a", metric_value: 104 }] },
      { dims: ["d"] as string[], range: PRIOR, rows: [{ d: "a", metric_value: 100 }] },
    ];
    const r = await diagnoseMetric({ dims: ["d"], current: CUR, prior: PRIOR, thresholdPct: 10 }, runQuery(mild));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.anomaly.anomaly).toBe(false);
      expect(r.value.attributions[0]!.top).toHaveLength(1);
    }
  });

  it("分组缺失值按 0 处理(新增/消失的维度值)", async () => {
    const churn = [
      { dims: [] as string[], range: CUR, rows: [{ metric_value: 90 }] },
      { dims: [] as string[], range: PRIOR, rows: [{ metric_value: 100 }] },
      // 新增成员 g、消失成员 h
      { dims: ["g"] as string[], range: CUR, rows: [{ g: "new", metric_value: 90 }] },
      { dims: ["g"] as string[], range: PRIOR, rows: [{ g: "old", metric_value: 100 }] },
    ];
    const r = await diagnoseMetric({ dims: ["g"], current: CUR, prior: PRIOR }, runQuery(churn));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const top = r.value.attributions[0]!.top;
    expect(top.find((c) => c.value === "new")!.contribution).toBeCloseTo(0.9, 5);
    expect(top.find((c) => c.value === "old")!.contribution).toBeCloseTo(-1.0, 5);
  });

  it("prior 自动推导:只给 current 时取等长前移窗口", async () => {
    const r = await diagnoseMetric(
      { dims: [], current: { start: "2026-08-01", end: "2026-08-31" }, thresholdPct: 10 },
      async (_d, range) => ({ ok: true as const, rows: range.start === "2026-08-01" ? [{ metric_value: 1 }] : [{ metric_value: 1 }] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.priorWindow.start).toBe("2026-07-01");
  });
});
