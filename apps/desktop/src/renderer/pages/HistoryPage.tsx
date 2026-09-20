import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Collapse, Empty, message } from "antd";
import { DeleteOutlined, ExportOutlined } from "@ant-design/icons";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { replayEvents, type SessionEvent, type ToolStep } from "@beidou/core/src/session/replay";

/** 旧会话归档:只读(决策 5)。新对话在「智能分析助手」(DSH Runtime),旧 JSONL 在此查看/导出/删除。 */

const STORE_KEY = "daw.sessions"; // 旧 localStorage 会话(一次性迁移入盘后清除)

interface LegacySession { id: string; bubbles: Array<{ role: string; text: string; tools?: unknown[]; evidence?: unknown[] }> }
function loadLegacySessions(): LegacySession[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as LegacySession[]) : [];
  } catch {
    return [];
  }
}

function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string);
}

function Md({ text }: { text: string }) {
  return <div className="daw-md" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />;
}

function Trajectory({ tools }: { tools: ToolStep[] }) {
  if (tools.length === 0) return null;
  return (
    <Collapse
      size="small"
      ghost
      className="daw-traj"
      items={[{
        key: "t",
        label: <span className="daw-traj-label">🛠 工具轨迹({tools.length})</span>,
        children: tools.map((t, i) => (
          <div key={i} className="daw-traj-step">
            <span className={`daw-traj-dot ${t.ok === undefined ? "run" : t.ok ? "ok" : "fail"}`} />
            <span className="daw-traj-name">{t.name}</span>
            <span className="daw-traj-summary">{t.summary}</span>
            {t.input !== undefined && (
              <details className="daw-traj-input">
                <summary>入参</summary>
                <pre>{JSON.stringify(t.input, null, 2)}</pre>
              </details>
            )}
          </div>
        )),
      }]}
    />
  );
}

function timeStr(ts: string): string {
  try { return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ts; }
}

export default function HistoryPage() {
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; lastTs: string; messageCount: number }>>([]);
  const [activeId, setActiveId] = useState("");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  const bubbles = useMemo(() => replayEvents(events), [events]);

  const refreshSessions = async () => {
    try { setSessions(await window.daw.sessionList()); } catch { /* 忽略 */ }
  };

  const switchTo = async (id: string) => {
    setActiveId(id);
    try {
      setEvents((await window.daw.sessionRead(id)) as unknown as SessionEvent[]);
    } catch { setEvents([]); }
  };

  useEffect(() => {
    let disposed = false;
    void (async () => {
      // 旧 localStorage 会话一次性迁移入盘(仅存在时执行)
      try {
        const legacy = loadLegacySessions();
        for (const s of legacy) {
          if (s.bubbles?.length > 0) await window.daw.sessionImport(s.id, s.bubbles);
        }
        if (legacy.length > 0) localStorage.removeItem(STORE_KEY);
      } catch { /* 迁移失败下次再试 */ }
      const list = await window.daw.sessionList();
      if (disposed) return;
      setSessions(list);
      if (list.length > 0) await switchTo(list[0]!.id);
    })();
    return () => { disposed = true; };
  }, []);

  const removeSession = async (id: string) => {
    await window.daw.sessionDelete(id);
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (id === activeId) {
      if (next.length > 0) await switchTo(next[0]!.id);
      else { setActiveId(""); setEvents([]); }
    }
  };

  const exportActive = async () => {
    const md = bubbles.map((b) =>
      b.role === "user" ? `## 🙋 用户\n\n${b.text}` :
      `## 🤖 北斗work\n\n${b.text || "_(无文本)"}` +
      (b.tools?.length ? `\n\n<details><summary>工具轨迹(${b.tools.length})</summary>\n\n\`\`\`json\n${JSON.stringify(b.tools, null, 2)}\n\`\`\`\n</details>` : "")
    ).join("\n\n---\n\n");
    const r = await window.daw.exportReport(md);
    if (r.ok) message.success(`已导出:${r.file}`);
    else message.error(r.error ?? "导出失败");
  };

  return (
    <div style={{ display: "flex", gap: 0, height: "100%", overflow: "hidden" }}>
      <aside className="daw-side">
        <div className="daw-side-head">
          <span className="daw-side-title">历史会话(只读)</span>
          {activeId && <Button type="text" size="small" icon={<ExportOutlined />} onClick={exportActive}>导出</Button>}
        </div>
        <div style={{ flex: 1, overflowY: "auto", paddingBottom: 8 }}>
          {sessions.map((s) => (
            <div key={s.id} className={`daw-session-item${s.id === activeId ? " active" : ""}`} onClick={() => void switchTo(s.id)}>
              <div className="daw-session-title">{s.title}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="daw-session-time">{timeStr(s.lastTs)} · {s.messageCount} 问</span>
                <DeleteOutlined className="daw-session-time" onClick={(e) => { e.stopPropagation(); void removeSession(s.id); }} />
              </div>
            </div>
          ))}
          {sessions.length === 0 && <div style={{ padding: 16 }}><Empty description="暂无历史会话" image={Empty.PRESENTED_IMAGE_SIMPLE} /></div>}
        </div>
      </aside>

      <div className="daw-conv-col">
        <Alert
          type="info"
          showIcon
          style={{ margin: "8px 12px 0" }}
          message="旧会话归档(只读):Claude SDK 时代的会话记录。新对话请使用左侧「智能分析助手」(DeepSeek Harness 运行时)。"
        />
        <div className="daw-conv-scroll">
          <div className="daw-conv-inner">
            {bubbles.map((b, i) =>
              b.role === "user" ? (
                <div key={i} className="daw-row-user"><div className="daw-bubble-user">{b.text}</div></div>
              ) : (
                <div key={i} className="daw-row-ai">
                  <div className="daw-ai-head"><span className="daw-ai-avatar">BW</span><span className="daw-ai-name">北斗work</span></div>
                  <div className="daw-ai-body">
                    {b.text ? <Md text={b.text} /> : null}
                    {b.error ? <div className="daw-ai-error">{b.error}</div> : null}
                  </div>
                  {b.tools && b.tools.length > 0 ? <Trajectory tools={b.tools} /> : null}
                </div>
              ),
            )}
            <div ref={bottom} />
          </div>
        </div>
      </div>
    </div>
  );
}
