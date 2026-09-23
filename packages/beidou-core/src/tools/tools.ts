/**
 * 面向 Agent 的四个工具(search_semantics / query_metrics / query_dataset / clarify)。
 * 框架无关:handler 纯逻辑 + 注入依赖;由 main/agent 适配到 Agent SDK 的 MCP server。
 * 每次调用产生 EvidenceItem + 审计事件;SQL 一律走「编译器/构建器 → sql-guard → 只读执行」管线。
 */
import type { AuditEvent, EvidenceItem, RouteDecision, SearchHit, SemanticAssets, MetricMirror } from "../types";
import type { SemanticStore } from "../semantics/store";
import type { SemanticGraph } from "../semantics/graph";
import type { GuardPolicy } from "../guard/sql-guard";
import { guard } from "../guard/sql-guard";
import { compileMetricSql } from "../compiler/metric-sql";
import { buildExploreSql, type ExploreInput } from "./builder";
import { decideRoute, type RouterConfig } from "../router/policy";
import type { SrQueryResult } from "../services/starrocks";
import { buildEvidenceItem } from "../evidence/pack";
import { diagnoseMetric, type TimeWindow } from "../analysis/diagnosis";
import { modelsForMetric, type EntitiesFile } from "../semantics/entities";
import { searchKnowledge } from "./knowledge";
import type { ParsedOntology } from "../../../ontology-schema/src/types";
import type { Bindings } from "../../../ontology-schema/src/bindings";

export interface ToolContext {
  store: SemanticStore;
  assets: SemanticAssets;
  routerConfig: RouterConfig;
  guardPolicy: GuardPolicy;
  metricOnline: boolean;
  metricStatus?: Record<string, string | undefined>;
  /** 在线指标数值查询(未配置则走口径编译) */
  queryMetricsOnline?: (req: {
    metricName: string;
    dims?: string[];
    timeRange?: { start: string; end: string };
  }) => Promise<{ ok: true; value: { rows: Array<Record<string, unknown>>; note?: string } } | { ok: false; error: string }>;
  starrocksQuery: (sql: string) => Promise<{ ok: true; value: SrQueryResult } | { ok: false; error: { code: string; message: string } }>;
  audit: { append(e: AuditEvent): Promise<void> };
  sessionId: string;
  semanticVersion: string;
  /** 指标 code(mc…) → 指标(嵌套公式解析用) */
  metricsByCode: Map<string, MetricMirror>;
  /** 数据源模式:mock 时结果必须标注演示数据 */
  dataSource?: "mock" | "real";
  /** 当前身份(P0-5:贯穿业务工具,未登录 = undefined) */
  identity?: { username: string; source: "idaas-token" | "ept-session" | "none" } | undefined;
  /** 实体与业务模型(诊断维度选择与检索) */
  entities?: EntitiesFile;
  /** 本体(ontology.yaml 解析结果) */
  ontology?: ParsedOntology;
  /** 绑定层(bindings/*.yaml) */
  bindings?: Bindings;
  /** 业务知识库(空间 knowledge/*.md;检索给 Agent 参考) */
  knowledge?: Array<{ name: string; content: string }>;
  /** 业务 Playbook(空间 playbooks/*.md;按名读取) */
  playbooks?: Array<{ name: string; content: string }>;
  /** 语义图(资产仓模式装载期物化;缺省时检索不做图扩展) */
  graph?: SemanticGraph;
  now?: () => string;
}

export interface ToolResponse {
  ok: boolean;
  /** 给 LLM 看的文本(JSON/markdown) */
  text: string;
  evidence: EvidenceItem[];
  route?: RouteDecision;
  clarify?: { questions: string[] };
  error?: string;
}

const nowIso = (ctx: ToolContext): string => ctx.now?.() ?? new Date().toISOString();

async function audit(ctx: ToolContext, kind: AuditEvent["kind"], summary: string, detail?: unknown): Promise<void> {
  await ctx.audit.append({ ts: nowIso(ctx), kind, sessionId: ctx.sessionId, summary, detail });
}

/** 统一执行管线:guard → 只读查询;拒绝时写 guard_rejection 审计 */
async function runGuardedSql(
  ctx: ToolContext,
  sql: string,
): Promise<{ ok: true; value: SrQueryResult; sql: string } | { ok: false; error: string }> {
  const g = guard(sql, ctx.guardPolicy);
  if (!g.ok) {
    await audit(ctx, "guard_rejection", `护栏拒绝:${g.rule}`, g);
    return { ok: false, error: `SQL 被护栏拒绝(${g.rule}):${g.reason}` };
  }
  const started = Date.now();
  const r = await ctx.starrocksQuery(g.sql);
  const elapsedMs = Date.now() - started;
  if (!r.ok) {
    await audit(ctx, "tool_result", `查询失败:${r.error.code}`, r.error);
    return { ok: false, error: `查询失败:${r.error.message}` };
  }
  return { ok: true, value: r.value, sql: g.sql };
}

function lineageOf(ctx: ToolContext, metric: MetricMirror): string[] {
  const chain = [metric.metricName];
  if (metric.datasetName) chain.push(metric.datasetName);
  chain.push(...metric.physicalTables);
  return chain;
}

/**
 * 把用户/模型传入的语义维度 ID转换为指标平台字段名。
 * 资产层保留 dimension.bs.* 作为本体稳定 ID，providerDimensions 是平台快照
 * 中的 dimName；只有在线查询需要后者，离线 SQL 编译仍使用语义 ID。
 */
function resolveOnlineDimensions(metric: MetricMirror, requested: string[]): { dims: string[]; invalid: string[]; allowed: string[] } {
  const semantic = metric.dimensions ?? [];
  const provider = metric.providerDimensions ?? [];
  const allowed = [...new Set([...semantic, ...provider])];
  const invalid: string[] = [];
  const dims: string[] = [];
  for (const dim of requested) {
    const semanticIndex = semantic.indexOf(dim);
    const isSyntheticTime = /^metric_time__(day|week|month|quarter|year)$/.test(dim);
    if (semanticIndex >= 0) {
      dims.push(provider[semanticIndex] ?? dim);
    } else if (provider.includes(dim) || (isSyntheticTime && (semantic.includes("dimension.bs.metric-time") || semantic.includes("metric_time")))) {
      dims.push(dim);
    } else {
      invalid.push(dim);
    }
  }
  return { dims, invalid, allowed };
}

/**
 * 把资产仓中的能力层/知识层挂到诊断结果上。
 * 这里仅做确定性关联：Playbook 必须显式引用指标 code 或平台指标名，
 * 知识页按指标显示名检索；不根据相似词臆造业务建议。
 */
function assetGuidance(ctx: ToolContext, metric: MetricMirror): {
  playbooks: Array<{ name: string; content: string }>;
  knowledge: Array<{ name: string; excerpt: string }>;
} {
  const refs = [metric.metricName, metric.code, metric.displayName].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const playbooks = (ctx.playbooks ?? [])
    .filter((p) => refs.some((ref) => p.content.toLowerCase().includes(ref)))
    .map((p) => ({ name: p.name, content: p.content }));
  // 知识页既可能写业务显示名,也可能写平台指标名/资产 code;三者都检索并去重。
  const knowledge = refs
    .flatMap((ref) => searchKnowledge(ctx.knowledge ?? [], ref))
    .sort((a, b) => b.score - a.score)
    .filter((hit, index, all) => all.findIndex((x) => x.name === hit.name) === index)
    .slice(0, 3)
    .map((h) => ({ name: h.name, excerpt: h.excerpt }));
  return { playbooks, knowledge };
}

export interface ToolSet {
  search_semantics(input: { query: string; limit?: number }): Promise<ToolResponse>;
  query_metrics(input: {
    metricName: string;
    dims?: string[];
    timeRange?: { start: string; end: string };
  }): Promise<ToolResponse>;
  query_dataset(
    input:
      | { mode: "drilldown"; metricName: string; dims?: string[]; timeRange?: { start: string; end: string } }
      | (Omit<ExploreInput, "limit"> & { mode: "explore"; limit?: number }),
  ): Promise<ToolResponse>;
  clarify(input: { questions: string[] }): Promise<ToolResponse>;
  diagnose_metric(input: {
    metricName: string;
    timeRange?: { start: string; end: string };
    dims?: string[];
    thresholdPct?: number;
  }): Promise<ToolResponse>;
  trace_lineage(input: { metricName: string }): Promise<ToolResponse>;
  search_knowledge(input: { query: string }): Promise<ToolResponse>;
  read_playbook(input: { name: string }): Promise<ToolResponse>;
  list_ontology(input: { subdomain?: string }): Promise<ToolResponse>;
}

/**
 * 图邻居扩展(六步检索第 4 步):top 命中的资产沿语义图带出关联指标。
 * 只补指标类命中(类/技能等中间节点走一跳再带出同主体/同依赖指标),分数压在
 * 直接命中之下,保证扩展永不挤掉关键词命中。
 */
export function graphExpandHits(
  hits: SearchHit[],
  deps: { graph: SemanticGraph; store: SemanticStore; metricsByCode: Map<string, MetricMirror> },
  opts?: { seedCount?: number; cap?: number },
): SearchHit[] {
  const { graph, metricsByCode } = deps;
  const seen = new Set(hits.filter((h) => h.kind === "metric").map((h) => h.id));
  const seeds = hits.slice(0, opts?.seedCount ?? 3).map((h) => {
    if (h.kind === "metric") return deps.store.getMetric(h.id)?.code;
    if (h.kind === "entity" || h.kind === "model") return h.id;
    return undefined;
  }).filter((x): x is string => !!x);

  const out: SearchHit[] = [];
  let budget = opts?.cap ?? 5;
  const metricHit = (mirror: MetricMirror, why: string): SearchHit => ({
    kind: "metric",
    id: mirror.metricName,
    name: mirror.metricName,
    displayName: mirror.displayName,
    score: 30,
    why,
    dimensions: mirror.dimensions,
    providerDimensions: mirror.providerDimensions,
    physicalTables: mirror.physicalTables,
  });
  const addMetric = (assetId: string, why: string): boolean => {
    const mirror = metricsByCode.get(assetId);
    if (!mirror || seen.has(mirror.metricName)) return false;
    seen.add(mirror.metricName);
    out.push(metricHit(mirror, why));
    budget -= 1;
    return true;
  };

  for (const seed of seeds) {
    if (budget <= 0) break;
    for (const { edge, other } of graph.neighbors(seed)) {
      if (budget <= 0) break;
      if (addMetric(other, `图扩展(${edge.type}:${seed})`)) continue;
      // 非指标中间节点(类/技能/Playbook)再走一跳,带出同主体/同依赖指标
      for (const hop2 of graph.neighbors(other)) {
        if (budget <= 0) break;
        addMetric(hop2.other, `图扩展(经 ${other})`);
      }
    }
  }
  return out;
}

export function createTools(ctx: ToolContext): ToolSet {
  const compileAndRun = async (
    metricName: string,
    dims: string[],
    timeRange: { start: string; end: string } | undefined,
  ): Promise<ToolResponse> => {
    const metric = ctx.store.getMetric(metricName);
    if (!metric) {
      await audit(ctx, "tool_call", `指标不存在:${metricName}`);
      return { ok: false, text: "", evidence: [], error: `指标不存在:${metricName};请先调用 search_semantics 确认指标名` };
    }
    const compileR = compileMetricSql(
      { metric, dims, timeRange, maxRow: ctx.guardPolicy.maxRow },
      {
        resolveColumn: (ds, col) => ctx.store.resolveColumn(ds, col)?.physicalColumn ?? null,
        resolveMetricCode: (code) => ctx.metricsByCode.get(code)?.caliber?.formula ?? null,
        resolveDimBinding: (dim) => ctx.store.resolveDimBinding(dim),
      },
    );
    if (!compileR.ok) {
      await audit(ctx, "tool_result", `口径编译失败:${metricName}`, compileR.error);
      const platformOnly = metric.type === "DERIVED" && compileR.error.code === "NO_FORMULA";
      if (platformOnly) {
        return {
          ok: false,
          text: "",
          evidence: [],
          error: `指标已在语义资产中登记,但属于${metric.displayName ?? metricName}派生指标;环比/同比周期计算必须调用指标平台,当前指标平台查询未配置,因此拒绝使用基础指标公式替代。`,
        };
      }
      return { ok: false, text: "", evidence: [], error: `口径编译失败(${compileR.error.code}):${compileR.error.message};该指标暂不支持自动下钻,请向用户说明并建议人工路径` };
    }
    const runR = await runGuardedSql(ctx, compileR.value.sql);
    if (!runR.ok) return { ok: false, text: "", evidence: [], error: runR.error };
    const evidence = buildEvidenceItem({
      kind: "metric_query",
      title: `${metric.displayName ?? metricName}${timeRange ? ` ${timeRange.start}~${timeRange.end}` : ""}${ctx.dataSource === "mock" ? "(演示数据)" : ""}`,
      metricName,
      caliber: metric.businessCaliber ?? compileR.value.caliberSummary.expr,
      sql: runR.sql,
      physicalTables: metric.physicalTables,
      lineage: lineageOf(ctx, metric),
      rows: runR.value.rowCount,
      truncated: runR.value.truncated,
      semanticVersion: ctx.semanticVersion,
      mock: ctx.dataSource === "mock",
    });
    await audit(ctx, "tool_result", `指标查询完成:${metricName}(${runR.value.rowCount} 行)`, {
      sql: runR.sql,
      truncated: runR.value.truncated,
    });
    return {
      ok: true,
      text: JSON.stringify(
        {
          metric: metricName,
          caliber: metric.businessCaliber,
          columns: runR.value.columns,
          rows: runR.value.rows,
          truncated: runR.value.truncated,
          note: "结果由指标口径编译 SQL 计算得到,口径与平台定义一致",
        },
        null,
        1,
      ),
      evidence: [evidence],
    };
  };

  return {
    async search_semantics({ query, limit }) {
      await audit(ctx, "tool_call", `语义检索:${query}`);
      const hits: SearchHit[] = ctx.store.search(query, { limit: limit ?? 8 });
      // 实体与业务模型命中(名称/描述/属性)
      const q = query.toLowerCase();
      for (const e of ctx.entities?.entities ?? []) {
        if (e.name.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q)) {
          hits.push({ kind: "entity", id: e.name, name: e.name, displayName: e.description, score: 60, why: "实体命中" });
        }
      }
      for (const m of ctx.entities?.models ?? []) {
        if (m.name.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q) || m.metrics.some((x) => x.toLowerCase().includes(q))) {
          hits.push({
            kind: "model", id: m.name, name: m.name, displayName: m.description,
            score: 65, why: "业务模型命中",
            dimensions: m.dimensions,
          });
        }
      }
      // 本体命中(class/property/relation/action + 子域归属)
      const ont = ctx.ontology;
      if (ont) {
        for (const cls of ont.classes) {
          const nameL = cls.name.toLowerCase();
          const descL = (cls.description ?? "").toLowerCase();
          const propL = cls.properties.map((p) => `${p.id} ${p.name ?? ""}`.toLowerCase()).join(" ");
          if (nameL.includes(q) || descL.includes(q) || propL.includes(q)) {
            hits.push({
              kind: "entity", id: cls.id, name: cls.name,
              displayName: cls.description, score: 70, why: `本体 class(${cls.subdomain})`,
              physicalTables: cls.metrics && cls.metrics.length > 0 ? undefined : undefined,
            });
          }
        }
        for (const rel of ont.relations) {
          if (rel.id.toLowerCase().includes(q) || (rel.name ?? "").toLowerCase().includes(q)) {
            hits.push({ kind: "entity", id: rel.id, name: rel.name ?? rel.id, score: 55, why: "本体 relation" });
          }
        }
        for (const act of ont.actions) {
          if (act.name.toLowerCase().includes(q) || act.id.toLowerCase().includes(q)) {
            hits.push({
              kind: "entity", id: act.id, name: act.name, score: 65, why: `本体 action(${act.subdomain})`,
            });
          }
        }
      }
      hits.sort((a, b) => b.score - a.score);
      // 图邻居扩展:top 命中沿语义图带出关联指标(未装载图时跳过)
      if (ctx.graph) {
        hits.push(...graphExpandHits(hits, { graph: ctx.graph, store: ctx.store, metricsByCode: ctx.metricsByCode }));
        hits.sort((a, b) => b.score - a.score);
      }
      const route = decideRoute({
        hits,
        config: ctx.routerConfig,
        metricOnline: ctx.metricOnline,
        metricStatus: ctx.metricStatus,
      });
      const evidence = buildEvidenceItem({ kind: "semantic_search", title: `检索:${query}`, semanticVersion: ctx.semanticVersion });
      return {
        ok: true,
        text: JSON.stringify({ hits, route, hint: ROUTE_HINTS[route.route] }, null, 1),
        evidence: [evidence],
        route,
      };
    },

    async query_metrics({ metricName, dims, timeRange }) {
      await audit(ctx, "tool_call", `查指标:${metricName}`, { dims, timeRange });
      const metric = ctx.store.getMetric(metricName);
      if (!metric) {
        await audit(ctx, "tool_result", `指标资产校验失败:${metricName}`);
        return { ok: false, text: "", evidence: [], error: `指标不存在于当前 beidou-workspace 资产:${metricName};请先调用 search_semantics 或使用资产中的 metricName` };
      }
      const requestedDims = dims ?? [];
      const resolved = resolveOnlineDimensions(metric, requestedDims);
      if (resolved.invalid.length > 0) {
        await audit(ctx, "tool_result", `维度资产校验失败:${metricName}`, { invalidDims: resolved.invalid, allowedDims: resolved.allowed });
        return { ok: false, text: "", evidence: [], error: `维度不属于指标 ${metric.displayName ?? metricName}:${resolved.invalid.join(",")};可用维度:${resolved.allowed.join(",") || "无"}` };
      }
      if (ctx.metricOnline && ctx.queryMetricsOnline) {
        const r = await ctx.queryMetricsOnline({ metricName, dims: resolved.dims, timeRange });
        if (r.ok) {
          const evidence = buildEvidenceItem({
            kind: "metric_query",
            title: metric?.displayName ?? metricName,
            metricName,
            caliber: metric?.businessCaliber,
            lineage: lineageOf(ctx, metric),
            physicalTables: metric?.physicalTables,
            rows: r.value.rows.length,
            semanticVersion: ctx.semanticVersion,
          });
          await audit(ctx, "tool_result", `在线指标查询完成:${metricName}(${r.value.rows.length} 行)`, { dims: requestedDims, timeRange, source: "anymetrics-semantic" });
          return { ok: true, text: JSON.stringify({ metric: metricName, displayName: metric.displayName, caliber: metric.businessCaliber, dimensions: metric.dimensions, providerDimensions: metric.providerDimensions, rows: r.value.rows, note: r.value.note, source: "AnyMetrics semantic API" }, null, 1), evidence: [evidence] };
        }
        // 在线失败 → 降级口径编译(不静默编数)
        await audit(ctx, "tool_result", `在线指标查询失败,降级口径编译:${r.error}`);
      }
      return compileAndRun(metricName, dims ?? [], timeRange);
    },

    async query_dataset(input) {
      if (input.mode === "drilldown") {
        await audit(ctx, "tool_call", `口径下钻:${input.metricName}`, { dims: input.dims, timeRange: input.timeRange });
        return compileAndRun(input.metricName, input.dims ?? [], input.timeRange);
      }
      await audit(ctx, "tool_call", `明细分析:${input.table}`, input);
      const buildR = buildExploreSql(
        { ...input, limit: input.limit },
        { allowedTables: ctx.guardPolicy.allowedTables },
      );
      if (!buildR.ok) {
        await audit(ctx, "tool_result", `SQL 构建拒绝:${buildR.error.code}`, buildR.error);
        return { ok: false, text: "", evidence: [], error: `SQL 构建拒绝(${buildR.error.code}):${buildR.error.message}` };
      }
      const runR = await runGuardedSql(ctx, buildR.value);
      if (!runR.ok) return { ok: false, text: "", evidence: [], error: runR.error };
      const evidence = buildEvidenceItem({
        kind: "dataset_query",
        title: `明细分析:${input.table}${ctx.dataSource === "mock" ? "(演示数据)" : ""}`,
        sql: runR.sql,
        physicalTables: [input.table],
        rows: runR.value.rowCount,
        truncated: runR.value.truncated,
        semanticVersion: ctx.semanticVersion,
        mock: ctx.dataSource === "mock",
      });
      return {
        ok: true,
        text: JSON.stringify({ columns: runR.value.columns, rows: runR.value.rows, truncated: runR.value.truncated, dataSource: ctx.dataSource ?? "real" }, null, 1),
        evidence: [evidence],
      };
    },

    async clarify({ questions }) {
      await audit(ctx, "tool_call", `请求澄清:${questions.join(";")}`);
      const evidence = buildEvidenceItem({ kind: "clarify", title: "需要澄清", semanticVersion: ctx.semanticVersion });
      return {
        ok: true,
        text: JSON.stringify({ action: "clarify", questions }, null, 1),
        evidence: [evidence],
        clarify: { questions },
      };
    },

    async diagnose_metric({ metricName, timeRange, dims, thresholdPct }) {
      await audit(ctx, "tool_call", `智能诊断:${metricName}`, { timeRange, dims });
      const metric = ctx.store.getMetric(metricName);
      if (!metric) {
        return { ok: false, text: "", evidence: [], error: `指标不存在:${metricName};请先 search_semantics` };
      }
      const current: TimeWindow = timeRange ?? { start: "2000-01-01", end: "9999-12-31" };
      // 归因维度选择(S7.3 智能化):显式 dims > 业务模型声明的关注维度 > 指标自身维度前 4
      const candDims = dims
        ? dims
        : (() => {
            const modelDims = modelsForMetric(ctx.entities ?? { entities: [], models: [] }, metricName)
              .flatMap((m) => m.dimensions);
            const pool = modelDims.length > 0 ? modelDims : metric.dimensions;
            return [...new Set(pool)].slice(0, modelDims.length > 0 ? modelDims.length : 4);
      })();
      const runQuery = async (qs: string[], range: TimeWindow) => {
        if (ctx.metricOnline && ctx.queryMetricsOnline) {
          const resolved = resolveOnlineDimensions(metric, qs);
          if (resolved.invalid.length > 0) return { ok: false as const, error: `维度不属于指标:${resolved.invalid.join(",")}` };
          const online = await ctx.queryMetricsOnline({ metricName, dims: resolved.dims, timeRange: range });
          if (!online.ok) return { ok: false as const, error: online.error };
          return { ok: true as const, rows: online.value.rows };
        }
        const compileR = compileMetricSql(
          { metric, dims: qs, timeRange: range, maxRow: ctx.guardPolicy.maxRow },
          {
            resolveColumn: (ds, col) => ctx.store.resolveColumn(ds, col)?.physicalColumn ?? null,
            resolveMetricCode: (code) => ctx.metricsByCode.get(code)?.caliber?.formula ?? null,
            resolveDimBinding: (d) => ctx.store.resolveDimBinding(d),
          },
        );
        if (!compileR.ok) return { ok: false as const, error: `${compileR.error.code}:${compileR.error.message}` };
        const runR = await runGuardedSql(ctx, compileR.value.sql);
        if (!runR.ok) return { ok: false as const, error: runR.error };
        return { ok: true as const, rows: runR.value.rows };
      };
      const r = await diagnoseMetric({ dims: candDims, current, thresholdPct }, runQuery);
      if (!r.ok) {
        await audit(ctx, "tool_result", `诊断失败:${metricName}`, r.error);
        return { ok: false, text: "", evidence: [], error: `诊断失败:${r.error.message}` };
      }
      const d = r.value;
      const guidance = assetGuidance(ctx, metric);
      const evidence = buildEvidenceItem({
        kind: "metric_query",
        title: `诊断:${metric.displayName ?? metricName}${ctx.dataSource === "mock" ? "(演示数据)" : ""}`,
        metricName,
        caliber: metric.businessCaliber,
        physicalTables: metric.physicalTables,
        lineage: lineageOf(ctx, metric),
        rows: d.attributions.reduce((s2, a) => s2 + a.top.length, 0) + 2,
        semanticVersion: ctx.semanticVersion,
        mock: ctx.dataSource === "mock",
      });
      await audit(ctx, "tool_result", `诊断完成:${metricName}(Δ${d.totals.delta}, ${d.anomaly.anomaly ? "异常" : "正常"})`);
      return {
        ok: true,
        text: JSON.stringify({
          metric: metricName,
          caliber: metric.businessCaliber,
          windows: { current, prior: d.priorWindow },
          totals: d.totals,
          anomaly: d.anomaly,
          attributions: d.attributions,
          assetGuidance: guidance,
          note: "诊断数值为确定性计算(贡献=维度值变化/基期总量);请基于以上结构化结果写诊断报告:结论→异常与方向→Top 贡献维度与值→业务建议(引用知识库与 Playbook 如有)",
        }, null, 1),
        evidence: [evidence],
      };
    },

    async trace_lineage({ metricName }) {
      await audit(ctx, "tool_call", `追踪指标血缘:${metricName}`);
      const metric = ctx.store.getMetric(metricName);
      if (!metric) return { ok: false, text: "", evidence: [], error: `指标不存在:${metricName};请先 search_semantics` };
      const dataset = metric.datasetName ? ctx.store.getDataset(metric.datasetName) : undefined;
      const dimensions = metric.dimensions.map((dimension) => ({
        dimension,
        providerDimension: metric.providerDimensions?.[metric.dimensions.indexOf(dimension)] ?? dimension,
        details: metric.dimensionDetails?.find((d) => d.name === (metric.providerDimensions?.[metric.dimensions.indexOf(dimension)] ?? dimension)),
        binding: ctx.store.resolveDimBinding(dimension),
      }));
      const guidance = assetGuidance(ctx, metric);
      const relatedMetrics = ctx.assets.metrics
        .filter((candidate) => candidate.metricName !== metric.metricName && candidate.physicalTables.some((table) => metric.physicalTables.includes(table)))
        .map((candidate) => ({ metricName: candidate.metricName, displayName: candidate.displayName, reason: "共享物理表" }));
      const affectedDatasets = ctx.assets.datasets
        .filter((candidate) => candidate.metrics.includes(metric.metricName) || candidate.physicalTables.some((table) => metric.physicalTables.includes(table)))
        .map((candidate) => candidate.datasetName);
      const lineage = {
        metric: { name: metric.metricName, code: metric.code, displayName: metric.displayName, caliber: metric.caliber, physicalTables: metric.physicalTables },
        dataset: dataset ? { name: dataset.datasetName, physicalTables: dataset.physicalTables, columns: dataset.columns } : null,
        dimensions,
        dependentMetrics: metric.refMetricCodes.map((code) => ctx.metricsByCode.get(code)?.metricName ?? code),
        guidance: { playbooks: guidance.playbooks.map((p) => p.name), knowledge: guidance.knowledge.map((k) => k.name) },
        impact: { relatedMetrics, affectedDatasets, affectedPlaybooks: guidance.playbooks.map((p) => p.name) },
        semanticVersion: ctx.semanticVersion,
      };
      const evidence = buildEvidenceItem({ kind: "semantic_search", title: `血缘:${metric.displayName ?? metricName}`, metricName, physicalTables: metric.physicalTables, lineage: lineageOf(ctx, metric), semanticVersion: ctx.semanticVersion });
      return { ok: true, text: JSON.stringify(lineage, null, 1), evidence: [evidence] };
    },

    async search_knowledge({ query }) {
      await audit(ctx, "tool_call", `知识库检索:${query}`);
      const hits = searchKnowledge(ctx.knowledge ?? [], query).map((h) => ({
        name: h.name, score: h.score, excerpt: h.excerpt, matchedHeadings: h.matchedHeadings,
      }));
      const evidence = buildEvidenceItem({ kind: "semantic_search", title: `知识库:${query}`, semanticVersion: ctx.semanticVersion });
      return {
        ok: true,
        text: JSON.stringify({ hits, hint: hits.length === 0 ? "知识库无命中;可用业务常识回答但需注明未经知识库背书" : "按相关性排序的业务知识摘录" }, null, 1),
        evidence: [evidence],
      };
    },

    async list_ontology({ subdomain: subFilter }) {
      await audit(ctx, "tool_call", `本体导航:${subFilter ?? "全部"}`);
      const ont = ctx.ontology;
      if (!ont || ont.classes.length === 0) {
        return {
          ok: false, text: "", evidence: [],
          error: "ontology.yaml 为空或未配置;请先在 semantics/ontology.yaml 定义业务域本体",
        };
      }
      const subs = subFilter ? ont.domain.subdomains.filter((s) => s.id === subFilter || s.name === subFilter) : ont.domain.subdomains;
      const result = subs.map((sub) => ({
        subdomain: sub.id,
        name: sub.name,
        status: sub.status,
        topics: sub.topics,
        classes: ont.classes.filter((c) => c.subdomain === sub.id).map((c) => ({
          id: c.id, name: c.name, topic: c.topic, key: c.key,
          properties: c.properties.map((p) => p.id),
          metrics: c.metrics ?? [],
          table: ctx.bindings?.datasets[c.id]?.table,
        })),
        actions: ont.actions.filter((a) => a.subdomain === sub.id).map((a) => ({
          id: a.id, name: a.name, subject: a.subject, metrics: a.metrics, dims: a.dims,
        })),
      }));
      const evidence = buildEvidenceItem({ kind: "semantic_search", title: `本体:${subFilter ?? "全部子域"}`, semanticVersion: ctx.semanticVersion });
      return {
        ok: true,
        text: JSON.stringify({ domain: ont.domain.id, version: ont.version, subdomains: result }, null, 1),
        evidence: [evidence],
      };
    },

    async read_playbook({ name }) {
      await audit(ctx, "tool_call", `读取 Playbook:${name}`);
      const pb = (ctx.playbooks ?? []).find((p) => p.name === name || p.name === `${name}.md`);
      if (!pb) {
        const names = (ctx.playbooks ?? []).map((p) => p.name);
        return { ok: false, text: "", evidence: [], error: `Playbook 不存在:${name};可用:${names.join(", ") || "(无)"}` };
      }
      const evidence = buildEvidenceItem({ kind: "semantic_search", title: `Playbook:${pb.name}`, semanticVersion: ctx.semanticVersion });
      return { ok: true, text: pb.content, evidence: [evidence] };
    },
  };
}

const ROUTE_HINTS: Record<string, string> = {
  query_metrics: "高置信指标命中:调用 query_metrics(优先)或 query_dataset(drilldown)获取口径一致数据",
  query_dataset: "数据集/物理表命中:调用 query_dataset(explore 模式,结构化参数)",
  clarify: "证据不足:必须调用 clarify 向用户提问,不得猜测口径",
  reject: "拒绝回答并说明原因",
};
