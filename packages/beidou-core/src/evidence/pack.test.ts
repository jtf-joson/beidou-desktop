import { describe, expect, it } from "vitest";
import { buildEvidenceItem, redactSecrets } from "./pack";

describe("buildEvidenceItem", () => {
  it("指标查询证据:口径、SQL、血缘链齐全", () => {
    const e = buildEvidenceItem({
      kind: "metric_query",
      title: "智驾高速里程(天) 近30天",
      metricName: "sum_highway_adas_odometer_days",
      caliber: "高速智驾活跃天数",
      sql: "SELECT count(vin) ...",
      physicalTables: ["default_catalog.dw.dws_vehicle_adas_drive_index_df"],
      lineage: ["sum_highway_adas_odometer_days", "dm_vom_adas_total_odometer", "default_catalog.dw.dws_vehicle_adas_drive_index_df"],
      rows: 30,
      elapsedMs: 120,
      semanticVersion: "2026-09-17T12:00:00Z",
    });
    expect(e.title).toContain("智驾");
    expect(e.lineage).toHaveLength(3);
    expect(e.semanticVersion).toBeTruthy();
  });

  it("明细查询证据:truncated 标记", () => {
    const e = buildEvidenceItem({ kind: "dataset_query", title: "明细", sql: "SELECT ...", rows: 200, truncated: true });
    expect(e.truncated).toBe(true);
  });
});

describe("redactSecrets 审计脱敏", () => {
  it("脱敏常见敏感键", () => {
    const out = redactSecrets({
      Authorization: "Bearer abc",
      auth_value: "u123",
      password: "p",
      nested: { cookie: "x=1", token: "t", safe: "ok" },
      sql: "SELECT 'password' FROM t",
    });
    expect(out.Authorization).toBe("***");
    expect((out as any).auth_value).toBe("***");
    expect((out as any).password).toBe("***");
    expect((out.nested as any).cookie).toBe("***");
    expect((out.nested as any).token).toBe("***");
    expect((out.nested as any).safe).toBe("ok");
    expect(out.sql).toContain("password"); // 值里的词不动,只按键脱敏
  });

  it("字符串输入脱敏 bearer/token 字样", () => {
    const s = redactSecrets("Authorization: Bearer eyJhbGciOi.xxx") as string;
    expect(s).not.toContain("eyJhbGciOi");
  });
});
