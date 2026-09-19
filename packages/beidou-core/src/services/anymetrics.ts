/**
 * AnyMetrics(北斗指标平台)客户端(SPEC Q2.9)。
 * 端点契约来自 ~/beidou-metrics-export/scripts/fetch_metrics.py 的实测;在线数值查询契约待联调校正(SPEC Q5.2)。
 * 依赖注入 fetch 与 delay,便于测试与 Electron 主进程复用。
 */
import { err, ok, type Result } from "../types";

export interface AnyMetricsConfig {
  baseUrl: string;
  tenantId: string;
  authValue: string;
  authType?: string;
  timeoutMs?: number;
}

export interface AnyMetricsDeps {
  fetchFn: typeof fetch;
  /** 重试退避(测试注入 no-op) */
  delayFn?: (ms: number) => Promise<void>;
}

interface Envelope<T> {
  code?: number | string | null;
  errorMsg?: string;
  message?: string;
  data?: T;
}

const RETRIES = 3;

export interface AnyMetricsClient {
  listMetrics(p: { page: number; pageSize?: number }): Promise<Result<{
    metrics: Array<Record<string, unknown>>;
    total: number;
    hasNext: boolean;
  }>>;
  metricTree(): Promise<Result<unknown>>;
  metricDetail(names: string[]): Promise<Result<Array<Record<string, unknown>>>>;
  dimensions(names: string[]): Promise<Result<Record<string, Array<Record<string, unknown>>>>>;
}

export function createAnyMetricsClient(config: AnyMetricsConfig, deps: AnyMetricsDeps): AnyMetricsClient {
  const delay = deps.delayFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = config.baseUrl.replace(/\/+$/, "");

  const get = async <T>(path: string, params: Array<[string, string]> = []): Promise<Result<T>> => {
    const qs = new URLSearchParams(params).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      "tenant-id": config.tenantId,
      "auth-type": config.authType ?? "UID",
      "auth-value": config.authValue,
      Accept: "application/json",
    };
    let lastErr = "unknown";
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);
        const resp = await deps.fetchFn(url, { method: "GET", headers, signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) {
          lastErr = `HTTP ${resp.status}`;
          if (attempt < RETRIES && resp.status >= 500) {
            await delay(200 * Math.pow(1.5, attempt - 1));
            continue;
          }
          return err("ANYMETRICS_HTTP", `请求失败 ${path}:${lastErr}`);
        }
        const env = (await resp.json()) as Envelope<T>;
        const codeOk = env.code === 200 || env.code === null || env.code === undefined;
        if (!codeOk) {
          return err("ANYMETRICS_BIZ", env.errorMsg ?? env.message ?? `业务错误 code=${env.code}`);
        }
        return ok((env.data ?? ({} as T)));
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (attempt < RETRIES) {
          await delay(200 * Math.pow(1.5, attempt - 1));
          continue;
        }
      }
    }
    return err("ANYMETRICS_NETWORK", `网络错误:${lastErr}`);
  };

  return {
    async listMetrics({ page, pageSize = 200 }) {
      const r = await get<{ data?: Array<Record<string, unknown>>; total?: number; hasNext?: boolean }>(
        "/anymetrics/api/v1/metrics/list",
        [
          ["pageNumber", String(page)],
          ["pageSize", String(pageSize)],
          ["isIncludeStatisticalData", "false"],
        ],
      );
      if (!r.ok) return r;
      return ok({
        metrics: r.value.data ?? [],
        total: r.value.total ?? 0,
        hasNext: r.value.hasNext ?? false,
      });
    },
    metricTree() {
      return get<unknown>("/anymetrics/api/v1/metrics/treeList");
    },
    async metricDetail(names) {
      if (names.length === 0) return ok([]);
      if (names.length > 50) return err("ANYMETRICS_BATCH", "batchDetail 每批最多 50 个指标");
      return get<Array<Record<string, unknown>>>("/anymetrics/api/v1/metrics/batchDetail", [
        ...names.map((n) => ["metricNames", n] as [string, string]),
      ]);
    },
    async dimensions(names) {
      if (names.length === 0) return ok({});
      if (names.length > 50) return err("ANYMETRICS_BATCH", "dimensionAll 每批最多 50 个指标");
      return get<Record<string, Array<Record<string, unknown>>>>("/anymetrics/api/v1/metrics/dimensionAll", [
        ...names.map((n) => ["metricNames", n] as [string, string]),
      ]);
    },
  };
}
