/**
 * 会话持久化(JSONL 追加式,参照 dsh Session 体系)。
 * 文件即权威源:<sessionsDir>/<sessionId>.jsonl,一行一个事件,只追加;
 * 恢复 = replayEvents 回放(与渲染端实时 reducer 同构),不另存快照。
 */
import { appendFile, readFile, rm, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export interface SessionEvent {
  ts: string;
  type: "user_message" | "assistant_chunk" | "tool_call" | "tool_result" | "evidence" | "done" | "error";
  sessionId: string;
  /** user_message=用户原文;assistant_chunk=文本快照(整段替换);tool_call={name,input};tool_result={name,ok,summary};evidence=证据数组;done/error=原因 */
  data: unknown;
}

export interface SessionSummary {
  id: string;
  title: string;
  lastTs: string;
  messageCount: number;
}

/** 会话 ID 白名单:renderer 可控输入拼路径,防目录穿越(评审口径同 SQL Guard) */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`invalid sessionId: ${JSON.stringify(sessionId).slice(0, 100)}`);
  }
}

export class SessionStore {
  constructor(private readonly sessionsDir: string) {}

  private sessionFile(sessionId: string): string {
    assertSafeSessionId(sessionId);
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  async ensureDir(): Promise<void> {
    if (!existsSync(this.sessionsDir)) {
      await mkdir(this.sessionsDir, { recursive: true });
    }
  }

  async append(event: SessionEvent): Promise<void> {
    assertSafeSessionId(event.sessionId);
    await this.ensureDir();
    await appendFile(this.sessionFile(event.sessionId), JSON.stringify(event) + "\n", "utf-8");
  }

  /** 逐行回读;单行损坏(手改/断电截断)跳过该行,不整体失败 */
  async read(sessionId: string): Promise<SessionEvent[]> {
    const file = this.sessionFile(sessionId); // 校验在 try 外:非法 ID 必须抛出而非当成"不存在"
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      return [];
    }
    const events: SessionEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // 截断行:丢弃
      }
    }
    return events;
  }

  async list(): Promise<SessionSummary[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const files = await readdir(this.sessionsDir);
    const summaries: SessionSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.replace(/\.jsonl$/, "");
      if (!SAFE_SESSION_ID.test(id)) continue;
      const events = await this.read(id);
      if (events.length === 0) continue;
      const first = events.find((e) => e.type === "user_message");
      const last = events[events.length - 1]!;
      summaries.push({
        id,
        title: first ? String(first.data).slice(0, 50) : "新对话",
        lastTs: last.ts,
        messageCount: events.filter((e) => e.type === "user_message").length,
      });
    }
    return summaries.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }

  async delete(sessionId: string): Promise<void> {
    await rm(this.sessionFile(sessionId), { force: true });
  }
}
