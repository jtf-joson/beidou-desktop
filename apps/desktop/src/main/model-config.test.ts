import { describe, expect, it } from "vitest";
import { readModelSection, mergeModelSection, resolveModelToken, DEFAULT_BASE_URL } from "./model-config";

const RAW = `model:
  provider: deepseek-anthropic
  base_url: https://api.deepseek.com/anthropic
  auth_token_env: DEEPSEEK_API_KEY
  model: deepseek-chat
starrocks:
  host: sr.prod
  password: keep-me
`;

describe("model-config(模型配置结构化读写)", () => {
  it("readModelSection:解析 model 段;坏 YAML → 空对象(读取容错)", () => {
    expect(readModelSection(RAW)).toMatchObject({ provider: "deepseek-anthropic", auth_token_env: "DEEPSEEK_API_KEY" });
    expect(readModelSection("{{{")).toEqual({});
    expect(readModelSection("")).toEqual({});
  });

  it("merge:保留其他段(starrocks.password 原样);key 留空不动现有凭据", () => {
    const merged = mergeModelSection(RAW, { baseUrl: "https://x.example", model: "m1", apiKey: "" });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value).toContain("keep-me");
    const m = readModelSection(merged.value);
    expect(m.base_url).toBe("https://x.example");
    expect(m.model).toBe("m1");
    expect(m.auth_token).toBeUndefined(); // 空 key 不写入
    expect(m.auth_token_env).toBe("DEEPSEEK_API_KEY"); // 兜底保留
  });

  it("merge:非空 key 写入 auth_token(优先于 env 被读取)", () => {
    const merged = mergeModelSection(RAW, { apiKey: "sk-new" });
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(readModelSection(merged.value).auth_token).toBe("sk-new");
  });

  it("merge:空 YAML 从默认骨架起步", () => {
    const merged = mergeModelSection("", { baseUrl: DEFAULT_BASE_URL });
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(readModelSection(merged.value).provider).toBe("deepseek-anthropic");
  });

  it("P0-02:损坏 YAML → 拒绝保存(fail-closed,不清空其他段)", () => {
    const r = mergeModelSection("starrocks: [broken\n  host: x", { apiKey: "sk-x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("拒绝保存");
  });

  it("P0-02:根节点非映射(纯数组/标量)→ 拒绝保存", () => {
    expect(mergeModelSection("- a\n- b\n", {}).ok).toBe(false);
    expect(mergeModelSection("just a string\n", {}).ok).toBe(false);
    expect(mergeModelSection("# 仅注释\n", {}).ok).toBe(true); // 空/纯注释文件允许起步
  });

  it("resolveModelToken:auth_token 优先;否则环境变量;都没有 → undefined", () => {
    expect(resolveModelToken({ auth_token: "sk-a", auth_token_env: "X" })).toBe("sk-a");
    expect(resolveModelToken({ auth_token_env: "X" }, { X: "sk-env" } as NodeJS.ProcessEnv)).toBe("sk-env");
    expect(resolveModelToken({ auth_token_env: "X" }, {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveModelToken({})).toBeUndefined();
  });
});
