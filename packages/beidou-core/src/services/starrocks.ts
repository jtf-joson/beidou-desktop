/**
 * StarRocks 只读查询客户端(ARCHITECTURE L4)。
 * 连接器注入:mysql2 实现在 Electron 主进程组装(core 不 import mysql2),测试用 fake。
 * 行数上限用 sentinel 模式:多取一行判断截断(继承售后项目 completeness 模式)。
 */
import { err, ok, type Result } from "../types";

export interface StarRocksConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  /** 查询超时(秒);真实实现里以会话变量下发 */
  timeoutSec?: number;
  maxRows?: number;
}

export interface SrQueryResult {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  rowCount: number;
  truncated: boolean;
}

export interface SrConn {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>>; fields?: Array<{ name: string }> }>;
  end(): Promise<void>;
}

export interface StarRocksDeps {
  connect: (config: StarRocksConfig) => Promise<SrConn>;
}

const DEFAULT_MAX_ROWS = 200;

export async function queryStarRocks(
  deps: StarRocksDeps,
  config: StarRocksConfig,
  sql: string,
): Promise<Result<SrQueryResult>> {
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  let conn: SrConn | null = null;
  try {
    conn = await deps.connect(config);
    const { rows, fields } = await conn.query(sql);
    const truncated = rows.length > maxRows;
    return ok({
      rows: truncated ? rows.slice(0, maxRows) : rows,
      columns: (fields ?? []).map((f) => f.name),
      rowCount: Math.min(rows.length, maxRows),
      truncated,
    });
  } catch (e) {
    return err("SR_QUERY", `StarRocks 查询失败:${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await conn?.end().catch(() => undefined);
  }
}
