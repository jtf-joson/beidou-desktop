import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importBeidou } from "./importer";

const FIXTURE_DIR = fileURLToPath(new URL("../../test-fixtures/beidou", import.meta.url));

/** 规范名 → 夹具文件名映射(夹具是从真实导出抽样的) */
const FIXTURE_MAP: Record<string, string> = {
  "metrics.json": "metrics.sample.json",
  "details.json": "details.sample.json",
  "dimensions.json": "dimensions.sample.json",
  "lineage_summary.json": "lineage_summary.sample.json",
  "physical_tables.json": "physical_tables.sample.json",
};

/** 注入式文件读取器:按文件名读夹具,缺文件返回 null */
const reader = (name: string): string | null => {
  const file = FIXTURE_MAP[name] ?? name;
  try {
    return readFileSync(join(FIXTURE_DIR, file), "utf-8");
  } catch {
    return null;
  }
};

/** binop 变体:metrics/details 换成 drive_dur(BIN_OP 引用两个 mc 码) */
const binopReader = (name: string): string | null => {
  if (name === "metrics.json") return reader("metrics.binop.sample.json");
  if (name === "details.json") return reader("details.binop.sample.json");
  return reader(name);
};

describe("importBeidou 北斗导出 → 语义资产", () => {
  const assets = importBeidou(reader);

  it("导入指标,基础字段完整", () => {
    expect(assets.metrics).toHaveLength(2);
    const m = assets.metrics.find((x) => x.metricName === "all_adas_count_vin_day");
    expect(m).toBeDefined();
    expect(m!.displayName).toBeTruthy();
    expect(["ATOMIC", "DERIVED", "COMPOSITE"]).toContain(m!.type);
    expect(Array.isArray(m!.categoryPath)).toBe(true);
    expect(Array.isArray(m!.dimensions)).toBe(true);
  });

  it("details 提供 datasetName 与 refMetricCodes(BIN_OP 引用 mc 码)", () => {
    const binop = importBeidou(binopReader);
    const driveDur = binop.metrics.find((x) => x.metricName === "drive_dur");
    expect(driveDur).toBeDefined();
    expect(driveDur!.refMetricCodes.length).toBeGreaterThanOrEqual(2);
    expect(driveDur!.refMetricCodes[0]).toMatch(/^mc/);
  });

  it("数据集卡片:dataset_to_physical_tables + 列来自血缘映射", () => {
    expect(assets.datasets.length).toBeGreaterThan(0);
    // 虚拟数据集 dm_vom_adas_total_odometer → 物理表 ...dws_vehicle_adas_drive_index_df
    const ds = assets.datasets.find((d) => d.datasetName === "dm_vom_adas_total_odometer");
    expect(ds).toBeDefined();
    expect(ds!.physicalTables).toContain("default_catalog.dw.dws_vehicle_adas_drive_index_df");
    expect(ds!.columns).toContain("dt");
  });

  it("指标的物理表通过 数据集→物理表 间接得到", () => {
    const m = assets.metrics.find((x) => x.datasetName === "dm_vom_adas_total_odometer");
    if (m) {
      // 虚拟数据集名 ≠ 物理表名,必须经映射
      expect(m.physicalTables).toContain("default_catalog.dw.dws_vehicle_adas_drive_index_df");
      expect(m.physicalTables.some((t) => t.endsWith(".dm_vom_adas_total_odometer"))).toBe(false);
    }
  });

  it("反向索引:物理表 → 引用它的指标", () => {
    const m = assets.tableToMetrics["default_catalog.dw.dws_vehicle_adas_drive_index_df"];
    expect(Array.isArray(m)).toBe(true);
  });

  it("列绑定:物理列 → 数据集列(方向正确)", () => {
    const b = assets.columnBindings.find(
      (x) =>
        x.physicalTable === "default_catalog.dw.dws_vehicle_adas_drive_index_df" &&
        x.physicalColumn === "dt",
    );
    // dws_vehicle_adas_drive_index_df.dt 映射到数据集列 dm_vom_adas_total_odometer.dt
    expect(b).toBeDefined();
    expect(b!.dataset).toBe("dm_vom_adas_total_odometer");
    expect(b!.datasetColumn).toBe("dt");
  });

  it("缺文件容错:只给 metrics.json 也能导入并记 warning", () => {
    const only = importBeidou((name) => (name === "metrics.json" ? reader("metrics.sample.json") : null));
    expect(only.metrics).toHaveLength(2);
    expect(only.importWarnings.some((w) => w.includes("details.json"))).toBe(true);
    expect(only.datasets).toHaveLength(0);
  });

  it("全部文件缺失 → 错误(fail-closed)", () => {
    const r = importBeidou(() => null);
    expect(r.metrics).toHaveLength(0);
    expect(r.importWarnings.length).toBeGreaterThan(0);
  });
});
