import { describe, expect, it } from "vitest";
import { guard, type GuardPolicy } from "./sql-guard";

const policy: GuardPolicy = {
  allowedTables: [
    "default_catalog.dw.dws_vehicle_adas_drive_index_df",
    "default_catalog.dim.dim_vehicle_property_df",
  ],
  maxRow: 200,
  sensitiveColumns: ["vin", "phone_no"],
};

describe("sql-guard R1 单语句", () => {
  it("正常 SELECT 通过", () => {
    const r = guard("SELECT count(*) FROM default_catalog.dw.dws_vehicle_adas_drive_index_df", policy);
    expect(r.ok).toBe(true);
  });

  it("多条语句用分号分隔 → 拒绝 R1", () => {
    const r = guard("SELECT 1 FROM default_catalog.dw.dws_vehicle_adas_drive_index_df; SELECT 2", policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R1_multi_statement");
  });

  it("行尾分号允许", () => {
    const r = guard("SELECT 1 FROM default_catalog.dw.dws_vehicle_adas_drive_index_df;", policy);
    expect(r.ok).toBe(true);
  });

  it("空/纯空白输入 → 拒绝", () => {
    expect(guard("", policy).ok).toBe(false);
    expect(guard("   \n\t ", policy).ok).toBe(false);
  });
});

describe("sql-guard R2 首词白名单", () => {
  it("小写 select 允许(大小写不敏感)", () => {
    const r = guard("select dt from default_catalog.dw.dws_vehicle_adas_drive_index_df", policy);
    expect(r.ok).toBe(true);
  });

  it("WITH 开头(CTE)允许", () => {
    const r = guard(
      "WITH t AS (SELECT dt FROM default_catalog.dw.dws_vehicle_adas_drive_index_df) SELECT dt FROM t",
      policy,
    );
    expect(r.ok).toBe(true);
  });

  it("EXPLAIN/DESC 的表也须过白名单;SHOW 无表引用仍允许", () => {
    expect(guard("EXPLAIN SELECT 1", policy).ok).toBe(true); // 无表
    expect(guard("SHOW TABLES", policy).ok).toBe(true); // SHOW 不检查表
    // 白名单表的 DESC 允许
    expect(guard("DESC default_catalog.dw.dws_vehicle_adas_drive_index_df", policy).ok).toBe(true);
    // 非白名单表的 EXPLAIN 拒绝(P0-1 修复)
    const r = guard("EXPLAIN SELECT * FROM evil.table", policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R4_table_whitelist");
  });

  it("P0-1 回归:逗号+别名可检测后续表", () => {
    const r = guard(
      "SELECT a.dt FROM default_catalog.dw.dws_vehicle_adas_drive_index_df a, evil.schema.secret b",
      policy,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R4_table_whitelist");
  });

  it("P0-1 回归:SELECT * + 敏感列配置 → 拒绝", () => {
    const r = guard("SELECT * FROM default_catalog.dw.dws_vehicle_adas_drive_index_df", {
      ...policy,
      sensitiveColumns: ["vin"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R6_sensitive_column");
  });

  it("INSERT 开头 → 拒绝 R2(且命中 R3)", () => {
    const r = guard("INSERT INTO t VALUES (1)", policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["R2_lead_word", "R3_forbidden_keyword"]).toContain(r.rule);
  });
});

describe("sql-guard R3 关键词黑名单(token 级)", () => {
  const table = "default_catalog.dw.dws_vehicle_adas_drive_index_df";
  const cases = [
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT",
    "REVOKE", "SET", "KILL", "LOAD", "EXPORT", "CALL", "EXECUTE", "MERGE",
  ];
  for (const kw of cases) {
    it(`${kw} 出现在语句中 → 拒绝 R3`, () => {
      const r = guard(`SELECT * FROM ${table} WHERE 1=1 ${kw === "SET" ? "AND x SET" : `AND ${kw}`} `, policy);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rule).toBe("R3_forbidden_keyword");
    });
  }

  it("字符串字面量里的 DROP 不误伤", () => {
    const r = guard(
      `SELECT name, note FROM ${table} WHERE name = 'DROP TABLE x' AND note = "DELETE all"`,
      policy,
    );
    expect(r.ok).toBe(true);
  });

  it("注释里的 DELETE 不误伤(注释被剥离)", () => {
    const r = guard(`SELECT x FROM ${table} /* DELETE */ WHERE x = 1 -- DROP`, policy);
    expect(r.ok).toBe(true);
  });

  it("字符串里的分号不触发 R1", () => {
    const r = guard(`SELECT name FROM ${table} WHERE name = 'a;b'`, policy);
    expect(r.ok).toBe(true);
  });
});

describe("sql-guard R4 表白名单", () => {
  it("白名单表通过(反引号包裹也通过)", () => {
    const r = guard(
      "SELECT a.dt FROM `default_catalog`.`dw`.`dws_vehicle_adas_drive_index_df` a",
      policy,
    );
    expect(r.ok).toBe(true);
  });

  it("JOIN 了白名单外表 → 拒绝 R4", () => {
    const r = guard(
      "SELECT * FROM default_catalog.dw.dws_vehicle_adas_drive_index_df a JOIN other_db.secret_table b ON a.vin = b.vin",
      policy,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R4_table_whitelist");
  });

  it("UNION 第二段使用外表 → 拒绝 R4", () => {
    const r = guard(
      "SELECT dt FROM default_catalog.dw.dws_vehicle_adas_drive_index_df UNION ALL SELECT dt FROM evil.t",
      policy,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R4_table_whitelist");
  });

  it("白名单为空时任何 SELECT 都拒绝 R4(默认拒绝)", () => {
    const r = guard("SELECT 1 FROM x.y", { ...policy, allowedTables: [] });
    expect(r.ok).toBe(false);
  });
});

describe("sql-guard R5 LIMIT", () => {
  const table = "default_catalog.dw.dws_vehicle_adas_drive_index_df";
  const policy = { allowedTables: [table], maxRow: 200 }; // 无 sensitiveColumns(避免 SELECT * 被 R6 先拦)

  it("无 LIMIT → 追加 maxRow 并标记", () => {
    const r = guard(`SELECT * FROM ${table}`, policy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toMatch(/LIMIT\s+200\s*$/i);
      expect(r.appliedLimit).toBe(true);
    }
  });

  it("已有 LIMIT 10000 超上限 → 收紧为 200", () => {
    const r = guard(`SELECT * FROM ${table} LIMIT 10000`, policy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT\s+200\s*$/i);
  });

  it("已有 LIMIT 10 低于上限 → 保留", () => {
    const r = guard(`SELECT * FROM ${table} LIMIT 10`, policy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT\s+10\s*$/i);
  });

  it("LIMIT 非数字字面量(表达式/占位符)→ 拒绝 R5(fail-closed)", () => {
    const r = guard(`SELECT * FROM ${table} LIMIT ?`, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R5_limit");
  });

  it("LIMIT 带子查询表达式 → 拒绝 R5", () => {
    const r = guard(`SELECT * FROM ${table} LIMIT (SELECT 1)`, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R5_limit");
  });
});

describe("sql-guard R6 敏感列", () => {
  const table = "default_catalog.dw.dws_vehicle_adas_drive_index_df";

  it("SELECT 了敏感列 → 拒绝 R6", () => {
    const r = guard(`SELECT vin, dt FROM ${table}`, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("R6_sensitive_column");
  });

  it("敏感列只出现在字符串里不误伤", () => {
    const r = guard(`SELECT dt FROM ${table} WHERE note = 'vin is sensitive'`, policy);
    expect(r.ok).toBe(true);
  });
});
