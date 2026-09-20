/**
 * 会话回放:SessionEvent[] → 气泡流。
 * 与渲染端实时 reducer 严格同构——同一份规则,实时与恢复两条路径必得出同一界面。
 */
import type { SessionEvent } from "./store";
import type { EvidenceItem } from "../types";

export type { SessionEvent, EvidenceItem };

export interface ToolStep {
  name: string;
  input?: unknown;
  ok?: boolean;
  summary?: string;
  ts?: string;
}

export interface ReplayBubble {
  role: "user" | "assistant";
  text: string;
  tools?: ToolStep[];
  evidence?: EvidenceItem[];
  /** error 事件的落点:气泡内红色横幅(不单独占气泡) */
  error?: string;
}

/** 兼容旧 localStorage 气泡(core 不依赖 renderer 类型,取结构子集) */
export interface SessionBubble {
  role: "user" | "assistant";
  text: string;
  tools?: Array<{ name: string; input?: unknown; ok?: boolean; summary?: string }>;
  evidence?: EvidenceItem[];
}

export function replayEvents(events: SessionEvent[]): ReplayBubble[] {
  const bubbles: ReplayBubble[] = [];
  const ensureAssistant = (): ReplayBubble => {
    if (bubbles.length === 0 || bubbles[bubbles.length - 1]!.role !== "assistant") {
      bubbles.push({ role: "assistant", text: "", tools: [] });
    }
    return bubbles[bubbles.length - 1]!;
  };
  for (const e of events) {
    if (e.type === "user_message") {
      bubbles.push({ role: "user", text: String(e.data) });
    } else if (e.type === "assistant_chunk") {
      const b = ensureAssistant();
      b.text = String(e.data);
    } else if (e.type === "tool_call") {
      const b = ensureAssistant();
      b.tools = [...(b.tools ?? []), { ...(e.data as { name: string; input?: unknown }), ts: e.ts }];
    } else if (e.type === "tool_result") {
      const d = e.data as { name: string; ok: boolean; summary: string };
      for (let j = bubbles.length - 1; j >= 0; j--) {
        const b = bubbles[j]!;
        if (b.role === "assistant" && b.tools?.length) {
          const last = b.tools[b.tools.length - 1]!;
          b.tools[b.tools.length - 1] = { ...last, ok: d.ok, summary: d.summary, ts: e.ts };
          break;
        }
      }
    } else if (e.type === "evidence") {
      const b = ensureAssistant();
      b.evidence = e.data as EvidenceItem[];
    } else if (e.type === "error") {
      const b = ensureAssistant();
      b.error = String(e.data);
    }
    // done:终止标记,不产生内容
  }
  return bubbles;
}

/** AgentEvent 的结构性子集(desktop service 与测试都满足此形状) */
export type AgentEventLike =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "evidence"; items: EvidenceItem[] }
  | { type: "done"; reason?: string }
  | { type: "error"; message: string };

/** AgentEvent → SessionEvent:主进程落盘与渲染端实时回放共用同一映射,保证回放同构 */
export function agentEventToSessionEvent(sessionId: string, ev: AgentEventLike, ts: string = new Date().toISOString()): SessionEvent {
  switch (ev.type) {
    case "user": return { ts, sessionId, type: "user_message", data: ev.text };
    case "assistant": return { ts, sessionId, type: "assistant_chunk", data: ev.text };
    case "tool": return { ts, sessionId, type: "tool_call", data: { name: ev.name, input: ev.input } };
    case "tool_result": return { ts, sessionId, type: "tool_result", data: { name: ev.name, ok: ev.ok, summary: ev.summary } };
    case "evidence": return { ts, sessionId, type: "evidence", data: ev.items };
    case "done": return { ts, sessionId, type: "done", data: ev.reason };
    case "error": return { ts, sessionId, type: "error", data: ev.message };
  }
}

/** localStorage 旧会话 → 事件流(一次性迁移用;ts 单调递增保证回放顺序稳定) */
export function bubblesToEvents(sessionId: string, bubbles: SessionBubble[], now: () => string = () => new Date().toISOString()): SessionEvent[] {
  const events: SessionEvent[] = [];
  let t = 0;
  const ts = () => new Date(new Date(now()).getTime() + t++ * 1000).toISOString();
  for (const b of bubbles) {
    if (b.role === "user") {
      events.push({ ts: ts(), type: "user_message", sessionId, data: b.text });
      continue;
    }
    for (const tool of b.tools ?? []) {
      events.push({ ts: ts(), type: "tool_call", sessionId, data: { name: tool.name, input: tool.input } });
      events.push({
        ts: ts(), type: "tool_result", sessionId,
        data: { name: tool.name, ok: tool.ok ?? true, summary: tool.summary ?? "" },
      });
    }
    events.push({ ts: ts(), type: "assistant_chunk", sessionId, data: b.text });
    if (b.evidence?.length) events.push({ ts: ts(), type: "evidence", sessionId, data: b.evidence });
  }
  return events;
}
