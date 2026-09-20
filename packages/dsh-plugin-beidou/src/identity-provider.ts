/**
 * P0-01 修复:动态身份提供者。业务工具每次调用前现读 token 缓存并校验,
 * beidou_login 成功落盘后无需重启插件即可生效;身份不再在启动时快照。
 * 校验复用 core cachedToken(fail-closed:损坏/缺字段/临近过期都拒绝)。
 */
import type { IdaasAuth } from "@beidou-core/auth/idaas";

export interface PluginIdentity {
  username: string;
  source: string;
}

export type GetIdentity = () => Promise<PluginIdentity | null>;

export function createIdentityProvider(auth: IdaasAuth, openId: string): GetIdentity {
  return async () => {
    const r = await auth.cachedToken(openId);
    return r.ok ? { username: r.value.user_name ?? openId, source: "idaas-token" } : null;
  };
}
