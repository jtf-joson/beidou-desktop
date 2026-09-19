/**
 * Connection Router:多数据源 profile 路由(P1-4)。
 * 路由序:ontology bindings 精确表 > 同 schema 前缀 > dataset 卡片 > default;未命中 = 拒绝。
 */
export interface ConnectionProfile {
  name: string;
  type: "starrocks";
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  timeoutSec?: number;
  /** 此 profile 允许的表列表(空 = 由 default 推导) */
  allowedTables?: string[];
}

export interface ConnectionRouteInput {
  /** 查询目标表全名 catalog.schema.table */
  table: string;
  /** 可选:dataset 名(用于卡片级路由) */
  dataset?: string;
  profiles: ConnectionProfile[];
  /** 表→profile 映射(来自 ontology bindings + config.connections) */
  tableBindings: Record<string, string>;
  /** dataset→profile 映射 */
  datasetBindings: Record<string, string>;
}

export interface ConnectionRouteResult {
  profile: ConnectionProfile;
  matchType: "table_exact" | "schema_prefix" | "dataset_card" | "default";
}

export function resolveConnection(input: ConnectionRouteInput): ConnectionRouteResult | null {
  const { table, dataset, profiles, tableBindings, datasetBindings } = input;
  const profileByName = new Map(profiles.map((p) => [p.name, p]));

  // 1. ontology bindings 精确表 → profile
  const exactProfile = tableBindings[table];
  if (exactProfile && profileByName.has(exactProfile)) {
    return { profile: profileByName.get(exactProfile)!, matchType: "table_exact" };
  }

  // 2. 同 schema 前缀(catalog.schema.* → profile)
  const parts = table.split(".");
  if (parts.length === 3) {
    const schemaPrefix = `${parts[0]}.${parts[1]}`;
    for (const [boundTable, profileName] of Object.entries(tableBindings)) {
      if (boundTable.startsWith(`${schemaPrefix}.`) && profileByName.has(profileName)) {
        return { profile: profileByName.get(profileName)!, matchType: "schema_prefix" };
      }
    }
  }

  // 3. dataset 卡片 → profile
  if (dataset && datasetBindings[dataset] && profileByName.has(datasetBindings[dataset])) {
    return { profile: profileByName.get(datasetBindings[dataset])!, matchType: "dataset_card" };
  }

  // 4. default profile(name = "default" 或第一个)
  const defaultProfile = profileByName.get("default") ?? profiles[0];
  if (defaultProfile) {
    return { profile: defaultProfile, matchType: "default" };
  }

  // 未命中 = 拒绝(fail-closed)
  return null;
}
