import { SessionStore } from "@beidou/core/src/session/store";
import { join } from "node:path";

/**
 * 按目录缓存的 SessionStore 工厂(审核六轮 P0-01)。
 * 串行写队列是 SessionStore 的实例字段——每次调用都 new 一个新实例的话,
 * 每个事件各拿一个空队列,appendFile 并发提交仍会在线程池乱序落盘,
 * core 层的串行修复在生产路径完全失效。故按目录缓存实例,目录变化
 * (切换工作空间)时才重建;registerIpc 早于 bootstrapSpaces 的时序由
 * 传入 getDir 闭包保持惰性求值。
 */
export function createCachedSessionStoreFactory(getDir: () => string): () => SessionStore {
  let cache: { dir: string; store: SessionStore } | null = null;
  return () => {
    const dir = getDir();
    if (!cache || cache.dir !== dir) {
      cache = { dir, store: new SessionStore(dir) };
    }
    return cache.store;
  };
}

/** 主进程默认工厂:会话目录跟随当前激活空间 */
export function createSessionStoreFactory(getWorkspaceDir: () => string | undefined, fallbackDir: string): () => SessionStore {
  return createCachedSessionStoreFactory(() => join(getWorkspaceDir() ?? fallbackDir, "sessions"));
}
