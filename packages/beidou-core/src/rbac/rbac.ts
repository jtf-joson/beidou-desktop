/**
 * RBAC:角色 → 菜单可见性 + 能力点(双层防线的 UI 层;工具层在 IPC/服务侧二次校验)。
 * 角色命名与权限粒度对齐 DataBuddy/WeData 的空间角色模型(管理员/工程师/分析师/查看者),
 * 策略集中在本文件,可被契约测试锚定;空间可用 members.yaml 覆盖成员与默认角色。
 */
import { parse as parseYaml } from "yaml";

export type Role = "admin" | "engineer" | "analyst" | "viewer";

export interface SpaceMembership {
  username: string;
  role: Role;
}

export interface RbacPolicy {
  /** 角色 → 可见菜单 key(与 App.tsx 菜单对齐,契约测试锚定) */
  menus: Record<Role, string[]>;
  /** 角色 → 能力点 */
  perms: Record<Role, string[]>;
}

export const MENU_KEYS = ["chat", "semantics", "skills", "plugins", "audit", "settings"] as const;

export const DEFAULT_POLICY: RbacPolicy = {
  menus: {
    admin: [...MENU_KEYS],
    engineer: ["chat", "semantics", "skills", "audit"],
    analyst: ["chat", "semantics", "audit"],
    viewer: ["chat", "audit"],
  },
  perms: {
    admin: ["tool:query", "tool:clarify", "semantics:view", "semantics:edit", "skills:manage", "config:save", "audit:view", "space:admin"],
    engineer: ["tool:query", "tool:clarify", "semantics:view", "semantics:edit", "skills:manage", "audit:view"],
    analyst: ["tool:query", "tool:clarify", "semantics:view", "audit:view"],
    viewer: ["tool:query", "tool:clarify", "audit:view"],
  },
};

export function menusFor(role: string, policy: RbacPolicy): string[] {
  if (!(role in policy.menus)) return [];
  return policy.menus[role as Role];
}

export function can(role: string, perm: string, policy: RbacPolicy): boolean {
  if (!(role in policy.perms)) return false;
  return policy.perms[role as Role]!.includes(perm);
}

const ROLES: ReadonlySet<string> = new Set(["admin", "engineer", "analyst", "viewer"]);

export function parseMembers(text: string): SpaceMembership[] {
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  const list = (parsed as { members?: unknown } | null)?.members;
  if (!Array.isArray(list)) return [];
  const out: SpaceMembership[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as { username?: unknown; role?: unknown };
    if (typeof m.username !== "string" || !m.username) continue;
    if (typeof m.role !== "string" || !ROLES.has(m.role)) continue;
    out.push({ username: m.username, role: m.role as Role });
  }
  return out;
}

export function resolveRole(
  username: string | undefined,
  members: SpaceMembership[],
  opts: { defaultRole?: string; authenticated?: boolean },
): Role {
  // P0-03:未认证/匿名 = 固定 viewer;defaultRole 只给已认证用户
  if (!username) return "viewer";
  const hit = members.find((m) => m.username === username);
  if (hit) return hit.role;
  if (opts.authenticated === false) return "viewer";
  const d = opts.defaultRole;
  if (d && ROLES.has(d)) return d as Role;
  return "viewer";
}

export const DEFAULT_MEMBERS_FILE = `# 空间成员与角色(空间目录 members.yaml;角色:admin/engineer/analyst/viewer)
# 未列出的登录用户按 default_role 处理
default_role: viewer
members:
  - username: {{username}}
    role: admin
`;
