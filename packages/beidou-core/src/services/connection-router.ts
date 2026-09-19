/**
 * Connection Router:多数据源 profile 路由。
 * P0-3 修正:fail-closed — 错误 Binding 立即拒绝,不回退 default;无显式 default 不用 profiles[0]。
 */
export interface ConnectionProfile {
  name: string;
  type: "starrocks";
  host: string;
  port: number;
  user: string;
  /** 凭据引用(P1-10:不存明文;由执行层解析) */
  passwordEnv?: string;
  password?: string; // PoC 兼容;生产走 passwordEnv
  database?: string;
  timeoutSec?: number;
  /** 此 profile 允许的表(空 = 不限制,由 Guard 全局白名单兜底) */
  allowedTables?: string[];
}

export interface ConnectionRouteInput {
  table: string;
  dataset?: string;
  profiles: ConnectionProfile[];
  tableBindings: Record<string, string>;
  datasetBindings: Record<string, string>;
}

export type RouteError =
  | { code: "ROUTE_BINDING_PROFILE_NOT_FOUND"; message: string }
  | { code: "ROUTE_NO_DEFAULT"; message: string }
  | { code: "ROUTE_TABLE_NOT_ALLOWED"; message: string };

export type ConnectionRouteResult =
  | { ok: true; profile: ConnectionProfile; matchType: "table_exact" | "schema_prefix" | "dataset_card" | "default" }
  | { ok: false; error: RouteError };

export function resolveConnection(input: ConnectionRouteInput): ConnectionRouteResult {
  const { table, dataset, profiles, tableBindings, datasetBindings } = input;
  const profileByName = new Map(profiles.map((p) => [p.name, p]));

  // 1. 精确表 → profile;Binding 指向不存在的 profile = 立即拒绝(P0-3:不回退)
  const exactProfile = tableBindings[table];
  if (exactProfile) {
    if (!profileByName.has(exactProfile)) {
      return { ok: false, error: { code: "ROUTE_BINDING_PROFILE_NOT_FOUND", message: `表 ${table} 绑定的 profile "${exactProfile}" 不存在` } };
    }
    return { ok: true, profile: profileByName.get(exactProfile)!, matchType: "table_exact" };
  }

  // 2. 同 schema 前缀
  const parts = table.split(".");
  if (parts.length === 3) {
    const schemaPrefix = `${parts[0]}.${parts[1]}`;
    for (const [boundTable, profileName] of Object.entries(tableBindings)) {
      if (boundTable.startsWith(`${schemaPrefix}.`)) {
        if (!profileByName.has(profileName)) {
          return { ok: false, error: { code: "ROUTE_BINDING_PROFILE_NOT_FOUND", message: `schema ${schemaPrefix} 绑定的 profile "${profileName}" 不存在` } };
        }
        return { ok: true, profile: profileByName.get(profileName)!, matchType: "schema_prefix" };
      }
    }
  }

  // 3. dataset 卡片
  if (dataset && datasetBindings[dataset]) {
    const dp = datasetBindings[dataset];
    if (!profileByName.has(dp)) {
      return { ok: false, error: { code: "ROUTE_BINDING_PROFILE_NOT_FOUND", message: `dataset ${dataset} 绑定的 profile "${dp}" 不存在` } };
    }
    return { ok: true, profile: profileByName.get(dp)!, matchType: "dataset_card" };
  }

  // 4. 显式 default(P0-3:无显式 default 不用 profiles[0])
  const defaultProfile = profileByName.get("default");
  if (!defaultProfile) {
    return { ok: false, error: { code: "ROUTE_NO_DEFAULT", message: `表 ${table} 无绑定且无显式 default profile` } };
  }
  return { ok: true, profile: defaultProfile, matchType: "default" };
}
