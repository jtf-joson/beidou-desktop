/**
 * 身份工具 ×2(Phase 4):beidou_login / beidou_auth_status。
 * IDaaS 协议:登录链接 → 用户浏览器确认 → token 本地留存。
 * app_id = beidou-desktop(单用户 PoC,auth_mode: single-user-poc)。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createIdaasAuth } from "@beidou-core/auth/idaas";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { appendFile, readFile, writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const APP_ID = process.env.BEIDOU_IDAAS_APP_ID ?? "beidou-desktop";
const OPEN_ID = "owner";
const AUTH_DIR = join(homedir(), ".beidou", "auth");
const TOKEN_FILE = join(AUTH_DIR, "apps", APP_ID, "users", `${OPEN_ID}.json`);

const IDAAS_SCHEMA = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    ok: { type: "boolean" as const, required: true },
    message: { type: "string" as const, required: true },
  },
};

function renderAuth(_args: Record<string, unknown>, value: { ok: boolean; message: string }) {
  return [{ type: "text" as const, text: value.message }];
}

function buildAuth() {
  return createIdaasAuth(
    {
      serviceUrl: process.env.BEIDOU_IDAAS_URL ?? "https://idaas-auth-service.example.com",
      appId: APP_ID,
    },
    {
      fetchFn: fetch,
      writeFileAtomic: async (path, content) => {
        const abs = path.startsWith("auth/") ? join(homedir(), ".beidou", path) : path;
        await mkdir(dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp`;
        await writeFile(tmp, content, "utf-8");
        await rename(tmp, abs).catch(() => undefined);
        await chmod(abs, 0o600).catch(() => undefined);
      },
      readFile: async () => readFile(TOKEN_FILE, "utf-8"),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
    },
  );
}

export function registerIdentityTools(ctx: Context): void {
  // beidou_login:返回登录链接(用户浏览器确认),后台轮询
  ctx.tools.register(defineTool({
    name: "beidou_login",
    description: "北斗 IDaaS 登录:返回可点击的登录链接,用户在浏览器完成确认后 token 自动保存到本地。适合首次使用或 token 过期时调用。",
    parameters: {},
    output: { schema: IDAAS_SCHEMA, render: renderAuth },
    async execute() {
      try {
        const auth = buildAuth();
        const sessionR = await auth.createLoginSession({ openId: OPEN_ID, userName: OPEN_ID });
        if (!sessionR.ok) return { ok: false, message: `创建失败:${sessionR.error.message}` };
        return {
          ok: true,
          message: `🔐 请点击完成登录:[登录链接](${sessionR.value.loginUrl})\n\n登录完成后我会收到通知。如果浏览器没有自动打开,请手动复制链接到浏览器。`,
        };
      } catch (e) {
        return {
          ok: false,
          message: `登录会话创建失败:${e instanceof Error ? e.message : String(e)}。\n\n如果 app_id "${APP_ID}" 未在认证服务注册,请联系管理员或设置 BEIDOU_IDAAS_APP_ID 环境变量。`,
        };
      }
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as ReturnType<typeof defineTool>);

  // beidou_auth_status:查询 token 状态
  ctx.tools.register(defineTool({
    name: "beidou_auth_status",
    description: "检查北斗 IDaaS 登录状态:token 是否存在、是否过期、何时过期。",
    parameters: {},
    output: { schema: IDAAS_SCHEMA, render: renderAuth },
    async execute() {
      try {
        const auth = buildAuth();
        const r = await auth.cachedToken(OPEN_ID);
        if (r.ok) {
          return {
            ok: true,
            message: `✅ 已登录(app_id: ${APP_ID}, open_id: ${OPEN_ID})\n过期时间: ${r.value.expires_at ?? "未知"}\n用户: ${r.value.user_name ?? OPEN_ID}`,
          };
        }
        const reasonMap: Record<string, string> = {
          IDAAS_NO_CACHE: "未登录(token 缓存不存在)",
          IDAAS_TOKEN_EXPIRED: "已过期,请调用 beidou_login 重新登录",
          IDAAS_BAD_CACHE: "token 缓存损坏,请重新登录",
        };
        return {
          ok: false,
          message: `❌ ${reasonMap[r.error.code] ?? r.error.message}`,
        };
      } catch (e) {
        return { ok: false, message: `状态查询失败:${e instanceof Error ? e.message : String(e)}` };
      }
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as ReturnType<typeof defineTool>);
}
