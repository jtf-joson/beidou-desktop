import { describe, expect, it } from "vitest";
import { queryStarRocks, type SrConn, type StarRocksDeps } from "./starrocks";

const makeDeps = (rows: unknown[], opts: { fail?: boolean } = {}): { deps: StarRocksDeps; queries: string[]; closed: () => number } => {
  const queries: string[] = [];
  let closed = 0;
  const conn: SrConn = {
    async query(sql) {
      queries.push(sql);
      if (opts.fail) throw new Error("connection refused");
      return { rows: rows as Record<string, unknown>[], fields: Object.keys((rows[0] as object) ?? { a: 1 }).map((n) => ({ name: n })) };
    },
    async end() {
      closed++;
    },
  };
  return {
    deps: { connect: async () => conn },
    queries,
    closed: () => closed,
  };
};

describe("queryStarRocks", () => {
  it("正常查询:返回行、列、行数;连接用后即关", async () => {
    const { deps, closed } = makeDeps([{ dt: "2026-08-01", c: 1 }, { dt: "2026-08-02", c: 2 }]);
    const r = await queryStarRocks(deps, { host: "h", port: 9030, user: "ro", password: "x", maxRows: 100 }, "SELECT dt, c FROM t");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.rows).toHaveLength(2);
      expect(r.value.columns).toContain("dt");
      expect(r.value.truncated).toBe(false);
      expect(r.value.rowCount).toBe(2);
    }
    expect(closed()).toBe(1);
  });

  it("超过 maxRows → truncated 且只返回 maxRows 行(sentinel 模式)", async () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ i }));
    const { deps } = makeDeps(big);
    const r = await queryStarRocks(deps, { host: "h", port: 9030, user: "ro", password: "x", maxRows: 10 }, "SELECT i FROM t");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.truncated).toBe(true);
      expect(r.value.rows).toHaveLength(10);
      expect(r.value.rowCount).toBe(10);
    }
  });

  it("连接失败 → 结构化错误,连接仍尝试关闭", async () => {
    const { deps, closed } = makeDeps([], { fail: true });
    const r = await queryStarRocks(deps, { host: "h", port: 9030, user: "ro", password: "x", maxRows: 10 }, "SELECT 1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SR_QUERY");
    expect(closed()).toBe(1);
  });

  it("空结果:rows 空、columns 来自 fields、rowCount 0", async () => {
    const { deps } = makeDeps([]);
    const r = await queryStarRocks(deps, { host: "h", port: 9030, user: "ro", password: "x", maxRows: 10 }, "SELECT dt FROM t WHERE 1=0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.rows).toEqual([]);
      expect(r.value.rowCount).toBe(0);
    }
  });
});
