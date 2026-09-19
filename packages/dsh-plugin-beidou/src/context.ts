/**
 * ToolContext 组装:把 beidou-core 的工具依赖在 dsh 宿主里接齐。
 * 复用 loadWorkspace(零 electron 依赖)+ mysqlConnector/mockStarRocks + createAuditLog。
 */
import { loadWorkspace } from "../../../apps/desktop/src/main/workspace";
import { queryStarRocks } from "@beidou-core/services/starrocks";
import { createMockStarRocks } from "@beidou-core/services/mock-starrocks";
import { createAuditLog } from "@beidou-core/audit/log";
import type { StarRocksDeps } from "@beidou-core/services/starrocks";
import mysql from "mysql2/promise";
import { join } from "node:path";
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

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
  const connector = mock ? createMockStarRocks() : mysqlConnector();
  const auditFile = join(ws.dir, "audit", "audit.jsonl");
  if (!existsSync(join(ws.dir, "audit"))) await mkdir(join(ws.dir, "audit"), { recursive: true });
  const auditLog = createAuditLog({
    appendFile: async (line) => { await appendFile(auditFile, line, "utf-8"); },
    readFile: async () => { try { return await readFile(auditFile, "utf-8"); } catch { return ""; } },
  });

  const guard = ws.config.guard ?? {};
  return {
    workspace: ws,
    toolContextOverrides: {
      guardPolicy: {
        allowedTables: ws.store.allPhysicalTables(),
        maxRow: guard.max_row ?? 200,
        sensitiveColumns: guard.sensitive_columns ?? [],
      },
      dataSource: mock ? "mock" as const : "real" as const,
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
