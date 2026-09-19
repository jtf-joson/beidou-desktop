/**
 * 受控明细分析 SQL 构建器(SPEC Q2.6 白名单通道的 explore 模式)。
 * LLM 只提供结构化参数(表/列/聚合/条件),SQL 由本模块拼装——标识符白名单 + 字面量转义。
 */
import { err, ok, type Result } from "../types";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_IDENT = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){2,}$/;
const AGG_FUNCS = new Set(["count", "sum", "avg", "min", "max"]);
const WHERE_OPS = new Set([">", "<", ">=", "<=", "=", "!=", "in"]);
const HARD_MAX_ROWS = 200;

export interface ExploreWhere {
  column: string;
  op: string;
  value: string | number | Array<string | number>;
}

export interface ExploreInput {
  table: string;
  selectColumns: string[];
  aggregates?: Array<{ func: string; column: string; alias: string }>;
  where?: ExploreWhere[];
  groupBy?: string[];
  orderBy?: { column: string; desc?: boolean };
  limit?: number;
}

const literal = (v: string | number): string => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

export function buildExploreSql(input: ExploreInput, opts: { allowedTables: string[] }): Result<string> {
  const { table, selectColumns, aggregates = [], where = [], groupBy = [], orderBy } = input;
  if (!TABLE_IDENT.test(table) || !opts.allowedTables.includes(table)) {
    return err("BUILDER_TABLE", `表不在白名单:${table}`);
  }
  for (const c of [...selectColumns, ...groupBy, ...where.map((w) => w.column)]) {
    if (!IDENT.test(c)) return err("BUILDER_IDENT", `列名不合法:${c}`);
  }
  if (selectColumns.length === 0 && aggregates.length === 0) {
    return err("BUILDER_EMPTY_SELECT", "必须指定至少一个输出列或聚合(不允许 SELECT *)");
  }
  const selectParts = [...selectColumns];
  for (const a of aggregates) {
    if (!AGG_FUNCS.has(a.func.toLowerCase())) return err("BUILDER_FUNC", `聚合函数不在白名单:${a.func}`);
    if (!IDENT.test(a.column)) return err("BUILDER_IDENT", `聚合列名不合法:${a.column}`);
    if (!IDENT.test(a.alias)) return err("BUILDER_IDENT", `别名不合法:${a.alias}`);
    selectParts.push(`${a.func.toLowerCase()}(${a.column}) AS ${a.alias}`);
  }
  for (const w of where) {
    if (!WHERE_OPS.has(w.op)) return err("BUILDER_OP", `where 操作符不在白名单:${w.op}`);
  }
  if (orderBy) {
    const allowedOrder = new Set([...selectColumns, ...aggregates.map((a) => a.alias)]);
    if (!allowedOrder.has(orderBy.column)) return err("BUILDER_ORDER", `排序列必须在输出列中:${orderBy.column}`);
  }
  const limit = Math.min(input.limit ?? HARD_MAX_ROWS, HARD_MAX_ROWS);

  const lines: string[] = [];
  lines.push(`SELECT ${selectParts.join(", ")}`);
  lines.push(`FROM ${table}`);
  if (where.length > 0) {
    const conds = where.map((w) => {
      if (w.op === "in") {
        const vals = Array.isArray(w.value) ? w.value : [w.value];
        return `${w.column} IN (${vals.map(literal).join(", ")})`;
      }
      const v = Array.isArray(w.value) ? w.value[0]! : w.value;
      return `${w.column} ${w.op} ${literal(v)}`;
    });
    lines.push(`WHERE ${conds.join(" AND ")}`);
  }
  if (groupBy.length > 0) lines.push(`GROUP BY ${groupBy.join(", ")}`);
  if (orderBy) lines.push(`ORDER BY ${orderBy.column} ${orderBy.desc === false ? "ASC" : "DESC"}`);
  lines.push(`LIMIT ${limit}`);
  return ok(lines.join(" "));
}
