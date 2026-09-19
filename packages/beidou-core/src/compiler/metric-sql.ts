/**
 * 口径一致下钻编译器(ARCHITECTURE A3)。
 * 从平台 caliber(公式 AST + 固定过滤 + 时间字段)编译出 SQL——LLM 不写 SQL,只选参数。
 * 维度两类:①指标本数据集列(直接 GROUP BY);②跨数据集维度(dimXxx_df_col 形态,
 * 经 resolveDimBinding 解析维表,按 join key(默认 vin)自动 LEFT JOIN)。
 * 产物仍需过 sql-guard + 只读账号(双层防线)。
 */
import { err, ok, type MetricMirror, type Result } from "../types";
import { compileFilterExpr, compileFormula } from "./dsl";

export interface DimBinding {
  dimDataset: string;
  dimColumn: string;
  physicalTable: string;
  physicalColumn: string;
}

export interface MetricSqlDeps {
  resolveColumn: (dataset: string, column: string) => string | null;
  resolveMetricCode: (code: string) => unknown;
  /** 跨数据集维度解析(可选;无则跨数据集维度 fail-closed) */
  resolveDimBinding?: (dimName: string) => DimBinding | null;
}

export interface MetricSqlInput {
  metric: MetricMirror;
  /** 分组维度:本数据集列名 或 平台维度名(dimXxx_df_col) */
  dims: string[];
  timeRange?: { start: string; end: string };
  maxRow: number;
  /** 跨数据集 join 键(默认 vin;按序尝试) */
  joinKeys?: string[];
}

export interface MetricSqlResult {
  sql: string;
  caliberSummary: {
    expr: string;
    filters: string[];
    timeColumn?: string;
    physicalTable: string;
    joins: Array<{ table: string; on: string }>;
  };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_IDENT = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){2,}$/;
const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

interface ResolvedDim {
  /** SELECT/GROUP BY 里的输出表达式 */
  output: string;
  join?: { table: string; alias: string; onLeft: string; onRight: string };
}

export function compileMetricSql(input: MetricSqlInput, deps: MetricSqlDeps): Result<MetricSqlResult> {
  const { metric, dims, timeRange, maxRow } = input;
  const joinKeys = input.joinKeys ?? ["vin"];
  const caliber = metric.caliber;
  if (!caliber?.formula) return err("NO_FORMULA", `指标 ${metric.metricName} 缺少公式口径,无法编译下钻 SQL`);

  const tables = metric.physicalTables.filter((t) => TABLE_IDENT.test(t));
  if (metric.physicalTables.length !== 1 || tables.length !== 1) {
    return err("MULTI_TABLE", `指标 ${metric.metricName} 关联 ${metric.physicalTables.length} 张物理表,自动下钻不支持多表口径`);
  }
  const table = tables[0]!;
  const dataset = caliber.datasetName ?? metric.datasetName;
  if (!dataset) return err("NO_DATASET", `指标 ${metric.metricName} 缺少数据集信息`);

  // --- 维度解析(两遍:先判断是否需要 join,决定主表列是否加 t. 前缀) ---
  const resolvedDims: ResolvedDim[] = [];
  let joinCount = 0;
  for (const dim of dims) {
    const localCol = deps.resolveColumn(dataset, dim);
    if (localCol !== null && IDENT.test(localCol)) {
      resolvedDims.push({ output: localCol });
      continue;
    }
    const b = deps.resolveDimBinding?.(dim) ?? null;
    if (!b) return err("UNRESOLVED_DIM", `维度无法解析到本数据集列或维表:${dim}`);
    if (!TABLE_IDENT.test(b.physicalTable) || !IDENT.test(b.physicalColumn)) {
      return err("DSL_IDENT", `维表绑定不合法:${dim}`);
    }
    // join key:维表侧与本表侧都必须能解析
    let on: { left: string; right: string } | null = null;
    for (const jk of joinKeys) {
      const mainCol = deps.resolveColumn(dataset, jk);
      const dimCol = deps.resolveColumn(b.dimDataset, jk);
      if (mainCol && IDENT.test(mainCol) && dimCol && IDENT.test(dimCol)) {
        on = { left: mainCol, right: dimCol };
        break;
      }
    }
    if (!on) return err("UNRESOLVED_JOIN_KEY", `维表 ${b.physicalTable} 找不到可用 join 键(尝试:${joinKeys.join(",")})`);
    const alias = `d${joinCount++}`;
    resolvedDims.push({
      output: `${alias}.${b.physicalColumn}`,
      join: { table: b.physicalTable, alias, onLeft: on.left, onRight: on.right },
    });
  }
  const qualified = joinCount > 0; // 有 join 时主表列加 t. 前缀,避免与维表同名列歧义

  const qualify = (col: string): string => (qualified ? `t.${col}` : col);
  const ctx = {
    resolveColumn: (ds: string, col: string) => {
      const c = deps.resolveColumn(ds, col);
      return c === null ? null : qualify(c);
    },
    resolveMetricCode: (code: string) => deps.resolveMetricCode(code),
  };

  const exprR = compileFormula(caliber.formula, ctx);
  if (!exprR.ok) return err("CALIBER_EXPR", `口径公式编译失败:${exprR.error.message}`);

  const whereParts: string[] = [];
  let timeColumn: string | undefined;
  if (timeRange) {
    if (!caliber.metricTime) return err("NO_TIME_COL", `指标 ${metric.metricName} 缺少时间字段,无法应用时间范围`);
    const tc = deps.resolveColumn(dataset, caliber.metricTime);
    if (tc === null || !IDENT.test(tc)) return err("UNRESOLVED_TIME", `时间字段无法解析:${dataset}.${caliber.metricTime}`);
    timeColumn = tc;
    whereParts.push(`${qualify(tc)} >= ${quoteLiteral(timeRange.start)}`);
    whereParts.push(`${qualify(tc)} <= ${quoteLiteral(timeRange.end)}`);
  }

  const filterSqls: string[] = [];
  for (const f of caliber.filters ?? []) {
    if (!f.expr) continue;
    const r = compileFilterExpr(f.expr, ctx);
    if (!r.ok) return err("CALIBER_FILTER", `口径过滤编译失败:${r.error.message}`);
    filterSqls.push(r.value);
    whereParts.push(r.value);
  }

  const dimOutputs = resolvedDims.map((d) => d.output);
  const selectCols = [...dimOutputs, `${exprR.value} AS metric_value`];
  const lines: string[] = [];
  lines.push(`SELECT ${selectCols.join(", ")}`);
  lines.push(`FROM ${table}${qualified ? " AS t" : ""}`);
  const joins: Array<{ table: string; on: string }> = [];
  for (const d of resolvedDims) {
    if (!d.join) continue;
    lines.push(`LEFT JOIN ${d.join.table} AS ${d.join.alias} ON ${qualify(d.join.onLeft)} = ${d.join.alias}.${d.join.onRight}`);
    joins.push({ table: d.join.table, on: `${d.join.onLeft} = ${d.join.alias}.${d.join.onRight}` });
  }
  if (whereParts.length > 0) lines.push(`WHERE ${whereParts.join("\n  AND ")}`);
  if (dimOutputs.length > 0) {
    lines.push(`GROUP BY ${dimOutputs.join(", ")}`);
    lines.push(`ORDER BY metric_value DESC`);
  }
  lines.push(`LIMIT ${maxRow}`);

  return ok({
    sql: lines.join("\n"),
    caliberSummary: {
      expr: exprR.value,
      filters: filterSqls,
      timeColumn,
      physicalTable: table,
      joins,
    },
  });
}
