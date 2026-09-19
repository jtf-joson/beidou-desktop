import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importBeidou } from "../semantics/importer";
import { compileMetricSql } from "./metric-sql";
import type { MetricMirror } from "../types";

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

const binding = (dataset: string, col: string): string | null => {
  const b = assets.columnBindings.find((x) => x.dataset === dataset && x.datasetColumn === col);
  return b ? b.physicalColumn : null;
};
const deps = {
  resolveColumn: binding,
  resolveMetricCode: () => null,
};

const metric = assets.metrics.find((m) => m.metricName === "sum_highway_adas_odometer_days")!;

/** 跨数据集维度解析(与 store.resolveDimBinding 同构的测试实现) */
const dimBindingFixture = (dimName: string) => {
  const m = /^(.+)_df_(.+)$/.exec(dimName);
  if (!m) return null;
  const ds = assets.datasets.find((d) => d.datasetName === `${m[1]}_df`);
  if (!ds || ds.physicalTables.length !== 1) return null;
  return { dimDataset: ds.datasetName, dimColumn: m[2]!, physicalTable: ds.physicalTables[0]!, physicalColumn: m[2]! };
};

describe("compileMetricSql 口径一致下钻编译", () => {
  it("总量(无维度)+ 时间 + 固定过滤(真实口径)", () => {
    const r = compileMetricSql(
      { metric, dims: [], timeRange: { start: "2026-08-01", end: "2026-08-31" }, maxRow: 200 },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const norm = r.value.sql.replace(/\s+/g, " ").trim();
    expect(norm).toContain("AS metric_value");
    expect(norm).toContain("FROM default_catalog.dw.dws_vehicle_adas_drive_index_df");
    expect(norm).toMatch(/WHERE dt >= '2026-08-01' AND dt <= '2026-08-31'/);
    expect(norm).toMatch(/AND \(\(day_noa_active_odometer\) > \(0\)\) AND \(\(day_adas_odometer\) > \(0\)\)/);
    expect(norm).toMatch(/LIMIT 200$/);
    expect(norm.startsWith("SELECT count(")).toBe(true); // 表达式来自 formula,不是 LLM
    expect(r.value.caliberSummary.expr).toContain("count(");
  });

  it("带维度分组(数据集列 → 物理列)", () => {
    const dims = ["adas_durs"]; // 数据集列,物理列同名(在血缘映射中)
    const r = compileMetricSql({ metric, dims, timeRange: { start: "2026-08-01", end: "2026-08-31" }, maxRow: 50 }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const norm = r.value.sql.replace(/\s+/g, " ").trim();
    expect(norm).toContain("GROUP BY adas_durs");
    expect(norm).toContain("ORDER BY metric_value DESC");
  });

  it("无时间范围:不加时间过滤", () => {
    const r = compileMetricSql({ metric, dims: [], maxRow: 100 }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sql).not.toMatch(/>= '20/);
  });

  it("日期字面量做转义(防注入)", () => {
    const r = compileMetricSql({ metric, dims: [], timeRange: { start: "2026'OR'1", end: "2026-08-31" }, maxRow: 10 }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sql).toContain("'2026''OR''1'");
  });

  it("多物理表 → fail-closed", () => {
    const m2: MetricMirror = { ...metric, physicalTables: ["a.b.c", "d.e.f"] };
    const r = compileMetricSql({ metric: m2, dims: [], maxRow: 10 }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MULTI_TABLE");
  });

  it("无口径(formula 缺失)→ fail-closed", () => {
    const m2 = { ...metric, caliber: { datasetName: metric.datasetName } };
    const r = compileMetricSql({ metric: m2 as MetricMirror, dims: [], maxRow: 10 }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NO_FORMULA");
  });

  it("维度解析不了(不在血缘映射)→ fail-closed", () => {
    const r = compileMetricSql({ metric, dims: ["ghost_dim"], maxRow: 10 }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNRESOLVED_DIM");
  });

  it("跨数据集维度:自动 JOIN 维表(按 vin),GROUP BY 维表列(真实产品能力)", () => {
    const r = compileMetricSql(
      { metric, dims: ["dim_vehicle_property_df_config_level"], timeRange: { start: "2026-08-01", end: "2026-08-31" }, maxRow: 50 },
      { ...deps, resolveDimBinding: dimBindingFixture },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const norm = r.value.sql.replace(/\s+/g, " ").trim();
    expect(norm).toContain("LEFT JOIN default_catalog.dim.dim_vehicle_property_df AS d0 ON");
    expect(norm).toMatch(/\.vin = d0\.vin/);
    expect(norm).toContain("GROUP BY d0.config_level");
    expect(norm).toContain("WHERE t.dt >= '2026-08-01'");
  });

  it("混合维度:本数据集列 + 维表列同时下钻", () => {
    const r = compileMetricSql(
      { metric, dims: ["adas_durs", "dim_vehicle_property_df_veh_series_no"], maxRow: 50 },
      { ...deps, resolveDimBinding: dimBindingFixture },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const norm = r.value.sql.replace(/\s+/g, " ").trim();
    expect(norm).toContain("GROUP BY adas_durs, d0.veh_series_no");
    expect(norm).toContain("SELECT adas_durs, d0.veh_series_no");
  });

  it("维表解析不出(数据集不存在)→ fail-closed UNRESOLVED_DIM", () => {
    const r = compileMetricSql(
      { metric, dims: ["ghost_dataset_df_col"], maxRow: 10 },
      { ...deps, resolveDimBinding: dimBindingFixture },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNRESOLVED_DIM");
  });

  it("物理表名不合法 → fail-closed", () => {
    const m2: MetricMirror = { ...metric, physicalTables: ["evil; DROP TABLE x"] };
    const r = compileMetricSql({ metric: m2, dims: [], maxRow: 10 }, deps);
    expect(r.ok).toBe(false);
  });
});
