import { describe, expect, it } from "vitest";
import { restoreMaskedSecrets } from "./config-merge";

const ORIGINAL = `model:
  provider: deepseek
  auth_token: sk-real-secret-123
starrocks:
  host: sr.prod.inner
  port: 9030
  user: rd
  password: p@ssw0rd!
anymetrics:
  auth_value: uid-zhangsan
`;

describe("restoreMaskedSecrets(P0-07:掩码回写不覆盖真实密钥)", () => {
  it("提交文本中被掩码的密钥行,从原文按 key+缩进还原", () => {
    const submitted = ORIGINAL
      .replace("sk-real-secret-123", "***")
      .replace("p@ssw0rd!", "***")
      .replace("uid-zhangsan", "***")
      .replace("sr.prod.inner", "sr.new.inner"); // 用户真实修改的非敏感字段
    const merged = restoreMaskedSecrets(submitted, ORIGINAL);
    expect(merged).toContain("auth_token: sk-real-secret-123");
    expect(merged).toContain("password: p@ssw0rd!");
    expect(merged).toContain("auth_value: uid-zhangsan");
    expect(merged).toContain("host: sr.new.inner"); // 非掩码修改保留
  });

  it("无掩码时原样返回(不触发还原逻辑)", () => {
    const submitted = ORIGINAL.replace("sr.prod.inner", "sr.new.inner");
    expect(restoreMaskedSecrets(submitted, ORIGINAL)).toBe(submitted);
  });

  it("同一 key 名多次出现(嵌套/多连接)按顺序一一对应还原", () => {
    const original = ["connections:", "  prod:", "    password: pw-prod", "  test:", "    password: pw-test", ""].join("\n");
    const submitted = ["connections:", "  prod:", "    password: ***", "  test:", "    password: ***", ""].join("\n");
    const merged = restoreMaskedSecrets(submitted, original);
    expect(merged).toContain("password: pw-prod");
    expect(merged).toContain("password: pw-test");
    expect(merged.indexOf("pw-prod")).toBeLessThan(merged.indexOf("pw-test"));
  });

  it("掩码行在原文无对应 key(新加字段/原文无密钥)→ 保留提交值", () => {
    const submitted = "starrocks:\n  password: ***\n";
    const merged = restoreMaskedSecrets(submitted, "starrocks:\n  host: h\n");
    expect(merged).toBe(submitted);
  });

  it("掩码值出现在值中间(非整值掩码)不误还原", () => {
    const submitted = ORIGINAL.replace("sk-real-secret-123", "sk-***-tail");
    expect(restoreMaskedSecrets(submitted, ORIGINAL)).toBe(submitted);
  });

  it("值为 *** 的非密钥字段同样按 key 还原(规则一致,无白名单依赖)", () => {
    const original = "starrocks:\n  host: secret-looking-host\n";
    const submitted = "starrocks:\n  host: ***\n";
    expect(restoreMaskedSecrets(submitted, original)).toContain("host: secret-looking-host");
  });
});
