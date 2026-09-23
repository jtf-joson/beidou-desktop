/**
 * 8 个业务工具注册(dsh defineTool)。P1-3:输出单轨 BeidouToolResult。
 * 参数语义照抄 apps/desktop/src/main/agent/sdk-runner.ts;schema 遵守 dsh DSL(全必填/additionalProperties 显式)。
 * 可选参数 → required: false(dsh DSL 允许 required: false 但必须显式声明)。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createTools, type ToolContext, type ToolSet } from "@beidou/core/src/tools/tools.ts";
import { BEIDOU_RESULT_SCHEMA, toToolValue, type BeidouToolValue } from "./schemas";
import { toBeidouResult, newTraceId, type CoreToolResponse } from "./adapter";
import { decideToolAccess } from "./policy";
import { createTelemetrySink, withTelemetry } from "./telemetry";
import type { GetIdentity, PluginIdentity } from "./identity-provider";

type ParamSpec = Record<string, { type: "string" | "number" | "boolean" | "array" | "object"; required: boolean; description?: string; additionalProperties?: boolean }>;
type TelemetrySink = ReturnType<typeof createTelemetrySink>;

/**
 * 单轨包装(P0-01:身份动态化)。每次调用现取身份:
 * 优先 getIdentity()(现读 token 缓存,登录后无需重启即生效);
 * 未提供时回退启动快照。链路:身份 → 策略 → 遥测 → core → BeidouToolResult。
 */
export async function wrapTool(opts: {
  name: string;
  args: Record<string, never>;
  handler: (args: Record<string, never>) => Promise<CoreToolResponse>;
  telemetry: TelemetrySink;
  sessionId: string;
  /** 启动时身份快照(未提供动态提供者时的兜底) */
  identity?: PluginIdentity;
  /** 动态身份提供者:提供时快照被忽略 */
  getIdentity?: GetIdentity;
  /** 工作区已配置的企业只读服务凭据(当前用于 AnyMetrics 指标链路) */
  serviceAuth?: boolean;
}): Promise<BeidouToolValue> {
  const traceId = newTraceId();
  const identity = opts.getIdentity ? await opts.getIdentity() : opts.identity;
  const policy = decideToolAccess({ tool: opts.name, identity: identity ?? undefined, serviceAuth: opts.serviceAuth });
  const userId = identity?.username ?? "anonymous";
  const inputSummary = JSON.stringify(opts.args).slice(0, 200);
  if (policy.decision === "deny") {
    await opts.telemetry.append({
      timestamp: new Date().toISOString(), traceId, sessionId: opts.sessionId, userId,
      tool: opts.name, inputSummary, policyDecision: "deny", resultCode: policy.code ?? "FORBIDDEN",
    });
    return toToolValue({ ok: false, code: policy.code ?? "FORBIDDEN", message: policy.reason ?? "denied", warnings: [], evidence: [], traceId });
  }
  return withTelemetry(
    opts.telemetry,
    { traceId, sessionId: opts.sessionId, tool: opts.name, inputSummary, userId, policyDecision: "allow" },
    async () => toToolValue(toBeidouResult(await opts.handler(opts.args), { tool: opts.name, traceId })),
  );
}

export function registerBusinessTools(ctx: Context, toolCtx: ToolContext, getIdentity?: GetIdentity): void {
  const tools: ToolSet = createTools(toolCtx);
  const telemetry: TelemetrySink = createTelemetrySink({ sessionId: toolCtx.sessionId, audit: toolCtx.audit });
  const fallbackIdentity: PluginIdentity | undefined = toolCtx.identity
    ? { username: toolCtx.identity.username, source: toolCtx.identity.source }
    : undefined;

  const def = (name: string, description: string, parameters: ParamSpec, handler: (args: Record<string, never>) => Promise<CoreToolResponse>) => {
    // dsh-tools 的 ParameterSchemaSpec 过窄(要求字面量类型联合),此处运行时形状正确,用类型断言通过编译
    return defineTool({
      name,
      description,
      parameters,
      output: {
        schema: BEIDOU_RESULT_SCHEMA,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        render: ((_args: Record<string, unknown>, value: any) => {
          if (!value?.ok) return [{ type: "text" as const, text: JSON.stringify({ code: value?.code, message: value?.message, traceId: value?.traceId }) }];
          const warn = value.warnings?.length ? `\n\n⚠️ ${value.warnings.join(";")}` : "";
          return [{ type: "text" as const, text: `${value.message}${warn}` }];
        }) as any,
      },
      async execute(args: Record<string, never>) {
      return wrapTool({ name, args, handler, telemetry, sessionId: toolCtx.sessionId, identity: fallbackIdentity, getIdentity, serviceAuth: toolCtx.metricOnline });
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  };

  // 1. search_semantics
  ctx.tools.register(def(
    "search_semantics",
    "语义检索:在指标/数据集/术语/本体/物理表中查找候选,返回路由建议。回答任何数据问题前必须先调用。",
    {
      query: { type: "string", required: true, description: "用户问题或关键词" },
      limit: { type: "number", required: true, description: "返回候选数上限;不关心则传 0" },
    },
    async (args) => tools.search_semantics({ query: args.query as never, limit: (args.limit === 0 ? undefined : args.limit) as never }),
  ));

  // 2. query_metrics
  ctx.tools.register(def(
    "query_metrics",
    "查指标:按口径一致的编译 SQL 计算指标值(时间范围与维度可选)。",
    {
      metricName: { type: "string", required: true, description: "指标英文名(来自检索)" },
      dims: { type: "array", required: true, description: "分组维度列表;不需要分组传 []" },
      timeRange: { type: "object", required: true, description: "时间范围 {start, end};不限传 {}", additionalProperties: true },
    },
    async (args) => tools.query_metrics({ metricName: args.metricName as never, dims: args.dims as never, timeRange: (args.timeRange && Object.keys(args.timeRange as never).length > 0 ? args.timeRange : undefined) as never }),
  ));

  // 3. query_dataset
  ctx.tools.register(def(
    "query_dataset",
    "数据集查询。mode=drilldown 口径一致下钻;mode=explore 受控明细分析。",
    {
      mode: { type: "string", required: true, description: "drilldown 或 explore" },
      metricName: { type: "string", required: true, description: "drilldown:指标名;explore 传空串" },
      dims: { type: "array", required: true, description: "drilldown:分组维度;无则传 []" },
      timeRange: { type: "object", required: true, description: "drilldown:时间范围;无则传 {}", additionalProperties: true },
      table: { type: "string", required: true, description: "explore:物理表全名;drilldown 传空串" },
      selectColumns: { type: "array", required: true, description: "explore:选择的列;无则传 []" },
      aggregates: { type: "array", required: true, description: "explore:聚合定义;无则传 []" },
      where: { type: "array", required: true, description: "explore:过滤条件;无则传 []" },
      groupBy: { type: "array", required: true, description: "explore:分组列;无则传 []" },
      orderBy: { type: "object", required: true, description: "explore:排序;无则传 {}", additionalProperties: true },
      limit: { type: "number", required: true, description: "explore:行数上限;默认传 200" },
    },
    async (args) => tools.query_dataset(args as never),
  ));

  // 4. clarify
  ctx.tools.register(def(
    "clarify",
    "证据不足时向用户提出澄清问题(时间/口径/维度),不得猜测。",
    {
      questions: { type: "array", required: true, description: "澄清问题列表" },
    },
    async (args) => tools.clarify({ questions: args.questions as never }),
  ));

  // 5. diagnose_metric
  ctx.tools.register(def(
    "diagnose_metric",
    "智能诊断与归因:两期总量对比、异常检测、维度贡献拆解(Top 贡献者),返回结构化结果。",
    {
      metricName: { type: "string", required: true, description: "指标名" },
      timeRange: { type: "object", required: true, description: "时间范围 {start, end};不限传 {}", additionalProperties: true },
      dims: { type: "array", required: true, description: "归因维度列表;用指标默认则传 []" },
      thresholdPct: { type: "number", required: true, description: "异常阈值百分比;用默认 10 则传 0" },
    },
    async (args) => tools.diagnose_metric({ metricName: args.metricName as never, timeRange: (args.timeRange && Object.keys(args.timeRange as never).length > 0 ? args.timeRange : undefined) as never, dims: (Array.isArray(args.dims) && (args.dims as unknown[]).length > 0 ? args.dims : undefined) as never, thresholdPct: (args.thresholdPct === 0 ? undefined : args.thresholdPct) as never }),
  ));

  // 6. search_knowledge
  ctx.tools.register(def(
    "trace_lineage",
    "追踪指标血缘:返回指标口径、数据集、物理表、字段、维度绑定及关联 Playbook/知识资产。",
    { metricName: { type: "string", required: true, description: "指标名(来自检索)" } },
    async (args) => tools.trace_lineage({ metricName: args.metricName as never }),
  ));

  // 7. search_knowledge
  ctx.tools.register(def(
    "search_knowledge",
    "检索空间业务知识库(业务背景/口径解释/既往结论)。",
    {
      query: { type: "string", required: true, description: "检索关键词" },
    },
    async (args) => tools.search_knowledge({ query: args.query as never }),
  ));

  // 7. read_playbook
  ctx.tools.register(def(
    "read_playbook",
    "读取空间业务 Playbook(分析 SOP)。",
    {
      name: { type: "string", required: true, description: "Playbook 名称(不带 .md)" },
    },
    async (args) => tools.read_playbook({ name: args.name as never }),
  ));

  // 9. list_ontology
  ctx.tools.register(def(
    "list_ontology",
    "本体导航:按子域列出 class(属性/指标/表指针)、action(诊断入口)结构。",
    {
      subdomain: { type: "string", required: true, description: "子域 ID(如 store-ops);返回全部传空串" },
    },
    async (args) => tools.list_ontology({ subdomain: (args.subdomain === '' ? undefined : args.subdomain) as never }),
  ));
}
