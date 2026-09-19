import { describe, expect, it } from "vitest";
import { ERROR_CODES, type BeidouToolResult } from "./index";

describe("@beidou/contracts 协议层", () => {
  it("错误码 12 个、唯一、全大写下划线(机器可判别)", () => {
    expect(ERROR_CODES).toHaveLength(12);
    expect(new Set(ERROR_CODES).size).toBe(12);
    for (const c of ERROR_CODES) expect(c).toMatch(/^[A-Z_]+$/);
  });
  it("BeidouToolResult 结构自洽(ok↔code 约定)", () => {
    const ok: BeidouToolResult<{ v: number }> = { ok: true, code: "OK", data: { v: 1 }, traceId: "t1" };
    const err: BeidouToolResult = { ok: false, code: "BINDING_NOT_FOUND", message: "x", traceId: "t2" };
    expect(ok.code).toBe("OK");
    expect(err.ok).toBe(false);
  });
});
