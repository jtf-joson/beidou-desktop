/**
 * ToolContext 组装:把 beidou-core 的工具依赖在 dsh 宿主里接齐。
 * 复用 loadWorkspace(零 electron 依赖)+ mysqlConnector/mockStarRocks + createAuditLog。
 */
import { loadWorkspace } from "./workspace";
import { queryStarRocks } from "@beidou/core/src/services/starrocks.ts";
import { createMockStarRocks } from "@beidou/core/src/services/mock-starrocks.ts";
import { createAuditLog } from "@beidou/core/src/audit/log.ts";
import type { StarRocksDeps } from "@beidou/core/src/services/starrocks.ts";
import mysql from "mysql2/promise";
import { join } from "node:path";
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createAnyMetricsClient } from "@beidou/core/src/services/anymetrics.ts";

export interface PluginConfig {
  workspace: string;
  dataSource?: "mock" | "real";
}

/** mysql2 连接器(dsh 宿主版,零 electron 依赖) */
function mysqlConnector(): StarRocksDeps {
  return {
    connect: async (config) => {
      const conn = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectTimeout: 8_000,
        multipleStatements: false,
      });
      return {
        async query(sql) {
          const [result, fields] = await conn.query(sql);
          const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
          return { rows, fields: (fields ?? []).map((f) => ({ name: (f as { name: string }).name })) };
        },
        async end() { await conn.end(); },
      };
    },
  };
}

export async function buildPluginContext(config: PluginConfig) {
  const ws = loadWorkspace(config.workspace);
  const sr = ws.config.starrocks;
  const mock = config.dataSource === "mock" || (!sr?.host && sr?.mock !== false);

  // P0-2:支持多 profile(config.connections);单连接时直接用
  const connections = (ws.config as Record<string, unknown>).connections as Record<string, {
    host?: string; port?: number; user?: string; password?: string; database?: string;
  }> | undefined;
  const profiles = connections
    ? Object.entries(connections).map(([name, c]) => ({
        name, type: "starrocks" as const,
        host: c.host ?? "", port: c.port ?? 9030, user: c.user ?? "", password: c.password ?? "", database: c.database,
      }))
    : sr?.host
      ? [{ name: "default", type: "starrocks" as const, host: sr.host, port: sr.port ?? 9030, user: sr.user ?? "", password: sr.password ?? "", database: sr.database }]
      : [];

  const connector = mock ? createMockStarRocks() : mysqlConnector();
  const auditFile = join(ws.dir, "audit", "audit.jsonl");
  if (!existsSync(join(ws.dir, "audit"))) await mkdir(join(ws.dir, "audit"), { recursive: true });
  const auditLog = createAuditLog({
    appendFile: async (line) => { await appendFile(auditFile, line, "utf-8"); },
    readFile: async () => { try { return await readFile(auditFile, "utf-8"); } catch { return ""; } },
  });

  const guard = ws.config.guard ?? {};
  const any = ws.config.anymetrics;
  const authValue = any?.auth_value ?? (any?.auth_value_env ? process.env[any.auth_value_env] : undefined);
  const metricClient = any?.host && any.tenant_id && authValue
    ? createAnyMetricsClient({ baseUrl: any.host, semanticBaseUrl: any.semantic_host, tenantId: any.tenant_id, authType: any.auth_type ?? "UID", authValue }, { fetchFn: fetch })
    : undefined;
  void profiles; // 多 profile 由 connection-router 消费(Phase 4 闭环)
  return {
    workspace: ws,
    connectionProfiles: profiles,
    toolContextOverrides: {
      guardPolicy: {
        allowedTables: ws.store.allPhysicalTables(),
        maxRow: guard.max_row ?? 200,
        sensitiveColumns: guard.sensitive_columns ?? [],
      },
      dataSource: mock ? "mock" as const : "real" as const,
      metricClient,
      starrocksQuery: async (sql: string) => {
        return queryStarRocks(connector, {
          host: sr?.host ?? "",
          port: sr?.port ?? 9030,
          user: sr?.user ?? "",
          password: sr?.password ?? "",
          database: sr?.database,
          maxRows: guard.max_row ?? 200,
        }, sql);
      },
      auditSink: {
        append: async (e: unknown) => { await auditLog.append(e as never); },
      },
    },
    isMock: mock,
  };
}
