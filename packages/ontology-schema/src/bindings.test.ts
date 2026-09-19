import { describe, expect, it } from "vitest";
import { loadBindings } from "./bindings";

const datasetsYaml = `
version: 0.1.0
datasets:
  dim_store_df:
    table: { catalog: internal, schema: dims, table: dim_store_df }
    connection: starrocks-main
  fact_service_order:
    table: { catalog: internal, schema: facts, table: fact_service_order }
`;

const tablesYaml = `
version: 0.1.0
tables:
  internal.dims.dim_store_df:
    allowedColumns: [store_code, city, store_level]
    sensitiveColumns: [phone_no]
`;

const metricsYaml = `
version: 0.1.0
classMetrics:
  Store:
    - metricName: store_sales_amt
      source: anymetrics
  Customer:
    - metricName: nps_score
      source: anymetrics
`;

const knowledgeYaml = `
version: 0.1.0
classKnowledge:
  Store:
    - knowledge/store-ops/门店分级.md
`;

describe("loadBindings", () => {
  it("四文件全载入,类型正确", () => {
    const b = loadBindings({ datasetsYaml, tablesYaml, metricsYaml, knowledgeYaml });
    expect(b.datasets.dim_store_df!.table!.catalog).toBe("internal");
    expect(b.tables["internal.dims.dim_store_df"]!.sensitiveColumns).toContain("phone_no");
    expect(b.classMetrics.Store![0]!.metricName).toBe("store_sales_amt");
    expect(b.classKnowledge.Store![0]).toContain("门店分级");
  });

  it("空/坏 YAML → 空对应段(fail-open)", () => {
    const b = loadBindings({ datasetsYaml: "", tablesYaml: "bad: [", metricsYaml: "", knowledgeYaml: "" });
    expect(b.datasets).toEqual({});
    expect(b.tables).toEqual({});
    expect(b.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("缺文件 → 对应段空 + warning", () => {
    const b = loadBindings({});
    expect(b.datasets).toEqual({});
    expect(b.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("table 三段式校验(catalog.schema.table)", () => {
    const b = loadBindings({
      datasetsYaml: "datasets:\\n  bad_ds:\\n    table: { catalog: a, schema: b }",
    });
    expect(b.datasets.bad_ds).toBeUndefined();
  });
});
