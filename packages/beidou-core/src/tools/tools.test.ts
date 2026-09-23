import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importBeidou } from "../semantics/importer";
import { buildStore } from "../semantics/store";
import { buildSemanticGraph } from "../semantics/graph";
import { createTools, graphExpandHits, type ToolContext } from "./tools";
import type { AuditEvent, MetricMirror } from "../types";
import type { SrQueryResult } from "../services/starrocks";

const FIXTURE_DIR = fileURLToPath(new URL("../../test-fixtures/beidou", import.meta.url));
const MAP: Record<string, string> = {
  "metrics.json": "metrics.sample.json",
  "details.json": "details.sample.json",
  "dimensions.json": "dimensions.sample.json",
  "lineage_summary.json": "lineage_summary.sample.json",
  "physical_tables.json": "physical_tables.sample.json",
};
const assets = importBeidou((n) => {
  try {
    return readFileSync(join(FIXTURE_DIR, MAP[n] ?? n), "utf-8");
  } catch {
    return null;
  }
});

function makeCtx(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; executedSql: string[]; auditLog: AuditEvent[] } {
  const executedSql: string[] = [];
  const auditLog: AuditEvent[] = [];
  const fakeRows: SrQueryResult = {
    rows: [{ metric_value: 42 }],
    columns: ["metric_value"],
    rowCount: 1,
    truncated: false,
  };
  const store = buildStore(assets);
  const ctx: ToolContext = {
    store,
    assets,
    routerConfig: { metricScoreThreshold: 50 },
    guardPolicy: {
      allowedTables: store.allPhysicalTables(),
      maxRow: 200,
    },
    metricOnline: false,
    starrocksQuery: async (sql) => {
      executedSql.push(sql);
      return { ok: true, value: fakeRows };
    },
    audit: {
      append: async (e) => {
        auditLog.push(e);
      },
    },
    sessionId: "test-session",
    semanticVersion: "fixture-1",
    metricsByCode: new Map<string, MetricMirror>(),
    ...overrides,
  };
  return { ctx, executedSql, auditLog };
}

describe("tools.search_semantics", () => {
  it("返回命中 + 路由建议,并写审计", async () => {
    const { ctx, auditLog } = makeCtx();
    const tools = createTools(ctx);
    const r = await tools.search_semantics({ query: "高速智驾" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route?.route).toBeTruthy();
    expect(r.text).toContain("sum_highway_adas_odometer_days");
    expect(auditLog.length).toBeGreaterThan(0);
  });
});

describe("tools.diagnose_metric 资产指导", () => {
  it("在线模式的诊断两期数据都来自指标平台", async () => {
    const onlineCalls: Array<{ metricName: string; dims?: string[]; timeRange?: { start: string; end: string } }> = [];
    const { ctx, executedSql } = makeCtx({
      metricOnline: true,
      queryMetricsOnline: async (req) => {
        onlineCalls.push(req);
        return { ok: true as const, value: { rows: [{ metric_time: req.timeRange?.start, value: 10 }], note: "AnyMetrics semantic API" } };
      },
    });
    const r = await createTools(ctx).diagnose_metric({
      metricName: "sum_highway_adas_odometer_days",
      timeRange: { start: "2026-01-02", end: "2026-01-07" },
      dims: [],
    });
    expect(r.ok).toBe(true);
    expect(onlineCalls.length).toBeGreaterThanOrEqual(2);
    expect(executedSql).toHaveLength(0);
  });

  it("将显式引用指标的 Playbook 与知识页带入结构化结果", async () => {
    const metricName = "sum_highway_adas_odometer_days";
    const { ctx } = makeCtx({
      playbooks: [{ name: "门店销售下滑诊断", content: `指标:${metricName}\n步骤:拆解城市与门店` }],
      knowledge: [{ name: "经营口径", content: `# ${metricName}\n按确认时间统计` }],
    });
    const tools = createTools(ctx);
    const r = await tools.diagnose_metric({ metricName, timeRange: { start: "2026-01-01", end: "2026-01-07" }, dims: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = JSON.parse(r.text) as { assetGuidance: { playbooks: Array<{ name: string }>; knowledge: Array<{ name: string }> } };
    expect(body.assetGuidance.playbooks.map((p) => p.name)).toContain("门店销售下滑诊断");
    expect(body.assetGuidance.knowledge.map((k) => k.name)).toContain("经营口径");
  });
});

describe("tools.query_metrics(离线路径:口径编译 + guard + 执行)", () => {
  it("在线路径接受资产语义维度并转换为平台 dimName", async () => {
    const onlineCalls: Array<{ metricName: string; dims?: string[] }> = [];
    const metric = assets.metrics.find((m) => m.metricName === "sum_highway_adas_odometer_days")!;
    const semanticDim = "dimension.bs.repair-store-city-code";
    const providerDim = "repair_store_city_code";
    const onlineAssets = {
      ...assets,
      metrics: assets.metrics.map((m) => m.metricName === metric.metricName
        ? { ...m, dimensions: [semanticDim], providerDimensions: [providerDim] }
        : m),
    };
    const { ctx } = makeCtx({
      assets: onlineAssets,
      store: buildStore(onlineAssets),
      metricOnline: true,
      queryMetricsOnline: async (req) => {
        onlineCalls.push(req);
        return { ok: true as const, value: { rows: [{ value: 7 }] } };
      },
    });
    const r = await createTools(ctx).query_metrics({ metricName: metric.metricName, dims: [semanticDim] });
    expect(r.ok).toBe(true);
    expect(onlineCalls).toEqual([{ metricName: metric.metricName, dims: [providerDim] }]);
  });

  it("在线路径先校验资产,再调用指标平台并返回口径与血缘证据", async () => {
    const onlineCalls: Array<{ metricName: string; dims?: string[] }> = [];
    const { ctx } = makeCtx({
      metricOnline: true,
      queryMetricsOnline: async (req) => {
        onlineCalls.push(req);
        return { ok: true as const, value: { rows: [{ value: 7 }], note: "AnyMetrics semantic API" } };
      },
    });
    const metric = ctx.store.getMetric("sum_highway_adas_odometer_days")!;
    const r = await createTools(ctx).query_metrics({ metricName: metric.metricName });
    expect(r.ok).toBe(true);
    expect(onlineCalls).toHaveLength(1);
    expect(r.text).toContain("AnyMetrics semantic API");
    expect(r.evidence[0]?.lineage).toContain(metric.metricName);
    const invalid = await createTools(ctx).query_metrics({ metricName: metric.metricName, dims: ["not_a_metric_dimension"] });
    expect(invalid.ok).toBe(false);
    expect(onlineCalls).toHaveLength(1);
  });

  it("全链路:SQL 来自编译器,证据带口径/血缘/行数", async () => {
    const { ctx, executedSql, auditLog } = makeCtx();
    const tools = createTools(ctx);
    const r = await tools.query_metrics({
      metricName: "sum_highway_adas_odometer_days",
      timeRange: { start: "2026-08-01", end: "2026-08-31" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(executedSql).toHaveLength(1);
    expect(executedSql[0]).toMatch(/^SELECT count\(/);
    expect(executedSql[0]).toContain("WHERE dt >= '2026-08-01'");
    expect(r.evidence[0]?.caliber).toBeTruthy();
    expect(r.evidence[0]?.lineage?.length).toBeGreaterThanOrEqual(3);
    expect(r.evidence[0]?.rows).toBe(1);
    expect(auditLog.some((e) => e.kind === "tool_result")).toBe(true);
  });

  it("指标不存在 → 结构化错误(fail-closed)", async () => {
    const { ctx } = makeCtx();
    const r = await createTools(ctx).query_metrics({ metricName: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nope");
  });

  it("派生指标无平台查询能力 → 明确拒绝,不复用基础公式", async () => {
    const derived = {
      ...assets.metrics[0]!,
      metricName: "store_sales_mom",
      displayName: "门店销售额环比",
      type: "DERIVED" as const,
      caliber: { metricTime: "dt" },
      physicalTables: assets.metrics[0]!.physicalTables,
    };
    const derivedAssets = { ...assets, metrics: [...assets.metrics, derived] };
    const { ctx, executedSql } = makeCtx({ assets: derivedAssets, store: buildStore(derivedAssets) });
    const r = await createTools(ctx).query_metrics({ metricName: "store_sales_mom" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("指标平台");
    expect(executedSql).toHaveLength(0);
  });

  it("guard 拒绝(vin 为敏感列)→ guard_rejection 审计 + 不执行", async () => {
    const { ctx, executedSql, auditLog } = makeCtx({
      guardPolicy: {
        allowedTables: buildStore(assets).allPhysicalTables(),
        maxRow: 200,
        sensitiveColumns: ["vin"],
      },
    });
    const r = await createTools(ctx).query_metrics({ metricName: "sum_highway_adas_odometer_days" });
    expect(r.ok).toBe(false);
    expect(executedSql).toHaveLength(0);
    expect(auditLog.some((e) => e.kind === "guard_rejection")).toBe(true);
  });

  it("嵌套指标 code 可解析(BIN_OP 引用 mc 码)", async () => {
    // 构造 code → 简单公式的映射;并给 drive_dur 补数据集/物理表上下文(原口径未带)
    const binopAssets = importBeidou((n) => {
      const m: Record<string, string> = { ...MAP, "metrics.json": "metrics.binop.sample.json", "details.json": "details.binop.sample.json" };
      try {
        return readFileSync(join(FIXTURE_DIR, m[n] ?? n), "utf-8");
      } catch {
        return null;
      }
    });
    const patched: typeof binopAssets = {
      ...binopAssets,
      metrics: binopAssets.metrics.map((m) =>
        m.metricName === "drive_dur"
          ? {
              ...m,
              datasetName: "dm_vom_adas_total_odometer",
              physicalTables: ["default_catalog.dw.dws_vehicle_adas_drive_index_df"],
            }
          : m,
      ),
    };
    const driveDur = patched.metrics.find((m) => m.metricName === "drive_dur")!;
    const codeMap = new Map<string, MetricMirror>();
    for (const code of driveDur.refMetricCodes) {
      codeMap.set(code, {
        ...driveDur,
        metricName: "sub_" + code,
        caliber: {
          formula: { type: "CALL_OP", op: "count", args: [{ type: "NAME_REF", path: ["dm_vom_adas_total_odometer", "vin"] }] },
        },
      });
    }
    const { ctx, executedSql } = makeCtx({
      store: buildStore(patched),
      guardPolicy: { allowedTables: buildStore(patched).allPhysicalTables(), maxRow: 200 },
      metricsByCode: codeMap,
    });
    const r = await createTools(ctx).query_metrics({ metricName: "drive_dur" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(executedSql[0]).toContain("(count(vin) - count(vin))");
  });
});

describe("tools.query_dataset", () => {
  it("explore 模式:结构化参数 → SQL → 执行", async () => {
    const { ctx, executedSql } = makeCtx();
    const r = await createTools(ctx).query_dataset({
      mode: "explore",
      table: "default_catalog.dw.dws_vehicle_adas_drive_index_df",
      selectColumns: ["dt"],
      aggregates: [{ func: "count", column: "vin", alias: "cnt" }],
      groupBy: ["dt"],
      limit: 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(executedSql[0]).toContain("count(vin) AS cnt");
    expect(r.evidence[0]?.sql).toContain("GROUP BY dt");
  });

  it("explore 模式:白名单外表 → 拒绝", async () => {
    const { ctx } = makeCtx();
    const r = await createTools(ctx).query_dataset({
      mode: "explore",
      table: "evil.schema.t",
      selectColumns: ["a"],
    });
    expect(r.ok).toBe(false);
  });

  it("drilldown 模式:等价于离线指标查询", async () => {
    const { ctx, executedSql } = makeCtx();
    const r = await createTools(ctx).query_dataset({
      mode: "drilldown",
      metricName: "sum_highway_adas_odometer_days",
      dims: [],
      timeRange: { start: "2026-08-01", end: "2026-08-31" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(executedSql[0]).toContain("count(");
  });
});

describe("tools.clarify", () => {
  it("返回澄清问题 + 证据", async () => {
    const { ctx } = makeCtx();
    const r = await createTools(ctx).clarify({ questions: ["时间范围?", "口径?"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clarify?.questions).toHaveLength(2);
    expect(r.evidence[0]?.kind).toBe("clarify");
  });
});

describe("graphExpandHits(图邻居扩展)", () => {
  it("top 命中经共同主体带出兄弟指标,分数压在直接命中之下", () => {
    const mini: SemanticAssets = {
      metrics: [
        { metricName: "sales", displayName: "销售额", type: "ATOMIC", categoryPath: [], physicalTables: [], dimensions: [], refMetricCodes: [], code: "metric.sales" },
        { metricName: "orders", displayName: "订单数", type: "ATOMIC", categoryPath: [], physicalTables: [], dimensions: [], refMetricCodes: [], code: "metric.orders" },
      ],
      datasets: [], glossary: [], columnBindings: [], tableToMetrics: {}, importWarnings: [],
    };
    const store = buildStore(mini);
    const byCode = new Map(mini.metrics.map((m) => [m.code as string, m]));
    const graph = buildSemanticGraph({
      metrics: [
        { id: "metric.sales", subject: "class.store" },
        { id: "metric.orders", subject: "class.store" },
      ],
    });
    const hits: SearchHit[] = [
      { kind: "metric", id: "sales", name: "sales", displayName: "销售额", score: 100, why: "英文名精确匹配" },
    ];
    const expanded = graphExpandHits(hits, { graph, store, metricsByCode: byCode });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({ kind: "metric", id: "orders", score: 30 });
    expect(expanded[0]?.why).toContain("class.store");
    expect(hits).toHaveLength(1);
  });

  it("entity 种子直接沿 measuredBy 带出指标", () => {
    const mini: SemanticAssets = {
      metrics: [
        { metricName: "nss", displayName: "净满意度", type: "COMPOSITE", categoryPath: [], physicalTables: [], dimensions: [], refMetricCodes: [], code: "metric.nss" },
      ],
      datasets: [], glossary: [], columnBindings: [], tableToMetrics: {}, importWarnings: [],
    };
    const graph = buildSemanticGraph({ metrics: [{ id: "metric.nss", subject: "class.ticket" }] });
    const hits: SearchHit[] = [
      { kind: "entity", id: "class.ticket", name: "服务工单", score: 70, why: "本体 class" },
    ];
    const expanded = graphExpandHits(hits, { graph, store: buildStore(mini), metricsByCode: new Map([["metric.nss", mini.metrics[0]!]]) });
    expect(expanded[0]).toMatchObject({ id: "nss", why: expect.stringContaining("measuredBy") });
  });
});
