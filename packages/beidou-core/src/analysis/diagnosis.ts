/**
 * 智能诊断引擎(DataBuddy「指标异动归因」单机版)。
 * 确定性计算全部在本模块(总量对比→异常检测→维度贡献拆解→Top 贡献者排序);
 * 查询经注入的 runQuery(工具层接 compileMetricSql,保证口径一致);LLM 只做解读,不做算术。
 * 贡献拆解算法沿用 DataBuddy:contribution_i = (cur_i - prior_i) / prior_total(即贡献占基期总量比例);
 * 新增/消失成员按 0 处理;贡献合计应≈总变化比例(闭合校验)。
 */
import { err, ok, type Result } from "../types";

export interface TimeWindow {
  start: string;
  end: string;
}

export interface RunQueryFn {
  (dims: string[], range: TimeWindow): Promise<
    { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string }
  >;
}

export interface AnomalyResult {
  anomaly: boolean;
  direction: "up" | "down" | "flat";
  pctChange: number | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

export function detectAnomaly(input: {
  current: number;
  prior: number;
  thresholdPct: number;
}): AnomalyResult {
  const { current, prior, thresholdPct } = input;
  if (prior === 0) {
    return { anomaly: true, direction: current > 0 ? "up" : "flat", pctChange: null };
  }
  const pctChange = (current - prior) / Math.abs(prior);
  const anomaly = Math.abs(pctChange) > thresholdPct / 100;
  return {
    anomaly,
    direction: pctChange > 0 ? "up" : pctChange < 0 ? "down" : "flat",
    pctChange,
  };
}

/** 等长前移窗口:把 current 的日期各减去窗口长度 */
export function derivePriorWindow(current: TimeWindow): TimeWindow {
  const lenDays = Math.max(1, Math.round((new Date(current.end).getTime() - new Date(current.start).getTime()) / 86400_000)) + 1;
  const shift = (d: string): string => {
    const t = new Date(d).getTime() - lenDays * 86400_000;
    return new Date(t).toISOString().slice(0, 10);
  };
  return { start: shift(current.start), end: shift(current.end) };
}

export interface Contribution {
  value: string;
  current: number;
  prior: number;
  delta: number;
  /** (cur - prior) / prior_total */
  contribution: number;
}

export interface DimAttribution {
  dim: string;
  top: Contribution[];
  /** Top 贡献合计(≈ 总变化比例,闭合参考) */
  contributionSum: number;
}

export interface DiagnosisResult {
  totals: { current: number; prior: number; delta: number };
  anomaly: AnomalyResult;
  priorWindow: TimeWindow;
  attributions: DimAttribution[];
}

const VALUE_COL = "metric_value";

export async function diagnoseMetric(
  input: {
    dims: string[];
    current: TimeWindow;
    prior?: TimeWindow;
    thresholdPct?: number;
    topK?: number;
  },
  runQuery: RunQueryFn,
): Promise<Result<DiagnosisResult>> {
  const priorWindow = input.prior ?? derivePriorWindow(input.current);
  const thresholdPct = input.thresholdPct ?? 10;
  const topK = input.topK ?? 5;

  const totals = await runQuery([], input.current);
  if (!totals.ok) return err("DIAG_QUERY", `本期总量查询失败:${totals.error}`);
  const priorTotals = await runQuery([], priorWindow);
  if (!priorTotals.ok) return err("DIAG_QUERY", `基期总量查询失败:${priorTotals.error}`);
  const curTotal = num(totals.rows[0]?.[VALUE_COL]);
  const priorTotal = num(priorTotals.rows[0]?.[VALUE_COL]);
  const anomaly = detectAnomaly({ current: curTotal, prior: priorTotal, thresholdPct });

  const attributions: DimAttribution[] = [];
  for (const dim of input.dims) {
    const curRows = await runQuery([dim], input.current);
    if (!curRows.ok) return err("DIAG_QUERY", `维度 ${dim} 本期查询失败:${curRows.error}`);
    const priorRows = await runQuery([dim], priorWindow);
    if (!priorRows.ok) return err("DIAG_QUERY", `维度 ${dim} 基期查询失败:${priorRows.error}`);

    const curMap = new Map(curRows.rows.map((r) => [String(r[dim] ?? "null"), num(r[VALUE_COL])]));
    const priorMap = new Map(priorRows.rows.map((r) => [String(r[dim] ?? "null"), num(r[VALUE_COL])]));
    const values = new Set([...curMap.keys(), ...priorMap.keys()]);
    const contributions: Contribution[] = [];
    for (const v of values) {
      const c = curMap.get(v) ?? 0;
      const p = priorMap.get(v) ?? 0;
      contributions.push({
        value: v,
        current: c,
        prior: p,
        delta: c - p,
        contribution: priorTotal === 0 ? 0 : (c - p) / priorTotal,
      });
    }
    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    const top = contributions.slice(0, topK);
    attributions.push({
      dim,
      top,
      contributionSum: top.reduce((s, c) => s + c.contribution, 0),
    });
  }

  return ok({
    totals: { current: curTotal, prior: priorTotal, delta: curTotal - priorTotal },
    anomaly,
    priorWindow,
    attributions,
  });
}
