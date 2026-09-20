import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Collapse, Empty, Spin, message } from "antd";
import { SendOutlined, ExportOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  agentEventToSessionEvent,
  replayEvents,
  type SessionEvent,
  type ToolStep,
  type EvidenceItem as EvItem,
  type AgentEventLike,
} from "@beidou/core/src/session/replay";

type Bubble = ReturnType<typeof replayEvents>[number];

/** 旧 localStorage 会话(一次性迁移到磁盘 JSONL 后弃用) */
interface LegacySession {
  id: string;
  ts: number;
  bubbles: Array<{ role: "user" | "assistant"; text: string; tools?: Array<{ name: string; summary?: string }>; evidence?: EvItem[] }>;
}

const STORE_KEY = "daw.sessions";

const SUGGESTIONS = [
  "高速智驾天数最近一个月是多少?",
  "按车型看高速智驾天数的分布",
  "高速智驾天数最近为什么变化,帮我诊断归因",
  "智驾活跃相关的指标和业务模型有哪些?",
];

const loadLegacySessions = (): LegacySession[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as LegacySession[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
};

/* ---------- Markdown 渲染(assistant 正文;XSS:marked 输出经 DOMPurify 白名单净化) ---------- */
const renderMd = (text: string): string =>
  DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string);

const Md = React.memo(({ text }: { text: string }) => {
  const html = useMemo(() => renderMd(text), [text]);
  return <div className="daw-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/* ---------- 工具轨迹视图:逐步骤状态 + 入参展开 ---------- */
const Trajectory = ({ tools }: { tools: ToolStep[] }) => {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="daw-traj">
      <div className="daw-traj-head">
        <span className="daw-traj-title">工具轨迹</span>
        <span className="daw-traj-count">{tools.length} 步</span>
      </div>
      <ol className="daw-traj-list">
        {tools.map((t, i) => {
          // 已发出调用但没有结果 = 执行中
          const running = t.ok === undefined && t.summary === undefined;
          const name = t.name.replace(/^mcp__data-workbench__/, "");
          return (
            <li key={i} className={`daw-traj-step${t.ok === false ? " fail" : ""}${running ? " running" : ""}`}>
              <div className="daw-traj-line" onClick={() => setOpen(open === i ? null : i)}>
                <span className="dot" />
                <span className="daw-traj-name">{name}</span>
                {t.summary ? <span className="daw-traj-summary">{t.summary}</span> : null}
                {t.input !== undefined && t.input !== null ? (
                  <span className="daw-traj-toggle">{open === i ? "收起" : "入参"}</span>
                ) : null}
              </div>
              {open === i && t.input !== undefined && t.input !== null ? (
                <pre className="daw-traj-json">{JSON.stringify(t.input, null, 2)}</pre>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default function ChatPage({ theme, modelConfigured, onGoSettings }: { theme?: boolean; modelConfigured?: boolean; onGoSettings?: () => void }) {
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; lastTs: string; messageCount: number }>>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const bubbles = useMemo(() => replayEvents(events), [events]);
  void theme;

  const refreshSessions = async () => {
    try {
      setSessions(await window.daw.sessionList());
    } catch {
      // 列表刷新失败不阻塞会话
    }
  };

  const switchTo = async (id: string) => {
    setActiveId(id);
    setBusy(false);
    try {
      // IPC 返回松散 JSON,边界处收敛为 SessionEvent
      setEvents((await window.daw.sessionRead(id)) as unknown as SessionEvent[]);
    } catch {
      setEvents([]);
    }
  };

  // 启动:一次性迁移 localStorage → 磁盘 JSONL;再从磁盘装载会话列表
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const legacy = loadLegacySessions();
        for (const s of legacy) {
          if (s.bubbles.length > 0) await window.daw.sessionImport(s.id, s.bubbles);
        }
        if (legacy.length > 0) localStorage.removeItem(STORE_KEY);
      } catch {
        // 迁移失败不阻塞(旧数据留在 localStorage,下次再试)
      }
      const list = await window.daw.sessionList();
      if (disposed) return;
      setSessions(list);
      if (list.length > 0) await switchTo(list[0]!.id);
      else setActiveId(`s-${Date.now()}`);
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 实时事件 → 追加到事件流 → replayEvents 重放(与磁盘恢复同一条代码路径)
  useEffect(() => {
    const off = window.daw.onAgentEvent(({ sessionId: sid, ev }) => {
      const e = ev as AgentEventLike;
      if (sid !== activeId) {
        // 旧会话的完成事件也须解除全局 busy(否则切会话后永久卡死)
        if (e.type === "done" || e.type === "error") setBusy(false);
        return;
      }
      setEvents((prev) => [...prev, agentEventToSessionEvent(sid, e)]);
      if (e.type === "done" || e.type === "error") {
        setBusy(false);
        void refreshSessions(); // 首条消息后列表出现新会话/时间排序更新
      }
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 60);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy || !activeId) return;
    setInput("");
    setBusy(true);
    const r = await window.daw.send(activeId, q);
    if (!r.ok) {
      setBusy(false);
      message.error(r.error ?? "发送失败");
    }
  };

  const newSession = () => {
    setActiveId(`s-${Date.now()}`);
    setEvents([]);
    setBusy(false);
  };

  const removeSession = async (id: string) => {
    await window.daw.sessionDelete(id);
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (id === activeId) {
      if (next.length > 0) await switchTo(next[0]!.id);
      else {
        setActiveId(`s-${Date.now()}`);
        setEvents([]);
      }
    }
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

  const timeStr = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  };

  return (
    <div className="daw-chat-wrap">
      {/* 会话列表(dsh 风格二级面板;权威源=磁盘 JSONL) */}
      <aside className="daw-side">
        <div className="daw-side-head">
          <span className="daw-side-title">会话</span>
          <Button type="text" size="small" icon={<PlusOutlined />} onClick={newSession}>新对话</Button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", paddingBottom: 8 }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`daw-session-item${s.id === activeId ? " active" : ""}`}
              onClick={() => void switchTo(s.id)}
            >
              <div className="daw-session-title">{s.title}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="daw-session-time">{timeStr(s.lastTs)} · {s.messageCount} 问</span>
                <DeleteOutlined
                  className="daw-session-time"
                  onClick={(e) => { e.stopPropagation(); void removeSession(s.id); }}
                />
              </div>
            </div>
          ))}
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
                    <div key={s} className="daw-suggest-card" onClick={() => void send(s)}>{s}</div>
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
                  <div className="daw-ai-body">
                    {b.text ? (
                      <Md text={b.text} />
                    ) : busy && i === bubbles.length - 1 ? (
                      <Spin size="small" />
                    ) : null}
                    {b.error ? <div className="daw-ai-error">{b.error}</div> : null}
                  </div>
                  {b.tools && b.tools.length > 0 ? <Trajectory tools={b.tools} /> : null}
                </div>
              ),
            )}
            <div ref={bottom} />
          </div>
        </div>

        {/* 输入区 */}
        <div className="daw-inputbar">
          {modelConfigured === false && (
            <Alert
              type="warning"
              showIcon
              style={{ margin: "0 0 8px", padding: "6px 12px", fontSize: 12 }}
              message={
                <>
                  演示模式:未配置模型 API Key,回答由固定管线生成。
                  {onGoSettings ? (
                    <a onClick={onGoSettings} style={{ marginLeft: 8 }}>前往 设置 → 模型 配置 →</a>
                  ) : null}
                </>
              }
            />
          )}
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
                    void send();
                  }
                }}
              />
              <Button
                type="primary"
                shape="circle"
                icon={<SendOutlined style={{ fontSize: 14 }} />}
                loading={busy}
                disabled={!input.trim()}
                onClick={() => void send()}
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
          <Button size="small" type="text" icon={<ExportOutlined />} disabled={bubbles.length === 0} onClick={() => void exportReport()}>
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
