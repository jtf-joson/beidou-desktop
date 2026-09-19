/**
 * 路由策略(纯函数)。SPEC Q2.6:LLM 提路径、协议决定能不能走。
 * 本模块是「协议」的可测实现:system prompt 的路由规则与 UI 的路由 chip 都由此生成/校验,
 * 避免双写漂移(CODE_STANDARDS 契约测试锚点)。
 */
import type { RouteDecision, SearchHit } from "../types";

export interface RouterConfig {
  /** 指标命中分数阈值(≥ 才走指标 API) */
  metricScoreThreshold: number;
}

export interface RouteInput {
  hits: SearchHit[];
  config: RouterConfig;
  /** 指标平台在线可用性(未配置/不可达时降级走口径编译 SQL) */
  metricOnline: boolean;
  /** 指标状态(可选双保险:OFFLINE 指标不直查) */
  metricStatus?: Record<string, string | undefined>;
}

const CLARIFY_TEMPLATE = [
  "时间范围是什么?(如:本月/上季度/近 30 天)",
  "关注哪个业务对象或口径?(如:全量还是某车型/某区域)",
  "需要按什么维度拆分?(如:按车型/按月)",
];

export function decideRoute(input: RouteInput): RouteDecision {
  const { hits, config, metricOnline, metricStatus } = input;
  const metricHits = hits
    .filter((h) => h.kind === "metric")
    .filter((h) => (metricStatus?.[h.id] ?? "ONLINE") === "ONLINE");
  const top = metricHits[0];
  const datasetTop = hits.find((h) => h.kind === "dataset");

  if (top && top.score >= config.metricScoreThreshold) {
    if (metricOnline) {
      return {
        route: "query_metrics",
        reason: `指标「${top.displayName ?? top.name}」高置信命中(分数 ${Math.round(top.score)})`,
        primaryHit: top,
      };
    }
    return {
      route: "query_dataset",
      reason: `指标「${top.displayName ?? top.name}」命中但指标平台离线,走口径编译下钻(口径一致性由编译器保证)`,
      primaryHit: top,
    };
  }

  if (datasetTop && datasetTop.score >= config.metricScoreThreshold * 0.8) {
    return {
      route: "query_dataset",
      reason: `数据集「${datasetTop.displayName ?? datasetTop.name}」命中,走受控明细分析`,
      primaryHit: datasetTop,
    };
  }

  if (top && top.score >= config.metricScoreThreshold * 0.4) {
    return {
      route: "clarify",
      reason: `指标「${top.displayName ?? top.name}」弱命中(分数 ${Math.round(top.score)}),需用户确认口径`,
      clarifyQuestions: [
        `你问的是不是「${top.displayName ?? top.name}」?(${top.why})`,
        ...CLARIFY_TEMPLATE,
      ],
      primaryHit: top,
    };
  }

  return {
    route: "clarify",
    reason: "语义检索无足够命中(不猜)",
    clarifyQuestions: CLARIFY_TEMPLATE,
  };
}
