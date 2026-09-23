/**
 * 分析工作台的统一结果协议。
 *
 * 工具仍然返回 BeidouToolResult；data 使用本协议后，客户端不需要解析
 * 自然语言来猜测结果应该画成什么图。所有字段保持可序列化，方便通过
 * Harness、日志和报告产物传递。
 */

export type AnalysisResultType =
  | "metric"
  | "table"
  | "line"
  | "bar"
  | "pie"
  | "funnel"
  | "diagnosis"
  | "report"

export interface AnalysisFilter {
  field: string
  label?: string
  value: string | number | boolean | null
}

export interface AnalysisEvidence {
  traceId: string
  source?: string
  caliber?: string
  sql?: string
  queriedAt?: string
  mock?: boolean
}

export interface AnalysisSeries {
  name: string
  values: Array<string | number | null>
  color?: string
}

export interface AnalysisResultBase {
  type: AnalysisResultType
  title: string
  description?: string
  unit?: string
  filters?: AnalysisFilter[]
  evidence?: AnalysisEvidence[]
  actions?: Array<"drilldown" | "explain" | "report" | "sql" | "export">
}

export interface MetricAnalysisResult extends AnalysisResultBase {
  type: "metric"
  value: number | string | null
  comparison?: { label: string; value: number | string | null; direction?: "up" | "down" | "flat" }
}

export interface ChartAnalysisResult extends AnalysisResultBase {
  type: "line" | "bar" | "pie" | "funnel"
  labels: string[]
  series: AnalysisSeries[]
}

export interface TableAnalysisResult extends AnalysisResultBase {
  type: "table"
  columns: Array<{ key: string; label: string; type?: "text" | "number" | "date" | "percent" }>
  rows: Array<Record<string, string | number | boolean | null>>
  truncated?: boolean
}

export interface DiagnosisAnalysisResult extends AnalysisResultBase {
  type: "diagnosis"
  severity: "info" | "warning" | "critical"
  findings: Array<{ title: string; detail: string; impact?: string }>
  recommendations?: string[]
}

export interface ReportAnalysisResult extends AnalysisResultBase {
  type: "report"
  sections: Array<{ title: string; summary?: string; resultIds?: string[] }>
}

export type AnalysisResult =
  | MetricAnalysisResult
  | ChartAnalysisResult
  | TableAnalysisResult
  | DiagnosisAnalysisResult
  | ReportAnalysisResult

export interface AnalysisResultEnvelope {
  version: 1
  sessionId: string
  resultId: string
  generatedAt: string
  results: AnalysisResult[]
}
