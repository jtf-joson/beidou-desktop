import { describe, expect, it } from "vitest";
import { resolveConnection, type ConnectionProfile } from "./connection-router";

const profiles: ConnectionProfile[] = [
  { name: "default", type: "starrocks", host: "sr-main", port: 9030, user: "ro", password: "x" },
  { name: "sr-finance", type: "starrocks", host: "sr-fn", port: 9030, user: "ro", password: "y" },
];

describe("resolveConnection(P0-3 fail-closed)", () => {
  const base = {
    profiles,
    tableBindings: { "internal.dims.dim_store_df": "sr-finance" },
    datasetBindings: { dim_store: "sr-finance" },
  };

  it("精确表 > 其他", () => {
    const r = resolveConnection({ ...base, table: "internal.dims.dim_store_df" });
    expect(r.ok && r.matchType).toBe("table_exact");
  });

  it("同 schema 前缀", () => {
    const r = resolveConnection({ ...base, table: "internal.dims.dim_other" });
    expect(r.ok && r.matchType).toBe("schema_prefix");
  });

  it("dataset 卡片", () => {
    const r = resolveConnection({ ...base, table: "other.schema.table", dataset: "dim_store" });
    expect(r.ok && r.matchType).toBe("dataset_card");
  });

  it("显式 default 兜底", () => {
    const r = resolveConnection({ ...base, table: "unknown.schema.table" });
    expect(r.ok && r.matchType).toBe("default");
  });

  it("P0-3: 精确 Binding 指向不存在 profile → 立即拒绝(不回退)", () => {
    const r = resolveConnection({
      ...base,
      table: "internal.dims.dim_store_df",
      tableBindings: { "internal.dims.dim_store_df": "ghost-profile" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ROUTE_BINDING_PROFILE_NOT_FOUND");
  });

  it("P0-3: 无显式 default → 拒绝(不用 profiles[0])", () => {
    const r = resolveConnection({
      profiles: [profiles[1]!], // 只有 sr-finance,无 default
      table: "any.table",
      tableBindings: {},
      datasetBindings: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ROUTE_NO_DEFAULT");
  });

  it("零 profile → 拒绝", () => {
    const r = resolveConnection({ ...base, profiles: [], table: "any.table" });
    expect(r.ok).toBe(false);
  });
});
