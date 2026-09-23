/** 审核八轮 P0-02:DSH 全局 tools/pre-execute 门禁 */
import { describe, expect, it } from "vitest";
import { registerGlobalToolGate } from "./index";
import { ALLOWED_TOOLS } from "./policy";
import type { Context } from "@deepseek-ai/cordis";

function fakeCtx(): { ctx: Context; handlers: Map<string, (exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>> } {
  const handlers = new Map();
  const ctx = {
    on: (ev: string, fn: (exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>) => { handlers.set(ev, fn); },
  } as unknown as Context;
  return { ctx, handlers };
}

describe("registerGlobalToolGate(全局工具门禁)", () => {
  it("注册 tools/pre-execute waterfall 监听", () => {
    const { ctx, handlers } = fakeCtx();
    registerGlobalToolGate(ctx);
    expect(handlers.has("tools/pre-execute")).toBe(true);
  });
  it("白名单外工具 → deny + TOOL_NOT_ALLOWED 理由(含内置工具名)", async () => {
    const { ctx, handlers } = fakeCtx();
    registerGlobalToolGate(ctx);
    const gate = handlers.get("tools/pre-execute")!;
    for (const evil of ["Bash", "Read", "tool-web", "Write", "subagent", "whatever"]) {
      const d = (await gate({ name: evil }, async () => ({ kind: "allow" }))) as { kind: string; reason?: string };
      expect(d.kind).toBe("deny");
      expect(d.reason).toContain("TOOL_NOT_ALLOWED");
    }
  });
  it("白名单内工具 → 放行 next()", async () => {
    const { ctx, handlers } = fakeCtx();
    registerGlobalToolGate(ctx);
    const gate = handlers.get("tools/pre-execute")!;
    for (const name of ALLOWED_TOOLS) {
      const d = (await gate({ name }, async () => ({ kind: "allow" }))) as { kind: string };
      expect(d.kind).toBe("allow");
    }
  });
});
