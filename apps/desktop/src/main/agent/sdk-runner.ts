/**
 * Agent SDK 执行器(SPEC A5:SDK 只在此文件出现,版本升级只改这里)。
 * 把 core 的四个工具包装成进程内 MCP server,接管事件流转发。
 * 注:SDK 仅发行 ESM,主进程为 CJS 打包,故用动态 import。
 */
import type { AgentEvent } from "./service";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 打包态可执行文件定位:SDK 内置的 claude 是平台原生二进制(optionalDependency
 * @anthropic-ai/claude-agent-sdk-<platform>-<arch>,bun 编译)。打包后它位于 app.asar
 * 内,子进程无法执行(ENOENT)——electron-builder 已 asarUnpack 到
 * app.asar.unpacked/,此处显式把 pathToClaudeCodeExecutable 指向真实文件。
 * dev 态返回 undefined,走 SDK 默认解析。
 */
function resolveClaudeExecutable(): string | undefined {
  if (!process.resourcesPath) return undefined;
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates = [
    join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@anthropic-ai", pkg, "claude"),
    join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js"),
  ];
  return candidates.find((p) => existsSync(p));
}

type ToolSetLike = {
  search_semantics(input: { query: string; limit?: number }): Promise<{ ok: boolean; text: string; error?: string }>;
  query_metrics(input: { metricName: string; dims?: string[]; timeRange?: { start: string; end: string } }): Promise<{ ok: boolean; text: string; error?: string }>;
  query_dataset(input: Record<string, unknown>): Promise<{ ok: boolean; text: string; error?: string }>;
  clarify(input: { questions: string[] }): Promise<{ ok: boolean; text: string; error?: string }>;
  diagnose_metric(input: Record<string, unknown>): Promise<{ ok: boolean; text: string; error?: string }>;
  search_knowledge(input: { query: string }): Promise<{ ok: boolean; text: string; error?: string }>;
  read_playbook(input: { name: string }): Promise<{ ok: boolean; text: string; error?: string }>;
};

const asCallTool = (r: { ok: boolean; text: string; error?: string }) => ({
  content: [{ type: "text" as const, text: r.ok ? r.text : JSON.stringify({ error: r.error ?? "unknown" }) }],
  isError: !r.ok,
});

export async function runSdkAgent(input: {
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  env: Record<string, string>;
  toolSet: ToolSetLike;
  onEvent: (e: AgentEvent) => void;
}): Promise<string> {
  const [{ query, createSdkMcpServer, tool }, { z }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("zod"),
  ]);
  const t = input.toolSet;
  const server = createSdkMcpServer({
    name: "data-workbench",
    version: "0.1.0",
    alwaysLoad: true,
    timeout: 120_000,
    tools: [
      tool(
        "search_semantics",
        "语义检索:在指标/数据集/术语/物理表中查找候选,返回路由建议。回答任何数据问题前必须先调用。",
        { query: z.string().describe("用户问题或关键词"), limit: z.number().optional() },
        async (args) => asCallTool(await t.search_semantics({ query: args.query, limit: args.limit })),
      ),
      tool(
        "query_metrics",
        "查指标:按口径一致的编译 SQL 计算指标值(时间范围与维度可选)。",
        {
          metricName: z.string(),
          dims: z.array(z.string()).optional(),
          timeRange: z.object({ start: z.string(), end: z.string() }).optional(),
        },
        async (args) => asCallTool(await t.query_metrics(args)),
      ),
      tool(
        "query_dataset",
        "数据集查询:drilldown=口径一致下钻(metricName/dims/timeRange);explore=受控明细分析(table/selectColumns/aggregates/where/groupBy/limit)。",
        {
          mode: z.enum(["drilldown", "explore"]),
          metricName: z.string().optional(),
          dims: z.array(z.string()).optional(),
          timeRange: z.object({ start: z.string(), end: z.string() }).optional(),
          table: z.string().optional(),
          selectColumns: z.array(z.string()).optional(),
          aggregates: z.array(z.object({ func: z.string(), column: z.string(), alias: z.string() })).optional(),
          where: z.array(z.object({ column: z.string(), op: z.string(), value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]) })).optional(),
          groupBy: z.array(z.string()).optional(),
          orderBy: z.object({ column: z.string(), desc: z.boolean().optional() }).optional(),
          limit: z.number().optional(),
        },
        async (args) => asCallTool(await t.query_dataset(args as Record<string, unknown>)),
      ),
      tool(
        "diagnose_metric",
        "智能诊断与归因:两期总量对比、异常检测、维度贡献拆解(Top 贡献者),返回结构化结果供解读成诊断报告。",
        {
          metricName: z.string(),
          timeRange: z.object({ start: z.string(), end: z.string() }).optional(),
          dims: z.array(z.string()).optional(),
          thresholdPct: z.number().optional(),
        },
        async (args) => asCallTool(await t.diagnose_metric(args)),
      ),
      tool(
        "search_knowledge",
        "检索空间业务知识库(业务背景/口径解释/既往结论)。",
        { query: z.string() },
        async (args) => asCallTool(await t.search_knowledge(args)),
      ),
      tool(
        "read_playbook",
        "读取空间业务 Playbook(分析 SOP);name 来自知识检索或用户提及。",
        { name: z.string() },
        async (args) => asCallTool(await t.read_playbook(args)),
      ),
      tool(
        "clarify",
        "证据不足时向用户提出澄清问题(时间/口径/维度),不得猜测。",
        { questions: z.array(z.string()).min(1) },
        async (args) => asCallTool(await t.clarify({ questions: args.questions })),
      ),
    ],
  });

  const q = query({
    prompt: input.userMessage,
    options: {
      cwd: input.cwd,
      systemPrompt: input.systemPrompt,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      env: {
        // P0-4:allowlist 而非全量 process.env(防内网凭据泄漏到 Agent SDK)
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "",
        TERM: process.env.TERM ?? "",
        ...input.env,
      } as Record<string, string>,
      mcpServers: { "data-workbench": server },
      allowedTools: [
        "mcp__data-workbench__search_semantics", "mcp__data-workbench__query_metrics",
        "mcp__data-workbench__query_dataset", "mcp__data-workbench__clarify",
        "mcp__data-workbench__diagnose_metric", "mcp__data-workbench__search_knowledge",
        "mcp__data-workbench__read_playbook",
      ],
      maxTurns: 30,
      settingSources: [],
    },
  });

  let finalText = "";
  let lastAssistantText = "";
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) {
          lastAssistantText = block.text;
          input.onEvent({ type: "assistant", text: block.text });
        } else if (block.type === "tool_use") {
          input.onEvent({ type: "tool", name: block.name, input: block.input });
        }
      }
    } else if (msg.type === "user") {
      for (const block of msg.message.content) {
        if (typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_result") {
          const tr = block as { is_error?: boolean };
          input.onEvent({ type: "tool_result", name: "(tool)", ok: !tr.is_error, summary: tr.is_error ? "失败" : "完成" });
        }
      }
    } else if (msg.type === "result") {
      const rmsg = msg as { result?: unknown; subtype?: string; is_error?: boolean };
      if (rmsg.is_error || (rmsg.subtype ?? "").startsWith("error_")) {
        input.onEvent({ type: "error", message: `Agent 会话异常结束:${rmsg.subtype ?? "unknown"}` });
        finalText = ""; // 错误结果不伪装成回答
      } else {
        const r = rmsg.result;
        finalText = typeof r === "string" ? r : "";
      }
    }
  }
  return finalText || lastAssistantText;
}
