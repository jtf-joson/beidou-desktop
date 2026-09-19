import { describe, expect, it } from "vitest";
import { parseEntities, modelsForMetric } from "./entities";

const yaml = `
entities:
  - name: 车辆
    description: 整车主体
    dataset: dim_vehicle_property_df
    key: vin
    attributes: [config_level, veh_series_no]
  - name: 客户
    description: 车主
    attributes: [customer_id]
businessModels:
  - name: 智驾活跃
    description: 智驾使用强度
    entities: [车辆]
    metrics: [sum_highway_adas_odometer_days, all_adas_count_vin_day]
    dimensions: [dim_vehicle_property_df_config_level, dim_vehicle_property_df_veh_series_no]
  - name: 蓝牙钥匙
    entities: [车辆]
    metrics: [sentry_mode_durs]
    dimensions: [dim_vehicle_property_df_config_level]
`;

describe("parseEntities", () => {
  it("解析实体与业务模型(字段校验,非法条目忽略)", () => {
    const r = parseEntities(yaml);
    expect(r.entities).toHaveLength(2);
    expect(r.entities[0]).toMatchObject({ name: "车辆", dataset: "dim_vehicle_property_df", key: "vin" });
    expect(r.entities[0]!.attributes).toContain("config_level");
    expect(r.models).toHaveLength(2);
    expect(r.models[0]!.dimensions).toContain("dim_vehicle_property_df_config_level");
  });

  it("空/坏/缺字段 → 空结果或部分结果(fail-open,不炸)", () => {
    expect(parseEntities("").entities).toEqual([]);
    expect(parseEntities("not: [yaml").entities).toEqual([]);
    const partial = parseEntities("entities:\\n  - name: A\\n");
    expect(partial.entities).toHaveLength(0); // 缺 attributes 也不致命?不——实体最少要 name
  });

  it("实体至少要有 name;模型至少要有 name+metrics", () => {
    const r = parseEntities(`
entities:
  - name: 有名实体
    attributes: []
  - description: 没名字的
businessModels:
  - name: 好模型
    metrics: [m]
  - name: 坏模型
`);
    expect(r.entities.map((e) => e.name)).toEqual(["有名实体"]);
    expect(r.models.map((m) => m.name)).toEqual(["好模型"]);
  });
});

describe("modelsForMetric", () => {
  const parsed = parseEntities(yaml);
  it("按指标找业务模型(返回关注维度)", () => {
    const hits = modelsForMetric(parsed, "sum_highway_adas_odometer_days");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe("智驾活跃");
    expect(modelsForMetric(parsed, "sentry_mode_durs")[0]!.name).toBe("蓝牙钥匙");
  });

  it("无覆盖模型 → 空数组", () => {
    expect(modelsForMetric(parsed, "unknown_metric")).toEqual([]);
  });
});
