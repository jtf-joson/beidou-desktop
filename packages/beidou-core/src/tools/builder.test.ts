import { describe, expect, it } from "vitest";
import { buildExploreSql } from "./builder";

const OK = { allowedTables: ["default_catalog.dw.t1", "default_catalog.dim.d2"] };

describe("buildExploreSql 受控明细分析 SQL 构建", () => {
  it("选择列 + 聚合 + 分组 + 排序", () => {
    const r = buildExploreSql(
      {
        table: "default_catalog.dw.t1",
        selectColumns: ["dt"],
        aggregates: [{ func: "count", column: "vin", alias: "cnt" }],
        groupBy: ["dt"],
        orderBy: { column: "cnt", desc: true },
        limit: 100,
      },
      OK,
    );
    expect(r).toEqual({
      ok: true,
      value: "SELECT dt, count(vin) AS cnt FROM default_catalog.dw.t1 GROUP BY dt ORDER BY cnt DESC LIMIT 100",
    });
  });

  it("where 条件(值做字面量转义)", () => {
    const r = buildExploreSql(
      {
        table: "default_catalog.dim.d2",
        selectColumns: ["config_level"],
        aggregates: [{ func: "sum", column: "cnt", alias: "s" }],
        where: [
          { column: "dt", op: ">=", value: "2026-08-01" },
          { column: "name", op: "=", value: "a'b" },
        ],
        groupBy: ["config_level"],
        limit: 50,
      },
      OK,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toContain("dt >= '2026-08-01'");
      expect(r.value).toContain("name = 'a''b'");
    }
  });

  it("in 条件用数组值", () => {
    const r = buildExploreSql(
      { table: "default_catalog.dw.t1", selectColumns: ["a"], where: [{ column: "a", op: "in", value: ["x", "y"] }], limit: 10 },
      OK,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain("a IN ('x', 'y')");
  });

  it("表不在白名单 → 拒绝", () => {
    const r = buildExploreSql({ table: "evil.t", selectColumns: ["a"], limit: 10 }, OK);
    expect(r.ok).toBe(false);
  });

  it("列名不合法 → 拒绝(防注入)", () => {
    const r = buildExploreSql({ table: "default_catalog.dw.t1", selectColumns: ["a; DROP"], limit: 10 }, OK);
    expect(r.ok).toBe(false);
  });

  it("聚合函数不在白名单 → 拒绝", () => {
    const r = buildExploreSql(
      { table: "default_catalog.dw.t1", selectColumns: [], aggregates: [{ func: "pg_sleep", column: "x", alias: "y" }], limit: 10 },
      OK,
    );
    expect(r.ok).toBe(false);
  });

  it("where 操作符不在白名单 → 拒绝", () => {
    const r = buildExploreSql(
      { table: "default_catalog.dw.t1", selectColumns: ["a"], where: [{ column: "a", op: "like", value: "x" }], limit: 10 },
      OK,
    );
    expect(r.ok).toBe(false);
  });

  it("无 select 列也无聚合 → 拒绝(不允许 SELECT *)", () => {
    const r = buildExploreSql({ table: "default_catalog.dw.t1", selectColumns: [], limit: 10 }, OK);
    expect(r.ok).toBe(false);
  });

  it("limit 超上限收紧到 200", () => {
    const r = buildExploreSql({ table: "default_catalog.dw.t1", selectColumns: ["a"], limit: 99999 }, OK);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatch(/LIMIT 200$/);
  });

  it("orderBy 列必须是 select/groupBy 中的列", () => {
    const r = buildExploreSql(
      { table: "default_catalog.dw.t1", selectColumns: ["a"], orderBy: { column: "secret_col", desc: false }, limit: 10 },
      OK,
    );
    expect(r.ok).toBe(false);
  });
});
