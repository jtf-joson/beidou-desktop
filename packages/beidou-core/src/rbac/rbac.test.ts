import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, can, menusFor, parseMembers, resolveRole, DEFAULT_MEMBERS_FILE } from "./rbac";

describe("RBAC 默认策略(角色 → 菜单与能力)", () => {
  it("四角色菜单差异:admin 全量,viewer 只有对话与审计", () => {
    const admin = menusFor("admin", DEFAULT_POLICY);
    const viewer = menusFor("viewer", DEFAULT_POLICY);
    expect(admin).toContain("plugins");
    expect(admin).toContain("skills");
    expect(admin).toContain("settings");
    expect(viewer).toContain("chat");
    expect(viewer).toContain("audit");
    expect(viewer).not.toContain("plugins");
    expect(viewer).not.toContain("skills");
    expect(viewer).not.toContain("settings");
    const analyst = menusFor("analyst", DEFAULT_POLICY);
    expect(analyst).toContain("semantics");
    expect(analyst).not.toContain("plugins");
  });

  it("能力点:查询类人人可用;编辑类 engineer/admin;空间管理 admin", () => {
    for (const role of ["admin", "engineer", "analyst", "viewer"] as const) {
      expect(can(role, "tool:query", DEFAULT_POLICY)).toBe(true);
    }
    expect(can("analyst", "semantics:edit", DEFAULT_POLICY)).toBe(false);
    expect(can("engineer", "semantics:edit", DEFAULT_POLICY)).toBe(true);
    expect(can("engineer", "space:admin", DEFAULT_POLICY)).toBe(false);
    expect(can("admin", "space:admin", DEFAULT_POLICY)).toBe(true);
    expect(can("viewer", "config:save", DEFAULT_POLICY)).toBe(false);
  });

  it("非法角色 fail-closed(无任何菜单)", () => {
    expect(menusFor("hacker" as never, DEFAULT_POLICY)).toEqual([]);
    expect(can("hacker" as never, "tool:query", DEFAULT_POLICY)).toBe(false);
  });
});

describe("parseMembers / resolveRole", () => {
  it("成员文件:username→role,非法条目忽略", () => {
    const m = parseMembers(`
members:
  - username: demo_user
    role: admin
  - username: zhang.san
    role: analyst
  - role: viewer
  - username: bad
    role: superhero
`);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ username: "demo_user", role: "admin" });
  });

  it("空/坏文件 → 空成员表(不炸)", () => {
    expect(parseMembers("")).toEqual([]);
    expect(parseMembers("not: [yaml")).toEqual([]);
  });

  it("resolveRole:成员显式角色优先;未列出走空间默认;无默认则 viewer", () => {
    const members = [{ username: "a", role: "admin" as const }];
    expect(resolveRole("a", members, { defaultRole: "viewer" })).toBe("admin");
    expect(resolveRole("b", members, { defaultRole: "analyst" })).toBe("analyst");
    expect(resolveRole("b", members, {})).toBe("viewer");
  });

  it("默认角色值非法时回退 viewer", () => {
    expect(resolveRole("b", [], { defaultRole: "superhero" as never })).toBe("viewer");
  });

  it("DEFAULT_MEMBERS_FILE 模板可被 parseMembers 解析", () => {
    const m = parseMembers(DEFAULT_MEMBERS_FILE.replace("{{username}}", "demo_user"));
    expect(m).toHaveLength(1);
    expect(m[0]!.role).toBe("admin");
  });
});
