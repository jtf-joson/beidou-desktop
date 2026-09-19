import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importBeidou } from "../semantics/importer";
import { buildStore } from "../semantics/store";
import { createTools, type ToolContext } from "./tools";
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

describe("tools.query_metrics(离线路径:口径编译 + guard + 执行)", () => {
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
