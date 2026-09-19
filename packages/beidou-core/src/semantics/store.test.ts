import { describe, expect, it } from "vitest";
import type { SemanticAssets } from "../types";
import { buildStore } from "./store";

const assets: SemanticAssets = {
  metrics: [
    {
      metricName: "sum_highway_adas_odometer_days",
      displayName: "智驾高速里程(天)",
      type: "ATOMIC",
      categoryPath: ["智能驾驶", "行车"],
      datasetName: "dm_vom_adas_total_odometer",
      physicalTables: ["default_catalog.dw.dws_vehicle_adas_drive_index_df"],
      dimensions: ["dim_vehicle_property_df_config_level", "autopilot"],
      refMetricCodes: [],
    },
    {
      metricName: "sentry_mode_durs",
      displayName: "哨兵模式时长",
      type: "ATOMIC",
      categoryPath: ["智能空间"],
      datasetName: "dws_vehicle_adas_sentry_mode_di",
      physicalTables: ["default_catalog.dw.dws_vehicle_adas_sentry_mode_di"],
      dimensions: ["act_delivery_days"],
      refMetricCodes: [],
    },
  ],
  datasets: [
    {
      datasetName: "dm_vom_adas_total_odometer",
      displayName: "智驾行车累计表",
      physicalTables: ["default_catalog.dw.dws_vehicle_adas_drive_index_df"],
      metrics: ["sum_highway_adas_odometer_days"],
      columns: ["dt", "vin", "adas_durs"],
    },
  ],
  glossary: [
    { term: "智驾里程", synonyms: ["NOP里程", "自动驾驶里程"], metricRefs: ["sum_highway_adas_odometer_days"] },
    { term: "哨兵", synonyms: ["sentinel"], metricRefs: ["sentry_mode_durs"] },
  ],
  columnBindings: [],
  tableToMetrics: {
    "default_catalog.dw.dws_vehicle_adas_drive_index_df": ["sum_highway_adas_odometer_days"],
    "default_catalog.dw.dws_vehicle_adas_sentry_mode_di": ["sentry_mode_durs"],
  },
  importWarnings: [],
};

describe("buildStore 语义检索", () => {
  const store = buildStore(assets);

  it("按英文名精确命中,得分最高且带维度/物理表", () => {
    const hits = store.search("sum_highway_adas_odometer_days");
    const top = hits.find((h) => h.kind === "metric");
    expect(top?.id).toBe("sum_highway_adas_odometer_days");
    expect(top?.dimensions).toContain("autopilot");
    expect(top?.physicalTables?.[0]).toContain("dws_vehicle_adas_drive_index_df");
  });

  it("按中文显示名子串命中", () => {
    const hits = store.search("智驾高速里程");
    expect(hits.some((h) => h.kind === "metric" && h.id === "sum_highway_adas_odometer_days")).toBe(true);
  });

  it("glossary 同义词扩展:NOP里程 → 智驾里程 → 指标", () => {
    const hits = store.search("NOP里程");
    expect(hits.some((h) => h.kind === "metric" && h.id === "sum_highway_adas_odometer_days")).toBe(true);
    expect(hits.some((h) => h.kind === "term")).toBe(true);
  });

  it("词袋命中:多词查询按覆盖词数加分(高速+里程 命中智驾高速里程)", () => {
    const hits = store.search("高速 里程 有多少");
    const metricHits = hits.filter((h) => h.kind === "metric");
    expect(metricHits[0]?.id).toBe("sum_highway_adas_odometer_days");
  });

  it("数据集名与显示名可检索", () => {
    const hits = store.search("智驾行车累计表");
    expect(hits.some((h) => h.kind === "dataset" && h.id === "dm_vom_adas_total_odometer")).toBe(true);
  });

  it("物理表名可检索(kind=table)", () => {
    const hits = store.search("dws_vehicle_adas_sentry_mode_di");
    expect(hits.some((h) => h.kind === "table")).toBe(true);
  });

  it("无命中返回空数组(不猜)", () => {
    expect(store.search("不存在的概念xyz")).toEqual([]);
  });

  it("limit 生效", () => {
    expect(store.search("智驾", { limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it("searchById 精确取指标(供工具层用)", () => {
    const m = store.getMetric("sum_highway_adas_odometer_days");
    expect(m?.displayName).toBe("智驾高速里程(天)");
    expect(store.getMetric("nope")).toBeUndefined();
  });
});
