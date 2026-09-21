import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Collapse, Empty, Input, Spin, message } from "antd";
import { PlusOutlined, SendOutlined } from "@ant-design/icons";
import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * 智能分析助手:自研聊天窗口,经 DSH SDK 运行时(beidou-sdk profile,stdio
 * JSON-RPC)驱动 DeepSeek Harness——不再内嵌 DSH Web,无双导航(0.17.2)。
 * 事件流 = DSH session.event/session.status(原始帧),渲染层做轻量映射:
 * user/message→用户气泡;assistant/message→回复(text+reasoning);tool/call+result→轨迹。
 */

interface ToolStepState { callId: string; name: string; args: string; ok?: boolean; summary?: string }
interface Bubble {
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  tools: ToolStepState[];
}

type DshFrame = {
  kind: "session.event" | "session.status";
  sessionId?: string;
  status?: string;
  event?: { type: string; seq?: number; data?: Record<string, unknown> };
};

function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string);
}
function Md({ text }: { text: string }) {
  return <div className="daw-md" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />;
}

/** DSH 事件 → 气泡流(轻量折叠归并;tool 按 callId 配对) */
function eventsToBubbles(events: DshFrame[]): Bubble[] {
  const bubbles: Bubble[] = [];
  const ensureAssistant = (): Bubble => {
    if (bubbles.length === 0 || bubbles[bubbles.length - 1]!.role !== "assistant") {
      bubbles.push({ role: "assistant", text: "", tools: [] });
    }
    return bubbles[bubbles.length - 1]!;
  };
  for (const f of events) {
    if (f.kind !== "session.event" || !f.event) continue;
    const { type, data } = f.event;
    if (type === "user/message") {
      const source = (data as { source?: { kind?: string } }).source;
      if (source?.kind !== "user") continue; // runtime context 等内部消息不展示
      const content = (data as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      bubbles.push({ role: "user", text: content.map((c) => c.text ?? "").join(""), tools: [] });
    } else if (type === "assistant/message") {
      const msg = (data as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
      const content = msg?.content ?? [];
      const b = ensureAssistant();
      for (const c of content) {
        if (c.type === "text" && c.text?.trim()) b.text = c.text;
        else if (c.type === "reasoning" && c.text?.trim() && !b.reasoning) b.reasoning = c.text;
      }
    } else if (type === "tool/call") {
      const b = ensureAssistant();
      b.tools.push({
        callId: String((data as { callId?: string }).callId ?? ""),
        name: String((data as { name?: string }).name ?? "?"),
        args: String((data as { arguments?: string }).arguments ?? "{}").slice(0, 400),
      });
    } else if (type === "tool/result") {
      const msg = (data as { message?: { content?: Array<{ type: string; toolCallId?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> }> } }).message;
      const tr = msg?.content?.find((c) => c.type === "tool-result");
      if (!tr) continue;
      // 按 callId 配对到最后一个未完成步(工具轨迹准确性:原生 callId 关联)
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const step = bubbles[i]!.tools.find((t) => t.callId === tr.toolCallId && t.ok === undefined);
        if (step) {
          const textOut = (tr.content ?? []).map((c) => c.text ?? "").join("").slice(0, 200);
          step.ok = !tr.isError;
          step.summary = tr.isError ? `失败:${textOut || "工具错误"}` : textOut || "完成";
          break;
        }
      }
    }
  }
  return bubbles;
}

function Trajectory({ tools }: { tools: ToolStepState[] }) {
  if (tools.length === 0) return null;
  return (
    <Collapse
      size="small" ghost className="daw-traj"
      items={[{
        key: "t",
        label: <span className="daw-traj-label">🛠 工具轨迹({tools.length})</span>,
        children: tools.map((t, i) => (
          <div key={i} className="daw-traj-step">
            <span className={`daw-traj-dot ${t.ok === undefined ? "run" : t.ok ? "ok" : "fail"}`} />
            <span className="daw-traj-name">{t.name}</span>
            <span className="daw-traj-summary">{t.summary ?? "执行中…"}</span>
            <details className="daw-traj-input"><summary>入参</summary><pre>{t.args}</pre></details>
          </div>
        )),
      }]}
    />
  );
}

export default function ChatPage({ theme, modelConfigured, onGoSettings }: { theme?: boolean; modelConfigured?: boolean; onGoSettings?: () => void }) {
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; lastTs: string }>>([]);
  const [activeId, setActiveId] = useState("");
  const [events, setEvents] = useState<DshFrame[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef(""); // 同步镜像:事件到达可能早于 effect 重挂
  void theme;

  const bubbles = useMemo(() => eventsToBubbles(events), [events]);

  const refreshSessions = async () => {
    try { setSessions(await window.daw.dshSessions()); } catch { /* 忽略 */ }
  };

  useEffect(() => { void refreshSessions(); }, []);

  useEffect(() => {
    const off = window.daw.onDshEvent((raw) => {
      const f = raw as DshFrame;
      if (f.sessionId && f.sessionId !== activeIdRef.current) return; // 只显示当前会话
      if (f.kind === "session.event") setEvents((prev) => [...prev, f]);
      if (f.kind === "session.status" && f.status === "idle") {
        setBusy(false);
        void refreshSessions(); // 标题可能已更新
      }
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 60);
    });
    const offRestart = window.daw.onDshRestart((p) => {
      if (p.crashed) setRuntimeError("DSH 运行时异常退出,发送下一条消息将自动重启。");
      setEvents([]);
      setBusy(false);
    });
    return () => { off(); offRestart(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const newSession = () => {
    const id = `s-${Date.now()}`;
    activeIdRef.current = id;
    setActiveId(id);
    setEvents([]);
    setBusy(false);
  };

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    if (!activeIdRef.current) {
      const nid = `s-${Date.now()}`;
      activeIdRef.current = nid;
      setActiveId(nid);
    }
    setInput("");
    setBusy(true);
    setRuntimeError("");
    const sid = activeIdRef.current;
    const r = await window.daw.dshSend(sid, q);
    if (!r.ok) {
      setBusy(false);
      message.error(r.error ?? "发送失败");
    } else {
      void refreshSessions();
    }
  };

  const switchSession = (id: string) => {
    activeIdRef.current = id;
    setActiveId(id);
    setEvents([]); // 历史回放后续接 DSH 持久化装载(待办);当前会话实时渲染
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <aside className="daw-side">
        <div className="daw-side-head">
          <span className="daw-side-title">会话</span>
          <Button type="text" size="small" icon={<PlusOutlined />} onClick={newSession}>新对话</Button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", paddingBottom: 8 }}>
          {sessions.map((s) => (
            <div key={s.id} className={`daw-session-item${s.id === activeId ? " active" : ""}`} onClick={() => switchSession(s.id)}>
              <div className="daw-session-title">{s.title || "新对话"}</div>
            </div>
          ))}
          {sessions.length === 0 && <div style={{ padding: 16 }}><Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} /></div>}
        </div>
      </aside>

      <div className="daw-conv-col">
        <div className="daw-conv-scroll">
          <div className="daw-conv-inner">
            {bubbles.length === 0 && !busy && (
              <div className="daw-hero">
                <div className="daw-hero-title">北斗work · 智能分析助手</div>
                <div className="daw-hero-sub">DeepSeek Harness 运行时 · 语义检索 → 口径一致查询 → 诊断归因 · 每步带工具轨迹</div>
              </div>
            )}
            {bubbles.map((b, i) =>
              b.role === "user" ? (
                <div key={i} className="daw-row-user"><div className="daw-bubble-user">{b.text}</div></div>
              ) : (
                <div key={i} className="daw-row-ai">
                  <div className="daw-ai-head"><span className="daw-ai-avatar">BW</span><span className="daw-ai-name">北斗work</span></div>
                  <div className="daw-ai-body">
                    {b.reasoning && (
                      <details className="daw-traj-input" style={{ marginBottom: 6 }}>
                        <summary style={{ fontSize: 12, color: "var(--daw-sub, #888)" }}>💭 思考过程</summary>
                        <pre>{b.reasoning}</pre>
                      </details>
                    )}
                    {b.text ? <Md text={b.text} /> : busy && i === bubbles.length - 1 ? <Spin size="small" /> : null}
                  </div>
                  <Trajectory tools={b.tools} />
                </div>
              ),
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="daw-inputbar">
          {runtimeError && <Alert type="warning" showIcon style={{ margin: "0 0 6px", padding: "4px 12px", fontSize: 12 }} message={runtimeError} />}
          {modelConfigured === false && (
            <Alert type="warning" showIcon style={{ margin: "0 0 6px", padding: "4px 12px", fontSize: 12 }}
              message={<>未配置模型 API Key。{onGoSettings ? <a onClick={onGoSettings}>前往设置</a> : null}</>} />
          )}
          <div className="daw-inputbar-inner">
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send(); } }}
              autoSize={{ minRows: 1, maxRows: 5 }}
              placeholder="问一个数据问题…(Enter 发送 / Shift+Enter 换行)"
              disabled={busy}
            />
            <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={() => void send()} />
          </div>
          <div style={{ fontSize: 11, color: "var(--daw-sub, #999)", marginTop: 4 }}>
            Agent 先检索语义资产再回答 · SQL 由口径编译器生成并过护栏 · 每次调用有审计
          </div>
        </div>
      </div>
    </div>
  );
}
