/**
 * AgentService:会话编排(可单测,electron 依赖为零)。
 * 两种策略:
 *  - sdk:Claude Agent SDK + DeepSeek Anthropic 端点(主力,SPEC Q2.2)
 *  - mock:无模型 key 时的确定性管线(检索→路由→工具→回答),保证可运行与 e2e 冒烟
 */
import { createTools, type ToolContext, type ToolResponse } from "@beidou/core/src/tools/tools";
import { buildSystemPrompt } from "@beidou/core/src/router/prompt";
import type { EvidenceItem, SearchHit } from "@beidou/core/src/types";
import type { LoadedWorkspace } from "../workspace";
import type { SrQueryResult } from "@beidou/core/src/services/starrocks";

export type AgentEvent =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "evidence"; items: EvidenceItem[] }
  | { type: "done"; reason?: string }
  | { type: "error"; message: string };

export interface AgentDeps {
  /** StarRocks 执行(真实实现用 mysql2;测试注入 fake) */
  starrocksQuery: (sql: string) => Promise<{ ok: true; value: SrQueryResult } | { ok: false; error: { code: string; message: string } }>;
  /** 在线指标查询(可选) */
  queryMetricsOnline?: ToolContext["queryMetricsOnline"];
  /** 真实策略执行器(由 index.ts 注入 Agent SDK 封装;测试/离线不注入 → mock 策略) */
  runSdkAgent?: (input: {
    systemPrompt: string;
    userMessage: string;
    env: Record<string, string>;
    toolSet: ToolSetLike;
    onEvent: (e: AgentEvent) => void;
  }) => Promise<string>;
  now?: () => string;
  /** 数据源模式(mock 时工具层标注演示数据) */
  dataSource?: "mock" | "real";
  /** 工具层审计 sink(P0-7:注入真实落盘,替代 no-op) */
  auditSink?: { append(e: unknown): Promise<void> };
  /** 当前身份(P0-5:贯穿业务工具) */
  identity?: { username: string; source: "idaas-token" | "ept-session" | "none" };
}

export class AgentService {
  private readonly evidenceBySession = new Map<string, EvidenceItem[]>();

  constructor(
    private readonly workspace: LoadedWorkspace,
    private readonly deps: AgentDeps,
  ) {}

  get useSdk(): boolean {
    return this.deps.runSdkAgent !== undefined;
  }

  private buildToolContext(sessionId: string): ToolContext {
    const w = this.workspace;
    const guard = w.config.guard ?? {};
    return {
      store: w.store,
      assets: w.assets,
      routerConfig: { metricScoreThreshold: 50 },
      guardPolicy: {
        allowedTables: w.store.allPhysicalTables(),
        maxRow: guard.max_row ?? 200,
        sensitiveColumns: guard.sensitive_columns ?? [],
      },
      metricOnline: false, // MVP:指标数值统一走口径编译;在线契约联调后打开
      queryMetricsOnline: this.deps.queryMetricsOnline,
      starrocksQuery: this.deps.starrocksQuery,
      audit: this.deps.auditSink ?? {
        append: async (e) => {
          console.warn("[audit] no sink injected, event dropped:", e.kind, e.summary);
        },
      },
      sessionId,
      semanticVersion: w.semanticVersion,
      metricsByCode: w.metricsByCode,
      knowledge: w.knowledge,
      playbooks: w.playbooks,
      entities: w.entities,
      ontology: w.ontology,
      bindings: w.bindings,
      dataSource: this.deps.dataSource,
      identity: this.deps.identity,
      now: this.deps.now,
    };
  }

  collectEvidence(sessionId: string, items: EvidenceItem[]): void {
    const list = this.evidenceBySession.get(sessionId) ?? [];
    list.push(...items);
    this.evidenceBySession.set(sessionId, list);
  }

  evidenceOf(sessionId: string): EvidenceItem[] {
    return this.evidenceBySession.get(sessionId) ?? [];
  }

  async ask(sessionId: string, userMessage: string, onEvent: (e: AgentEvent) => void): Promise<void> {
    const ctx = this.buildToolContext(sessionId);
    const tools = createTools(ctx);
    // 工具结果旁路收集证据
    const wrapped = wrapTools(tools, (resp) => {
      if (resp.evidence.length > 0) this.collectEvidence(sessionId, resp.evidence);
    });

    onEvent({ type: "user", text: userMessage });

    if (this.deps.runSdkAgent) {
      const w = this.workspace;
      const env: Record<string, string> = {};
      const token = w.config.model?.auth_token ?? (w.config.model?.auth_token_env ? process.env[w.config.model.auth_token_env] : undefined);
      if (token) env.ANTHROPIC_AUTH_TOKEN = token;
      if (w.config.model?.base_url) env.ANTHROPIC_BASE_URL = w.config.model.base_url;
      if (w.config.model?.model) env.ANTHROPIC_MODEL = w.config.model.model;
      const finalText = await this.deps.runSdkAgent({
        systemPrompt: buildSystemPrompt({
          metricOnline: false,
          workspaceName: w.name,
          knowledgeNames: w.knowledge.map((k) => k.name),
          playbookNames: w.playbooks.map((p) => p.name),
        }),
        userMessage,
        env,
        toolSet: wrapped,
        onEvent,
      });
      onEvent({ type: "assistant", text: finalText });
      onEvent({ type: "evidence", items: this.evidenceOf(sessionId) });
      onEvent({ type: "done" });
      return;
    }

    // ---- mock 策略:确定性管线 ----
    // 注:不发空 assistant 占位事件——tool_call 的 ensureAssistant 自会建气泡;
    // 空占位块一旦在落盘/回放中乱序到下一轮,会把上一轮正文清空成永久 Spin。
    const answer = await runMockPipeline(wrapped, userMessage, onEvent);
    onEvent({ type: "assistant", text: answer });
    onEvent({ type: "evidence", items: this.evidenceOf(sessionId) });
    onEvent({ type: "done" });
  }
}

type ToolSetLike = ReturnType<typeof createTools>;

function wrapTools(tools: ToolSetLike, after: (resp: ToolResponse) => void): ToolSetLike {
  const wrap = <K extends keyof ToolSetLike>(name: K) => {
    const fn = tools[name] as (input: never) => Promise<ToolResponse>;
    return async (input: never): Promise<ToolResponse> => {
      const resp = await fn(input);
      after(resp);
      return resp;
    };
  };
  return {
    search_semantics: wrap("search_semantics"),
    query_metrics: wrap("query_metrics"),
    query_dataset: wrap("query_dataset"),
    clarify: wrap("clarify"),
    diagnose_metric: wrap("diagnose_metric"),
    search_knowledge: wrap("search_knowledge"),
    read_playbook: wrap("read_playbook"),
    list_ontology: wrap("list_ontology"),
  };
}

/** mock:检索 → 路由 → 执行 → 模板化回答(与 system prompt 协议同构) */
async function runMockPipeline(tools: ToolSetLike, userMessage: string, onEvent: (e: AgentEvent) => void): Promise<string> {
  onEvent({ type: "tool", name: "search_semantics", input: { query: userMessage } });
  const search = await tools.search_semantics({ query: userMessage });
  onEvent({ type: "tool_result", name: "search_semantics", ok: search.ok, summary: search.ok ? "检索完成" : (search.error ?? "失败") });
  if (!search.ok) return `检索失败:${search.error}`;

  const route = search.route?.route ?? "clarify";
  if (route === "query_metrics" || route === "query_dataset") {
    const primary = search.route?.primaryHit;
    if (primary?.kind === "metric") {
      onEvent({ type: "tool", name: "query_metrics", input: { metricName: primary.id } });
      const q = await tools.query_metrics({ metricName: primary.id });
      onEvent({ type: "tool_result", name: "query_metrics", ok: q.ok, summary: q.ok ? "查询完成" : (q.error ?? "失败") });
      if (q.ok) {
        const rowsText = extractRowsSummary(q.text);
        return [
          `**${primary.displayName ?? primary.name}** 的查询结果:`,
          "",
          rowsText,
          "",
          `口径:${q.evidence[0]?.caliber ?? "见证据面板"}`,
          q.evidence[0]?.truncated ? "(结果超过行数上限,已截断——可缩小时间范围或维度)" : "",
          "",
          "_(演示模式:未配置模型 key,回答由确定性管线生成;配置 DeepSeek key 后由 LLM 驱动。)_",
        ]
          .filter((x) => x !== "")
          .join("\n");
      }
      return `查询失败:${q.error}\n\n_(演示模式)_`;
    }
    if (primary?.kind === "dataset") {
      const tables = primary.physicalTables ?? [];
      if (tables.length > 0) {
        const cols = "dt";
        onEvent({ type: "tool", name: "query_dataset", input: { mode: "explore", table: tables[0], selectColumns: [cols], limit: 20 } });
        const q = await tools.query_dataset({ mode: "explore", table: tables[0]!, selectColumns: [cols], limit: 20 });
        onEvent({ type: "tool_result", name: "query_dataset", ok: q.ok, summary: q.ok ? "查询完成" : (q.error ?? "失败") });
        if (q.ok) return `数据集「${primary.displayName ?? primary.name}」抽样(前 20 行,dt 列):\n\n${extractRowsSummary(q.text)}\n\n_(演示模式:明细分析请配置模型后由 LLM 编排。)_`;
        return `明细查询失败:${q.error}`;
      }
    }
    return `命中「${primary?.displayName ?? "资产"}」但暂无可执行路径,请配置模型 key 以启用完整智能分析。_(演示模式)_`;
  }

  // clarify
  const questions = search.route?.clarifyQuestions ?? ["时间范围是什么?", "关注哪个口径?"];
  onEvent({ type: "tool", name: "clarify", input: { questions } });
  await tools.clarify({ questions });
  onEvent({ type: "tool_result", name: "clarify", ok: true, summary: "等待用户澄清" });
  return [
    "我还不能确定你要查询的内容,请补充:",
    ...questions.map((q) => `- ${q}`),
    "",
    `当前语义资产:${summarizeHits(search.text)}。_(演示模式)_`,
  ].join("\n");
}

function extractRowsSummary(toolText: string): string {
  try {
    const parsed = JSON.parse(toolText) as { rows?: Array<Record<string, unknown>>; columns?: string[] };
    if (!parsed.rows) return toolText.slice(0, 500);
    const cols = parsed.columns ?? Object.keys(parsed.rows[0] ?? {});
    const head = `| ${cols.join(" | ")} |`;
    const sep = `| ${cols.map(() => "---").join(" | ")} |`;
    const body = parsed.rows
      .slice(0, 20)
      .map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`)
      .join("\n");
    return [head, sep, body].join("\n");
  } catch {
    return toolText.slice(0, 500);
  }
}

function summarizeHits(toolText: string): string {
  try {
    const parsed = JSON.parse(toolText) as { hits?: SearchHit[] };
    const n = parsed.hits?.length ?? 0;
    return n === 0 ? "无命中" : `${n} 个候选`;
  } catch {
    return "未知";
  }
}
