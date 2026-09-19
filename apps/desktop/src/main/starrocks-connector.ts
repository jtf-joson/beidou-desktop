/**
 * mysql2 → StarRocks 连接器(core 的 StarRocksDeps 真实实现)。
 * 只读账号 + 会话超时是护栏之外的物理兜底(CODE_STANDARDS §4)。
 */
import mysql from "mysql2/promise";
import type { StarRocksConfig } from "@beidou/core/src/services/starrocks";
import type { StarRocksDeps, SrConn } from "@beidou/core/src/services/starrocks";

export function mysqlConnector(): StarRocksDeps {
  return {
    connect: async (config: StarRocksConfig): Promise<SrConn> => {
      const conn = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectTimeout: 8_000,
        multipleStatements: false,
      });
      const timeout = config.timeoutSec ?? 60;
      try {
        await conn.query(`SET query_timeout = ${Math.max(1, Math.min(timeout, 3600))}`);
      } catch {
        // 会话变量失败不阻断(部分环境无权限);超时由连接层兜底
      }
      return {
        async query(sql) {
          const [result, fields] = await conn.query(sql);
          const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
          return {
            rows,
            fields: (fields ?? []).map((f) => ({ name: (f as { name: string }).name })),
          };
        },
        async end() {
          await conn.end();
        },
      };
    },
  };
}
