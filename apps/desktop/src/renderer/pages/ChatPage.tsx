import React, { useEffect, useRef, useState } from "react";
import { Alert, Spin } from "antd";

type Rect = { x: number; y: number; width: number; height: number };

function rectOf(el: HTMLElement | null): Rect {
  const r = el?.getBoundingClientRect();
  return {
    x: Math.round(r?.left ?? 0),
    y: Math.round(r?.top ?? 0),
    width: Math.round(r?.width ?? 0),
    height: Math.round(r?.height ?? 0),
  };
}

/**
 * 智能分析助手:内嵌 DSH Web(唯一 Agent Runtime,Claude Agent SDK 已移除)。
 * 渲染层只提供占位容器并经 ResizeObserver 上报矩形;主进程用 WebContentsView
 * 承载(非 iframe/webview——审核口径:主进程控制导航/生命周期/安全)。
 */
export default function ChatPage({ theme, modelConfigured, onGoSettings }: { theme?: boolean; modelConfigured?: boolean; onGoSettings?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"starting" | "ready" | "error">("starting");
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0); // 空间切换/运行时崩溃 → 重新 attach

  // 主进程通知:DSH 已停止(空间切换/配置变更/崩溃)→ 重新拉起并重建内嵌
  useEffect(() => {
    const off = window.daw.onDshRestart((payload) => {
      setState("starting");
      setError(payload.crashed ? "DSH 运行时异常退出,正在重启…" : "");
      setNonce((n) => n + 1);
    });
    return off;
  }, []);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void (async () => {
      try {
        const r = await window.daw.dshAttach(rectOf(hostRef.current));
        if (disposed) return;
        if (!r.ok) {
          setError(r.error ?? "DSH 启动失败");
          setState("error");
          return;
        }
        setState("ready");
        // 容器尺寸/位置变化(窗口缩放、布局变化)实时同步给主进程的 WebContentsView
        ro = new ResizeObserver(() => void window.daw.dshBounds(rectOf(hostRef.current)));
        ro.observe(hostRef.current!);
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          setState("error");
        }
      }
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      void window.daw.dshHide();
    };
  }, [nonce]);

  void theme;

  return (
    <div className="daw-conv-col" style={{ position: "relative" }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      {state !== "ready" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
          {state === "starting" && (<>
            <Spin />
            <span style={{ fontSize: 12, color: "var(--daw-sub, #888)" }}>正在启动 DeepSeek Harness(beidou-web)…</span>
          </>)}
          {state === "error" && (
            <Alert
              type="error"
              showIcon
              style={{ maxWidth: 560 }}
              message="DSH 运行时启动失败"
              description={<>{error}{modelConfigured === false ? <div style={{ marginTop: 8 }}>模型 API Key 未配置——<a onClick={onGoSettings}>前往 设置 → 模型 配置</a></div> : null}</>}
            />
          )}
        </div>
      )}
    </div>
  );
}
