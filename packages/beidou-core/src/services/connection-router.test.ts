import { describe, expect, it } from "vitest";
import { resolveConnection, type ConnectionProfile } from "./connection-router";

const profiles: ConnectionProfile[] = [
  { name: "default", type: "starrocks", host: "sr-main", port: 9030, user: "ro", password: "x" },
  { name: "sr-finance", type: "starrocks", host: "sr-fn", port: 9030, user: "ro", password: "y" },
];

describe("resolveConnection(P1-4 路由序)", () => {
  const base = {
    profiles,
    tableBindings: { "internal.dims.dim_store_df": "sr-finance" },
    datasetBindings: { dim_store: "sr-finance" },
  };

  it("精确表 > 其他", () => {
    const r = resolveConnection({ ...base, table: "internal.dims.dim_store_df" });
    expect(r?.matchType).toBe("table_exact");
    expect(r?.profile.name).toBe("sr-finance");
  });

  it("同 schema 前缀", () => {
    const r = resolveConnection({ ...base, table: "internal.dims.dim_other" });
    expect(r?.matchType).toBe("schema_prefix");
    expect(r?.profile.name).toBe("sr-finance");
  });

  it("dataset 卡片", () => {
    const r = resolveConnection({ ...base, table: "other.schema.table", dataset: "dim_store" });
    expect(r?.matchType).toBe("dataset_card");
  });

  it("default 兜底", () => {
    const r = resolveConnection({ ...base, table: "unknown.schema.table" });
    expect(r?.matchType).toBe("default");
    expect(r?.profile.name).toBe("default");
  });

  it("零 profile → null(拒绝)", () => {
    const r = resolveConnection({ ...base, profiles: [], table: "any.table" });
    expect(r).toBeNull();
  });

  it("bindings 指向不存在的 profile → 跳过(不拒绝,继续路由)", () => {
    const r = resolveConnection({
      ...base,
      table: "internal.dims.dim_store_df",
      tableBindings: { "internal.dims.dim_store_df": "ghost-profile" },
    });
    // ghost 不存在 → 尝试 schema prefix → 也指向 ghost → 跳过 → default
    expect(r?.matchType).toBe("default");
  });
});
