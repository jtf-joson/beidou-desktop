import { describe, expect, it } from "vitest";
import { createMockStarRocks } from "./mock-starrocks";

const T = "default_catalog.dw.dws_vehicle_adas_drive_index_df";

describe("createMockStarRocks 演示数据连接器", () => {
  it("总量口径:SELECT agg(...) AS metric_value → 单行数值", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    const r = await conn.query(`SELECT count(vin) AS metric_value FROM ${T} WHERE dt >= '2026-08-01' AND dt <= '2026-08-31' LIMIT 100`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.metric_value).toEqual(expect.any(Number));
    expect(Number(r.rows[0]!.metric_value)).toBeGreaterThan(0);
    expect(r.fields?.map((f) => f.name)).toContain("metric_value");
  });

  it("分组口径:GROUP BY dt → 多行,dt 是日期序列", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    const r = await conn.query(`SELECT dt, count(vin) AS metric_value FROM ${T} GROUP BY dt ORDER BY metric_value DESC LIMIT 7`);
    expect(r.rows.length).toBeGreaterThan(1);
    expect(r.rows.length).toBeLessThanOrEqual(7);
    expect(String(r.rows[0]!.dt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const row of r.rows) expect(Number(row.metric_value)).toBeGreaterThan(0);
  });

  it("确定性:同一 SQL 两次查询结果完全一致(演示可信)", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    const sql = `SELECT config_level, sum(cnt) AS metric_value FROM ${T} GROUP BY config_level LIMIT 5`;
    const a = await conn.query(sql);
    const b = await conn.query(sql);
    expect(a.rows).toEqual(b.rows);
  });

  it("不同 SQL 产生不同数据(不是常数)", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    const a = await conn.query(`SELECT count(vin) AS metric_value FROM ${T} LIMIT 10`);
    const b = await conn.query(`SELECT count(vin) AS metric_value FROM ${T} WHERE dt >= '2026-01-01' LIMIT 10`);
    // 允许偶发相同,但用多个变体至少一组不同
    const c = await conn.query(`SELECT sum(adas_durs) AS metric_value FROM ${T} LIMIT 10`);
    const values = new Set([a.rows[0]!.metric_value, b.rows[0]!.metric_value, c.rows[0]!.metric_value]);
    expect(values.size).toBeGreaterThan(1);
  });

  it("explore 形态:多列 + 聚合别名", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    const r = await conn.query(`SELECT dt, count(vin) AS cnt FROM ${T} GROUP BY dt ORDER BY cnt DESC LIMIT 20`);
    expect(r.fields?.map((f) => f.name)).toEqual(["dt", "cnt"]);
    expect(r.rows[0]).toHaveProperty("cnt");
  });

  it("解析不了的 SQL → 通用单行(不炸)", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    const r = await conn.query("SHOW TABLES");
    expect(r.rows.length).toBeGreaterThanOrEqual(0); // 不抛错即可
  });

  it("end() 可调用(连接器契约)", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    await expect(conn.end()).resolves.toBeUndefined();
  });

  it("非日期分组列:生成带列名前缀的类别值", async () => {
    const mock = createMockStarRocks();
    const conn = await mock.connect({ host: "", port: 9030, user: "", password: "" });
    const r = await conn.query(`SELECT veh_series, count(vin) AS metric_value FROM ${T} GROUP BY veh_series LIMIT 5`);
    expect(String(r.rows[0]!.veh_series)).toContain("veh_series");
  });
});
