/**
 * 身份工具 ×2(Phase 4):beidou_login / beidou_auth_status。
 * IDaaS 协议:登录链接 → 用户浏览器确认 → token 本地留存。
 * app_id = beidou-desktop(单用户 PoC,auth_mode: single-user-poc)。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createIdaasAuth, type IdaasAuth } from "@beidou-core/auth/idaas";
import type { ErrorCode } from "@beidou/contracts";
import { BEIDOU_RESULT_SCHEMA, toToolValue, type BeidouToolValue } from "./schemas";
import { renderBeidouResult, newTraceId } from "./adapter";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { appendFile, readFile, writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const APP_ID = process.env.BEIDOU_IDAAS_APP_ID ?? "beidou-desktop";
/** P0-02(审核七轮):openId 不再硬编码 owner——由产品壳注入 BEIDOU_OPEN_ID
 * (与 Electron 侧 currentOpenId() 同源,共用同一 token 文件;缺省回退 owner 仅限裸跑场景) */
export const OPEN_ID = process.env.BEIDOU_OPEN_ID ?? "owner";
const AUTH_DIR = join(homedir(), ".beidou", "auth");
const TOKEN_FILE = join(AUTH_DIR, "apps", APP_ID, "users", `${OPEN_ID}.json`);

/** IDaaS 内部错误码 → 契约错误码(P1-3 单轨:身份工具同样输出 BeidouToolResult) */
const CODE_MAP: Record<string, ErrorCode> = {
  IDAAS_NO_CACHE: "AUTH_REQUIRED",
  IDAAS_TOKEN_EXPIRED: "AUTH_EXPIRED",
  IDAAS_BAD_CACHE: "AUTH_REQUIRED",
};

/** 后台登录任务状态(P0-02:成功/失败必须落状态,供 beidou_auth_status 与日志一致读取) */
export interface LoginTaskState {
  status: "polling" | "success" | "failed";
  updatedAt: string;
  error?: string;
}
let loginTask: LoginTaskState | null = null;
export function getLoginTask(): LoginTaskState | null {
  return loginTask;
}

/** settle completeLogin 的 Result:ok:false 是常规失败(非异常),不得记为成功 */
export function settleLoginResult(r: { ok: true; value: unknown } | { ok: false; error: { message: string } }): void {
  loginTask = r.ok
    ? { status: "success", updatedAt: new Date().toISOString() }
    : { status: "failed", updatedAt: new Date().toISOString(), error: r.error.message };
}

export function buildIdaasAuth(): IdaasAuth {
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
        // P1-7: rename 失败必须抛错(不能静默吞掉,否则 token 未落盘但工具报成功)
        try {
          await rename(tmp, abs);
        } catch (e) {
          await import("node:fs/promises").then((fs) => fs.unlink(tmp).catch(() => undefined));
          throw new Error(`token 文件写入失败(rename): ${e instanceof Error ? e.message : String(e)}`);
        }
        await chmod(abs, 0o600).catch(() => undefined);
        // 写后校验:读回确认
        const check = await readFile(abs, "utf-8");
        if (!check.includes("authorization")) throw new Error("token 文件写入校验失败");
      },
      readFile: async () => readFile(TOKEN_FILE, "utf-8"),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
    },
  );
}

export function registerIdentityTools(ctx: Context, opts: { auth?: IdaasAuth } = {}): void {
  const auth = opts.auth ?? buildIdaasAuth();
  // beidou_login:返回登录链接(用户浏览器确认),后台轮询
  ctx.tools.register(defineTool({
    name: "beidou_login",
    description: "北斗 IDaaS 登录:返回可点击的登录链接,后台自动轮询登录状态并在成功后保存 token。适合首次使用或 token 过期时调用。",
    parameters: {},
    output: { schema: BEIDOU_RESULT_SCHEMA, render: renderBeidouResult },
    async execute(): Promise<BeidouToolValue> {
      const traceId = newTraceId();
      try {
        const sessionR = await auth.createLoginSession({ openId: OPEN_ID, userName: OPEN_ID });
        if (!sessionR.ok) return toToolValue({ ok: false, code: "INTERNAL_ERROR", message: `创建失败:${sessionR.error.message}`, warnings: [], evidence: [], traceId });
        const { loginUrl, sessionId } = sessionR.value;

        // P0-1: 后台轮询 completeLogin(不阻塞工具返回;token 自动保存)
        // P0-2 修复:completeLogin 返回 Result——ok:false(失败/超时/会话过期)不抛异常,
        // 必须显式分支记录,不得把 resolve 一律当成功。
        loginTask = { status: "polling", updatedAt: new Date().toISOString() };
        void auth.completeLogin({ sessionId, openId: OPEN_ID, poll: { intervalMs: 3000, maxAttempts: 100 } })
          .then((r) => {
            settleLoginResult(r);
            if (r.ok) console.log("[beidou-work] IDaaS login completed, token saved");
            else console.error("[beidou-work] IDaaS login failed:", r.error.code, r.error.message);
          })
          .catch((e) => {
            loginTask = { status: "failed", updatedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
            console.error("[beidou-work] IDaaS login error:", e);
          });

        return toToolValue({
          ok: true, code: "OK", traceId,
          message: `🔐 请点击完成登录:[登录链接](${loginUrl})\n\n后台正在轮询登录状态(最长 5 分钟)。登录完成后 token 会自动保存到本地,届时可调用 beidou_auth_status 确认。`,
        });
      } catch (e) {
        return toToolValue({
          ok: false, code: "INTERNAL_ERROR", traceId,
          message: `登录会话创建失败:${e instanceof Error ? e.message : String(e)}。\n\n如果 app_id "${APP_ID}" 未在认证服务注册,请联系管理员或设置 BEIDOU_IDAAS_APP_ID 环境变量。`,
          warnings: [], evidence: [],
        });
      }
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as ReturnType<typeof defineTool>);

  // beidou_auth_status:查询 token 状态
  ctx.tools.register(defineTool({
    name: "beidou_auth_status",
    description: "检查北斗 IDaaS 登录状态:token 是否存在、是否过期、何时过期,以及最近一次后台登录任务的结果。",
    parameters: {},
    output: { schema: BEIDOU_RESULT_SCHEMA, render: renderBeidouResult },
    async execute(): Promise<BeidouToolValue> {
      const traceId = newTraceId();
      try {
        const r = await auth.cachedToken(OPEN_ID);
        // P0-2:附最近登录任务状态,保证与登录日志口径一致
        const task = getLoginTask();
        const taskLine = task
          ? `\n最近登录任务:${task.status === "polling" ? "进行中(等待浏览器确认)" : task.status === "success" ? "成功" : `失败(${task.error ?? "未知原因"})`}`
          : "";
        if (r.ok) {
          return toToolValue({
            ok: true, code: "OK", traceId,
            message: `✅ 已登录(app_id: ${APP_ID}, open_id: ${OPEN_ID})\n过期时间: ${r.value.expires_at ?? "未知"}\n用户: ${r.value.user_name ?? OPEN_ID}${taskLine}`,
          });
        }
        const reasonMap: Record<string, string> = {
          IDAAS_NO_CACHE: "未登录(token 缓存不存在)",
          IDAAS_TOKEN_EXPIRED: "已过期,请调用 beidou_login 重新登录",
          IDAAS_BAD_CACHE: "token 缓存损坏,请重新登录",
        };
        return toToolValue({
          ok: false, code: CODE_MAP[r.error.code] ?? "INTERNAL_ERROR", traceId,
          message: `❌ ${reasonMap[r.error.code] ?? r.error.message}${taskLine}`,
          warnings: [], evidence: [],
        });
      } catch (e) {
        return toToolValue({ ok: false, code: "INTERNAL_ERROR", traceId, message: `状态查询失败:${e instanceof Error ? e.message : String(e)}`, warnings: [], evidence: [] });
      }
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as ReturnType<typeof defineTool>);
}
