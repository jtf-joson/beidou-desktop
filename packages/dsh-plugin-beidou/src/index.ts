/**
 * 北斗work dsh 插件入口(Phase 1:空壳验证)。
 * V1 验收:插件装载、beidou_ping 工具出现在目录、无 loader 报错。
 * Phase 3/4 在此注册全部 8+2 个工具(见 docs/plans/poc-dsh-plugin-v2.md)。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "beidou-work";
export const inject = ["tools"];

export function apply(ctx: Context) {
  console.log("[beidou-work] plugin loaded (phase-1 shell)");

  ctx.tools.register(
    defineTool({
      name: "beidou_ping",
      description:
        "北斗work 连通性探测:返回插件版本与工作区路径摘要。任何北斗工具调用前可用它确认插件在位。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pong: { type: "boolean", required: true },
            version: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args) {
        return { pong: true, version: "0.1.0 (phase-1)" };
      },
    }),
  );
}
