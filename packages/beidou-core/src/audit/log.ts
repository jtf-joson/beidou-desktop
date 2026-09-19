/**
 * 审计日志(JSONL,只追加;派生物但不可篡改历史)。
 * fs 注入;写入前脱敏。
 */
import type { AuditEvent } from "../types";
import { redactSecrets } from "../evidence/pack";

export interface AuditDeps {
  appendFile: (line: string) => Promise<void>;
  readFile: () => Promise<string>;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
  tail(n: number): Promise<AuditEvent[]>;
}

export function createAuditLog(deps: AuditDeps): AuditLog {
  return {
    async append(event) {
      const safe = redactSecrets(event);
      await deps.appendFile(JSON.stringify(safe) + "\n");
    },
    async tail(n) {
      let text: string;
      try {
        text = await deps.readFile();
      } catch {
        return [];
      }
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      const events: AuditEvent[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as AuditEvent);
        } catch {
          // 历史脏数据跳过(不炸)
        }
      }
      return events.slice(-n);
    },
  };
}
