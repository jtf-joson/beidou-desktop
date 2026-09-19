import { describe, expect, it } from "vitest";
import { filterAssets, parseScope } from "./scope";
import type { SemanticAssets } from "../types";

const base: SemanticAssets = {
  metrics: [
    { metricName: "a1", displayName: "A1", type: "ATOMIC", categoryPath: ["智能驾驶", "行车"], datasetName: "ds1", physicalTables: ["cat.s.t1"], dimensions: [], refMetricCodes: [] },
    { metricName: "a2", displayName: "A2", type: "ATOMIC", categoryPath: ["智能空间"], datasetName: "ds2", physicalTables: ["cat.s.t2"], dimensions: [], refMetricCodes: [] },
    { metricName: "a3", displayName: "A3", type: "ATOMIC", categoryPath: ["智能驾驶", "泊车"], datasetName: "ds1", physicalTables: ["cat.s.t1"], dimensions: [], refMetricCodes: [] },
  ],
  datasets: [
    { datasetName: "ds1", physicalTables: ["cat.s.t1"], metrics: ["a1", "a3"], columns: ["dt"] },
    { datasetName: "ds2", physicalTables: ["cat.s.t2"], metrics: ["a2"], columns: ["dt"] },
  ],
  glossary: [
    { term: "智驾", synonyms: ["NOP"], metricRefs: ["a1", "a3"] },
    { term: "通用", synonyms: [], metricRefs: [] },
  ],
  columnBindings: [
    { dataset: "ds1", datasetColumn: "dt", physicalTable: "cat.s.t1", physicalColumn: "dt" },
    { dataset: "ds2", datasetColumn: "dt", physicalTable: "cat.s.t2", physicalColumn: "dt" },
  ],
  tableToMetrics: { "cat.s.t1": ["a1", "a3"], "cat.s.t2": ["a2"] },
  importWarnings: [],
};

describe("filterAssets 空间资产隔离", () => {
  it("scope 为 null → 原样(不过滤)", () => {
    const out = filterAssets(base, null);
    expect(out.metrics).toHaveLength(3);
  });

  it("按类目前缀过滤:只留智能驾驶", () => {
    const out = filterAssets(base, { categoryPaths: [["智能驾驶"]] });
    expect(out.metrics.map((m) => m.metricName).sort()).toEqual(["a1", "a3"]);
    expect(out.datasets.map((d) => d.datasetName)).toEqual(["ds1"]);
    expect(out.columnBindings.map((b) => b.dataset)).toEqual(["ds1"]);
    expect(Object.keys(out.tableToMetrics)).toEqual(["cat.s.t1"]);
  });

  it("类目前缀支持多级(智能驾驶/行车 只留 a1)", () => {
    const out = filterAssets(base, { categoryPaths: [["智能驾驶", "行车"]] });
    expect(out.metrics.map((m) => m.metricName)).toEqual(["a1"]);
  });

  it("按指标名白名单过滤;数据集/绑定/血缘跟随", () => {
    const out = filterAssets(base, { metricNames: ["a2"] });
    expect(out.metrics.map((m) => m.metricName)).toEqual(["a2"]);
    expect(out.datasets.map((d) => d.datasetName)).toEqual(["ds2"]);
  });

  it("按数据集过滤(显式包含未挂指标的数据集)", () => {
    const out = filterAssets(base, { datasets: ["ds2"] });
    expect(out.metrics.map((m) => m.metricName)).toEqual(["a2"]);
    expect(out.datasets.map((d) => d.datasetName)).toEqual(["ds2"]);
  });

  it("glossary:引用了被保留指标的术语留下;无引用的通用术语也留下;全被过滤的留下吗?不——只留命中的与无引用的", () => {
    const out = filterAssets(base, { categoryPaths: [["智能空间"]] });
    expect(out.glossary.map((g) => g.term).sort()).toEqual(["通用"]);
  });

  it("多条件并集(命中任一即保留)", () => {
    const out = filterAssets(base, { categoryPaths: [["智能空间"]], metricNames: ["a1"] });
    expect(out.metrics.map((m) => m.metricName).sort()).toEqual(["a1", "a2"]);
  });
});

describe("parseScope", () => {
  it("YAML 解析 + 非法值忽略", () => {
    const r = parseScope("categoryPaths:\n  - [智能驾驶]\nmetricNames: [a1]\nfoo: bar\n");
    expect(r).toEqual({
      ok: true,
      value: { categoryPaths: [["智能驾驶"]], metricNames: ["a1"] },
    });
  });

  it("空 → null(不过滤);坏 YAML → 错误(由装载层告警)", () => {
    const empty = parseScope("");
    expect(empty.ok && empty.value === null).toBe(true);
    const bad = parseScope("a: [unclosed");
    expect(bad.ok).toBe(false);
  });
});
