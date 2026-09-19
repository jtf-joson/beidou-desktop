/**
 * 领域类型唯一来源(CODE_STANDARDS §2:领域词汇表与 DataBuddy 术语对齐)。
 * src/core 全体模块只从这里取类型;禁止反向依赖。
 */

/** 结构化错误:fail-closed 一切异常出口(CODE_STANDARDS §1.3) */
export interface AppError {
  code: string;
  message: string;
  detail?: unknown;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(code: string, message: string, detail?: unknown): Result<T> => ({
  ok: false,
  error: { code, message, detail },
});

// ---------------------------------------------------------------------------
// 语义资产(SPEC Q2.4:文件即权威源,本类型是其内存投影)
// ---------------------------------------------------------------------------

export type MetricType = "ATOMIC" | "DERIVED" | "COMPOSITE";

/** 指标口径(平台 caliber 的结构化投影;编译器输入) */
export interface MetricCaliber {
  datasetName?: string;
  /** 人类可读表达式,如 count(['ds'/'vin']) */
  expr?: string;
  /** 公式 AST:{type: CALL_OP|BIN_OP|NAME_REF|CONSTANT, op, args, x, y, val, path} */
  formula?: unknown;
  /** 固定过滤:[{type: "EXPR", expr: "((['ds'/'col']) > (0))"}] */
  filters?: Array<{ type?: string; expr?: string }>;
  /** 时间字段(数据集列名,通常是 dt) */
  metricTime?: string;
}

/** 指标镜像:权威源在指标平台,此处为导入投影(Semantic-as-Code) */
export interface MetricMirror {
  /** 平台主键,如 sum_highway_adas_odometer_days */
  metricName: string;
  /** 中文名,如 智驾高速里程(天) */
  displayName: string;
  type: MetricType;
  /** 平台内部 code(mc 开头),BIN_OP 里 NAME_REF 可能引用它 */
  code?: string;
  unit?: string;
  /** 业务口径(人话) */
  businessCaliber?: string;
  status?: string;
  owner?: string;
  /** 类目路径,如 [智能驾驶, 行车] */
  categoryPath: string[];
  /** ATOMIC:口径所在数据集 */
  datasetName?: string;
  /** 物理表全限定名 catalog.schema.table */
  physicalTables: string[];
  /** 可用维度 dimName 列表 */
  dimensions: string[];
  /** DERIVED/COMPOSITE 引用的指标 code */
  refMetricCodes: string[];
  /** 口径(ATOMIC 有 formula/filters;DERIVED 有 refMetricCode) */
  caliber?: MetricCaliber;
}

/** 数据集卡片:平台虚拟数据集 → 物理表 */
export interface DatasetCard {
  datasetName: string;
  displayName?: string;
  physicalTables: string[];
  /** 依赖此数据集的指标 */
  metrics: string[];
  /** 数据集列名(来自血缘映射) */
  columns: string[];
}

/** 术语(glossary.yaml 人工维护) */
export interface GlossaryTerm {
  term: string;
  synonyms: string[];
  metricRefs?: string[];
  datasetRefs?: string[];
  note?: string;
}

/** 数据集列 → 物理列 的映射(来自北斗血缘,派生) */
export interface ColumnBinding {
  dataset: string;
  datasetColumn: string;
  physicalTable: string;
  physicalColumn: string;
}

export interface SemanticAssets {
  metrics: MetricMirror[];
  datasets: DatasetCard[];
  glossary: GlossaryTerm[];
  columnBindings: ColumnBinding[];
  /** 物理表 → 引用它的指标(反向索引) */
  tableToMetrics: Record<string, string[]>;
  importWarnings: string[];
}

// ---------------------------------------------------------------------------
// 检索与路由
// ---------------------------------------------------------------------------

export type AssetKind = "metric" | "dataset" | "term" | "table" | "entity" | "model";

export interface SearchHit {
  kind: AssetKind;
  /** metricName / datasetName / term / 物理表全名 */
  id: string;
  name: string;
  displayName?: string;
  score: number;
  /** 命中原因(供 UI 与 Agent 解释) */
  why: string;
  /** 附带:指标命中时给维度与物理表,便于 Agent 直接决策 */
  dimensions?: string[];
  physicalTables?: string[];
}

export type RouteKind = "query_metrics" | "query_dataset" | "clarify" | "reject";

export interface RouteDecision {
  route: RouteKind;
  /** 决策依据(进入 EvidencePack 与审计) */
  reason: string;
  /** clarify 时建议向用户提出的问题 */
  clarifyQuestions?: string[];
  primaryHit?: SearchHit;
}

// ---------------------------------------------------------------------------
// 证据与审计(DataBuddy EvidencePack 的单机版)
// ---------------------------------------------------------------------------

export type EvidenceKind = "metric_query" | "dataset_query" | "semantic_search" | "clarify";

export interface EvidenceItem {
  kind: EvidenceKind;
  title: string;
  /** 指标口径(人话),来自平台 businessCaliber */
  caliber?: string;
  /** 实际执行的 SQL(编译器产物) */
  sql?: string;
  /** 涉及物理表 */
  physicalTables?: string[];
  /** 指标名(命中平台指标时) */
  metricName?: string;
  rows?: number;
  truncated?: boolean;
  elapsedMs?: number;
  /** 血缘链:指标 ← 数据集 ← 物理表 */
  lineage?: string[];
  /** 语义资产版本(导入时间戳或 git sha) */
  semanticVersion?: string;
  /** 演示数据标记(mock 连接器产出) */
  mock?: boolean;
}

export type AuditEvent = {
  ts: string;
  /** ISO 时间 */
  kind: "user_message" | "tool_call" | "tool_result" | "guard_rejection" | "agent_reply";
  sessionId: string;
  user?: string;
  summary: string;
  detail?: unknown;
};
