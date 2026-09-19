/**
 * 8 个业务工具注册(dsh defineTool)。
 * 参数语义照抄 apps/desktop/src/main/agent/sdk-runner.ts;schema 遵守 dsh DSL(全必填/additionalProperties 显式)。
 * 可选参数 → required: false(dsh DSL 允许 required: false 但必须显式声明)。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createTools, type ToolContext, type ToolSet } from "@beidou-core/tools/tools";
import { TOOL_OUTPUT_SCHEMA, renderToolResponse, toToolValue } from "./adapter";

type ParamSpec = Record<string, { type: "string" | "number" | "boolean" | "array" | "object"; required: boolean; description?: string }>;

function toolDef(
  name: string,
  description: string,
  parameters: ParamSpec,
  handler: (args: Record<string, never>) => Promise<{ ok: boolean; text: string; error?: string }>,
) {
  // dsh-tools 的 ParameterSchemaSpec 过窄(要求字面量类型联合),此处运行时形状正确,用类型断言通过编译
  return defineTool({
    name,
    description,
    parameters,
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResponse },
    async execute(args: Record<string, never>) {
      return toToolValue(await handler(args));
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as ReturnType<typeof defineTool>;
}

export function registerBusinessTools(ctx: Context, toolCtx: ToolContext): void {
  const tools: ToolSet = createTools(toolCtx);

  // 1. search_semantics
  ctx.tools.register(toolDef(
    "search_semantics",
    "语义检索:在指标/数据集/术语/本体/物理表中查找候选,返回路由建议。回答任何数据问题前必须先调用。",
    {
      query: { type: "string", required: true, description: "用户问题或关键词" },
      limit: { type: "number", required: false, description: "返回候选数上限(默认 8)" },
    },
    async (args) => tools.search_semantics({ query: args.query as never, limit: args.limit as never }),
  ));

  // 2. query_metrics
  ctx.tools.register(toolDef(
    "query_metrics",
    "查指标:按口径一致的编译 SQL 计算指标值(时间范围与维度可选)。",
    {
      metricName: { type: "string", required: true, description: "指标英文名(来自检索)" },
      dims: { type: "array", required: false, description: "分组维度列表" },
    },
    async (args) => tools.query_metrics({ metricName: args.metricName as never, dims: (args.dims ?? []) as never }),
  ));

  // 3. query_dataset
  ctx.tools.register(toolDef(
    "query_dataset",
    "数据集查询。mode=drilldown 口径一致下钻;mode=explore 受控明细分析。",
    {
      mode: { type: "string", required: true, description: "drilldown 或 explore" },
      metricName: { type: "string", required: false, description: "drilldown:指标名" },
      table: { type: "string", required: false, description: "explore:物理表全名" },
      selectColumns: { type: "array", required: false, description: "explore:选择的列" },
      limit: { type: "number", required: false, description: "explore:行数上限" },
    },
    async (args) => tools.query_dataset(args as never),
  ));

  // 4. clarify
  ctx.tools.register(toolDef(
    "clarify",
    "证据不足时向用户提出澄清问题(时间/口径/维度),不得猜测。",
    {
      questions: { type: "array", required: true, description: "澄清问题列表" },
    },
    async (args) => tools.clarify({ questions: args.questions as never }),
  ));

  // 5. diagnose_metric
  ctx.tools.register(toolDef(
    "diagnose_metric",
    "智能诊断与归因:两期总量对比、异常检测、维度贡献拆解(Top 贡献者),返回结构化结果。",
    {
      metricName: { type: "string", required: true, description: "指标名" },
    },
    async (args) => tools.diagnose_metric({ metricName: args.metricName as never }),
  ));

  // 6. search_knowledge
  ctx.tools.register(toolDef(
    "search_knowledge",
    "检索空间业务知识库(业务背景/口径解释/既往结论)。",
    {
      query: { type: "string", required: true, description: "检索关键词" },
    },
    async (args) => tools.search_knowledge({ query: args.query as never }),
  ));

  // 7. read_playbook
  ctx.tools.register(toolDef(
    "read_playbook",
    "读取空间业务 Playbook(分析 SOP)。",
    {
      name: { type: "string", required: true, description: "Playbook 名称(不带 .md)" },
    },
    async (args) => tools.read_playbook({ name: args.name as never }),
  ));

  // 8. list_ontology
  ctx.tools.register(toolDef(
    "list_ontology",
    "本体导航:按子域列出 class(属性/指标/表指针)、action(诊断入口)结构。",
    {
      subdomain: { type: "string", required: false, description: "子域 ID(如 store-ops);不传返回全部" },
    },
    async (args) => tools.list_ontology({ subdomain: (args.subdomain ?? undefined) as never }),
  ));
}
