import { describe, expect, it } from "vitest";
import { compileFilterExpr, compileFormula, type CompileCtx } from "./dsl";

const KNOWN_COLS = new Set(["vin", "a", "b", "amt", "dt", "day_noa_active_odometer", "day_adas_odometer"]);
const ctx: CompileCtx = {
  resolveColumn: (dataset, col) => {
    // 简化映射:数据集列名 = 物理列名,且必须在已知列集合内(测试用)
    if (dataset === "dm_vom_adas_total_odometer" && KNOWN_COLS.has(col)) return col;
    return null;
  },
  resolveMetricCode: () => null,
};

const f = (node: unknown) => compileFormula(node, ctx);

describe("compileFormula 公式 AST → SQL 表达式", () => {
  it("CALL_OP + NAME_REF(真实样例)", () => {
    const r = f({
      type: "CALL_OP",
      op: "count",
      args: [{ type: "NAME_REF", path: ["dm_vom_adas_total_odometer", "vin"] }],
    });
    expect(r).toEqual({ ok: true, value: "count(vin)" });
  });

  it("BIN_OP 用 x/y 字段(不是 args)", () => {
    const r = f({
      type: "BIN_OP",
      op: "-",
      x: { type: "NAME_REF", path: ["dm_vom_adas_total_odometer", "a"] },
      y: { type: "NAME_REF", path: ["dm_vom_adas_total_odometer", "b"] },
    });
    expect(r).toEqual({ ok: true, value: "(a - b)" });
  });

  it("嵌套:BIN_OP(CALL_OP, CONSTANT)", () => {
    const r = f({
      type: "BIN_OP",
      op: "*",
      x: { type: "CALL_OP", op: "sum", args: [{ type: "NAME_REF", path: ["dm_vom_adas_total_odometer", "amt"] }] },
      y: { type: "CONSTANT", val: 100 },
    });
    expect(r).toEqual({ ok: true, value: "(sum(amt) * 100)" });
  });

  it("NAME_REF 引用指标 code 时经 resolveMetricCode 展开", () => {
    const ctx2: CompileCtx = {
      ...ctx,
      resolveMetricCode: (code) =>
        code === "mcX" ? { type: "CALL_OP", op: "count", args: [{ type: "NAME_REF", path: ["dm_vom_adas_total_odometer", "vin"] }] } : null,
    };
    const r = compileFormula({ type: "BIN_OP", op: "-", x: { type: "NAME_REF", path: ["mcX"] }, y: { type: "NAME_REF", path: ["mcY"] } }, ctx2);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "UNRESOLVED_REF" }) });
    const r2 = compileFormula({ type: "NAME_REF", path: ["mcX"] }, ctx2);
    expect(r2).toEqual({ ok: true, value: "count(vin)" });
  });

  it("CONSTANT 字符串做 SQL 转义(防注入)", () => {
    const r = f({ type: "CONSTANT", val: "a'b" });
    expect(r).toEqual({ ok: true, value: "'a''b'" });
  });

  it("未知函数名 → fail-closed", () => {
    const r = f({ type: "CALL_OP", op: "pg_sleep", args: [] });
    expect(r.ok).toBe(false);
  });

  it("非法运算符 → fail-closed", () => {
    const r = f({
      type: "BIN_OP",
      op: "||",
      x: { type: "CONSTANT", val: 1 },
      y: { type: "CONSTANT", val: 2 },
    });
    expect(r.ok).toBe(false);
  });

  it("列解析失败(数据集列不在血缘映射)→ fail-closed", () => {
    const r = f({ type: "NAME_REF", path: ["dm_vom_adas_total_odometer", "ghost_col"] });
    expect(r.ok).toBe(false);
  });

  it("null / 未知节点类型 → fail-closed", () => {
    expect(f(null).ok).toBe(false);
    expect(f({ type: "WHO_AM_I" }).ok).toBe(false);
  });
});

describe("compileFilterExpr 过滤 DSL 文本 → SQL 谓词", () => {
  it("真实样例:双条件 AND(全括号中缀)", () => {
    const r = compileFilterExpr(
      "((['dm_vom_adas_total_odometer'/'day_noa_active_odometer']) > (0)) AND ((['dm_vom_adas_total_odometer'/'day_adas_odometer']) > (0))",
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe("((day_noa_active_odometer) > (0)) AND ((day_adas_odometer) > (0))");
    }
  });

  it("OR / NOT / 嵌套括号", () => {
    const r = compileFilterExpr("(NOT ((['dm'/'a']) = (1))) OR ((['dm'/'b']) >= (2.5))", {
      resolveColumn: (ds, c) => (ds === "dm" ? c : null),
      resolveMetricCode: () => null,
    });
    expect(r).toEqual({ ok: true, value: "(NOT ((a) = (1))) OR ((b) >= (2.5))" });
  });

  it("字符串字面量与不等于", () => {
    const r = compileFilterExpr("((['dm'/'c']) != ('x''y'))", {
      resolveColumn: (ds, c) => (ds === "dm" ? c : null),
      resolveMetricCode: () => null,
    });
    expect(r).toEqual({ ok: true, value: "((c) != ('x''y'))" });
  });

  it("垃圾输入 → fail-closed", () => {
    expect(compileFilterExpr("随便一串", ctx).ok).toBe(false);
    expect(compileFilterExpr("", ctx).ok).toBe(false);
    expect(compileFilterExpr("((['dm'/'a']) > (0)) AND", ctx).ok).toBe(false);
  });

  it("注入尝试(引用外闭合/分号)→ fail-closed", () => {
    expect(compileFilterExpr("((['dm'/'a']) > (0)); DROP TABLE t", ctx).ok).toBe(false);
    expect(compileFilterExpr("((['dm'/'a']) > ((0) OR (1)))", ctx).ok).toBe(false);
  });
});
