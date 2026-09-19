import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Collapse, Empty, Spin, message } from "antd";
import { SendOutlined, ExportOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";

interface ToolEvent { type: "tool"; name: string; input: unknown }
interface EvidenceItem {
  kind: string; title: string; caliber?: string; sql?: string; rows?: number;
  truncated?: boolean; lineage?: string[]; metricName?: string; mock?: boolean;
}
type AgentEvent =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | ToolEvent
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "evidence"; items: EvidenceItem[] }
  | { type: "done"; reason?: string }
  | { type: "error"; message: string };

interface Bubble {
  role: "user" | "assistant";
  text: string;
  tools?: Array<{ name: string; summary?: string }>;
  evidence?: EvidenceItem[];
}

interface ChatSession {
  id: string;
  ts: number;
  bubbles: Bubble[];
}

const STORE_KEY = "daw.sessions";

const SUGGESTIONS = [
  "高速智驾天数最近一个月是多少?",
  "按车型看高速智驾天数的分布",
  "高速智驾天数最近为什么变化,帮我诊断归因",
  "智驾活跃相关的指标和业务模型有哪些?",
];

const loadSessions = (): ChatSession[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as ChatSession[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
};

export default function ChatPage({ theme }: { theme?: boolean }) {
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions);
  const [activeId, setActiveId] = useState<string>(() => loadSessions()[0]?.id ?? `s-${Date.now()}`);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const active = useMemo(() => sessions.find((s) => s.id === activeId), [sessions, activeId]);
  const bubbles = active?.bubbles ?? [];
  void theme;

  const setBubbles = (fn: (prev: Bubble[]) => Bubble[]) => {
    setSessions((prevSessions) => {
      const cur = prevSessions.find((s) => s.id === activeId);
      const nextBubbles = fn(cur?.bubbles ?? []);
      if (cur) return prevSessions.map((s) => (s.id === activeId ? { ...s, bubbles: nextBubbles, ts: Date.now() } : s));
      return [{ id: activeId, ts: Date.now(), bubbles: nextBubbles }, ...prevSessions];
    });
  };

  // 会话持久化:写回 localStorage(修复只读不写导致切页/重启丢历史)
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(sessions.filter((s) => s.bubbles.length > 0).slice(0, 30)));
    } catch {
      // localStorage 满/不可用时不阻塞
    }
  }, [sessions]);

  useEffect(() => {
    const off = window.daw.onAgentEvent(({ sessionId: sid, ev }) => {
      if (sid !== activeId) {
        // 旧会话的完成事件也须解除全局 busy(否则切会话后永久卡死)
        const e0 = ev as AgentEvent;
        if (e0.type === "done" || e0.type === "error") setBusy(false);
        return;
      }
      const e = ev as AgentEvent;
      setBubbles((prev) => {
        const next = [...prev];
        const ensureAssistant = (): number => {
          if (next.length === 0 || next[next.length - 1]!.role !== "assistant") next.push({ role: "assistant", text: "", tools: [] });
          return next.length - 1;
        };
        if (e.type === "user") next.push({ role: "user", text: e.text });
        else if (e.type === "assistant") {
          const i = ensureAssistant();
          next[i] = { ...next[i]!, text: e.text };
        } else if (e.type === "tool") {
          const i = ensureAssistant();
          const cur = next[i]!;
          next[i] = { ...cur, tools: [...(cur.tools ?? []), { name: e.name.replace(/^mcp__data-workbench__/, "") }] };
        } else if (e.type === "tool_result") {
          for (let j = next.length - 1; j >= 0; j--) {
            const b = next[j]!;
            if (b.role === "assistant" && b.tools?.length) {
              b.tools[b.tools.length - 1] = { ...b.tools[b.tools.length - 1]!, summary: e.summary };
              break;
            }
          }
        } else if (e.type === "evidence") {
          const i = ensureAssistant();
          next[i] = { ...next[i]!, evidence: e.items };
        }
        return next;
      });
      if (e.type === "done" || e.type === "error") setBusy(false);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 60);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const r = await window.daw.send(activeId, q);
    if (!r.ok) {
      setBusy(false);
      message.error(r.error ?? "发送失败");
    }
  };

  const newSession = () => {
    const id = `s-${Date.now()}`;
    setActiveId(id);
    setBusy(false);
    setSessions((prev) => [{ id, ts: Date.now(), bubbles: [] }, ...prev.filter((s) => s.bubbles.length > 0)]);
  };

  const removeSession = (id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? `s-${Date.now()}`);
      return next;
    });
  };

  const exportReport = async () => {
    const lastQ = [...bubbles].reverse().find((b) => b.role === "user");
    const lastA = [...bubbles].reverse().find((b) => b.role === "assistant" && b.text);
    const ev = [...bubbles].reverse().find((b) => b.evidence?.length);
    const md = [
      `# 北斗work 数据分析报告`, ``,
      `- 时间:${new Date().toLocaleString("zh-CN")}`,
      `- 问题:${lastQ?.text ?? ""}`, ``, `## 分析结论`, ``, lastA?.text ?? "(无)", ``, `## 证据(EvidencePack)`, ``,
      ...(ev?.evidence ?? []).flatMap((e, i) => [
        `### ${i + 1}. ${e.title}`,
        e.caliber ? `- 口径:${e.caliber}` : "",
        e.sql ? "- SQL:\n\n```sql\n" + e.sql + "\n```" : "",
        e.lineage ? `- 血缘:${e.lineage.join(" ← ")}` : "",
        e.rows !== undefined ? `- 行数:${e.rows}${e.truncated ? "(截断)" : ""}` : "",
        e.mock ? "- ⚠️ 演示数据(mock)" : "",
      ].filter(Boolean)),
    ].join("\n");
    const r = await window.daw.exportReport(md);
    if (r.ok) message.success(`报告已导出:${r.file}`);
    else message.error(r.error ?? "导出失败");
  };

  const timeStr = (ts: number): string => {
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  };

  return (
    <div className="daw-chat-wrap">
      {/* 会话列表(dsh 风格二级面板) */}
      <aside className="daw-side">
        <div className="daw-side-head">
          <span className="daw-side-title">会话</span>
          <Button type="text" size="small" icon={<PlusOutlined />} onClick={newSession}>新对话</Button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", paddingBottom: 8 }}>
          {sessions.map((s) => {
            const title = s.bubbles.find((b) => b.role === "user")?.text ?? "新对话";
            return (
              <div
                key={s.id}
                className={`daw-session-item${s.id === activeId ? " active" : ""}`}
                onClick={() => { setActiveId(s.id); setBusy(false); }}
              >
                <div className="daw-session-title">{title}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="daw-session-time">{timeStr(s.ts)}</span>
                  <DeleteOutlined
                    className="daw-session-time"
                    onClick={(e) => { e.stopPropagation(); removeSession(s.id); }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* 会话区 */}
      <div className="daw-conv-col">
        <div className="daw-conv-scroll">
          <div className="daw-conv-inner">
            {bubbles.length === 0 && (
              <div className="daw-hero">
                <div className="daw-hero-title">北斗work · 智能数据分析</div>
                <div className="daw-hero-sub">语义检索 → 口径一致查询 → 诊断归因,每个答案带证据</div>
                <div className="daw-suggest">
                  {SUGGESTIONS.map((s) => (
                    <div key={s} className="daw-suggest-card" onClick={() => send(s)}>{s}</div>
                  ))}
                </div>
              </div>
            )}
            {bubbles.map((b, i) =>
              b.role === "user" ? (
                <div key={i} className="daw-row-user"><div className="daw-bubble-user">{b.text}</div></div>
              ) : (
                <div key={i} className="daw-row-ai">
                  <div className="daw-ai-head">
                    <span className="daw-ai-avatar">BW</span>
                    <span className="daw-ai-name">北斗work</span>
                  </div>
                  <div className="daw-ai-body">{b.text || <Spin size="small" />}</div>
                  {b.tools && b.tools.length > 0 && (
                    <div className="daw-toolchips">
                      {b.tools.map((t, j) => {
                        const fail = t.summary?.includes("失败") || t.summary?.includes("拒绝");
                        return (
                          <span key={j} className={`daw-toolchip${fail ? " fail" : ""}`}>
                            <span className="dot" />
                            {t.name}{t.summary ? ` · ${t.summary}` : ""}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              ),
            )}
            <div ref={bottom} />
          </div>
        </div>

        {/* 输入区 */}
        <div className="daw-inputbar">
          <div className="daw-inputbar-inner">
            <div className="daw-input-card">
              <textarea
                rows={1}
                value={input}
                placeholder="问一个数据问题…(Enter 发送 / Shift+Enter 换行)"
                onChange={(e) => {
                  setInput(e.target.value);
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 140) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <Button
                type="primary"
                shape="circle"
                icon={<SendOutlined style={{ fontSize: 14 }} />}
                loading={busy}
                disabled={!input.trim()}
                onClick={() => send()}
              />
            </div>
            <div className="daw-input-hint">
              Agent 先检索语义资产再回答 · SQL 由口径编译器生成并过护栏 · <span className="daw-kbd">Enter</span> 发送
            </div>
          </div>
        </div>
      </div>

      {/* 证据面板 */}
      <aside className="daw-evidence">
        <div className="daw-evidence-head">
          <span className="daw-side-title">证据 EvidencePack</span>
          <Button size="small" type="text" icon={<ExportOutlined />} disabled={bubbles.length === 0} onClick={exportReport}>
            导出报告
          </Button>
        </div>
        <div className="daw-evidence-body">
          {(() => {
            const last = [...bubbles].reverse().find((b) => b.evidence?.length);
            const items = last?.evidence ?? [];
            if (!items.length) return <Empty description="暂无证据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
            return (
              <Collapse
                size="small"
                ghost
                items={items.map((ev, i) => ({
                  key: i,
                  label: (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, flexWrap: "wrap" }}>
                      <span className={`daw-chip${ev.kind === "metric_query" ? " ok" : ""}`} style={{ height: 20 }}>
                        <span className="dot" />{ev.kind}
                      </span>
                      <span style={{ color: "var(--text-2)" }}>{ev.title}</span>
                      {ev.mock ? <span className="daw-chip warn" style={{ height: 20 }}>mock</span> : null}
                    </span>
                  ),
                  children: (
                    <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                      {ev.caliber && <p style={{ margin: "4px 0" }}><b>口径:</b>{ev.caliber}</p>}
                      {ev.sql && (
                        <pre style={{ background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, padding: 8, fontSize: 11, whiteSpace: "pre-wrap", margin: "6px 0" }}>{ev.sql}</pre>
                      )}
                      {ev.lineage && <p style={{ margin: "4px 0" }}><b>血缘:</b>{ev.lineage.join(" ← ")}</p>}
                      {ev.rows !== undefined && <p style={{ margin: "4px 0" }}><b>行数:</b>{ev.rows}{ev.truncated ? "(截断)" : ""}</p>}
                    </div>
                  ),
                }))}
              />
            );
          })()}
        </div>
      </aside>
    </div>
  );
}
